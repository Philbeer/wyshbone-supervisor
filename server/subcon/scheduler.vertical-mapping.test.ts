/**
 * Subconscious Scheduler Vertical Mapping Integration Tests
 * 
 * Tests that the scheduler correctly uses vertical → pack mapping.
 * Run with: npx tsx server/subcon/scheduler.vertical-mapping.test.ts
 * 
 * SUP-16: Map brewery vertical → default subconscious packs
 * SUP-17: Ensure accounts have vertical = 'brewery'
 */

import {
  startSubconScheduler,
  stopSubconScheduler,
  getSubconSchedulerStatus,
  triggerSchedule,
  getCurrentVerticalId,
  getCurrentVerticalPackIds,
  _resetScheduler,
  _clearScheduleStates,
  _getScheduleState
} from './scheduler';
import { _clearRegistry } from './registry';
import { _resetEngineInitialized, initializeSubconEngine } from './index';
import { getDefaultSubconPackIdsForVertical } from './SubconVerticalMapping';
import type { VerticalId } from '../core/verticals/types';
// SUP-17: Import account helpers for testing
import {
  getAccountVerticalId,
  createAccountContext,
  DEFAULT_VERTICAL_ID
} from '../core/accounts';

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
  console.log('Scheduler Vertical Mapping Integration Tests (SUP-16)');
  console.log('='.repeat(60));

  // Disable scheduler during tests
  const originalEnv = process.env.SUBCON_SCHEDULER_ENABLED;
  process.env.SUBCON_SCHEDULER_ENABLED = 'false';

  // ============================================
  // getCurrentVerticalId() tests
  // ============================================

  describe('getCurrentVerticalId() returns brewery by default', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    const verticalId = getCurrentVerticalId();
    
    assert(
      verticalId === 'brewery',
      'Default verticalId should be brewery'
    );
  });

  // ============================================
  // getCurrentVerticalPackIds() tests
  // ============================================

  describe('getCurrentVerticalPackIds() returns brewery packs by default', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    const packIds = getCurrentVerticalPackIds();
    const expectedPackIds = getDefaultSubconPackIdsForVertical('brewery');
    
    assert(
      Array.isArray(packIds),
      'Should return an array'
    );
    assert(
      packIds.length === expectedPackIds.length,
      'Should return same number of packs as brewery mapping'
    );
    assert(
      packIds.includes('stale_leads'),
      'Should include stale_leads pack for brewery'
    );
  });

  // ============================================
  // Scheduler uses vertical mapping tests
  // ============================================

  await describe('triggerSchedule() runs pack from brewery vertical', async () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    // Temporarily enable scheduler env for this test
    process.env.SUBCON_SCHEDULER_ENABLED = 'true';
    
    // Initialize the engine (registers packs)
    initializeSubconEngine();
    
    // Trigger the stale_leads_hourly schedule
    await triggerSchedule('stale_leads_hourly');
    
    const state = _getScheduleState('stale_leads_hourly');
    assert(
      state !== undefined,
      'Schedule state should exist after trigger'
    );
    assert(
      state?.lastRunAt !== null,
      'lastRunAt should be set after trigger'
    );
    assert(
      state?.lastRunSuccess === true,
      'lastRunSuccess should be true (pack is in brewery vertical defaults)'
    );
    
    // Reset env
    process.env.SUBCON_SCHEDULER_ENABLED = 'false';
  });

  // ============================================
  // Consistency tests
  // ============================================

  describe('Vertical mapping is consistent between scheduler and mapping module', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    const schedulerVerticalId = getCurrentVerticalId();
    const schedulerPackIds = getCurrentVerticalPackIds();
    const mappingPackIds = getDefaultSubconPackIdsForVertical(schedulerVerticalId);
    
    assert(
      schedulerPackIds.length === mappingPackIds.length,
      'Scheduler and mapping should return same number of packs'
    );
    
    // Check all scheduler pack IDs are in mapping pack IDs
    const allMatch = schedulerPackIds.every(id => mappingPackIds.includes(id));
    assert(
      allMatch,
      'All scheduler pack IDs should be in mapping module'
    );
    
    // Check mapping pack IDs are in scheduler pack IDs
    const reverseMatch = mappingPackIds.every(id => schedulerPackIds.includes(id as any));
    assert(
      reverseMatch,
      'All mapping pack IDs should be in scheduler result'
    );
  });

  // ============================================
  // Backwards compatibility tests
  // ============================================

  describe('Backwards compatibility: stale_leads runs for brewery', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    const packIds = getCurrentVerticalPackIds();
    
    assert(
      packIds.includes('stale_leads'),
      'stale_leads pack should run for brewery (backwards compatible)'
    );
  });

  await describe('Backwards compatibility: scheduler status reports schedules', async () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    const status = getSubconSchedulerStatus();
    
    assert(
      status.running === false,
      'Scheduler should not be running (disabled)'
    );
    assert(
      Array.isArray(status.schedules),
      'Status should have schedules array'
    );
    
    // The stale_leads_hourly schedule should be in the list
    const staleLeadsSchedule = status.schedules.find(
      s => s.scheduleId === 'stale_leads_hourly'
    );
    assert(
      staleLeadsSchedule !== undefined,
      'stale_leads_hourly should be in schedule list'
    );
  });

  // ============================================
  // Account context simulation tests
  // ============================================

  describe('Account with brewery vertical gets stale_leads pack', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    // Simulate an account with brewery vertical
    const account = {
      id: 'acc_test_123',
      verticalId: 'brewery' as VerticalId
    };
    
    // Get packs for this vertical
    const packIds = getDefaultSubconPackIdsForVertical(account.verticalId);
    
    assert(
      packIds.length > 0,
      'Account with brewery vertical should have packs'
    );
    assert(
      packIds.includes('stale_leads'),
      'Account with brewery vertical should get stale_leads'
    );
  });

  describe('Account with no vertical falls back to brewery', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    // Simulate an account with no vertical set (fallback scenario)
    const account = {
      id: 'acc_test_456',
      verticalId: undefined as VerticalId | undefined
    };
    
    // Default to brewery when verticalId is missing
    const verticalId = account.verticalId ?? 'brewery';
    const packIds = getDefaultSubconPackIdsForVertical(verticalId as VerticalId);
    
    assert(
      packIds.length > 0,
      'Account without vertical should fallback to brewery packs'
    );
    assert(
      packIds.includes('stale_leads'),
      'Fallback should include stale_leads'
    );
  });

  // ============================================
  // SUP-17: Account helpers integration tests
  // ============================================

  describe('SUP-17: getAccountVerticalId() returns brewery by default', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    // Test with undefined
    const verticalUndefined = getAccountVerticalId(undefined);
    assert(
      verticalUndefined === 'brewery',
      'getAccountVerticalId(undefined) should return brewery'
    );
    
    // Test with null
    const verticalNull = getAccountVerticalId(null);
    assert(
      verticalNull === 'brewery',
      'getAccountVerticalId(null) should return brewery'
    );
    
    // Test with brewery
    const verticalBrewery = getAccountVerticalId('brewery');
    assert(
      verticalBrewery === 'brewery',
      'getAccountVerticalId("brewery") should return brewery'
    );
  });

  describe('SUP-17: createAccountContext() sets brewery by default', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    // Create context without specifying verticalId
    const ctx = createAccountContext('acc_sup17_test');
    
    assert(
      ctx.accountId === 'acc_sup17_test',
      'Context should have correct accountId'
    );
    assert(
      ctx.verticalId === 'brewery',
      'Context should default to brewery verticalId'
    );
    
    // Verify packs are correct for this context
    const packIds = getDefaultSubconPackIdsForVertical(ctx.verticalId);
    assert(
      packIds.includes('stale_leads'),
      'Context vertical should include stale_leads pack'
    );
  });

  describe('SUP-17: DEFAULT_VERTICAL_ID constant is brewery', () => {
    assert(
      DEFAULT_VERTICAL_ID === 'brewery',
      'DEFAULT_VERTICAL_ID should be brewery'
    );
    
    // Verify it matches scheduler default
    const schedulerDefault = getCurrentVerticalId();
    assert(
      schedulerDefault === DEFAULT_VERTICAL_ID,
      'Scheduler default should match DEFAULT_VERTICAL_ID'
    );
  });

  // ============================================
  // Cleanup
  // ============================================
  
  // Restore original env
  if (originalEnv !== undefined) {
    process.env.SUBCON_SCHEDULER_ENABLED = originalEnv;
  } else {
    delete process.env.SUBCON_SCHEDULER_ENABLED;
  }
  
  _resetScheduler();
  _clearRegistry();
  _resetEngineInitialized();

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
