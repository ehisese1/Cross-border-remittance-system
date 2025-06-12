;; Cross-Border Remittance System
;; Low-fee international money transfer using Clarity smart contracts


;; Constants
(define-constant CONTRACT_OWNER tx-sender)
(define-constant ERR_NOT_AUTHORIZED (err u100))
(define-constant ERR_INSUFFICIENT_BALANCE (err u101))
(define-constant ERR_INVALID_AMOUNT (err u102))
(define-constant ERR_TRANSFER_NOT_FOUND (err u103))
(define-constant ERR_TRANSFER_ALREADY_CLAIMED (err u104))
(define-constant ERR_INVALID_RECIPIENT (err u105))
(define-constant ERR_TRANSFER_EXPIRED (err u106))
(define-constant ERR_INVALID_DURATION (err u107))

;; Fee structure (in basis points - 1 basis point = 0.01%)
(define-constant BASE_FEE_BPS u50) ;; 0.5% base fee
(define-constant MIN_FEE u1000000) ;; Minimum fee: 1 STX (in microSTX)
(define-constant MAX_FEE u50000000) ;; Maximum fee: 50 STX (in microSTX)
(define-constant DEFAULT_EXPIRY_DURATION u1000) ;; Default expiry in transaction count

;; Data structures
(define-map transfers
  { transfer-id: uint }
  {
    sender: principal,
    recipient: principal,
    amount: uint,
    fee: uint,
    created-at-tx: uint,
    expires-after-tx-count: uint,
    claimed: bool,
    cancelled: bool,
    country-from: (string-ascii 3),
    country-to: (string-ascii 3)
  }
)

(define-map exchange-rates
  { currency-pair: (string-ascii 7) } ;; e.g., "USD-EUR"
  { rate: uint, updated-at-tx: uint } ;; Rate in basis points (10000 = 1.0000)
)

(define-map user-balances
  { user: principal }
  { balance: uint }
)

;; Manual expiration tracking
(define-map transfer-expiry-status
  { transfer-id: uint }
  { expired: bool, checked-at-tx: uint }
)

;; Data variables
(define-data-var next-transfer-id uint u1)
(define-data-var total-fees-collected uint u0)
(define-data-var contract-paused bool false)
(define-data-var transaction-counter uint u0)

;; Read-only functions

(define-read-only (get-transfer (transfer-id uint))
  (map-get? transfers { transfer-id: transfer-id })
)

(define-read-only (get-exchange-rate (currency-pair (string-ascii 7)))
  (map-get? exchange-rates { currency-pair: currency-pair })
)

(define-read-only (get-user-balance (user principal))
  (default-to u0 (get balance (map-get? user-balances { user: user })))
)

(define-read-only (calculate-fee (amount uint))
  (let ((calculated-fee (/ (* amount BASE_FEE_BPS) u10000)))
    (if (< calculated-fee MIN_FEE)
      MIN_FEE
      (if (> calculated-fee MAX_FEE)
        MAX_FEE
        calculated-fee
      )
    )
  )
)

(define-read-only (get-total-fees-collected)
  (var-get total-fees-collected)
)

(define-read-only (is-contract-paused)
  (var-get contract-paused)
)

(define-read-only (get-current-tx-counter)
  (var-get transaction-counter)
)

(define-read-only (check-transfer-expired (transfer-id uint))
  (match (get-transfer transfer-id)
    transfer-data 
    (let ((current-tx (var-get transaction-counter))
          (created-at (get created-at-tx transfer-data))
          (duration (get expires-after-tx-count transfer-data)))
      (> current-tx (+ created-at duration))
    )
    false
  )
)

;; Private functions

(define-private (is-authorized)
  (is-eq tx-sender CONTRACT_OWNER)
)

(define-private (increment-tx-counter)
  (var-set transaction-counter (+ (var-get transaction-counter) u1))
)

