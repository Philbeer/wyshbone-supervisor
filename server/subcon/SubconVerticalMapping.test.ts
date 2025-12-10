/**
 * Subconscious Vertical Mapping Tests
 * 
 * Unit tests for the vertical → subconscious pack mapping.
 * Run with: npx tsx server/subcon/SubconVerticalMapping.test.ts
 * 
 * SUP-16: Map brewery vertical → default subconscious packs
 */

import {
  getDefaultSubconPackIdsForVertical,
  getVerticalSubconConfig,
  listVerticalSubconConfigs,
  hasDefaultSubconPacks,
  type VerticalSubconConfig
} from './SubconVerticalMapping';
import type { VerticalId } from '../core/verticals/types';

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
  console.log('Subconscious Vertical Mapping Tests (SUP-16)');
  console.log('='.repeat(60));

  // ============================================
  // getDefaultSubconPackIdsForVertical() tests
  // ============================================

  describe('getDefaultSubconPackIdsForVertical("brewery")', () => {
    const packIds = getDefaultSubconPackIdsForVertical('brewery');
    
    assert(
      Array.isArray(packIds),
      'Should return an array'
    );
    assert(
      packIds.length > 0,
      'Should return non-empty array for brewery'
    );
    assert(
      packIds.includes('stale_leads'),
      'Should include stale_leads pack for brewery'
    );
  });

  describe('getDefaultSubconPackIdsForVertical() with unknown vertical', () => {
    // Cast to any to test with a hypothetical unknown vertical
    const unknownVerticalId = 'unknown_vertical' as VerticalId;
    const packIds = getDefaultSubconPackIdsForVertical(unknownVerticalId);
    
    assert(
      Array.isArray(packIds),
      'Should return an array for unknown vertical'
    );
    
    // Fallback should be brewery packs
    const breweryPackIds = getDefaultSubconPackIdsForVertical('brewery');
    assert(
      packIds.length === breweryPackIds.length,
      'Unknown vertical should fallback to brewery pack count'
    );
    assert(
      packIds.includes('stale_leads'),
      'Unknown vertical should fallback to include stale_leads'
    );
  });

  // ============================================
  // getVerticalSubconConfig() tests
  // ============================================

  describe('getVerticalSubconConfig("brewery")', () => {
    const config = getVerticalSubconConfig('brewery');
    
    assert(
      config !== undefined,
      'Should find config for brewery'
    );
    assert(
      config?.verticalId === 'brewery',
      'Config verticalId should be brewery'
    );
    assert(
      Array.isArray(config?.defaultPackIds),
      'Config should have defaultPackIds array'
    );
    assert(
      config?.defaultPackIds.includes('stale_leads'),
      'Config defaultPackIds should include stale_leads'
    );
  });

  describe('getVerticalSubconConfig() with unknown vertical', () => {
    const unknownVerticalId = 'unknown_vertical' as VerticalId;
    const config = getVerticalSubconConfig(unknownVerticalId);
    
    assert(
      config === undefined,
      'Should return undefined for unknown vertical'
    );
  });

  // ============================================
  // listVerticalSubconConfigs() tests
  // ============================================

  describe('listVerticalSubconConfigs()', () => {
    const configs = listVerticalSubconConfigs();
    
    assert(
      Array.isArray(configs),
      'Should return an array'
    );
    assert(
      configs.length >= 1,
      'Should have at least one config'
    );
    
    const breweryConfig = configs.find(c => c.verticalId === 'brewery');
    assert(
      breweryConfig !== undefined,
      'Should include a config with verticalId "brewery"'
    );
    assert(
      breweryConfig?.defaultPackIds.includes('stale_leads'),
      'Brewery config should include stale_leads pack'
    );
  });

  describe('listVerticalSubconConfigs() returns a copy', () => {
    const configs1 = listVerticalSubconConfigs();
    const configs2 = listVerticalSubconConfigs();
    
    assert(
      configs1 !== configs2,
      'Should return different array instances (copy)'
    );
    assert(
      configs1.length === configs2.length,
      'Both copies should have same length'
    );
  });

  // ============================================
  // hasDefaultSubconPacks() tests
  // ============================================

  describe('hasDefaultSubconPacks("brewery")', () => {
    const hasDefaults = hasDefaultSubconPacks('brewery');
    
    assert(
      hasDefaults === true,
      'Brewery should have default subcon packs'
    );
  });

  describe('hasDefaultSubconPacks() with unknown vertical falls back to brewery', () => {
    const unknownVerticalId = 'unknown_vertical' as VerticalId;
    const hasDefaults = hasDefaultSubconPacks(unknownVerticalId);
    
    // Since unknown verticals fall back to brewery, this should still be true
    assert(
      hasDefaults === true,
      'Unknown vertical should have defaults (via brewery fallback)'
    );
  });

  // ============================================
  // Type safety tests
  // ============================================

  describe('Config type structure validation', () => {
    const configs = listVerticalSubconConfigs();
    
    for (const config of configs) {
      assert(
        typeof config.verticalId === 'string',
        `Config ${config.verticalId} has string verticalId`
      );
      assert(
        Array.isArray(config.defaultPackIds),
        `Config ${config.verticalId} has array defaultPackIds`
      );
      
      for (const packId of config.defaultPackIds) {
        assert(
          typeof packId === 'string',
          `Pack ID "${packId}" in ${config.verticalId} is a string`
        );
      }
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
