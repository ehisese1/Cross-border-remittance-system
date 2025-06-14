import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock Clarity contract interface
class MockClarityContract {
  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      transfers: new Map(),
      exchangeRates: new Map(),
      userBalances: new Map(),
      transferExpiryStatus: new Map(),
      nextTransferId: 1,
      totalFeesCollected: 0,
      contractPaused: false,
      transactionCounter: 0,
      contractOwner: 'SP1HTBVD3S94Q1HVSRMQQB5K8QFDB7G2R0F8C0VV1'
    };
  }

  // Helper functions
  incrementTxCounter() {
    this.state.transactionCounter += 1;
  }

  calculateFee(amount) {
    const BASE_FEE_BPS = 50;
    const MIN_FEE = 1000000;
    const MAX_FEE = 50000000;
    
    const calculatedFee = Math.floor((amount * BASE_FEE_BPS) / 10000);
    
    if (calculatedFee < MIN_FEE) return MIN_FEE;
    if (calculatedFee > MAX_FEE) return MAX_FEE;
    return calculatedFee;
  }

  getUserBalance(user) {
    return this.state.userBalances.get(user) || 0;
  }

  checkTransferExpired(transferId) {
    const transfer = this.state.transfers.get(transferId);
    if (!transfer) return false;
    
    const currentTx = this.state.transactionCounter;
    const createdAt = transfer.createdAtTx;
    const duration = transfer.expiresAfterTxCount;
    
    return currentTx > (createdAt + duration);
  }

  // Contract functions
  deposit(sender, amount) {
    this.incrementTxCounter();
    
    if (amount <= 0) return { ok: false, error: 102 }; // ERR_INVALID_AMOUNT
    if (this.state.contractPaused) return { ok: false, error: 100 }; // ERR_NOT_AUTHORIZED
    
    const currentBalance = this.getUserBalance(sender);
    this.state.userBalances.set(sender, currentBalance + amount);
    
    return { ok: true, value: true };
  }

  withdraw(sender, amount) {
    this.incrementTxCounter();
    
    const currentBalance = this.getUserBalance(sender);
    if (currentBalance < amount) return { ok: false, error: 101 }; // ERR_INSUFFICIENT_BALANCE
    if (amount <= 0) return { ok: false, error: 102 }; // ERR_INVALID_AMOUNT
    
    this.state.userBalances.set(sender, currentBalance - amount);
    return { ok: true, value: true };
  }

  createTransfer(sender, recipient, amount, countryFrom, countryTo, expiryDuration) {
    this.incrementTxCounter();
    
    if (this.state.contractPaused) return { ok: false, error: 100 };
    if (amount <= 0) return { ok: false, error: 102 };
    if (expiryDuration <= 0) return { ok: false, error: 107 }; // ERR_INVALID_DURATION
    if (sender === recipient) return { ok: false, error: 105 }; // ERR_INVALID_RECIPIENT
    
    const transferId = this.state.nextTransferId;
    const fee = this.calculateFee(amount);
    const totalCost = amount + fee;
    const senderBalance = this.getUserBalance(sender);
    
    if (senderBalance < totalCost) return { ok: false, error: 101 };
    
    // Deduct from sender's balance
    this.state.userBalances.set(sender, senderBalance - totalCost);
    
    // Create transfer record
    this.state.transfers.set(transferId, {
      sender,
      recipient,
      amount,
      fee,
      createdAtTx: this.state.transactionCounter,
      expiresAfterTxCount: expiryDuration,
      claimed: false,
      cancelled: false,
      countryFrom,
      countryTo
    });
    
    this.state.totalFeesCollected += fee;
    this.state.nextTransferId += 1;
    
    return { ok: true, value: transferId };
  }

  claimTransfer(claimer, transferId) {
    this.incrementTxCounter();
    
    const transfer = this.state.transfers.get(transferId);
    if (!transfer) return { ok: false, error: 103 }; // ERR_TRANSFER_NOT_FOUND
    if (this.state.contractPaused) return { ok: false, error: 100 };
    if (claimer !== transfer.recipient) return { ok: false, error: 100 };
    if (transfer.claimed) return { ok: false, error: 104 }; // ERR_TRANSFER_ALREADY_CLAIMED
    if (transfer.cancelled) return { ok: false, error: 104 };
    if (this.checkTransferExpired(transferId)) return { ok: false, error: 106 }; // ERR_TRANSFER_EXPIRED
    
    // Mark as claimed
    transfer.claimed = true;
    
    // Credit recipient's balance
    const recipientBalance = this.getUserBalance(claimer);
    this.state.userBalances.set(claimer, recipientBalance + transfer.amount);
    
    return { ok: true, value: true };
  }

  cancelExpiredTransfer(sender, transferId) {
    this.incrementTxCounter();
    
    const transfer = this.state.transfers.get(transferId);
    if (!transfer) return { ok: false, error: 103 };
    if (this.state.contractPaused) return { ok: false, error: 100 };
    if (sender !== transfer.sender) return { ok: false, error: 100 };
    if (transfer.claimed) return { ok: false, error: 104 };
    if (transfer.cancelled) return { ok: false, error: 104 };
    if (!this.checkTransferExpired(transferId)) return { ok: false, error: 100 };
    
    // Mark as cancelled
    transfer.cancelled = true;
    
    // Refund sender (amount only, fee is kept)
    const senderBalance = this.getUserBalance(sender);
    this.state.userBalances.set(sender, senderBalance + transfer.amount);
    
    return { ok: true, value: true };
  }

  setExchangeRate(sender, currencyPair, rate) {
    this.incrementTxCounter();
    
    if (sender !== this.state.contractOwner) return { ok: false, error: 100 };
    
    this.state.exchangeRates.set(currencyPair, {
      rate,
      updatedAtTx: this.state.transactionCounter
    });
    
    return { ok: true, value: true };
  }

  pauseContract(sender) {
    this.incrementTxCounter();
    if (sender !== this.state.contractOwner) return { ok: false, error: 100 };
    this.state.contractPaused = true;
    return { ok: true, value: true };
  }

  unpauseContract(sender) {
    this.incrementTxCounter();
    if (sender !== this.state.contractOwner) return { ok: false, error: 100 };
    this.state.contractPaused = false;
    return { ok: true, value: true };
  }

  withdrawFees(sender) {
    this.incrementTxCounter();
    if (sender !== this.state.contractOwner) return { ok: false, error: 100 };
    if (this.state.totalFeesCollected <= 0) return { ok: false, error: 102 };
    
    const fees = this.state.totalFeesCollected;
    this.state.totalFeesCollected = 0;
    return { ok: true, value: fees };
  }

  quickTransfer(sender, recipient, amount) {
    return this.createTransfer(sender, recipient, amount, "USA", "USA", 1000);
  }
}