(define-private (mark-transfer-expired (transfer-id uint))
  (map-set transfer-expiry-status
    { transfer-id: transfer-id }
    { expired: true, checked-at-tx: (var-get transaction-counter) }
  )
)

;; Public functions

;; Initialize or update exchange rate (only contract owner)
(define-public (set-exchange-rate (currency-pair (string-ascii 7)) (rate uint))
  (begin
    (increment-tx-counter)
    (asserts! (is-authorized) ERR_NOT_AUTHORIZED)
    (ok (map-set exchange-rates
      { currency-pair: currency-pair }
      { rate: rate, updated-at-tx: (var-get transaction-counter) }
    ))
  )
)

;; Deposit funds to user balance
(define-public (deposit (amount uint))
  (begin
    (increment-tx-counter)
    (asserts! (> amount u0) ERR_INVALID_AMOUNT)
    (asserts! (not (var-get contract-paused)) ERR_NOT_AUTHORIZED)
    (try! (stx-transfer? amount tx-sender (as-contract tx-sender)))
    (let ((current-balance (get-user-balance tx-sender)))
      (ok (map-set user-balances
        { user: tx-sender }
        { balance: (+ current-balance amount) }
      ))
    )
  )
)
;; Withdraw funds from user balance
(define-public (withdraw (amount uint))
  (let ((current-balance (get-user-balance tx-sender)))
    (begin
      (increment-tx-counter)
      (asserts! (>= current-balance amount) ERR_INSUFFICIENT_BALANCE)
      (asserts! (> amount u0) ERR_INVALID_AMOUNT)
      (try! (as-contract (stx-transfer? amount tx-sender tx-sender)))
      (ok (map-set user-balances
        { user: tx-sender }
        { balance: (- current-balance amount) }
      ))
    )
  )
)

;; Create a new remittance transfer
(define-public (create-transfer 
  (recipient principal) 
  (amount uint) 
  (country-from (string-ascii 3))
  (country-to (string-ascii 3))
  (expiry-duration uint))
  (let (
    (transfer-id (var-get next-transfer-id))
    (fee (calculate-fee amount))
    (total-cost (+ amount fee))
    (sender-balance (get-user-balance tx-sender))
  )
    (begin
      (increment-tx-counter)
      (asserts! (not (var-get contract-paused)) ERR_NOT_AUTHORIZED)
      (asserts! (> amount u0) ERR_INVALID_AMOUNT)
      (asserts! (> expiry-duration u0) ERR_INVALID_DURATION)
      (asserts! (not (is-eq recipient tx-sender)) ERR_INVALID_RECIPIENT)
      (asserts! (>= sender-balance total-cost) ERR_INSUFFICIENT_BALANCE)
      
      ;; Deduct from sender's balance
      (map-set user-balances
        { user: tx-sender }
        { balance: (- sender-balance total-cost) }
      )
      
      ;; Create transfer record
      (map-set transfers
        { transfer-id: transfer-id }
        {
          sender: tx-sender,
          recipient: recipient,
          amount: amount,
          fee: fee,
          created-at-tx: (var-get transaction-counter),
          expires-after-tx-count: expiry-duration,
          claimed: false,
          cancelled: false,
          country-from: country-from,
          country-to: country-to
        }
      )
      
      ;; Update fee collection
      (var-set total-fees-collected (+ (var-get total-fees-collected) fee))
      
      ;; Increment transfer ID
      (var-set next-transfer-id (+ transfer-id u1))
      
      (ok transfer-id)
    )
  )
)
;; Claim a transfer (by recipient)
(define-public (claim-transfer (transfer-id uint))
  (let ((transfer-data (unwrap! (get-transfer transfer-id) ERR_TRANSFER_NOT_FOUND)))
    (begin
      (increment-tx-counter)
      (asserts! (not (var-get contract-paused)) ERR_NOT_AUTHORIZED)
      (asserts! (is-eq tx-sender (get recipient transfer-data)) ERR_NOT_AUTHORIZED)
      (asserts! (not (get claimed transfer-data)) ERR_TRANSFER_ALREADY_CLAIMED)
      (asserts! (not (get cancelled transfer-data)) ERR_TRANSFER_ALREADY_CLAIMED)
      (asserts! (not (check-transfer-expired transfer-id)) ERR_TRANSFER_EXPIRED)
      
      ;; Mark as claimed
      (map-set transfers
        { transfer-id: transfer-id }
        (merge transfer-data { claimed: true })
      )
      
      ;; Credit recipient's balance
      (let ((recipient-balance (get-user-balance tx-sender)))
        (map-set user-balances
          { user: tx-sender }
          { balance: (+ recipient-balance (get amount transfer-data)) }
        )
      )
      
      (ok true)
    )
  )
)

