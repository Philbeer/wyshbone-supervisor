/**
 * Supervisor Scheduler - In-Memory Test
 * 
 * Simple test to verify FIFO queue behavior.
 * Run with: npx tsx server/core/scheduler/scheduler.test.ts
 */

import { createScheduler } from './supervisor-scheduler';

interface TestPayload {
  name: string;
  value: number;
}

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
 * Run scheduler tests
 */
function runTests(): void {
  console.log('\n=== SupervisorScheduler Tests ===\n');

  // 1. Create a scheduler
  const scheduler = createScheduler<TestPayload>();
  console.log('1. Created scheduler');

  // Verify initial state
  assert(scheduler.size() === 0, 'Initial size is 0');
  assert(scheduler.isEmpty(), 'Initial queue is empty');
  assert(scheduler.peek() === undefined, 'Peek on empty queue returns undefined');

  // 2. Enqueue 3 tasks
  const task1 = scheduler.enqueue('task.type.a', { name: 'first', value: 1 });
  const task2 = scheduler.enqueue('task.type.b', { name: 'second', value: 2 });
  const task3 = scheduler.enqueue('task.type.c', { name: 'third', value: 3 });
  console.log('\n2. Enqueued 3 tasks');

  // Verify task IDs were generated
  assert(task1.id.startsWith('task_'), 'Task 1 has generated ID');
  assert(task2.id.startsWith('task_'), 'Task 2 has generated ID');
  assert(task3.id.startsWith('task_'), 'Task 3 has generated ID');

  // 3. Assert size() == 3
  assert(scheduler.size() === 3, 'Size is 3 after enqueueing');
  console.log('\n3. Size verification passed');

  // 4. Assert peek() returns the first task
  const peeked = scheduler.peek();
  assert(peeked !== undefined, 'Peek returns a task');
  assert(peeked!.id === task1.id, 'Peek returns the first task');
  assert(peeked!.payload.name === 'first', 'Peek task has correct payload');
  assert(scheduler.size() === 3, 'Size unchanged after peek');
  console.log('\n4. Peek verification passed');

  // 5. Assert dequeue() returns tasks in FIFO order
  const dequeued1 = scheduler.dequeue();
  assert(dequeued1 !== undefined, 'First dequeue returns a task');
  assert(dequeued1!.id === task1.id, 'First dequeue returns task 1');
  assert(dequeued1!.payload.name === 'first', 'First dequeue has correct payload');

  const dequeued2 = scheduler.dequeue();
  assert(dequeued2 !== undefined, 'Second dequeue returns a task');
  assert(dequeued2!.id === task2.id, 'Second dequeue returns task 2');
  assert(dequeued2!.payload.name === 'second', 'Second dequeue has correct payload');

  const dequeued3 = scheduler.dequeue();
  assert(dequeued3 !== undefined, 'Third dequeue returns a task');
  assert(dequeued3!.id === task3.id, 'Third dequeue returns task 3');
  assert(dequeued3!.payload.name === 'third', 'Third dequeue has correct payload');
  console.log('\n5. FIFO order verification passed');

  // 6. Assert size() == 0 at the end
  assert(scheduler.size() === 0, 'Size is 0 after dequeueing all');
  assert(scheduler.isEmpty(), 'Queue is empty after dequeueing all');
  assert(scheduler.dequeue() === undefined, 'Dequeue on empty queue returns undefined');
  console.log('\n6. Empty queue verification passed');

  // Verify statistics
  const stats = scheduler.getStats();
  assert(stats.queueSize === 0, 'Stats show queue size 0');
  assert(stats.totalEnqueued === 3, 'Stats show 3 total enqueued');
  assert(stats.totalDequeued === 3, 'Stats show 3 total dequeued');
  console.log('\n7. Statistics verification passed');

  console.log('\n=== All Tests Passed! ===\n');
}

// Run tests
runTests();
