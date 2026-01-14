/**
 * Subconscious Scheduler Tests
 * 
 * Unit tests for the subconscious scheduler.
 * Run with: npx tsx server/subcon/scheduler.test.ts
 * 
 * SUP-11: Simple scheduler (hourly/daily stub)
 */

import {
  isScheduleDue,
  startSubconScheduler,
  stopSubconScheduler,
  getSubconSchedulerStatus,
  triggerSchedule,
  _setTimeProvider,
  _resetTimeProvider,
  _clearScheduleStates,
  _setScheduleLastRun,
  _getScheduleState,
  _resetScheduler
} from './scheduler';
import { FREQUENCY_INTERVALS } from './scheduler-types';
import type { SubconSchedule } from './scheduler-types';
import { _clearRegistry } from './registry';
import { _resetEngineInitialized } from './index';

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// TEST DATA
// ============================================

const hourlySchedule: SubconSchedule = {
  id: 'stale_leads_hourly',
  packId: 'stale_leads',
  frequency: 'hourly',
  enabled: true,
};

const dailySchedule: SubconSchedule = {
  id: 'stale_leads_hourly', // Reusing ID for test
  packId: 'stale_leads',
  frequency: 'daily',
  enabled: true,
};

const disabledSchedule: SubconSchedule = {
  id: 'stale_leads_hourly',
  packId: 'stale_leads',
  frequency: 'hourly',
  enabled: false,
};

const testIntervalSchedule: SubconSchedule = {
  id: 'stale_leads_hourly',
  packId: 'stale_leads',
  frequency: 'test_interval',
  enabled: true,
};

// ============================================
// TESTS
// ============================================