;; Cancel an expired transfer (refund to sender)
(define-public (cancel-expired-transfer (transfer-id uint))
  (let ((transfer-data (unwrap! (get-transfer transfer-id) ERR_TRANSFER_NOT_FOUND)))
    (begin
      (increment-tx-counter)
      (asserts! (not (var-get contract-paused)) ERR_NOT_AUTHORIZED)
      (asserts! (is-eq tx-sender (get sender transfer-data)) ERR_NOT_AUTHORIZED)
      (asserts! (not (get claimed transfer-data)) ERR_TRANSFER_ALREADY_CLAIMED)
      (asserts! (not (get cancelled transfer-data)) ERR_TRANSFER_ALREADY_CLAIMED)
      (asserts! (check-transfer-expired transfer-id) ERR_NOT_AUTHORIZED)
      
      ;; Mark as cancelled
      (map-set transfers
        { transfer-id: transfer-id }
        (merge transfer-data { cancelled: true })
      )
      
      ;; Mark as expired for tracking
      (mark-transfer-expired transfer-id)
      
      ;; Refund sender (amount only, fee is kept)
      (let ((sender-balance (get-user-balance tx-sender)))
        (map-set user-balances
          { user: tx-sender }
          { balance: (+ sender-balance (get amount transfer-data)) }
        )
      )
      
      (ok true)
    )
  )
)
;; Allow anyone to mark an expired transfer as expired (for gas efficiency)
(define-public (mark-expired (transfer-id uint))
  (begin
    (increment-tx-counter)
    (asserts! (check-transfer-expired transfer-id) ERR_NOT_AUTHORIZED)
    (mark-transfer-expired transfer-id)
    (ok true)
  )
)

;; Quick transfer for same amounts (optimized gas)
(define-public (quick-transfer (recipient principal) (amount uint))
  (create-transfer recipient amount "USA" "USA" DEFAULT_EXPIRY_DURATION)
)

;; Emergency pause (only contract owner)
(define-public (pause-contract)
  (begin
    (increment-tx-counter)
    (asserts! (is-authorized) ERR_NOT_AUTHORIZED)
    (ok (var-set contract-paused true))
  )
)

;; Unpause contract (only contract owner)
(define-public (unpause-contract)
  (begin
    (increment-tx-counter)
    (asserts! (is-authorized) ERR_NOT_AUTHORIZED)
    (ok (var-set contract-paused false))
  )
)

;; Withdraw collected fees (only contract owner)
(define-public (withdraw-fees)
  (let ((fees (var-get total-fees-collected)))
    (begin
      (increment-tx-counter)
      (asserts! (is-authorized) ERR_NOT_AUTHORIZED)
      (asserts! (> fees u0) ERR_INVALID_AMOUNT)
      (try! (as-contract (stx-transfer? fees tx-sender CONTRACT_OWNER)))
      (var-set total-fees-collected u0)
      (ok fees)
    )
  )
)

;; Batch process multiple transfers (gas optimization)
(define-public (batch-claim (transfer-ids (list 10 uint)))
  (begin
    (increment-tx-counter)
    (ok (map claim-transfer transfer-ids))
  )
)