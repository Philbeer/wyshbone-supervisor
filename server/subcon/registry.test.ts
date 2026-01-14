/**
 * Subconscious Pack Registry Tests
 * 
 * Unit tests for the subconscious pack registry.
 * Run with: npx tsx server/subcon/registry.test.ts
 * 
 * SUP-10: SubconsciousPack type + registry
 */

import {
  registerSubconPack,
  getSubconPack,
  hasSubconPack,
  listSubconPacks,
  runSubconPack,
  _clearRegistry,
  _getRegistrySize
} from './registry';
import { SubconPackNotFoundError } from './types';
import type { SubconsciousPack, SubconContext } from './types';
import { staleLeadsPack } from './packs';

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
// TEST FIXTURES
// ============================================

const testContext: SubconContext = {
  userId: 'test_user_123',
  accountId: 'test_account_456',
  timestamp: new Date().toISOString()
};

// ============================================
// TESTS
// ============================================

async function runTests() {
  console.log('='.repeat(60));
  console.log('Subconscious Pack Registry Tests (SUP-10)');
  console.log('='.repeat(60));

  // Clear registry before each test suite
  _clearRegistry();

  describe('registerSubconPack() and getSubconPack()', () => {
    _clearRegistry();
    
    registerSubconPack(staleLeadsPack);
    
    const retrieved = getSubconPack('stale_leads');
    assert(retrieved !== undefined, 'Should retrieve registered pack');
    assert(retrieved?.id === 'stale_leads', 'Retrieved pack should have correct ID');
  });

  describe('hasSubconPack()', () => {
    _clearRegistry();
    
    assert(hasSubconPack('stale_leads') === false, 'Should return false for unregistered pack');
    
    registerSubconPack(staleLeadsPack);
    
    assert(hasSubconPack('stale_leads') === true, 'Should return true for registered pack');
  });

  describe('listSubconPacks()', () => {
    _clearRegistry();
    
    assert(listSubconPacks().length === 0, 'Should return empty array when no packs registered');
    
    registerSubconPack(staleLeadsPack);
    
    const packs = listSubconPacks();
    assert(packs.length === 1, 'Should return one pack after registration');
    assert(packs.includes('stale_leads'), 'Should include stale_leads in list');
  });

  await describe('runSubconPack() with registered pack', async () => {
    _clearRegistry();
    registerSubconPack(staleLeadsPack);
    
    const result = await runSubconPack('stale_leads', testContext);
    
    assert(result.success === true, 'Result should indicate success');
    assert(result.packId === 'stale_leads', 'Result should include correct pack ID');
    assert(result.output !== undefined, 'Result should include output');
    assert(Array.isArray(result.output?.nudges), 'Output should have nudges array');
    assert(result.output?.nudges.length === 0, 'Placeholder pack should return empty nudges');
    assert(typeof result.output?.completedAt === 'string', 'Output should have completedAt timestamp');
  });

  await describe('runSubconPack() with unknown pack throws error', async () => {
    _clearRegistry();
    
    let errorThrown = false;
    let errorMessage = '';
    
    try {
      // Cast to any to test with invalid pack ID
      await runSubconPack('unknown_pack' as any, testContext);
    } catch (error) {
      errorThrown = true;
      if (error instanceof SubconPackNotFoundError) {
        errorMessage = error.message;
      }
    }
    
    assert(errorThrown === true, 'Should throw error for unknown pack');
    assert(
      errorMessage.includes('unknown_pack'),
      'Error message should mention the unknown pack ID'
    );
  });

  await describe('staleLeadsPack returns expected output structure', async () => {
    const output = await staleLeadsPack.run(testContext);
    
    assert(Array.isArray(output.nudges), 'Output should have nudges array');
    assert(output.nudges.length === 0, 'Placeholder should return empty nudges');
    assert(typeof output.completedAt === 'string', 'Output should have completedAt');
    assert(typeof output.summary === 'string', 'Output should have summary');
  });

  describe('_getRegistrySize() helper', () => {
    _clearRegistry();
    
    assert(_getRegistrySize() === 0, 'Registry size should be 0 after clear');
    
    registerSubconPack(staleLeadsPack);
    
    assert(_getRegistrySize() === 1, 'Registry size should be 1 after registration');
  });

  describe('Re-registering a pack overwrites previous', () => {
    _clearRegistry();
    
    registerSubconPack(staleLeadsPack);
    
    // Create a modified version of the pack
    const modifiedPack: SubconsciousPack = {
      id: 'stale_leads',
      async run() {
        return {
          nudges: [{ type: 'test', message: 'Modified', priority: 'low' }],
          completedAt: new Date().toISOString()
        };
      }
    };
    
    registerSubconPack(modifiedPack);
    
    assert(_getRegistrySize() === 1, 'Registry size should still be 1');
    
    const retrieved = getSubconPack('stale_leads');
    assert(retrieved === modifiedPack, 'Should retrieve the modified pack');
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

