/**
 * Save Lead Events Tests
 * 
 * Tests for LeadSaved event emission.
 * Run with: npx tsx server/features/saveLead/saveLead.events.test.ts
 * 
 * SUP-8: Lead Saved Events
 */

import { 
  saveLead, 
  clearSavedLeads,
  getLeadEventBus,
  setLeadEventBus,
  type IncomingLeadPayload,
  type LeadSavedEvent
} from './index';
import { createEventBus } from '../../core/event-bus';
import type { BaseSupervisorEvent } from '../../core/types';

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
 * Wait for async event handling to complete
 */
function waitForEvents(ms: number = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run LeadSaved event tests
 */
async function runTests(): Promise<void> {
  console.log('\n=== SUP-8: LeadSaved Event Tests ===\n');

  // Create a fresh event bus for testing
  const testBus = createEventBus();
  const originalBus = getLeadEventBus();
  
  // Use the test bus for all tests
  setLeadEventBus(testBus);

  // Clear store before tests
  clearSavedLeads();

  // ============================================
  // Test 1: LeadSaved event is emitted when saveLead is called
  // ============================================
  console.log('\n1. Testing LeadSaved event emission...');
  
  const receivedEvents: BaseSupervisorEvent[] = [];
  
  const subscription = testBus.subscribe<LeadSavedEvent>('lead.saved', async (event) => {
    receivedEvents.push(event);
  });

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

  const savedLead = saveLead(fullPayload);
  
  // Wait for async event handling
  await waitForEvents();
  
  assert(receivedEvents.length === 1, 'LeadSaved event was emitted');
  assert(receivedEvents[0].type === 'lead.saved', 'Event type is "lead.saved"');
  console.log('   Event emission test passed\n');

  // ============================================
  // Test 2: Event payload contains all expected fields
  // ============================================
  console.log('2. Testing event payload fields...');
  
  const event = receivedEvents[0] as LeadSavedEvent;
  const payload = event.payload;
  
  assert(payload.leadId === savedLead.id, 'payload.leadId matches saved lead id');
  assert(payload.ownerUserId === 'user-123', 'payload.ownerUserId is correct');
  assert(payload.businessName === 'Test Dental Clinic', 'payload.businessName is correct');
  assert(payload.address === '123 Test Street, London SW1A 1AA', 'payload.address is correct');
  assert(payload.placeId === 'ChIJtest123', 'payload.placeId is correct');
  assert(payload.website === 'https://testdental.com', 'payload.website is correct');
  assert(payload.phone === '+44 20 1234 5678', 'payload.phone is correct');
  assert(payload.lat === 51.5074, 'payload.lat is correct');
  assert(payload.lng === -0.1278, 'payload.lng is correct');
  assert(payload.source === 'google', 'payload.source is correct');
  assert(typeof payload.createdAt === 'string', 'payload.createdAt is a string');
  assert(payload.createdAt.includes('T'), 'payload.createdAt is ISO format');
  console.log('   Payload fields test passed\n');

  // ============================================
  // Test 3: Event has correct metadata
  // ============================================
  console.log('3. Testing event metadata...');
  
  assert(typeof event.id === 'string', 'Event has id');
  assert(event.id.startsWith('evt_'), 'Event id has correct prefix');
  assert(typeof event.timestamp === 'string', 'Event has timestamp');
  assert(event.timestamp.includes('T'), 'Event timestamp is ISO format');
  assert(event.source === 'lead-store', 'Event source is "lead-store"');
  console.log('   Event metadata test passed\n');

  // ============================================
  // Test 4: Multiple leads emit multiple events
  // ============================================
  console.log('4. Testing multiple lead saves...');
  
  // Clear events from previous tests
  receivedEvents.length = 0;
  
  const lead2 = saveLead({
    lead: {
      businessName: "Second Business",
      address: "456 Another Street",
      source: "manual"
    },
    ownerUserId: "user-456"
  });
  
  const lead3 = saveLead({
    lead: {
      businessName: "Third Business",
      address: "789 Third Avenue",
      source: "database"
    },
    ownerUserId: "user-789"
  });
  
  await waitForEvents();
  
  assert(receivedEvents.length === 2, 'Two events emitted for two saves');
  
  const event2 = receivedEvents[0] as LeadSavedEvent;
  const event3 = receivedEvents[1] as LeadSavedEvent;
  
  assert(event2.payload.leadId === lead2.id, 'First event has correct leadId');
  assert(event2.payload.businessName === 'Second Business', 'First event has correct businessName');
  assert(event3.payload.leadId === lead3.id, 'Second event has correct leadId');
  assert(event3.payload.businessName === 'Third Business', 'Second event has correct businessName');
  console.log('   Multiple events test passed\n');

  // ============================================
  // Test 5: Event payload handles optional fields correctly
  // ============================================
  console.log('5. Testing optional fields handling...');
  
  receivedEvents.length = 0;
  
  const minimalPayload: IncomingLeadPayload = {
    lead: {
      businessName: "Minimal Business",
      address: "100 Minimal Lane",
      source: "manual"
    },
    ownerUserId: "user-minimal"
  };
  
  saveLead(minimalPayload);
  await waitForEvents();
  
  assert(receivedEvents.length === 1, 'Event emitted for minimal payload');
  
  const minimalEvent = receivedEvents[0] as LeadSavedEvent;
  
  assert(minimalEvent.payload.placeId === undefined, 'Optional placeId is undefined');
  assert(minimalEvent.payload.website === undefined, 'Optional website is undefined');
  assert(minimalEvent.payload.phone === undefined, 'Optional phone is undefined');
  assert(minimalEvent.payload.lat === undefined, 'Optional lat is undefined');
  assert(minimalEvent.payload.lng === undefined, 'Optional lng is undefined');
  console.log('   Optional fields test passed\n');

  // ============================================
  // Test 6: Wildcard subscription works for lead events
  // ============================================
  console.log('6. Testing wildcard subscription...');
  
  receivedEvents.length = 0;
  const wildcardEvents: BaseSupervisorEvent[] = [];
  
  const wildcardSub = testBus.subscribe('lead.*', async (event) => {
    wildcardEvents.push(event);
  });
  
  saveLead({
    lead: {
      businessName: "Wildcard Test",
      address: "Wild Card Street",
      source: "google"
    },
    ownerUserId: "user-wildcard"
  });
  
  await waitForEvents();
  
  assert(wildcardEvents.length === 1, 'Wildcard subscription received event');
  assert(wildcardEvents[0].type === 'lead.saved', 'Wildcard received correct event type');
  console.log('   Wildcard subscription test passed\n');

  // ============================================
  // Test 7: Event bus getter returns the active bus
  // ============================================
  console.log('7. Testing getLeadEventBus...');
  
  const currentBus = getLeadEventBus();
  assert(currentBus === testBus, 'getLeadEventBus returns current bus');
  console.log('   Event bus getter test passed\n');

  // Cleanup
  subscription.unsubscribe();
  wildcardSub.unsubscribe();
  testBus.clear();
  clearSavedLeads();
  
  // Restore original event bus
  setLeadEventBus(originalBus);

  console.log('=== All SUP-8 LeadSaved Event Tests Passed! ===\n');
}

// Run tests
runTests().catch(error => {
  console.error('\n❌ Test failed:', error.message);
  process.exit(1);
});

