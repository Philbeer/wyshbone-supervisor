/**
 * Subconscious Nudges Storage Tests
 * 
 * SUP-13: Full test coverage for nudge storage and integration
 * 
 * Run with: npx tsx server/subcon/packs/subconNudges.test.ts
 * 
 * Tests cover:
 * - Table insert and fetch
 * - Storing multiple nudges
 * - Resolving and dismissing
 * - Filtering unresolved
 * - Integration with staleLeadsPack using mock storage
 */

import type { SuggestedLead } from '@shared/schema';
import type { SubconNudge, DBSubconNudge } from '../types';
import {
  staleLeadsPack,
  _setStorage,
  type StaleLeadsStorage,
} from './staleleads';
import type { SubconContext } from '../types';

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

function assertEqual<T>(actual: T, expected: T, message: string) {
  const condition = actual === expected;
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message} (expected: ${expected}, got: ${actual})`);
    failed++;
  }
}

function assertDeepEqual<T>(actual: T, expected: T, message: string) {
  const condition = JSON.stringify(actual) === JSON.stringify(expected);
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    console.log(`     Expected: ${JSON.stringify(expected)}`);
    console.log(`     Actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function describe(name: string, fn: () => void | Promise<void>) {
  console.log(`\n${name}`);
  return fn();
}

// ============================================
// MOCK STORAGE IMPLEMENTATION
// ============================================

interface MockNudge {
  id: string;
  accountId: string;
  userId: string | null;
  nudgeType: string;
  title: string;
  message: string;
  importance: number;
  leadId: string | null;
  context: Record<string, unknown> | null;
  createdAt: Date;
  resolvedAt: Date | null;
  dismissedAt: Date | null;
}

class MockNudgeStorage {
  private nudges: MockNudge[] = [];
  private idCounter = 0;

  /**
   * Convert priority to importance score
   */
  private priorityToImportance(priority: 'low' | 'medium' | 'high'): number {
    switch (priority) {
      case 'high': return 90;
      case 'medium': return 60;
      case 'low': return 30;
      default: return 50;
    }
  }

