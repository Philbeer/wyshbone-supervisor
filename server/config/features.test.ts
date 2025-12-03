/**
 * Feature Toggle Tests
 * 
 * Unit tests for the feature toggle system.
 * Run with: npx tsx server/config/features.test.ts
 * 
 * SUP-9: Lead Finder on/off toggle
 */

import { 
  isFeatureEnabled, 
  getFeatureConfig, 
  getAllFeatureConfigs,
  defaultFeatureToggles,
  type FeatureId 
} from './features';

/**
 * Simple test runner
 */
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
  const result = fn();
  if (result instanceof Promise) {
    return result;
  }
}

/**
 * Run all tests
 */
async function runTests() {
  console.log('='.repeat(60));
  console.log('Feature Toggle Tests (SUP-9)');
  console.log('='.repeat(60));

  // Store original env value
  const originalEnv = process.env.FEATURE_LEAD_FINDER_ENABLED;

  describe('isFeatureEnabled() with default config', () => {
    // Clear env override for this test
    delete process.env.FEATURE_LEAD_FINDER_ENABLED;
    
    const enabled = isFeatureEnabled('lead_finder');
    assert(
      enabled === defaultFeatureToggles.lead_finder.enabled,
      `lead_finder should match default config (${defaultFeatureToggles.lead_finder.enabled})`
    );
  });

  describe('isFeatureEnabled() with env override = true', () => {
    process.env.FEATURE_LEAD_FINDER_ENABLED = 'true';
    
    const enabled = isFeatureEnabled('lead_finder');
    assert(enabled === true, 'lead_finder should be enabled when env=true');
  });

  describe('isFeatureEnabled() with env override = false', () => {
    process.env.FEATURE_LEAD_FINDER_ENABLED = 'false';
    
    const enabled = isFeatureEnabled('lead_finder');
    assert(enabled === false, 'lead_finder should be disabled when env=false');
  });

  describe('isFeatureEnabled() with env override = 1', () => {
    process.env.FEATURE_LEAD_FINDER_ENABLED = '1';
    
    const enabled = isFeatureEnabled('lead_finder');
    assert(enabled === true, 'lead_finder should be enabled when env=1');
  });

  describe('isFeatureEnabled() with env override = 0', () => {
    process.env.FEATURE_LEAD_FINDER_ENABLED = '0';
    
    const enabled = isFeatureEnabled('lead_finder');
    assert(enabled === false, 'lead_finder should be disabled when env=0');
  });

  describe('isFeatureEnabled() with env override = yes', () => {
    process.env.FEATURE_LEAD_FINDER_ENABLED = 'yes';
    
    const enabled = isFeatureEnabled('lead_finder');
    assert(enabled === true, 'lead_finder should be enabled when env=yes');
  });

  describe('isFeatureEnabled() with env override = no', () => {
    process.env.FEATURE_LEAD_FINDER_ENABLED = 'no';
    
    const enabled = isFeatureEnabled('lead_finder');
    assert(enabled === false, 'lead_finder should be disabled when env=no');
  });

  describe('isFeatureEnabled() case insensitivity', () => {
    process.env.FEATURE_LEAD_FINDER_ENABLED = 'TRUE';
    assert(isFeatureEnabled('lead_finder') === true, 'Should handle TRUE (uppercase)');
    
    process.env.FEATURE_LEAD_FINDER_ENABLED = 'False';
    assert(isFeatureEnabled('lead_finder') === false, 'Should handle False (mixed case)');
  });

  describe('isFeatureEnabled() with whitespace', () => {
    process.env.FEATURE_LEAD_FINDER_ENABLED = '  true  ';
    assert(isFeatureEnabled('lead_finder') === true, 'Should trim whitespace');
  });

  describe('isFeatureEnabled() with empty string falls back to default', () => {
    process.env.FEATURE_LEAD_FINDER_ENABLED = '';
    
    const enabled = isFeatureEnabled('lead_finder');
    assert(
      enabled === defaultFeatureToggles.lead_finder.enabled,
      'Empty string should fall back to default'
    );
  });

  describe('getFeatureConfig() returns full config', () => {
    delete process.env.FEATURE_LEAD_FINDER_ENABLED;
    
    const config = getFeatureConfig('lead_finder');
    
    assert(config.featureId === 'lead_finder', 'featureId should be lead_finder');
    assert(config.name === 'Lead Finder', 'name should be Lead Finder');
    assert(typeof config.description === 'string', 'description should be a string');
    assert(typeof config.enabled === 'boolean', 'enabled should be a boolean');
  });

  describe('getFeatureConfig() respects env override', () => {
    process.env.FEATURE_LEAD_FINDER_ENABLED = 'false';
    
    const config = getFeatureConfig('lead_finder');
    assert(config.enabled === false, 'Config should reflect env override');
    
    process.env.FEATURE_LEAD_FINDER_ENABLED = 'true';
    
    const config2 = getFeatureConfig('lead_finder');
    assert(config2.enabled === true, 'Config should reflect updated env override');
  });

  describe('getAllFeatureConfigs() returns all features', () => {
    delete process.env.FEATURE_LEAD_FINDER_ENABLED;
    
    const configs = getAllFeatureConfigs();
    
    assert(Array.isArray(configs), 'Should return an array');
    assert(configs.length > 0, 'Should have at least one feature');
    
    const leadFinder = configs.find(c => c.featureId === 'lead_finder');
    assert(leadFinder !== undefined, 'Should include lead_finder');
  });

  describe('isFeatureEnabled() with context (future-proofing)', () => {
    delete process.env.FEATURE_LEAD_FINDER_ENABLED;
    
    // Context should be accepted even if not used yet
    const enabled = isFeatureEnabled('lead_finder', { 
      environment: 'production',
      accountId: 'test-account'
    });
    
    assert(typeof enabled === 'boolean', 'Should return boolean with context');
  });

  // Restore original env
  if (originalEnv !== undefined) {
    process.env.FEATURE_LEAD_FINDER_ENABLED = originalEnv;
  } else {
    delete process.env.FEATURE_LEAD_FINDER_ENABLED;
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

// Run tests
runTests().catch(console.error);

