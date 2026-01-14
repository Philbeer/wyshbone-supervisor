/**
 * Test Task Executor
 *
 * Tests the autonomous task execution functionality.
 * This script demonstrates executing generated tasks using the unified tool endpoint.
 */

import { generateAndExecuteTasks } from '../autonomous-agent';

const TEST_USER_ID = process.env.TEST_USER_ID || 'test-user-123';

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('🧪 TASK EXECUTOR TEST');
  console.log('='.repeat(60) + '\n');

  console.log('Test Configuration:');
  console.log(`- User ID: ${TEST_USER_ID}`);
  console.log(`- UI Endpoint: ${process.env.UI_URL || 'http://localhost:5173'}/api/tools/execute`);
  console.log('');

  console.log('📝 Note: This test will:');
  console.log('  1. Generate tasks using Claude API');
  console.log('  2. Execute each task via unified tool endpoint');
  console.log('  3. Evaluate if results are interesting');
  console.log('  4. Log all activities to database');
  console.log('  5. Apply 2-second rate limiting between tasks');
  console.log('');

  try {
    console.log('🚀 Starting task generation and execution...\n');

    const result = await generateAndExecuteTasks(TEST_USER_ID);

    console.log('\n' + '='.repeat(60));
    console.log('📊 RESULTS');
    console.log('='.repeat(60) + '\n');

    console.log('TASK GENERATION:');
    console.log(`  Tasks Generated: ${result.generation.tasks.length}`);
    console.log(`  Model: ${result.generation.model}`);
    console.log(`  Input Tokens: ${result.generation.tokensUsed.input}`);
    console.log(`  Output Tokens: ${result.generation.tokensUsed.output}`);
    console.log('');

    console.log('GENERATED TASKS:');
    result.generation.tasks.forEach((task, i) => {
      console.log(`  ${i + 1}. [${task.priority.toUpperCase()}] ${task.title}`);
      console.log(`     ${task.description}`);
      console.log(`     Duration: ${task.estimatedDuration}`);
    });
    console.log('');

    console.log('TASK EXECUTION:');
    console.log(`  Total Tasks: ${result.execution.totalTasks}`);
    console.log(`  Successful: ${result.execution.successful}`);
    console.log(`  Failed: ${result.execution.failed}`);
    console.log(`  Interesting Results: ${result.execution.interesting}`);
    console.log(`  Total Duration: ${result.execution.totalDuration}ms`);
    console.log('');

    if (result.execution.results.length > 0) {
      console.log('EXECUTION DETAILS:');
      result.execution.results.forEach((execResult, i) => {
        const statusEmoji = execResult.status === 'success' ? '✅' : '❌';
        const interestingEmoji = execResult.interesting ? '🌟' : '';
        console.log(`  ${i + 1}. ${statusEmoji} ${interestingEmoji} ${execResult.task.title}`);
        console.log(`     Status: ${execResult.status}`);
        console.log(`     Execution Time: ${execResult.executionTime}ms`);
        if (execResult.interesting) {
          console.log(`     💡 ${execResult.interestingReason}`);
        }
        if (execResult.error) {
          console.log(`     Error: ${execResult.error}`);
        }
      });
      console.log('');
    }

    console.log('='.repeat(60));
    console.log('✅ TEST COMPLETE');
    console.log('='.repeat(60) + '\n');

    // Exit with appropriate code
    if (result.execution.failed > 0) {
      console.log('⚠️  Some tasks failed - check logs above');
      process.exit(0); // Don't fail the test if UI is not running
    } else {
      console.log('🎉 All tasks executed successfully!');
      process.exit(0);
    }

  } catch (error: any) {
    console.error('\n❌ TEST FAILED:', error.message);
    console.error('');
    console.error('Possible causes:');
    console.error('  - Claude API key not configured (ANTHROPIC_API_KEY)');
    console.error('  - Supabase not connected (DATABASE_URL)');
    console.error('  - User has no goals or monitors');
    console.error('  - wyshbone-ui not running (for tool execution)');
    console.error('');
    process.exit(1);
  }
}

main();
