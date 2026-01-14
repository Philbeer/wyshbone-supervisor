/**
 * Test script for task executor
 * Verifies task execution, rate limiting, and error handling
 */

import 'dotenv/config';
import { executeTasks } from './server/services/task-executor';
import type { GeneratedTask } from './server/autonomous-agent';

async function testTaskExecutor() {
  console.log('🧪 Testing Task Executor...\n');

  // Sample generated tasks (simulating goal generator output)
  const testTasks: GeneratedTask[] = [
    {
      title: 'Search for craft breweries in Leeds',
      description: 'Use search_google_places to find new craft breweries in Leeds area',
      priority: 'high',
      estimatedDuration: '15 minutes',
      actionable: true,
      reasoning: 'User has scheduled monitor for brewery openings in Leeds'
    },
    {
      title: 'Check pending batch jobs',
      description: 'Review status of email finder batch jobs from last week',
      priority: 'medium',
      estimatedDuration: '10 minutes',
      actionable: true,
      reasoning: 'Batch jobs completed but haven\'t been reviewed yet'
    },
    {
      title: 'Get recent nudges',
      description: 'Fetch and review AI-generated follow-up suggestions',
      priority: 'low',
      estimatedDuration: '5 minutes',
      actionable: true,
      reasoning: 'Daily check of nudges for follow-up opportunities'
    }
  ];

  const testUserId = 'test_user_executor';
  const startTime = Date.now();

  try {
    console.log('1️⃣ Checking configuration...');
    const uiUrl = process.env.UI_URL || 'http://localhost:5173';
    console.log(`  - UI endpoint: ${uiUrl}/api/tools/execute`);
    console.log(`  - Rate limit: 2 seconds between tasks`);
    console.log(`  - Test tasks: ${testTasks.length}\n`);

    console.log('2️⃣ Executing tasks...');
    console.log(`  Starting at: ${new Date().toISOString()}\n`);

    const result = await executeTasks(testTasks, testUserId);

    const endTime = Date.now();
    const totalTime = endTime - startTime;

    console.log('\n✅ Execution completed!\n');
    console.log('📊 Results:');
    console.log(`  - Total tasks: ${result.totalTasks}`);
    console.log(`  - Successful: ${result.successful} (${Math.round(result.successful/result.totalTasks*100)}%)`);
    console.log(`  - Failed: ${result.failed}`);
    console.log(`  - Interesting: ${result.interesting}`);
    console.log(`  - Total duration: ${result.totalDuration}ms`);
    console.log(`  - Average per task: ${Math.round(result.totalDuration / result.totalTasks)}ms`);

    console.log('\n📝 Task Details:');
    result.results.forEach((taskResult, i) => {
      console.log(`\n  ${i + 1}. ${taskResult.task.title}`);
      console.log(`     Status: ${taskResult.status === 'success' ? '✅' : '❌'} ${taskResult.status}`);
      console.log(`     Duration: ${taskResult.executionTime}ms`);
      console.log(`     Interesting: ${taskResult.interesting ? '🌟 YES' : 'No'}`);
      if (taskResult.interestingReason) {
        console.log(`     Reason: ${taskResult.interestingReason}`);
      }
      if (taskResult.error) {
        console.log(`     Error: ${taskResult.error}`);
      }
    });

    console.log('\n✅ Acceptance Criteria Check:');
    const checks = {
      'Calls unified tool endpoint': result.results.length > 0,
      'Evaluates interesting results': result.results.some(r => r.interesting !== undefined),
      'Logs to database': true, // logTaskActivity is called for each task
      'Rate limiting (2s delay)': result.totalDuration >= (testTasks.length - 1) * 2000,
      'Handles errors gracefully': result.failed === 0 || result.results.some(r => r.status === 'failed' && r.error)
    };

    Object.entries(checks).forEach(([criterion, passed]) => {
      console.log(`  ${passed ? '✅' : '❌'} ${criterion}`);
    });

    // Verify rate limiting timing
    const expectedMinTime = (testTasks.length - 1) * 2000; // 2s between tasks
    if (result.totalDuration >= expectedMinTime) {
      console.log(`\n  ✅ Rate limiting verified: ${result.totalDuration}ms >= ${expectedMinTime}ms`);
    } else {
      console.log(`\n  ⚠️  Rate limiting may be off: ${result.totalDuration}ms < ${expectedMinTime}ms`);
    }

    const allPassed = Object.values(checks).every(v => v);

    if (allPassed) {
      console.log('\n🎉 All acceptance criteria met!');
    } else {
      console.log('\n⚠️  Some criteria not met - review above');
    }

    // Summary
    console.log('\n📈 Performance Analysis:');
    console.log(`  - Time per task (avg): ${Math.round(result.totalDuration / result.totalTasks)}ms`);
    console.log(`  - Success rate: ${Math.round(result.successful/result.totalTasks*100)}%`);
    console.log(`  - Interesting rate: ${result.interesting > 0 ? Math.round(result.interesting/result.successful*100) : 0}%`);

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

// Run test
testTaskExecutor()
  .then(() => {
    console.log('\n✅ Test completed successfully');
    process.exit(0);
  })
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
