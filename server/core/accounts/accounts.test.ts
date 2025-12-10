/**
 * Account Types and Helpers Tests
 * 
 * Unit tests for the account types module.
 * Run with: npx tsx server/core/accounts/accounts.test.ts
 * 
 * SUP-17: Ensure accounts have vertical = 'brewery'
 */

import {
  createAccountFromRaw,
  ensureAccountVertical,
  getAccountVerticalId,
  createAccountContext,
  isBreweryAccount,
  DEFAULT_VERTICAL_ID,
  type Account,
  type RawAccountData,
  type AccountContext,
} from './types';

// ============================================
// TEST UTILITIES
// ============================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

function describe(name: string, fn: () => void | Promise<void>) {
  console.log(`\n${name}`);
  return fn();
}

// ============================================
// TESTS
// ============================================

async function runTests() {
  console.log('='.repeat(60));
  console.log('Account Types Tests (SUP-17)');
  console.log('='.repeat(60));

  // ============================================
  // DEFAULT_VERTICAL_ID tests
  // ============================================

  describe('DEFAULT_VERTICAL_ID constant', () => {
    assert(
      DEFAULT_VERTICAL_ID === 'brewery',
      'DEFAULT_VERTICAL_ID should be "brewery"'
    );
  });

  // ============================================
  // createAccountFromRaw() tests
  // ============================================

  describe('createAccountFromRaw() with vertical_id set', () => {
    const raw: RawAccountData = {
      id: 'acc_123',
      vertical_id: 'brewery',
      name: 'Test Brewery'
    };
    
    const account = createAccountFromRaw(raw);
    
    assert(account.id === 'acc_123', 'Should preserve account ID');
    assert(account.verticalId === 'brewery', 'Should set verticalId from vertical_id');
    assert(account.name === 'Test Brewery', 'Should preserve name');
  });

  describe('createAccountFromRaw() with missing vertical_id', () => {
    const raw: RawAccountData = {
      id: 'acc_456',
      name: 'Legacy Account'
    };
    
    const account = createAccountFromRaw(raw);
    
    assert(account.id === 'acc_456', 'Should preserve account ID');
    assert(account.verticalId === 'brewery', 'Should default to brewery when vertical_id is missing');
    assert(account.name === 'Legacy Account', 'Should preserve name');
  });

  describe('createAccountFromRaw() with null vertical_id', () => {
    const raw: RawAccountData = {
      id: 'acc_789',
      vertical_id: null,
      name: 'Null Vertical Account'
    };
    
    const account = createAccountFromRaw(raw);
    
    assert(account.verticalId === 'brewery', 'Should default to brewery when vertical_id is null');
  });

  describe('createAccountFromRaw() with empty string vertical_id', () => {
    const raw: RawAccountData = {
      id: 'acc_empty',
      vertical_id: '',
    };
    
    const account = createAccountFromRaw(raw);
    
    assert(account.verticalId === 'brewery', 'Should default to brewery when vertical_id is empty string');
  });

  // ============================================
  // ensureAccountVertical() tests
  // ============================================

  describe('ensureAccountVertical() with verticalId set', () => {
    const partial = { id: 'acc_1', verticalId: 'brewery' as const };
    const account = ensureAccountVertical(partial);
    
    assert(account.id === 'acc_1', 'Should preserve account ID');
    assert(account.verticalId === 'brewery', 'Should preserve verticalId');
  });

  describe('ensureAccountVertical() without verticalId', () => {
    const partial = { id: 'acc_2' };
    const account = ensureAccountVertical(partial);
    
    assert(account.id === 'acc_2', 'Should preserve account ID');
    assert(account.verticalId === 'brewery', 'Should set default verticalId');
  });

  // ============================================
  // getAccountVerticalId() tests
  // ============================================

  describe('getAccountVerticalId() with valid verticalId', () => {
    const result = getAccountVerticalId('brewery');
    assert(result === 'brewery', 'Should return the provided verticalId');
  });

  describe('getAccountVerticalId() with undefined', () => {
    const result = getAccountVerticalId(undefined);
    assert(result === 'brewery', 'Should return brewery for undefined');
  });

  describe('getAccountVerticalId() with null', () => {
    const result = getAccountVerticalId(null);
    assert(result === 'brewery', 'Should return brewery for null');
  });

  // ============================================
  // createAccountContext() tests
  // ============================================

  describe('createAccountContext() with all params', () => {
    const ctx = createAccountContext('acc_ctx', 'brewery', 'user_1');
    
    assert(ctx.accountId === 'acc_ctx', 'Should set accountId');
    assert(ctx.verticalId === 'brewery', 'Should set verticalId');
    assert(ctx.userId === 'user_1', 'Should set userId');
  });

  describe('createAccountContext() without verticalId', () => {
    const ctx = createAccountContext('acc_ctx_2');
    
    assert(ctx.accountId === 'acc_ctx_2', 'Should set accountId');
    assert(ctx.verticalId === 'brewery', 'Should default verticalId to brewery');
    assert(ctx.userId === undefined, 'userId should be undefined');
  });

  describe('createAccountContext() with null verticalId', () => {
    const ctx = createAccountContext('acc_ctx_3', null, 'user_2');
    
    assert(ctx.verticalId === 'brewery', 'Should default to brewery when null');
  });

  // ============================================
  // isBreweryAccount() tests
  // ============================================

  describe('isBreweryAccount() with brewery vertical', () => {
    const account = { verticalId: 'brewery' as const };
    assert(isBreweryAccount(account) === true, 'Should return true for brewery');
  });

  describe('isBreweryAccount() with undefined vertical', () => {
    const account = {};
    assert(isBreweryAccount(account) === true, 'Should return true for undefined (defaults to brewery)');
  });

  describe('isBreweryAccount() with null vertical', () => {
    const account = { verticalId: null };
    assert(isBreweryAccount(account) === true, 'Should return true for null (defaults to brewery)');
  });

  // ============================================
  // Type structure tests
  // ============================================

  describe('Account type structure', () => {
    const account: Account = {
      id: 'acc_type_test',
      verticalId: 'brewery',
      name: 'Type Test',
      metadata: { foo: 'bar' }
    };
    
    assert(typeof account.id === 'string', 'id should be string');
    assert(typeof account.verticalId === 'string', 'verticalId should be string');
    assert(account.verticalId === 'brewery', 'verticalId should be brewery');
    assert(typeof account.name === 'string', 'name should be string');
    assert(typeof account.metadata === 'object', 'metadata should be object');
  });

  describe('AccountContext type structure', () => {
    const ctx: AccountContext = {
      accountId: 'ctx_type_test',
      verticalId: 'brewery',
      userId: 'user_type_test'
    };
    
    assert(typeof ctx.accountId === 'string', 'accountId should be string');
    assert(typeof ctx.verticalId === 'string', 'verticalId should be string');
    assert(ctx.verticalId === 'brewery', 'verticalId should be brewery');
    assert(typeof ctx.userId === 'string', 'userId should be string');
  });

  // ============================================
  // Integration tests - new accounts get brewery
  // ============================================

  describe('New account creation defaults to brewery', () => {
    // Simulate what happens when creating a new account
    const newAccountRaw: RawAccountData = {
      id: 'new_acc_' + Date.now(),
      name: 'New Brewery Business'
      // vertical_id not set - simulating a new account
    };
    
    const account = createAccountFromRaw(newAccountRaw);
    
    assert(
      account.verticalId === 'brewery',
      'New account should default to brewery vertical'
    );
  });

  describe('Legacy account migration gets brewery', () => {
    // Simulate what happens with legacy accounts that have no vertical
    const legacyAccountRaw: RawAccountData = {
      id: 'legacy_acc_123',
      vertical_id: null, // Legacy accounts might have null
      name: 'Legacy Business'
    };
    
    const account = createAccountFromRaw(legacyAccountRaw);
    
    assert(
      account.verticalId === 'brewery',
      'Legacy account should get brewery vertical'
    );
  });

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

// Run tests
runTests().catch((error) => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
