/**
 * Save Lead Tests
 * 
 * Unit tests for the Save Lead feature.
 * Run with: npx tsx server/features/saveLead/saveLead.test.ts
 * 
 * SUP-7: Save Lead Endpoint
 */

import { 
  saveLead, 
  listSavedLeads, 
  getSavedLeadsCount, 
  clearSavedLeads,
  getSavedLeadById,
  type IncomingLeadPayload,
  type SavedLead
} from './index';

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
 * Run Save Lead tests
 */
async function runTests(): Promise<void> {
  console.log('\n=== Save Lead Tests ===\n');

  // Clear store before tests
  clearSavedLeads();
  assert(getSavedLeadsCount() === 0, 'Store is empty before tests');

  // Test 1: Save a lead with all fields
  console.log('\n1. Testing saveLead with all fields...');
  
  const fullPayload: IncomingLeadPayload = {
    lead: {
      businessName: "Test Dental Clinic",
      address: "123 Test Street, London SW1A 1AA",
      placeId: "ChIJtest123",
      website: "https://testdental.com",
      phone: "+44 20 1234 5678",
      lat: 51.5074,
      lng: -0.1278,
      source: "google"
    },
    ownerUserId: "user-123"
  };

  const saved1 = saveLead(fullPayload);
  
  assert(typeof saved1.id === 'string', 'Saved lead has id as string');
  assert(saved1.id.startsWith('lead_'), 'Lead id has correct prefix');
  assert(saved1.ownerUserId === 'user-123', 'ownerUserId is correct');
  assert(typeof saved1.createdAt === 'string', 'createdAt is a string');
  assert(saved1.businessName === 'Test Dental Clinic', 'businessName is correct');
  assert(saved1.address === '123 Test Street, London SW1A 1AA', 'address is correct');
  assert(saved1.placeId === 'ChIJtest123', 'placeId is correct');
  assert(saved1.website === 'https://testdental.com', 'website is correct');
  assert(saved1.phone === '+44 20 1234 5678', 'phone is correct');
  assert(saved1.lat === 51.5074, 'lat is correct');
  assert(saved1.lng === -0.1278, 'lng is correct');
  assert(saved1.source === 'google', 'source is correct');
  console.log('   Full fields test passed\n');

  // Test 2: Save a lead with minimal fields
  console.log('2. Testing saveLead with minimal fields...');
  
  const minimalPayload: IncomingLeadPayload = {
    lead: {
      businessName: "Minimal Business",
      address: "456 Minimal Street",
      source: "manual"
    },
    ownerUserId: "user-456"
  };

  const saved2 = saveLead(minimalPayload);
  
  assert(typeof saved2.id === 'string', 'Minimal lead has id');
  assert(saved2.ownerUserId === 'user-456', 'Minimal lead has correct ownerUserId');
  assert(saved2.businessName === 'Minimal Business', 'Minimal lead has correct businessName');
  assert(saved2.placeId === undefined, 'Optional placeId is undefined');
  assert(saved2.website === undefined, 'Optional website is undefined');
  console.log('   Minimal fields test passed\n');

  // Test 3: Store count increases
  console.log('3. Testing store count...');
  
  assert(getSavedLeadsCount() === 2, 'Store has 2 leads after saving 2');
  console.log('   Store count test passed\n');

  // Test 4: listSavedLeads returns all leads
  console.log('4. Testing listSavedLeads (all)...');
  
  const allLeads = listSavedLeads();
  assert(allLeads.length === 2, 'listSavedLeads returns all 2 leads');
  assert(allLeads[0].id === saved1.id, 'First lead matches');
  assert(allLeads[1].id === saved2.id, 'Second lead matches');
  console.log('   List all leads test passed\n');

  // Test 5: listSavedLeads filters by ownerUserId
  console.log('5. Testing listSavedLeads with filter...');
  
  const user123Leads = listSavedLeads('user-123');
  assert(user123Leads.length === 1, 'Filter returns 1 lead for user-123');
  assert(user123Leads[0].ownerUserId === 'user-123', 'Filtered lead belongs to user-123');
  
  const user456Leads = listSavedLeads('user-456');
  assert(user456Leads.length === 1, 'Filter returns 1 lead for user-456');
  assert(user456Leads[0].ownerUserId === 'user-456', 'Filtered lead belongs to user-456');
  
  const noLeads = listSavedLeads('nonexistent-user');
  assert(noLeads.length === 0, 'Filter returns 0 leads for nonexistent user');
  console.log('   Filter test passed\n');

  // Test 6: getSavedLeadById
  console.log('6. Testing getSavedLeadById...');
  
  const foundLead = getSavedLeadById(saved1.id);
  assert(foundLead !== undefined, 'Lead found by id');
  assert(foundLead?.businessName === 'Test Dental Clinic', 'Found lead has correct businessName');
  
  const notFound = getSavedLeadById('nonexistent-id');
  assert(notFound === undefined, 'Returns undefined for nonexistent id');
  console.log('   Get by id test passed\n');

  // Test 7: Different source types
  console.log('7. Testing different source types...');
  
  const databaseLead = saveLead({
    lead: {
      businessName: "Database Lead",
      address: "789 Database Ave",
      source: "database"
    },
    ownerUserId: "user-789"
  });
  assert(databaseLead.source === 'database', 'database source is correct');
  
  const manualLead = saveLead({
    lead: {
      businessName: "Manual Lead",
      address: "101 Manual Road",
      source: "manual"
    },
    ownerUserId: "user-101"
  });
  assert(manualLead.source === 'manual', 'manual source is correct');
  console.log('   Source types test passed\n');

  // Test 8: createdAt is valid ISO date
  console.log('8. Testing createdAt format...');
  
  const parsedDate = new Date(saved1.createdAt);
  assert(!isNaN(parsedDate.getTime()), 'createdAt is a valid date');
  assert(saved1.createdAt.includes('T'), 'createdAt is ISO format');
  console.log('   createdAt format test passed\n');

  // Test 9: clearSavedLeads works
  console.log('9. Testing clearSavedLeads...');
  
  const countBefore = getSavedLeadsCount();
  assert(countBefore > 0, 'Store has leads before clear');
  
  clearSavedLeads();
  assert(getSavedLeadsCount() === 0, 'Store is empty after clear');
  assert(listSavedLeads().length === 0, 'listSavedLeads returns empty after clear');
  console.log('   Clear test passed\n');

  console.log('=== All Save Lead Tests Passed! ===\n');
}

// Run tests
runTests().catch(error => {
  console.error('\n❌ Test failed:', error.message);
  process.exit(1);
});

