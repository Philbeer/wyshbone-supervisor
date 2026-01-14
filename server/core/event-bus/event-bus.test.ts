/**
 * Supervisor EventBus - In-Memory Test
 * 
 * Tests for pub/sub event bus functionality.
 * Run with: npx tsx server/core/event-bus/event-bus.test.ts
 */

import { createEventBus } from './in-memory-event-bus';
import type { BaseSupervisorEvent } from '../types';

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
 * Create a test event
 */
function createTestEvent(type: string, id?: string): BaseSupervisorEvent {
  return {
    id: id || `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    type,
    timestamp: new Date().toISOString(),
    source: 'test'
  };
}

/**
 * Run EventBus tests
 */
async function runTests(): Promise<void> {
  console.log('\n=== SupervisorEventBus Tests ===\n');

  // 1. Create an event bus
  const bus = createEventBus();
  console.log('1. Created event bus');

  // Verify initial state
  assert(!bus.hasSubscribers('test.event'), 'No initial subscribers');
  assert(bus.subscriberCount('test.event') === 0, 'Subscriber count is 0');

  // 2. Subscribe to events
  let receivedEvents: BaseSupervisorEvent[] = [];
  
  const sub1 = bus.subscribe('test.event', async (event) => {
    receivedEvents.push(event);
  });
  
  assert(sub1.id.startsWith('sub_'), 'Subscription has generated ID');
  assert(bus.hasSubscribers('test.event'), 'Has subscribers after subscribe');
  assert(bus.subscriberCount('test.event') === 1, 'Subscriber count is 1');
  console.log('\n2. Subscribe verification passed');

  // 3. Publish an event
  const testEvent1 = createTestEvent('test.event', 'evt_1');
  const result1 = await bus.publish(testEvent1);
  
  assert(result1.eventId === 'evt_1', 'Publish returns correct event ID');
  assert(result1.handlerCount === 1, 'One handler received the event');
  assert(result1.errorCount === 0, 'No errors during publish');
  assert(receivedEvents.length === 1, 'Handler received the event');
  assert(receivedEvents[0].id === 'evt_1', 'Received correct event');
  console.log('\n3. Publish verification passed');

  // 4. Wildcard pattern matching
  receivedEvents = [];
  
  const sub2 = bus.subscribe('test.*', async (event) => {
    receivedEvents.push(event);
  });
  
  const testEvent2 = createTestEvent('test.another', 'evt_2');
  const result2 = await bus.publish(testEvent2);
  
  assert(result2.handlerCount === 1, 'Wildcard handler matched');
  assert(receivedEvents.length === 1, 'Wildcard handler received event');
  assert(receivedEvents[0].type === 'test.another', 'Received correct event type');
  
  // test.event should match both specific and wildcard
  receivedEvents = [];
  const testEvent3 = createTestEvent('test.event', 'evt_3');
  const result3 = await bus.publish(testEvent3);
  
  assert(result3.handlerCount === 2, 'Both handlers matched test.event');
  assert(receivedEvents.length === 2, 'Both handlers received event');
  console.log('\n4. Wildcard pattern matching passed');

  // 5. Unsubscribe
  sub1.unsubscribe();
  
  assert(bus.subscriberCount('test.event') === 1, 'One subscriber after unsubscribe (wildcard)');
  
  receivedEvents = [];
  const testEvent4 = createTestEvent('test.event', 'evt_4');
  await bus.publish(testEvent4);
  
  assert(receivedEvents.length === 1, 'Only wildcard handler received after unsubscribe');
  console.log('\n5. Unsubscribe verification passed');

  // 6. Once option (one-time subscription)
  receivedEvents = [];
  
  bus.subscribe('once.test', async (event) => {
    receivedEvents.push(event);
  }, { once: true });
  
  assert(bus.subscriberCount('once.test') === 1, 'Once subscriber registered');
  
  await bus.publish(createTestEvent('once.test', 'evt_once_1'));
  assert(receivedEvents.length === 1, 'Once handler received first event');
  assert(bus.subscriberCount('once.test') === 0, 'Once subscriber removed after delivery');
  
  await bus.publish(createTestEvent('once.test', 'evt_once_2'));
  assert(receivedEvents.length === 1, 'No second delivery for once subscription');
  console.log('\n6. Once subscription verification passed');

  // 7. Error isolation
  let errorHandlerCalled = false;
  let goodHandlerCalled = false;
  
  bus.subscribe('error.test', async () => {
    throw new Error('Test error');
  });
  
  bus.subscribe('error.test', async () => {
    goodHandlerCalled = true;
  });
  
  const errorResult = await bus.publish(createTestEvent('error.test'));
  
  assert(errorResult.handlerCount === 2, 'Both handlers were called');
  assert(errorResult.errorCount === 1, 'One error was caught');
  assert(errorResult.errors?.length === 1, 'Error was recorded');
  assert(goodHandlerCalled, 'Good handler still executed despite error');
  console.log('\n7. Error isolation verification passed');

  // 8. Clear all subscriptions
  bus.clear();
  
  assert(bus.subscriberCount('test.event') === 0, 'No subscribers after clear');
  assert(bus.subscriberCount('test.*') === 0, 'No wildcard subscribers after clear');
  console.log('\n8. Clear verification passed');

  // 9. Filter option
  bus.subscribe('filter.test', async (event) => {
    receivedEvents.push(event);
  }, {
    filter: (event) => event.source === 'allowed'
  });
  
  receivedEvents = [];
  
  await bus.publish({ ...createTestEvent('filter.test'), source: 'blocked' });
  assert(receivedEvents.length === 0, 'Blocked event was filtered out');
  
  await bus.publish({ ...createTestEvent('filter.test'), source: 'allowed' });
  assert(receivedEvents.length === 1, 'Allowed event passed filter');
  console.log('\n9. Filter verification passed');

  console.log('\n=== All EventBus Tests Passed! ===\n');
}

// Run tests
runTests().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});

