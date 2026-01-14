/**
 * Supervisor TaskRunner - In-Memory Test
 * 
 * Tests for task execution engine functionality.
 * Run with: npx tsx server/core/task-runner/task-runner.test.ts
 */

import { createTaskRunner } from './task-runner';
import { createEventBus } from '../event-bus';
import type { TaskExecutionContext, RunTaskResult } from './types';

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
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run TaskRunner tests
 */
async function runTests(): Promise<void> {
  console.log('\n=== SupervisorTaskRunner Tests ===\n');

  // 1. Create a task runner
  const runner = createTaskRunner();
  console.log('1. Created task runner');

  // Verify initial configuration
  const config = runner.getConfig();
  assert(config.defaultTimeoutMs === 30000, 'Default timeout is 30s');
  assert(config.defaultMaxAttempts === 3, 'Default max attempts is 3');
  console.log('\n1. Configuration verification passed');

  // 2. Run a simple successful task
  const result1 = await runner.runFeature(
    'test.simple',
    { value: 42 },
    async (input) => {
      return { doubled: (input as { value: number }).value * 2 };
    }
  );

  assert(result1.success, 'Simple task succeeded');
  assert(result1.featureId === 'test.simple', 'Feature ID is correct');
  assert(result1.taskId.startsWith('task_'), 'Task ID was generated');
  assert(result1.attempts === 1, 'Completed in 1 attempt');
  assert(result1.status === 'succeeded', 'Status is succeeded');
  assert((result1.data as { doubled: number }).doubled === 84, 'Output is correct');
  assert(result1.durationMs >= 0, 'Duration is recorded');
  console.log('\n2. Simple task verification passed');

  // 3. Run a failing task
  const result2 = await runner.runFeature(
    'test.failing',
    {},
    async () => {
      throw new Error('Intentional failure');
    },
    { maxAttempts: 1 }
  );

  assert(!result2.success, 'Failing task failed');
  assert(result2.status === 'failed', 'Status is failed');
  assert(result2.error?.message === 'Intentional failure', 'Error message is captured');
  assert(result2.attempts === 1, 'Made 1 attempt');
  console.log('\n3. Failing task verification passed');

  // 4. Test retry behavior
  let attemptCount = 0;
  
  const result3 = await runner.runFeature(
    'test.retry',
    {},
    async () => {
      attemptCount++;
      if (attemptCount < 3) {
        throw new Error(`Attempt ${attemptCount} failed`);
      }
      return { success: true };
    },
    { 
      maxAttempts: 3,
      // Use shorter delays for testing
    }
  );

  assert(result3.success, 'Retry task eventually succeeded');
  assert(result3.attempts === 3, 'Made 3 attempts');
  assert(attemptCount === 3, 'Executor was called 3 times');
  console.log('\n4. Retry verification passed');

  // 5. Test timeout handling
  const shortTimeoutRunner = createTaskRunner({ defaultTimeoutMs: 50 });
  
  const result4 = await shortTimeoutRunner.runFeature(
    'test.timeout',
    {},
    async () => {
      await sleep(200);
      return { done: true };
    },
    { maxAttempts: 1 }
  );

  assert(!result4.success, 'Timeout task failed');
  assert(result4.status === 'timeout', 'Status is timeout');
  assert(result4.error?.message.includes('timed out'), 'Error mentions timeout');
  console.log('\n5. Timeout verification passed');

  // 6. Test lifecycle hooks
  const hookCalls: string[] = [];
  
  const result5 = await runner.runFeature(
    'test.hooks',
    { input: 'data' },
    async (input) => {
      hookCalls.push('executor');
      return { output: 'result' };
    },
    {
      maxAttempts: 1,
      hooks: {
        beforeTask: async () => { hookCalls.push('before'); },
        afterTask: async () => { hookCalls.push('after'); },
        onLog: (level, msg) => { hookCalls.push(`log:${level}`); }
      }
    }
  );

  assert(result5.success, 'Hooks task succeeded');
  assert(hookCalls.includes('before'), 'beforeTask hook was called');
  assert(hookCalls.includes('executor'), 'Executor was called');
  assert(hookCalls.includes('after'), 'afterTask hook was called');
  assert(hookCalls.some(h => h.startsWith('log:')), 'Log hook was called');
  console.log('\n6. Lifecycle hooks verification passed');

  // 7. Test with EventBus integration
  const eventBus = createEventBus();
  const runnerWithBus = createTaskRunner({}, eventBus);
  
  const receivedEvents: string[] = [];
  eventBus.subscribe('task.*', async (event) => {
    receivedEvents.push(event.type);
  });

  await runnerWithBus.runFeature(
    'test.events',
    {},
    async () => ({ done: true }),
    { maxAttempts: 1 }
  );

  assert(receivedEvents.includes('task.queued'), 'task.queued event emitted');
  assert(receivedEvents.includes('task.started'), 'task.started event emitted');
  assert(receivedEvents.includes('task.completed'), 'task.completed event emitted');
  console.log('\n7. EventBus integration verification passed');

  // 8. Test runTask alias
  const result6 = await runner.runTask(
    'test.alias',
    { x: 1 },
    async (input) => ({ y: (input as { x: number }).x + 1 }),
    { maxAttempts: 1 }
  );

  assert(result6.success, 'runTask alias works');
  assert(result6.featureId === 'test.alias', 'Feature ID correct via runTask');
  console.log('\n8. runTask alias verification passed');

  // 9. Test configure method
  runner.configure({ defaultTimeoutMs: 5000 });
  const newConfig = runner.getConfig();
  assert(newConfig.defaultTimeoutMs === 5000, 'Configuration was updated');
  console.log('\n9. Configure verification passed');

  console.log('\n=== All TaskRunner Tests Passed! ===\n');
}

// Run tests
runTests().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});