describe('Cross-Border Remittance System', () => {
  let contract;
  let owner;
  let user1;
  let user2;

  beforeEach(() => {
    contract = new MockClarityContract();
    owner = 'SP1HTBVD3S94Q1HVSRMQQB5K8QFDB7G2R0F8C0VV1';
    user1 = 'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7';
    user2 = 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE';
  });

  describe('Deposit and Withdraw', () => {
    it('should allow users to deposit funds', () => {
      const result = contract.deposit(user1, 10000000);
      
      expect(result.ok).toBe(true);
      expect(contract.getUserBalance(user1)).toBe(10000000);
    });

    it('should reject deposits of zero amount', () => {
      const result = contract.deposit(user1, 0);
      
      expect(result.ok).toBe(false);
      expect(result.error).toBe(102); // ERR_INVALID_AMOUNT
    });

    it('should allow users to withdraw funds', () => {
      contract.deposit(user1, 10000000);
      const result = contract.withdraw(user1, 5000000);
      
      expect(result.ok).toBe(true);
      expect(contract.getUserBalance(user1)).toBe(5000000);
    });

    it('should reject withdrawals exceeding balance', () => {
      contract.deposit(user1, 1000000);
      const result = contract.withdraw(user1, 2000000);
      
      expect(result.ok).toBe(false);
      expect(result.error).toBe(101); // ERR_INSUFFICIENT_BALANCE
    });
  });

  describe('Fee Calculation', () => {
    it('should calculate correct fees for different amounts', () => {
      // Test minimum fee
      expect(contract.calculateFee(1000000)).toBe(1000000); // Min fee
      
      // Test percentage fee
      expect(contract.calculateFee(200000000)).toBe(1000000); // 0.5% of 200 STX = 1 STX
      
      // Test maximum fee cap
      expect(contract.calculateFee(20000000000)).toBe(50000000); // Max fee = 50 STX
    });
  });

  describe('Transfer Creation', () => {
    beforeEach(() => {
      contract.deposit(user1, 100000000); // 100 STX
    });

    it('should create a transfer successfully', () => {
      const result = contract.createTransfer(user1, user2, 10000000, "USA", "MEX", 500);
      
      expect(result.ok).toBe(true);
      expect(result.value).toBe(1); // First transfer ID
      
      const transfer = contract.state.transfers.get(1);
      expect(transfer.sender).toBe(user1);
      expect(transfer.recipient).toBe(user2);
      expect(transfer.amount).toBe(10000000);
      expect(transfer.countryFrom).toBe("USA");
      expect(transfer.countryTo).toBe("MEX");
    });

    it('should deduct amount and fee from sender balance', () => {
      const initialBalance = contract.getUserBalance(user1);
      const amount = 10000000;
      const fee = contract.calculateFee(amount);
      
      contract.createTransfer(user1, user2, amount, "USA", "MEX", 500);
      
      expect(contract.getUserBalance(user1)).toBe(initialBalance - amount - fee);
    });

    it('should reject transfer to self', () => {
      const result = contract.createTransfer(user1, user1, 10000000, "USA", "USA", 500);
      
      expect(result.ok).toBe(false);
      expect(result.error).toBe(105); // ERR_INVALID_RECIPIENT
    });

    it('should reject transfer with insufficient balance', () => {
      const result = contract.createTransfer(user1, user2, 200000000, "USA", "MEX", 500);
      
      expect(result.ok).toBe(false);
      expect(result.error).toBe(101); // ERR_INSUFFICIENT_BALANCE
    });

    it('should reject transfer with zero expiry duration', () => {
      const result = contract.createTransfer(user1, user2, 10000000, "USA", "MEX", 0);
      
      expect(result.ok).toBe(false);
      expect(result.error).toBe(107); // ERR_INVALID_DURATION
    });
  });

  describe('Transfer Claiming', () => {
    let transferId;

    beforeEach(() => {
      contract.deposit(user1, 100000000);
      const result = contract.createTransfer(user1, user2, 10000000, "USA", "MEX", 500);
      transferId = result.value;
    });

    it('should allow recipient to claim transfer', () => {
      const initialBalance = contract.getUserBalance(user2);
      const result = contract.claimTransfer(user2, transferId);
      
      expect(result.ok).toBe(true);
      expect(contract.getUserBalance(user2)).toBe(initialBalance + 10000000);
      
      const transfer = contract.state.transfers.get(transferId);
      expect(transfer.claimed).toBe(true);
    });

    it('should reject claim by non-recipient', () => {
      const result = contract.claimTransfer(user1, transferId);
      
      expect(result.ok).toBe(false);
      expect(result.error).toBe(100); // ERR_NOT_AUTHORIZED
    });

    it('should reject double claiming', () => {
      contract.claimTransfer(user2, transferId);
      const result = contract.claimTransfer(user2, transferId);
      
      expect(result.ok).toBe(false);
      expect(result.error).toBe(104); // ERR_TRANSFER_ALREADY_CLAIMED
    });

    it('should reject claiming non-existent transfer', () => {
      const result = contract.claimTransfer(user2, 999);
      
      expect(result.ok).toBe(false);
      expect(result.error).toBe(103); // ERR_TRANSFER_NOT_FOUND
    });
  });

  describe('Transfer Expiration', () => {
    let transferId;

    beforeEach(() => {
      contract.deposit(user1, 100000000);
      const result = contract.createTransfer(user1, user2, 10000000, "USA", "MEX", 5);
      transferId = result.value;
    });

    it('should detect expired transfers', () => {
      // Simulate passage of time by incrementing transaction counter
      for (let i = 0; i < 10; i++) {
        contract.incrementTxCounter();
      }
      
      expect(contract.checkTransferExpired(transferId)).toBe(true);
    });

    it('should allow sender to cancel expired transfer', () => {
      // Make transfer expire
      for (let i = 0; i < 10; i++) {
        contract.incrementTxCounter();
      }
      
      const initialBalance = contract.getUserBalance(user1);
      const result = contract.cancelExpiredTransfer(user1, transferId);
      
      expect(result.ok).toBe(true);
      expect(contract.getUserBalance(user1)).toBe(initialBalance + 10000000); // Amount refunded, fee kept
      
      const transfer = contract.state.transfers.get(transferId);
      expect(transfer.cancelled).toBe(true);
    });

    it('should reject cancellation of non-expired transfer', () => {
      const result = contract.cancelExpiredTransfer(user1, transferId);
      
      expect(result.ok).toBe(false);
      expect(result.error).toBe(100); // ERR_NOT_AUTHORIZED
    });

    it('should reject claim of expired transfer', () => {
      // Make transfer expire
      for (let i = 0; i < 10; i++) {
        contract.incrementTxCounter();
      }
      
      const result = contract.claimTransfer(user2, transferId);
      
      expect(result.ok).toBe(false);
      expect(result.error).toBe(106); // ERR_TRANSFER_EXPIRED
    });
  });

  describe('Quick Transfer', () => {
    it('should create a quick domestic transfer', () => {
      contract.deposit(user1, 50000000);
      const result = contract.quickTransfer(user1, user2, 10000000);
      
      expect(result.ok).toBe(true);
      
      const transfer = contract.state.transfers.get(result.value);
      expect(transfer.countryFrom).toBe("USA");
      expect(transfer.countryTo).toBe("USA");
      expect(transfer.expiresAfterTxCount).toBe(1000);
    });
  });

  describe('Exchange Rate Management', () => {
    it('should allow owner to set exchange rates', () => {
      const result = contract.setExchangeRate(owner, "USD-EUR", 8500);
      
      expect(result.ok).toBe(true);
      
      const rate = contract.state.exchangeRates.get("USD-EUR");
      expect(rate.rate).toBe(8500);
    });

    it('should reject non-owner setting exchange rates', () => {
      const result = contract.setExchangeRate(user1, "USD-EUR", 8500);
      
      expect(result.ok).toBe(false);
      expect(result.error).toBe(100); // ERR_NOT_AUTHORIZED
    });
  });

  describe('Contract Pause/Unpause', () => {
    it('should allow owner to pause contract', () => {
      const result = contract.pauseContract(owner);
      
      expect(result.ok).toBe(true);
      expect(contract.state.contractPaused).toBe(true);
    });

    it('should reject deposits when paused', () => {
      contract.pauseContract(owner);
      const result = contract.deposit(user1, 10000000);
      
      expect(result.ok).toBe(false);
      expect(result.error).toBe(100); // ERR_NOT_AUTHORIZED
    });

    it('should allow owner to unpause contract', () => {
      contract.pauseContract(owner);
      const result = contract.unpauseContract(owner);
      
      expect(result.ok).toBe(true);
      expect(contract.state.contractPaused).toBe(false);
    });

    it('should reject non-owner pause attempts', () => {
      const result = contract.pauseContract(user1);
      
      expect(result.ok).toBe(false);
      expect(result.error).toBe(100);
    });
  });

  describe('Fee Management', () => {
    it('should accumulate fees from transfers', () => {
      contract.deposit(user1, 100000000);
      const fee = contract.calculateFee(10000000);
      
      contract.createTransfer(user1, user2, 10000000, "USA", "MEX", 500);
      
      expect(contract.state.totalFeesCollected).toBe(fee);
    });

    it('should allow owner to withdraw fees', () => {
      contract.deposit(user1, 100000000);
      contract.createTransfer(user1, user2, 10000000, "USA", "MEX", 500);
      
      const result = contract.withdrawFees(owner);
      
      expect(result.ok).toBe(true);
      expect(result.value).toBeGreaterThan(0);
      expect(contract.state.totalFeesCollected).toBe(0);
    });

    it('should reject fee withdrawal by non-owner', () => {
      const result = contract.withdrawFees(user1);
      
      expect(result.ok).toBe(false);
      expect(result.error).toBe(100);
    });
  });

  describe('Edge Cases and Security', () => {
    it('should handle maximum transfer amounts', () => {
      const maxAmount = 1000000000; // 1000 STX
      contract.deposit(user1, maxAmount + 50000000); // Add extra for fees
      
      const result = contract.createTransfer(user1, user2, maxAmount, "USA", "MEX", 500);
      
      expect(result.ok).toBe(true);
    });

    it('should increment transaction counter on each operation', () => {
      const initialCounter = contract.state.transactionCounter;
      
      contract.deposit(user1, 10000000);
      expect(contract.state.transactionCounter).toBe(initialCounter + 1);
      
      contract.withdraw(user1, 5000000);
      expect(contract.state.transactionCounter).toBe(initialCounter + 2);
    });

    it('should maintain state consistency across operations', () => {
      const amount = 10000000;
      const fee = contract.calculateFee(amount);
      
      contract.deposit(user1, amount + fee);
      const balanceAfterDeposit = contract.getUserBalance(user1);
      
      const transferResult = contract.createTransfer(user1, user2, amount, "USA", "MEX", 500);
      const balanceAfterTransfer = contract.getUserBalance(user1);
      
      contract.claimTransfer(user2, transferResult.value);
      const recipientBalance = contract.getUserBalance(user2);
      
      expect(balanceAfterDeposit).toBe(amount + fee);
      expect(balanceAfterTransfer).toBe(0);
      expect(recipientBalance).toBe(amount);
    });
  });
});