async function runTests() {
  console.log('='.repeat(60));
  console.log('Subconscious Scheduler Tests (SUP-11)');
  console.log('='.repeat(60));

  // Disable scheduler during tests
  const originalEnv = process.env.SUBCON_SCHEDULER_ENABLED;
  process.env.SUBCON_SCHEDULER_ENABLED = 'false';

  // ============================================
  // isScheduleDue() tests
  // ============================================

  describe('isScheduleDue() - never run before', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    const now = Date.now();
    
    // Should run if never run before
    const isDue = isScheduleDue(hourlySchedule, now);
    assert(isDue === true, 'Schedule that never ran should be due');
  });

  describe('isScheduleDue() - ran less than interval ago', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    const now = Date.now();
    const thirtyMinutesAgo = now - (30 * 60 * 1000);
    
    // Set last run to 30 minutes ago
    _setScheduleLastRun('stale_leads_hourly', thirtyMinutesAgo);
    
    const isDue = isScheduleDue(hourlySchedule, now);
    assert(isDue === false, 'Hourly schedule that ran 30 min ago should NOT be due');
  });

  describe('isScheduleDue() - ran more than interval ago (hourly)', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    const now = Date.now();
    const twoHoursAgo = now - (2 * 60 * 60 * 1000);
    
    _setScheduleLastRun('stale_leads_hourly', twoHoursAgo);
    
    const isDue = isScheduleDue(hourlySchedule, now);
    assert(isDue === true, 'Hourly schedule that ran 2 hours ago should be due');
  });

  describe('isScheduleDue() - ran exactly at interval boundary', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    const now = Date.now();
    const exactlyOneHourAgo = now - FREQUENCY_INTERVALS.hourly;
    
    _setScheduleLastRun('stale_leads_hourly', exactlyOneHourAgo);
    
    const isDue = isScheduleDue(hourlySchedule, now);
    assert(isDue === true, 'Hourly schedule that ran exactly 1 hour ago should be due');
  });

  describe('isScheduleDue() - daily frequency', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    const now = Date.now();
    const twelveHoursAgo = now - (12 * 60 * 60 * 1000);
    const twentyFiveHoursAgo = now - (25 * 60 * 60 * 1000);
    
    // 12 hours ago - not due
    _setScheduleLastRun('stale_leads_hourly', twelveHoursAgo);
    const isDue1 = isScheduleDue(dailySchedule, now);
    assert(isDue1 === false, 'Daily schedule that ran 12 hours ago should NOT be due');
    
    // 25 hours ago - due
    _setScheduleLastRun('stale_leads_hourly', twentyFiveHoursAgo);
    const isDue2 = isScheduleDue(dailySchedule, now);
    assert(isDue2 === true, 'Daily schedule that ran 25 hours ago should be due');
  });

  describe('isScheduleDue() - disabled schedule', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    const now = Date.now();
    
    // Even if never run, disabled schedule should not be due
    const isDue = isScheduleDue(disabledSchedule, now);
    assert(isDue === false, 'Disabled schedule should never be due');
  });

  describe('isScheduleDue() - test_interval frequency', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    const now = Date.now();
    const threeSecondsAgo = now - 3000;
    const tenSecondsAgo = now - 10000;
    
    // 3 seconds ago (5 second interval) - not due
    _setScheduleLastRun('stale_leads_hourly', threeSecondsAgo);
    const isDue1 = isScheduleDue(testIntervalSchedule, now);
    assert(isDue1 === false, 'Test interval schedule that ran 3s ago should NOT be due');
    
    // 10 seconds ago - due
    _setScheduleLastRun('stale_leads_hourly', tenSecondsAgo);
    const isDue2 = isScheduleDue(testIntervalSchedule, now);
    assert(isDue2 === true, 'Test interval schedule that ran 10s ago should be due');
  });

  // ============================================
  // Scheduler lifecycle tests
  // ============================================

  describe('getSubconSchedulerStatus() when not started', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    const status = getSubconSchedulerStatus();
    
    assert(status.running === false, 'Scheduler should not be running');
    assert(status.startedAt === null, 'startedAt should be null');
    assert(status.tickCount === 0, 'tickCount should be 0');
  });

  describe('Scheduler disabled via env var', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    process.env.SUBCON_SCHEDULER_ENABLED = 'false';
    
    startSubconScheduler();
    
    const status = getSubconSchedulerStatus();
    assert(status.running === false, 'Scheduler should not start when disabled');
    
    stopSubconScheduler();
  });

  await describe('triggerSchedule() executes pack', async () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    // Temporarily enable scheduler env for this test
    process.env.SUBCON_SCHEDULER_ENABLED = 'true';
    
    // Initialize manually since scheduler is disabled
    const { initializeSubconEngine } = await import('./index');
    initializeSubconEngine();
    
    await triggerSchedule('stale_leads_hourly');
    
    const state = _getScheduleState('stale_leads_hourly');
    assert(state !== undefined, 'Schedule state should exist after trigger');
    assert(state?.lastRunAt !== null, 'lastRunAt should be set after trigger');
    assert(state?.lastRunSuccess === true, 'lastRunSuccess should be true');
    
    // Reset env
    process.env.SUBCON_SCHEDULER_ENABLED = 'false';
  });

  await describe('triggerSchedule() with unknown schedule throws', async () => {
    _resetScheduler();
    
    let errorThrown = false;
    let errorMessage = '';
    
    try {
      await triggerSchedule('nonexistent_schedule' as any);
    } catch (error) {
      errorThrown = true;
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    
    assert(errorThrown === true, 'Should throw error for unknown schedule');
    assert(
      errorMessage.includes('not found'),
      'Error message should mention schedule not found'
    );
  });

  // ============================================
  // Time provider tests
  // ============================================

  describe('Custom time provider', () => {
    _resetScheduler();
    _clearRegistry();
    _resetEngineInitialized();
    
    const fixedTime = 1700000000000; // Fixed timestamp
    _setTimeProvider(() => fixedTime);
    
    // This should use the fixed time internally
    const now = Date.now(); // This still uses real time
    
    // But isScheduleDue should use our provider... 
    // Actually isScheduleDue takes 'now' as parameter, so test with that
    
    _setScheduleLastRun('stale_leads_hourly', fixedTime - (30 * 60 * 1000));
    const isDue = isScheduleDue(hourlySchedule, fixedTime);
    assert(isDue === false, 'Should correctly evaluate with provided time');
    
    _resetTimeProvider();
  });

  // ============================================
  // Frequency intervals validation
  // ============================================

  describe('FREQUENCY_INTERVALS values', () => {
    assert(
      FREQUENCY_INTERVALS.hourly === 60 * 60 * 1000,
      'Hourly should be 60 minutes in ms'
    );
    assert(
      FREQUENCY_INTERVALS.daily === 24 * 60 * 60 * 1000,
      'Daily should be 24 hours in ms'
    );
    assert(
      FREQUENCY_INTERVALS.test_interval === 5 * 1000,
      'Test interval should be 5 seconds in ms'
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