  /**
   * Generate a title from nudge type
   */
  private nudgeTypeToTitle(type: string): string {
    switch (type) {
      case 'stale_lead': return 'Stale Lead Alert';
      case 'follow_up': return 'Follow-up Reminder';
      default: return type.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
  }

  async saveSubconNudges(accountId: string, nudges: SubconNudge[]): Promise<void> {
    for (const nudge of nudges) {
      this.idCounter++;
      this.nudges.push({
        id: `nudge_${this.idCounter}`,
        accountId,
        userId: null,
        nudgeType: nudge.type,
        title: this.nudgeTypeToTitle(nudge.type),
        message: nudge.message,
        importance: this.priorityToImportance(nudge.priority),
        leadId: nudge.entityId || null,
        context: nudge.metadata ? (nudge.metadata as Record<string, unknown>) : null,
        createdAt: new Date(),
        resolvedAt: null,
        dismissedAt: null,
      });
    }
  }

  async getSubconNudgesByAccount(accountId: string): Promise<MockNudge[]> {
    return this.nudges
      .filter(n => n.accountId === accountId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async resolveSubconNudge(id: string): Promise<void> {
    const nudge = this.nudges.find(n => n.id === id);
    if (nudge) {
      nudge.resolvedAt = new Date();
    }
  }

  async dismissSubconNudge(id: string): Promise<void> {
    const nudge = this.nudges.find(n => n.id === id);
    if (nudge) {
      nudge.dismissedAt = new Date();
    }
  }

  async getUnresolvedSubconNudges(accountId: string): Promise<MockNudge[]> {
    return this.nudges
      .filter(n => 
        n.accountId === accountId && 
        n.resolvedAt === null && 
        n.dismissedAt === null
      )
      .sort((a, b) => b.importance - a.importance || b.createdAt.getTime() - a.createdAt.getTime());
  }

  // Helper method for tests
  getAllNudges(): MockNudge[] {
    return [...this.nudges];
  }

  // Reset for clean test runs
  reset(): void {
    this.nudges = [];
    this.idCounter = 0;
  }
}

// ============================================
// TEST DATA FACTORIES
// ============================================

const NOW = new Date('2024-06-15T12:00:00.000Z');

function daysAgo(days: number): Date {
  const date = new Date(NOW);
  date.setDate(date.getDate() - days);
  return date;
}

function createLead(overrides: Partial<SuggestedLead> = {}): SuggestedLead {
  return {
    id: `lead_${Math.random().toString(36).substring(2, 9)}`,
    userId: 'test_user',
    accountId: 'test_account',
    rationale: 'Test lead',
    source: 'test',
    score: 85,
    lead: { businessName: 'Test Business', address: '123 Test St' },
    createdAt: daysAgo(1),
    lastContactedAt: null,
    pipelineStage: null,
    pipelineStageChangedAt: null,
    updatedAt: daysAgo(1),
    ...overrides,
  };
}

function createFreshLead(businessName: string = 'Fresh Business'): SuggestedLead {
  return createLead({
    lead: { businessName },
    createdAt: daysAgo(2),
    lastContactedAt: daysAgo(1),
    updatedAt: daysAgo(1),
    pipelineStage: 'contacted',
    pipelineStageChangedAt: daysAgo(1),
  });
}

function createStaleLead(businessName: string = 'Stale Business', daysOld: number = 10): SuggestedLead {
  return createLead({
    lead: { businessName },
    createdAt: daysAgo(daysOld),
    lastContactedAt: null,
    updatedAt: daysAgo(daysOld),
  });
}

function createVeryStaleLead(businessName: string = 'Very Stale Business'): SuggestedLead {
  return createLead({
    lead: { businessName },
    createdAt: daysAgo(45),
    lastContactedAt: null,
    updatedAt: daysAgo(45),
    pipelineStage: 'new',
    pipelineStageChangedAt: daysAgo(45),
  });
}

// ============================================
// TESTS
// ============================================

async function runTests() {
  console.log('='.repeat(60));
  console.log('Subconscious Nudges Storage Tests (SUP-13)');
  console.log('='.repeat(60));

  const mockStorage = new MockNudgeStorage();

  // ========================================
  // Mock storage unit tests
  // ========================================
  
  await describe('Mock Storage: saveSubconNudges inserts nudges', async () => {
    mockStorage.reset();
    
    const nudges: SubconNudge[] = [
      {
        type: 'stale_lead',
        message: 'Test lead is stale',
        priority: 'high',
        entityId: 'lead_123',
        metadata: { score: 85 },
      },
    ];

    await mockStorage.saveSubconNudges('account_1', nudges);
    
    const all = mockStorage.getAllNudges();
    assertEqual(all.length, 1, 'Should have 1 nudge');
    assertEqual(all[0].accountId, 'account_1', 'Account ID should match');
    assertEqual(all[0].nudgeType, 'stale_lead', 'Nudge type should be stale_lead');
    assertEqual(all[0].message, 'Test lead is stale', 'Message should match');
    assertEqual(all[0].importance, 90, 'High priority should map to 90');
    assertEqual(all[0].leadId, 'lead_123', 'Lead ID should match');
    assert(all[0].resolvedAt === null, 'Should not be resolved');
    assert(all[0].dismissedAt === null, 'Should not be dismissed');
  });

  await describe('Mock Storage: stores multiple nudges', async () => {
    mockStorage.reset();
    
    const nudges: SubconNudge[] = [
      { type: 'stale_lead', message: 'Nudge 1', priority: 'high', entityId: 'lead_1' },
      { type: 'stale_lead', message: 'Nudge 2', priority: 'medium', entityId: 'lead_2' },
      { type: 'stale_lead', message: 'Nudge 3', priority: 'low', entityId: 'lead_3' },
    ];

    await mockStorage.saveSubconNudges('account_1', nudges);
    
    const all = mockStorage.getAllNudges();
    assertEqual(all.length, 3, 'Should have 3 nudges');
    assertEqual(all[0].importance, 90, 'First nudge should have high importance');
    assertEqual(all[1].importance, 60, 'Second nudge should have medium importance');
    assertEqual(all[2].importance, 30, 'Third nudge should have low importance');
  });

  await describe('Mock Storage: getSubconNudgesByAccount filters by account', async () => {
    mockStorage.reset();
    
    await mockStorage.saveSubconNudges('account_1', [
      { type: 'stale_lead', message: 'Account 1 Nudge 1', priority: 'high' },
      { type: 'stale_lead', message: 'Account 1 Nudge 2', priority: 'medium' },
    ]);
    
    await mockStorage.saveSubconNudges('account_2', [
      { type: 'stale_lead', message: 'Account 2 Nudge', priority: 'low' },
    ]);

    const account1Nudges = await mockStorage.getSubconNudgesByAccount('account_1');
    const account2Nudges = await mockStorage.getSubconNudgesByAccount('account_2');
    const account3Nudges = await mockStorage.getSubconNudgesByAccount('account_3');

    assertEqual(account1Nudges.length, 2, 'Account 1 should have 2 nudges');
    assertEqual(account2Nudges.length, 1, 'Account 2 should have 1 nudge');
    assertEqual(account3Nudges.length, 0, 'Account 3 should have 0 nudges');
  });

  await describe('Mock Storage: resolveSubconNudge sets resolvedAt', async () => {
    mockStorage.reset();
    
    await mockStorage.saveSubconNudges('account_1', [
      { type: 'stale_lead', message: 'To be resolved', priority: 'high' },
    ]);

    const before = mockStorage.getAllNudges()[0];
    assert(before.resolvedAt === null, 'Should not be resolved before');

    await mockStorage.resolveSubconNudge(before.id);

    const after = mockStorage.getAllNudges()[0];
    assert(after.resolvedAt !== null, 'Should be resolved after');
    assert(after.resolvedAt instanceof Date, 'resolvedAt should be a Date');
  });

  await describe('Mock Storage: dismissSubconNudge sets dismissedAt', async () => {
    mockStorage.reset();
    
    await mockStorage.saveSubconNudges('account_1', [
      { type: 'stale_lead', message: 'To be dismissed', priority: 'high' },
    ]);

    const before = mockStorage.getAllNudges()[0];
    assert(before.dismissedAt === null, 'Should not be dismissed before');

    await mockStorage.dismissSubconNudge(before.id);

    const after = mockStorage.getAllNudges()[0];
    assert(after.dismissedAt !== null, 'Should be dismissed after');
    assert(after.dismissedAt instanceof Date, 'dismissedAt should be a Date');
  });

  await describe('Mock Storage: getUnresolvedSubconNudges filters correctly', async () => {
    mockStorage.reset();
    
    await mockStorage.saveSubconNudges('account_1', [
      { type: 'stale_lead', message: 'Unresolved 1', priority: 'high' },
      { type: 'stale_lead', message: 'Unresolved 2', priority: 'medium' },
      { type: 'stale_lead', message: 'To Resolve', priority: 'low' },
      { type: 'stale_lead', message: 'To Dismiss', priority: 'low' },
    ]);

    const allNudges = mockStorage.getAllNudges();
    await mockStorage.resolveSubconNudge(allNudges[2].id);
    await mockStorage.dismissSubconNudge(allNudges[3].id);

    const unresolved = await mockStorage.getUnresolvedSubconNudges('account_1');
    
    assertEqual(unresolved.length, 2, 'Should have 2 unresolved nudges');
    assert(unresolved.every(n => n.resolvedAt === null), 'All should have null resolvedAt');
    assert(unresolved.every(n => n.dismissedAt === null), 'All should have null dismissedAt');
  });

  await describe('Mock Storage: getUnresolvedSubconNudges sorts by importance', async () => {
    mockStorage.reset();
    
    await mockStorage.saveSubconNudges('account_1', [
      { type: 'stale_lead', message: 'Low', priority: 'low' },
      { type: 'stale_lead', message: 'High', priority: 'high' },
      { type: 'stale_lead', message: 'Medium', priority: 'medium' },
    ]);

    const unresolved = await mockStorage.getUnresolvedSubconNudges('account_1');
    
    assertEqual(unresolved[0].importance, 90, 'First should be high importance');
    assertEqual(unresolved[1].importance, 60, 'Second should be medium importance');
    assertEqual(unresolved[2].importance, 30, 'Third should be low importance');
  });

  // ========================================
  // Integration tests with staleLeadsPack
  // ========================================

  await describe('Integration: staleLeadsPack calls saveSubconNudges', async () => {
    mockStorage.reset();
    
    const mockLeadsStorage: StaleLeadsStorage = {
      async getSuggestedLeadsByAccount(accountId: string) {
        return [
          createStaleLead('Stale Lead 1'),
          createStaleLead('Stale Lead 2'),
          createVeryStaleLead(),
        ];
      },
      async saveSubconNudges(accountId: string, nudges: SubconNudge[]) {
        await mockStorage.saveSubconNudges(accountId, nudges);
      },
    };
    
    _setStorage(mockLeadsStorage);
    
    try {
      const context: SubconContext = {
        userId: 'test_user',
        accountId: 'test_account',
        timestamp: NOW.toISOString(),
      };
      
      await staleLeadsPack.run(context);
      
      const savedNudges = mockStorage.getAllNudges();
      assertEqual(savedNudges.length, 3, 'Should have saved 3 nudges');
      assert(savedNudges.every(n => n.accountId === 'test_account'), 'All nudges should have correct accountId');
      assert(savedNudges.every(n => n.nudgeType === 'stale_lead'), 'All nudges should be stale_lead type');
    } finally {
      _setStorage(null);
    }
  });

  await describe('Integration: staleLeadsPack with fresh leads saves no nudges', async () => {
    mockStorage.reset();
    
    const mockLeadsStorage: StaleLeadsStorage = {
      async getSuggestedLeadsByAccount() {
        return [
          createFreshLead('Fresh 1'),
          createFreshLead('Fresh 2'),
        ];
      },
      async saveSubconNudges(accountId: string, nudges: SubconNudge[]) {
        await mockStorage.saveSubconNudges(accountId, nudges);
      },
    };
    
    _setStorage(mockLeadsStorage);
    
    try {
      const context: SubconContext = {
        userId: 'test_user',
        accountId: 'test_account',
        timestamp: NOW.toISOString(),
      };
      
      const output = await staleLeadsPack.run(context);
      
      assertEqual(output.nudges.length, 0, 'Pack should return 0 nudges');
      
      const savedNudges = mockStorage.getAllNudges();
      assertEqual(savedNudges.length, 0, 'Should have saved 0 nudges');
    } finally {
      _setStorage(null);
    }
  });

  await describe('Integration: staleLeadsPack with no leads saves no nudges', async () => {
    mockStorage.reset();
    
    const mockLeadsStorage: StaleLeadsStorage = {
      async getSuggestedLeadsByAccount() {
        return [];
      },
      async saveSubconNudges(accountId: string, nudges: SubconNudge[]) {
        await mockStorage.saveSubconNudges(accountId, nudges);
      },
    };
    
    _setStorage(mockLeadsStorage);
    
    try {
      const context: SubconContext = {
        userId: 'test_user',
        accountId: 'empty_account',
        timestamp: NOW.toISOString(),
      };
      
      await staleLeadsPack.run(context);
      
      const savedNudges = mockStorage.getAllNudges();
      assertEqual(savedNudges.length, 0, 'Should have saved 0 nudges for empty account');
    } finally {
      _setStorage(null);
    }
  });

  await describe('Integration: pack returns nudges even if storage fails', async () => {
    const mockLeadsStorage: StaleLeadsStorage = {
      async getSuggestedLeadsByAccount() {
        return [createStaleLead('Stale Lead')];
      },
      async saveSubconNudges() {
        throw new Error('Storage error');
      },
    };
    
    _setStorage(mockLeadsStorage);
    
    try {
      const context: SubconContext = {
        userId: 'test_user',
        accountId: 'test_account',
        timestamp: NOW.toISOString(),
      };
      
      const output = await staleLeadsPack.run(context);
      
      // Pack should still return nudges even if storage fails
      assertEqual(output.nudges.length, 1, 'Should still return nudges despite storage error');
    } finally {
      _setStorage(null);
    }
  });

  await describe('Integration: nudge metadata contains correct fields', async () => {
    mockStorage.reset();
    
    const mockLeadsStorage: StaleLeadsStorage = {
      async getSuggestedLeadsByAccount() {
        return [createVeryStaleLead('Very Stale Business')];
      },
      async saveSubconNudges(accountId: string, nudges: SubconNudge[]) {
        await mockStorage.saveSubconNudges(accountId, nudges);
      },
    };
    
    _setStorage(mockLeadsStorage);
    
    try {
      const context: SubconContext = {
        userId: 'test_user',
        accountId: 'test_account',
        timestamp: NOW.toISOString(),
      };
      
      await staleLeadsPack.run(context);
      
      const savedNudges = mockStorage.getAllNudges();
      assertEqual(savedNudges.length, 1, 'Should have 1 nudge');
      
      const nudge = savedNudges[0];
      assert(nudge.context !== null, 'Context should not be null');
      assert((nudge.context as any).businessName === 'Very Stale Business', 'Context should contain businessName');
      assert(typeof (nudge.context as any).score === 'number', 'Context should contain score');
      assert(Array.isArray((nudge.context as any).staleReasons), 'Context should contain staleReasons');
    } finally {
      _setStorage(null);
    }
  });

  // ========================================
  // Title generation tests
  // ========================================

  await describe('Mock Storage: generates correct titles', async () => {
    mockStorage.reset();
    
    await mockStorage.saveSubconNudges('account_1', [
      { type: 'stale_lead', message: 'Test', priority: 'high' },
      { type: 'follow_up', message: 'Test', priority: 'high' },
      { type: 'custom_type', message: 'Test', priority: 'high' },
    ]);

    const nudges = mockStorage.getAllNudges();
    assertEqual(nudges[0].title, 'Stale Lead Alert', 'stale_lead should generate correct title');
    assertEqual(nudges[1].title, 'Follow-up Reminder', 'follow_up should generate correct title');
    assertEqual(nudges[2].title, 'Custom Type', 'custom_type should generate capitalized title');
  });

  // ========================================
  // Edge cases
  // ========================================

  await describe('Edge case: empty nudge array', async () => {
    mockStorage.reset();
    
    await mockStorage.saveSubconNudges('account_1', []);
    
    const nudges = mockStorage.getAllNudges();
    assertEqual(nudges.length, 0, 'Empty array should result in no nudges');
  });

  await describe('Edge case: nudge without entityId', async () => {
    mockStorage.reset();
    
    await mockStorage.saveSubconNudges('account_1', [
      { type: 'stale_lead', message: 'No entity', priority: 'high' },
    ]);

    const nudges = mockStorage.getAllNudges();
    assertEqual(nudges.length, 1, 'Should save nudge');
    assertEqual(nudges[0].leadId, null, 'leadId should be null');
  });

  await describe('Edge case: nudge without metadata', async () => {
    mockStorage.reset();
    
    await mockStorage.saveSubconNudges('account_1', [
      { type: 'stale_lead', message: 'No metadata', priority: 'high' },
    ]);

    const nudges = mockStorage.getAllNudges();
    assertEqual(nudges.length, 1, 'Should save nudge');
    assertEqual(nudges[0].context, null, 'context should be null');
  });

  await describe('Edge case: resolving non-existent nudge', async () => {
    mockStorage.reset();
    
    // Should not throw
    await mockStorage.resolveSubconNudge('non_existent_id');
    
    assert(true, 'Resolving non-existent nudge should not throw');
  });

  await describe('Edge case: dismissing non-existent nudge', async () => {
    mockStorage.reset();
    
    // Should not throw
    await mockStorage.dismissSubconNudge('non_existent_id');
    
    assert(true, 'Dismissing non-existent nudge should not throw');
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

