/**
 * Lead Finder Tests
 * 
 * Unit tests for the Lead Finder feature.
 * Run with: npx tsx server/features/leadFinder/leadFinder.test.ts
 * 
 * SUP-6: Lead Finder Feature Pack
 */

import { runLeadFinder, type MockLead, type LeadFinderResult } from './leadFinder';

/**
 * Simple assertion helper
 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✓ ${message}`);
}

/**
 * Run Lead Finder tests
 */
async function runTests(): Promise<void> {
  console.log('\n=== Lead Finder Tests ===\n');

  // Test 1: Basic lead finder returns correct structure
  console.log('1. Testing basic lead finder structure...');
  
  const result1 = await runLeadFinder({
    query: "dental clinics",
    location: "UK"
  });
  
  assert(typeof result1 === 'object', 'Result is an object');
  assert(Array.isArray(result1.leads), 'Result has leads array');
  assert(typeof result1.count === 'number', 'Result has count as number');
  assert(result1.count === result1.leads.length, 'Count matches leads array length');
  console.log('   Basic structure verified\n');

  // Test 2: Leads have correct MockLead structure
  console.log('2. Testing MockLead structure...');
  
  const firstLead = result1.leads[0];
  assert(typeof firstLead.businessName === 'string', 'Lead has businessName as string');
  assert(typeof firstLead.address === 'string', 'Lead has address as string');
  assert(typeof firstLead.score === 'number', 'Lead has score as number');
  assert(firstLead.businessName.length > 0, 'businessName is not empty');
  assert(firstLead.address.length > 0, 'address is not empty');
  assert(firstLead.score >= 0 && firstLead.score <= 100, 'score is between 0 and 100');
  console.log('   MockLead structure verified\n');

  // Test 3: Returns multiple leads
  console.log('3. Testing returns multiple leads...');
  
  assert(result1.leads.length >= 3, 'Returns at least 3 leads');
  assert(result1.leads.length <= 5, 'Returns at most 5 leads');
  console.log(`   Returned ${result1.leads.length} leads\n`);

  // Test 4: Location filtering (Bristol)
  console.log('4. Testing location filtering...');
  
  const resultBristol = await runLeadFinder({
    query: "dental",
    location: "Bristol"
  });
  
  assert(resultBristol.leads.length > 0, 'Returns leads for Bristol');
  const bristolLead = resultBristol.leads.find(l => l.address.includes('Bristol'));
  assert(bristolLead !== undefined, 'Found a lead with Bristol in address');
  console.log('   Location filtering works\n');

  // Test 5: Empty params still work
  console.log('5. Testing with empty params...');
  
  const resultEmpty = await runLeadFinder({
    query: "",
    location: ""
  });
  
  assert(resultEmpty.leads.length > 0, 'Returns leads even with empty params');
  assert(resultEmpty.count > 0, 'Count is positive with empty params');
  console.log('   Empty params handled correctly\n');

  // Test 6: All leads have valid scores
  console.log('6. Testing all leads have valid scores...');
  
  for (const lead of result1.leads) {
    assert(
      lead.score >= 0 && lead.score <= 100,
      `Lead "${lead.businessName}" has valid score: ${lead.score}`
    );
  }
  console.log('   All lead scores are valid\n');

  console.log('=== All Lead Finder Tests Passed! ===\n');
}

// Run tests
runTests().catch(error => {
  console.error('\n❌ Test failed:', error.message);
  process.exit(1);
});

