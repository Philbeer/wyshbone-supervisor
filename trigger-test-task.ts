/**
 * Trigger a test task execution to verify WABS integration
 */

import 'dotenv/config';

async function triggerTestTask() {
  console.log('\n🚀 Triggering test task execution...\n');

  try {
    // Import the task executor
    const { executeTask } = await import('./server/services/task-executor.js');

    const testTask = {
      title: 'Test WABS Integration',
      description: 'Find craft breweries in Yorkshire serving IPA',
      tool: 'search' as const,
      parameters: {
        query: 'craft breweries Yorkshire IPA',
        location: 'Yorkshire, UK'
      },
      priority: 'high' as const,
      estimatedDuration: 30
    };

    const userId = 'test-wabs-user';
    const taskId = `wabs_test_${Date.now()}`;

    console.log(`Task ID: ${taskId}`);
    console.log(`User ID: ${userId}`);
    console.log(`Description: ${testTask.description}\n`);

    console.log('⏳ Executing task (may take a moment)...\n');

    const result = await executeTask(testTask, userId, taskId);

    console.log('📊 Task Execution Result:');
    console.log(`   Status: ${result.status}`);
    console.log(`   Interesting: ${result.interesting}`);
    console.log(`   Execution Time: ${result.executionTime}ms`);

    if (result.wabsScore !== undefined) {
      console.log(`\n🎯 WABS SCORE: ${result.wabsScore}/100`);
      if (result.wabsSignals) {
        console.log(`   Relevance: ${result.wabsSignals.relevance}/100`);
        console.log(`   Novelty: ${result.wabsSignals.novelty}/100`);
        console.log(`   Actionability: ${result.wabsSignals.actionability}/100`);
        console.log(`   Urgency: ${result.wabsSignals.urgency}/100`);
      }
      console.log(`   Reason: ${result.interestingReason || 'N/A'}`);
    } else {
      console.log('\n⚠️  NO WABS SCORE (not calculated)');
    }

    if (result.error) {
      console.log(`\n❌ Error: ${result.error}`);
    }

    console.log(`\n✅ Task execution complete`);
    console.log(`\nNext: Check database for stored WABS score`);
    console.log(`Query: SELECT * FROM task_executions WHERE task_id = '${taskId}';\n`);

  } catch (error: any) {
    console.error(`\n❌ Failed to execute task: ${error.message}`);
    console.error('Stack:', error.stack);
  }
}

triggerTestTask().catch(console.error);
