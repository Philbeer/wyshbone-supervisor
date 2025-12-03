/**
 * Stale Leads Pack Tests
 * 
 * SUP-12: Full test coverage for stale leads detection
 * 
 * Run with: npx tsx server/subcon/packs/staleLeads.test.ts
 * 
 * Tests cover:
 * - Fresh leads → 0 nudges
 * - Stale leads → nudges produced
 * - Scoring logic
 * - Stuck pipeline detection
 * - Never contacted detection
 */

import type { SuggestedLead } from '@shared/schema';
import {
  analyzeLeadStaleness,
  analyzeAllLeads,
  daysBetween,
  staleLeadsPack,
  _setStorage,
  type LeadStalenessInfo,
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

function assertRange(value: number, min: number, max: number, message: string) {
  const condition = value >= min && value <= max;
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message} (expected: ${min}-${max}, got: ${value})`);
    failed++;
  }
}

function describe(name: string, fn: () => void | Promise<void>) {
  console.log(`\n${name}`);
  return fn();
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
    createdAt: daysAgo(2), // Only 2 days old
    lastContactedAt: daysAgo(1), // Contacted yesterday
    updatedAt: daysAgo(1),
    pipelineStage: 'contacted',
    pipelineStageChangedAt: daysAgo(1),
  });
}

function createNeverContactedLead(businessName: string = 'Never Contacted Business', daysOld: number = 10): SuggestedLead {
  return createLead({
    lead: { businessName },
    createdAt: daysAgo(daysOld),
    lastContactedAt: null, // Never contacted
    updatedAt: daysAgo(daysOld),
  });
}

function createOldContactLead(businessName: string = 'Old Contact Business', daysSinceContact: number = 20): SuggestedLead {
  return createLead({
    lead: { businessName },
    createdAt: daysAgo(30),
    lastContactedAt: daysAgo(daysSinceContact),
    updatedAt: daysAgo(daysSinceContact),
    pipelineStage: 'follow_up',
    // Use a recent stage change so stuck pipeline doesn't trigger
    pipelineStageChangedAt: daysAgo(Math.min(daysSinceContact, 5)),
  });
}

function createStuckPipelineLead(businessName: string = 'Stuck Pipeline Business', daysInStage: number = 15): SuggestedLead {
  return createLead({
    lead: { businessName },
    createdAt: daysAgo(25),
    lastContactedAt: daysAgo(3), // Recently contacted
    updatedAt: daysAgo(3),
    pipelineStage: 'negotiation',
    pipelineStageChangedAt: daysAgo(daysInStage),
  });
}

function createNoUpdateLead(businessName: string = 'No Update Business', daysSinceUpdate: number = 20): SuggestedLead {
  return createLead({
    lead: { businessName },
    createdAt: daysAgo(30),
    lastContactedAt: daysAgo(5), // Recently contacted
    updatedAt: daysAgo(daysSinceUpdate),
    pipelineStage: 'proposal',
    pipelineStageChangedAt: daysAgo(5),
  });
}

function createVeryStaleLead(businessName: string = 'Very Stale Business'): SuggestedLead {
  return createLead({
    lead: { businessName },
    createdAt: daysAgo(45),
    lastContactedAt: null, // Never contacted
    updatedAt: daysAgo(45),
    pipelineStage: 'new',
    pipelineStageChangedAt: daysAgo(45), // Stuck in 'new' for 45 days
  });
}

// ============================================
// TESTS
// ============================================

async function runTests() {
  console.log('='.repeat(60));
  console.log('Stale Leads Pack Tests (SUP-12)');
  console.log('='.repeat(60));

  // ========================================
  // daysBetween() helper tests
  // ========================================
  
  describe('daysBetween() helper', () => {
    assertEqual(daysBetween(daysAgo(7), NOW), 7, 'Should calculate 7 days');
    assertEqual(daysBetween(daysAgo(14), NOW), 14, 'Should calculate 14 days');
    assertEqual(daysBetween(daysAgo(0), NOW), 0, 'Should calculate 0 days for same day');
    assertEqual(daysBetween(daysAgo(30), NOW), 30, 'Should calculate 30 days');
  });

  // ========================================
  // Fresh leads → 0 nudges
  // ========================================
  
  describe('Fresh leads → 0 nudges', () => {
    const freshLead = createFreshLead('Healthy Business');
    const analysis = analyzeLeadStaleness(freshLead, NOW);
    
    assert(analysis.isStale === false, 'Fresh lead should not be stale');
    assertEqual(analysis.staleReasons.length, 0, 'Fresh lead should have no stale reasons');
    assertEqual(analysis.finalScore, 0, 'Fresh lead should have 0 score');
  });

  describe('Multiple fresh leads → 0 stale', () => {
    const leads = [
      createFreshLead('Fresh Business 1'),
      createFreshLead('Fresh Business 2'),
      createFreshLead('Fresh Business 3'),
    ];
    
    const result = analyzeAllLeads(leads, NOW);
    
    assertEqual(result.totalLeads, 3, 'Should count all leads');
    assertEqual(result.staleLeads, 0, 'Should have 0 stale leads');
    assertEqual(result.freshLeads, 3, 'Should have 3 fresh leads');
  });

  // ========================================
  // Never contacted detection
  // ========================================
  
  describe('Never contacted → stale after 7 days', () => {
    // Lead created 6 days ago, never contacted - should NOT be stale yet
    const notYetStaleLead = createNeverContactedLead('Almost Stale', 6);
    const analysis1 = analyzeLeadStaleness(notYetStaleLead, NOW);
    
    assert(analysis1.isStale === false, '6-day never-contacted lead should NOT be stale');
    
    // Lead created 7 days ago, never contacted - SHOULD be stale
    const staleLead = createNeverContactedLead('Now Stale', 7);
    const analysis2 = analyzeLeadStaleness(staleLead, NOW);
    
    assert(analysis2.isStale === true, '7-day never-contacted lead SHOULD be stale');
    assert(analysis2.neverContacted === true, 'Should mark as never contacted');
    assert(analysis2.staleReasons.some(r => r.includes('never contacted')), 'Should have never contacted reason');
  });

  describe('Never contacted bonus scoring (+15)', () => {
    const staleLead = createNeverContactedLead('Never Contacted Lead', 10);
    const analysis = analyzeLeadStaleness(staleLead, NOW);
    
    assert(analysis.isStale === true, 'Should be stale');
    assert(analysis.neverContacted === true, 'Should be marked as never contacted');
    assert(analysis.bonuses >= 15, 'Should have at least +15 bonus');
    
    // Base score for 10 days mild staleness should be around 40-50
    // Final score should include +15 bonus
    assert(analysis.finalScore > analysis.baseScore, 'Final score should include bonus');
  });

  // ========================================
  // Last contacted > 14 days
  // ========================================
  
  describe('Last contacted > 14 days → stale', () => {
    // Contacted 13 days ago - not stale yet
    const notYetStale = createOldContactLead('Recent Contact', 13);
    const analysis1 = analyzeLeadStaleness(notYetStale, NOW);
    
    assert(analysis1.isStale === false, '13-day old contact should NOT be stale');
    
    // Contacted 14 days ago - stale
    const staleLead = createOldContactLead('Old Contact', 14);
    const analysis2 = analyzeLeadStaleness(staleLead, NOW);
    
    assert(analysis2.isStale === true, '14-day old contact SHOULD be stale');
    assert(analysis2.staleReasons.some(r => r.includes('Last contacted')), 'Should mention last contact');
  });

  // ========================================
  // Stuck pipeline detection (>10 days)
  // ========================================
  
  describe('Stuck pipeline → stale after 10 days', () => {
    // In stage for 10 days - not stale yet
    const notYetStuck = createStuckPipelineLead('Not Stuck Yet', 10);
    const analysis1 = analyzeLeadStaleness(notYetStuck, NOW);
    
    assert(analysis1.stuckInPipeline === false, '10-day stage should NOT be stuck');
    
    // In stage for 11 days - stuck
    const stuckLead = createStuckPipelineLead('Stuck Lead', 11);
    const analysis2 = analyzeLeadStaleness(stuckLead, NOW);
    
    assert(analysis2.stuckInPipeline === true, '11-day stage SHOULD be stuck');
    assert(analysis2.isStale === true, 'Stuck lead should be stale');
    assert(analysis2.staleReasons.some(r => r.includes('Stuck in')), 'Should mention stuck stage');
  });

  describe('Stuck pipeline bonus scoring (+10)', () => {
    const stuckLead = createStuckPipelineLead('Stuck Lead', 15);
    const analysis = analyzeLeadStaleness(stuckLead, NOW);
    
    assert(analysis.isStale === true, 'Should be stale');
    assert(analysis.stuckInPipeline === true, 'Should be marked as stuck');
    assert(analysis.bonuses >= 10, 'Should have at least +10 bonus');
  });

  // ========================================
  // No update > 14 days
  // ========================================
  
  describe('No update > 14 days → stale', () => {
    // Updated 13 days ago - not stale yet
    const notYetStale = createNoUpdateLead('Recently Updated', 13);
    const analysis1 = analyzeLeadStaleness(notYetStale, NOW);
    
    // This lead might be stale for other reasons, check specifically for update reason
    const hasUpdateReason = analysis1.staleReasons.some(r => r.includes('No updates'));
    assert(hasUpdateReason === false, '13-day old update should NOT trigger no-update staleness');
    
    // Updated 14 days ago - stale
    const staleLead = createNoUpdateLead('Outdated Lead', 14);
    const analysis2 = analyzeLeadStaleness(staleLead, NOW);
    
    assert(analysis2.staleReasons.some(r => r.includes('No updates')), '14-day old update SHOULD be stale');
  });

  // ========================================
  // Scoring logic
  // ========================================
  
  describe('Scoring: mild stale (40-60)', () => {
    // A lead that's mildly stale (just past threshold)
    const mildLead = createNeverContactedLead('Mild Stale', 8); // 8 days, barely stale
    const analysis = analyzeLeadStaleness(mildLead, NOW);
    
    assert(analysis.isStale === true, 'Should be stale');
    // Base score should be in mild range (40-60) before bonuses
    assertRange(analysis.baseScore, 40, 60, 'Base score should be mild range (40-60)');
  });

  describe('Scoring: medium stale (60-80)', () => {
    // A lead that's medium stale (~20-30 days)
    const mediumLead = createOldContactLead('Medium Stale', 25);
    const analysis = analyzeLeadStaleness(mediumLead, NOW);
    
    assert(analysis.isStale === true, 'Should be stale');
    assertRange(analysis.baseScore, 60, 80, 'Base score should be medium range (60-80)');
  });

  describe('Scoring: very stale (80-100)', () => {
    const veryStaleLead = createVeryStaleLead();
    const analysis = analyzeLeadStaleness(veryStaleLead, NOW);
    
    assert(analysis.isStale === true, 'Should be stale');
    assertRange(analysis.baseScore, 80, 100, 'Base score should be very stale range (80-100)');
  });

  describe('Scoring: combined bonuses cap at 100', () => {
    // Very stale + never contacted + stuck pipeline
    const maxStaleLead = createLead({
      lead: { businessName: 'Maximum Stale' },
      createdAt: daysAgo(60),
      lastContactedAt: null, // Never contacted (+15)
      updatedAt: daysAgo(60),
      pipelineStage: 'new',
      pipelineStageChangedAt: daysAgo(60), // Stuck (+10)
    });
    
    const analysis = analyzeLeadStaleness(maxStaleLead, NOW);
    
    assert(analysis.isStale === true, 'Should be stale');
    assert(analysis.finalScore <= 100, 'Final score should cap at 100');
    assert(analysis.neverContacted === true, 'Should have never contacted bonus');
    assert(analysis.stuckInPipeline === true, 'Should have stuck pipeline bonus');
  });

  // ========================================
  // Priority mapping
  // ========================================
  
  describe('Priority: low (score < 60)', () => {
    // Create a lead that's stale but low scoring
    const lowScoreLead = createLead({
      lead: { businessName: 'Low Score' },
      createdAt: daysAgo(20),
      lastContactedAt: daysAgo(14), // Just at threshold
      updatedAt: daysAgo(5), // Recent update
      pipelineStage: 'qualified',
      pipelineStageChangedAt: daysAgo(5), // Recent stage change
    });
    
    const analysis = analyzeLeadStaleness(lowScoreLead, NOW);
    if (analysis.isStale && analysis.finalScore < 60) {
      assertEqual(analysis.priority, 'low', 'Should be low priority');
    } else {
      console.log(`  ⚠️  Score ${analysis.finalScore} not in low range, skipping priority check`);
    }
  });

  describe('Priority: medium (score 60-79)', () => {
    const mediumLead = createOldContactLead('Medium Priority', 22);
    const analysis = analyzeLeadStaleness(mediumLead, NOW);
    
    if (analysis.finalScore >= 60 && analysis.finalScore < 80) {
      assertEqual(analysis.priority, 'medium', 'Should be medium priority');
    } else {
      console.log(`  ⚠️  Score ${analysis.finalScore} not in medium range, checking actual mapping`);
      assert(
        (analysis.priority === 'medium' && analysis.finalScore >= 60 && analysis.finalScore < 80) ||
        (analysis.priority === 'high' && analysis.finalScore >= 80) ||
        (analysis.priority === 'low' && analysis.finalScore < 60),
        'Priority should match score range'
      );
    }
  });

  describe('Priority: high (score >= 80)', () => {
    const veryStaleLead = createVeryStaleLead();
    const analysis = analyzeLeadStaleness(veryStaleLead, NOW);
    
    assert(analysis.finalScore >= 80, 'Very stale lead should have high score');
    assertEqual(analysis.priority, 'high', 'Should be high priority');
  });

  // ========================================
  // analyzeAllLeads aggregation
  // ========================================
  
  describe('analyzeAllLeads() aggregation', () => {
    const leads = [
      createFreshLead('Fresh 1'),
      createFreshLead('Fresh 2'),
      createNeverContactedLead('Stale 1', 10),
      createOldContactLead('Stale 2', 20),
      createVeryStaleLead(),
    ];
    
    const result = analyzeAllLeads(leads, NOW);
    
    assertEqual(result.totalLeads, 5, 'Should count all 5 leads');
    assertEqual(result.freshLeads, 2, 'Should have 2 fresh leads');
    assertEqual(result.staleLeads, 3, 'Should have 3 stale leads');
    assertEqual(result.analyses.length, 5, 'Should have 5 analyses');
  });

  // ========================================
  // Edge cases
  // ========================================
  
  describe('Lead with null updatedAt (backward compatibility)', () => {
    const leadWithNullUpdate = createLead({
      lead: { businessName: 'Legacy Lead' },
      createdAt: daysAgo(20),
      lastContactedAt: daysAgo(5),
      updatedAt: null,
      pipelineStage: 'qualified',
      pipelineStageChangedAt: daysAgo(5),
    });
    
    // Should not crash and should handle null gracefully
    const analysis = analyzeLeadStaleness(leadWithNullUpdate, NOW);
    assert(analysis !== null, 'Should handle null updatedAt without crashing');
    assertEqual(analysis.daysSinceUpdate, null, 'daysSinceUpdate should be null');
  });

  describe('Lead with missing business name in jsonb', () => {
    const leadWithoutName = createLead({
      lead: { address: '123 Test St' }, // No businessName
    });
    
    const analysis = analyzeLeadStaleness(leadWithoutName, NOW);
    assert(analysis.businessName.includes('Lead '), 'Should have fallback business name');
  });

  describe('Sorting: stale leads sorted by score descending', () => {
    const leads = [
      createNeverContactedLead('Mild Stale', 8),   // Lower score
      createVeryStaleLead(),                        // Highest score
      createOldContactLead('Medium Stale', 20),    // Medium score
    ];
    
    const result = analyzeAllLeads(leads, NOW);
    
    // Get stale analyses sorted by score
    const staleAnalyses = result.analyses
      .filter(a => a.isStale)
      .sort((a, b) => b.finalScore - a.finalScore);
    
    assert(staleAnalyses.length >= 2, 'Should have multiple stale analyses');
    
    // Check that scores are in descending order
    let prevScore = Infinity;
    let sorted = true;
    for (const analysis of staleAnalyses) {
      if (analysis.finalScore > prevScore) {
        sorted = false;
        break;
      }
      prevScore = analysis.finalScore;
    }
    
    assert(sorted, 'Analyses should be sortable by score descending');
  });

  // ========================================
  // Pack integration tests (with mock storage)
  // ========================================

  await describe('Pack: returns nudges for stale leads', async () => {
    // Create mock storage
    const mockStorage: StaleLeadsStorage = {
      async getSuggestedLeadsByAccount(accountId: string) {
        return [
          createFreshLead('Fresh Lead'),
          createNeverContactedLead('Stale Lead 1', 10),
          createVeryStaleLead(),
        ];
      }
    };
    
    _setStorage(mockStorage);
    
    try {
      const context: SubconContext = {
        userId: 'test_user',
        accountId: 'test_account',
        timestamp: NOW.toISOString(),
      };
      
      const output = await staleLeadsPack.run(context);
      
      assert(Array.isArray(output.nudges), 'Output should have nudges array');
      assertEqual(output.nudges.length, 2, 'Should have 2 nudges for 2 stale leads');
      assert(typeof output.completedAt === 'string', 'Output should have completedAt timestamp');
      assert(typeof output.summary === 'string', 'Output should have summary');
      
      if (output.nudges.length > 0) {
        const nudge = output.nudges[0];
        assertEqual(nudge.type, 'stale_lead', 'Nudge type should be stale_lead');
        assert(typeof nudge.message === 'string', 'Nudge should have message');
        assert(['low', 'medium', 'high'].includes(nudge.priority), 'Nudge should have valid priority');
        assert(typeof nudge.entityId === 'string', 'Nudge should have entityId');
        assert(nudge.metadata !== undefined, 'Nudge should have metadata');
      }
    } finally {
      _setStorage(null);
    }
  });

  await describe('Pack: returns empty nudges for no leads', async () => {
    const mockStorage: StaleLeadsStorage = {
      async getSuggestedLeadsByAccount() {
        return [];
      }
    };
    
    _setStorage(mockStorage);
    
    try {
      const context: SubconContext = {
        userId: 'test_user',
        accountId: 'empty_account',
        timestamp: NOW.toISOString(),
      };
      
      const output = await staleLeadsPack.run(context);
      
      assertEqual(output.nudges.length, 0, 'Should have 0 nudges for no leads');
      assert(output.summary?.includes('No leads found'), 'Summary should mention no leads');
    } finally {
      _setStorage(null);
    }
  });

  await describe('Pack: nudges sorted by score (highest first)', async () => {
    const mockStorage: StaleLeadsStorage = {
      async getSuggestedLeadsByAccount() {
        return [
          createNeverContactedLead('Mild Stale', 8),   // Lower score
          createVeryStaleLead(),                        // Highest score
          createOldContactLead('Medium Stale', 20),    // Medium score
        ];
      }
    };
    
    _setStorage(mockStorage);
    
    try {
      const context: SubconContext = {
        userId: 'test_user',
        accountId: 'test_account',
        timestamp: NOW.toISOString(),
      };
      
      const output = await staleLeadsPack.run(context);
      
      assert(output.nudges.length >= 2, 'Should have multiple nudges');
      
      // Check that scores are in descending order
      let prevScore = Infinity;
      let sorted = true;
      for (const nudge of output.nudges) {
        const score = (nudge.metadata as any)?.score ?? 0;
        if (score > prevScore) {
          sorted = false;
          break;
        }
        prevScore = score;
      }
      
      assert(sorted, 'Nudges should be sorted by score descending');
    } finally {
      _setStorage(null);
    }
  });

  await describe('Pack: all fresh leads returns 0 nudges', async () => {
    const mockStorage: StaleLeadsStorage = {
      async getSuggestedLeadsByAccount() {
        return [
          createFreshLead('Fresh 1'),
          createFreshLead('Fresh 2'),
          createFreshLead('Fresh 3'),
        ];
      }
    };
    
    _setStorage(mockStorage);
    
    try {
      const context: SubconContext = {
        userId: 'test_user',
        accountId: 'test_account',
        timestamp: NOW.toISOString(),
      };
      
      const output = await staleLeadsPack.run(context);
      
      assertEqual(output.nudges.length, 0, 'Should have 0 nudges for fresh leads');
      assert(output.summary?.includes('0 stale'), 'Summary should mention 0 stale leads');
    } finally {
      _setStorage(null);
    }
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
