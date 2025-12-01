/**
 * Supervisor Core - Integration Test
 * 
 * Tests that all core modules work together correctly.
 * Run with: npx tsx server/core/integration.test.ts
 */

import {
  // SUP-1: Base types
  BaseSupervisorEvent,
  BaseAgentConfig,
  BaseTaskDefinition,
  MessageEnvelope,
  EventEnvelope,
  TaskResult,
  
  // SUP-2: EventBus
  createEventBus,
  SupervisorEventBus,
  
  // SUP-3: Scheduler
  createScheduler,
  SupervisorScheduler,
  ScheduledTask,
  
  // SUP-4: Domain Events
  EventTypes,
  TaskQueuedPayload,
  TaskCompletedPayload,
  
  // SUP-5: TaskRunner
  createTaskRunner,
  TaskRunner,
  RunTaskResult,
  
  // Version
  CORE_VERSION
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
 * Run integration tests
 */
async function runTests(): Promise<void> {
  console.log('\n=== Supervisor Core Integration Tests ===\n');
  console.log(`Core Version: ${CORE_VERSION}\n`);

  // 1. Verify all exports are available
  assert(typeof createEventBus === 'function', 'createEventBus is exported');
  assert(typeof createScheduler === 'function', 'createScheduler is exported');
  assert(typeof createTaskRunner === 'function', 'createTaskRunner is exported');
  assert(typeof EventTypes === 'object', 'EventTypes is exported');
  assert(CORE_VERSION === '1.0.0', 'CORE_VERSION is correct');
  console.log('\n1. Export verification passed');

  // 2. Create all core components
  const eventBus = createEventBus();
  const scheduler = createScheduler<{ taskId: string; type: string }>();
  const taskRunner = createTaskRunner({}, eventBus);
  
  assert(eventBus !== null, 'EventBus created');
  assert(scheduler !== null, 'Scheduler created');
  assert(taskRunner !== null, 'TaskRunner created');
  console.log('\n2. Component creation passed');

  // 3. Integration: Schedule a task, run it, emit events
  const taskLog: string[] = [];
  
  // Subscribe to all task events
  eventBus.subscribe('task.*', async (event) => {
    taskLog.push(`event:${event.type}`);
  });

  // Enqueue a task
  const scheduledTask = scheduler.enqueue('lead.search', {
    taskId: 'integration_task_1',
    type: 'lead.search'
  });
  taskLog.push(`scheduled:${scheduledTask.id}`);
  
  assert(scheduler.size() === 1, 'Task is in queue');
  
  // Dequeue and run
  const dequeuedTask = scheduler.dequeue();
  assert(dequeuedTask !== undefined, 'Task was dequeued');
  taskLog.push(`dequeued:${dequeuedTask!.id}`);
  
  // Run the task through TaskRunner
  const result = await taskRunner.runFeature(
    dequeuedTask!.payload.type,
    { query: 'pubs', region: 'North West' },
    async (input, ctx) => {
      taskLog.push(`executing:${ctx.taskId}`);
      return { leads: ['lead1', 'lead2'] };
    },
    { maxAttempts: 1 }
  );
  
  taskLog.push(`completed:${result.taskId}`);
  
  assert(result.success, 'Task executed successfully');
  assert(scheduler.size() === 0, 'Queue is empty after processing');
  assert(taskLog.includes('event:task.queued'), 'task.queued event was emitted');
  assert(taskLog.includes('event:task.started'), 'task.started event was emitted');
  assert(taskLog.includes('event:task.completed'), 'task.completed event was emitted');
  console.log('\n3. Scheduler + TaskRunner + EventBus integration passed');

  // 4. Verify type compatibility (compile-time check, runtime validation)
  const testEvent: BaseSupervisorEvent = {
    id: 'test_event_1',
    type: EventTypes.LEAD_CREATED,
    timestamp: new Date().toISOString(),
    source: 'integration-test'
  };
  
  const publishResult = await eventBus.publish(testEvent);
  assert(publishResult.eventId === 'test_event_1', 'Event published with correct ID');
  console.log('\n4. Type compatibility verification passed');

  // 5. Test error handling across components
  let errorCaught = false;
  
  eventBus.subscribe('task.failed', async () => {
    errorCaught = true;
  });
  
  const failingResult = await taskRunner.runFeature(
    'test.failing',
    {},
    async () => { throw new Error('Integration test error'); },
    { maxAttempts: 1 }
  );
  
  assert(!failingResult.success, 'Failing task reported failure');
  assert(failingResult.error?.message === 'Integration test error', 'Error was captured');
  assert(errorCaught, 'task.failed event was received');
  console.log('\n5. Error handling integration passed');

  // 6. Verify scheduler stats
  scheduler.enqueue('task.a', { taskId: 'a', type: 'a' });
  scheduler.enqueue('task.b', { taskId: 'b', type: 'b' });
  scheduler.dequeue();
  
  const stats = scheduler.getStats();
  assert(stats.queueSize === 1, 'Queue size is correct');
  assert(stats.totalEnqueued === 3, 'Total enqueued is correct');
  assert(stats.totalDequeued === 2, 'Total dequeued is correct');
  console.log('\n6. Scheduler statistics verification passed');

  // 7. Cleanup
  eventBus.clear();
  scheduler.clear();
  
  assert(eventBus.subscriberCount('task.*') === 0, 'EventBus cleared');
  assert(scheduler.size() === 0, 'Scheduler cleared');
  console.log('\n7. Cleanup verification passed');

  console.log('\n=== All Integration Tests Passed! ===\n');
  console.log('Summary:');
  console.log('  • SUP-1: Base types work correctly');
  console.log('  • SUP-2: EventBus pub/sub functioning');
  console.log('  • SUP-3: Scheduler FIFO queue working');
  console.log('  • SUP-4: Domain events properly typed');
  console.log('  • SUP-5: TaskRunner executes with hooks');
  console.log('  • All modules integrate seamlessly\n');
}

// Run tests
runTests().catch(error => {
  console.error('Integration test failed:', error);
  process.exit(1);
});

