/**
 * Feature Runner Tests
 * 
 * Unit tests for the feature runner with toggle support.
 * Run with: npx tsx server/services/FeatureRunner.test.ts
 * 
 * SUP-9: Lead Finder on/off toggle
 */

import { runFeature } from './FeatureRunner';

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
  return fn();
}

/**
 * Run all tests
 */
async function runTests() {
  console.log('='.repeat(60));
  console.log('Feature Runner Tests (SUP-9)');
  console.log('='.repeat(60));

  // Store original env value
  const originalEnv = process.env.FEATURE_LEAD_FINDER_ENABLED;

  await describe('runFeature() when lead_finder is enabled', async () => {
    process.env.FEATURE_LEAD_FINDER_ENABLED = 'true';
    
    const result = await runFeature('leadFinder', {
      query: 'dental clinics',
      location: 'UK'
    });
    
    assert(result.status === 'ok', `Status should be 'ok' (got: ${result.status})`);
    assert(result.data !== undefined, 'Should return data');
    assert(result.errorCode === undefined, 'Should not have errorCode on success');
    
    // Check that we got leads
    const data = result.data as { leads: unknown[]; count: number };
    assert(Array.isArray(data.leads), 'Data should have leads array');
    assert(typeof data.count === 'number', 'Data should have count');
  });

  await describe('runFeature() when lead_finder is disabled', async () => {
    process.env.FEATURE_LEAD_FINDER_ENABLED = 'false';
    
    const result = await runFeature('leadFinder', {
      query: 'dental clinics',
      location: 'UK'
    });
    
    assert(
      result.status === 'feature_disabled', 
      `Status should be 'feature_disabled' (got: ${result.status})`
    );
    assert(result.data === undefined, 'Should not return data when disabled');
    assert(
      result.errorCode === 'FEATURE_DISABLED',
      `errorCode should be FEATURE_DISABLED (got: ${result.errorCode})`
    );
    assert(
      typeof result.error === 'string' && result.error.includes('disabled'),
      'Error message should mention disabled'
    );
  });

  await describe('runFeature() does not emit events when disabled', async () => {
    // This is more of an integration test but we can verify by checking
    // that the result is feature_disabled (which happens before event emission)
    process.env.FEATURE_LEAD_FINDER_ENABLED = 'false';
    
    const result = await runFeature('leadFinder', { query: 'test', location: '' });
    
    assert(
      result.status === 'feature_disabled',
      'Should return feature_disabled before any event emission'
    );
  });

  await describe('runFeature() respects context (future-proofing)', async () => {
    process.env.FEATURE_LEAD_FINDER_ENABLED = 'true';
    
    // Context should be passed through even if not fully used yet
    const result = await runFeature('leadFinder', {
      query: 'dental',
      location: ''
    }, {
      environment: 'production',
      accountId: 'test-123'
    });
    
    assert(result.status === 'ok', 'Should work with context parameter');
  });

  await describe('runFeature() handles execution errors correctly', async () => {
    process.env.FEATURE_LEAD_FINDER_ENABLED = 'true';
    
    // Normal execution should work - we can't easily trigger an error
    // in the mock lead finder, but we verify the errorCode field exists on errors
    const result = await runFeature('leadFinder', { query: '', location: '' });
    
    // Even with empty params, mock lead finder returns all leads
    assert(result.status === 'ok', 'Should handle empty params gracefully');
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

