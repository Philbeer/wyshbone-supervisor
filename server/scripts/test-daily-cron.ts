/**
 * Test Daily Cron Job
 *
 * Tests the daily agent cron job functionality.
 * This script demonstrates manual triggering and status checking.
 */

import { triggerDailyAgentManually, isDailyAgentCronRunning, getNextCronRunTime } from '../cron/daily-agent';

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('🧪 DAILY CRON JOB TEST');
  console.log('='.repeat(60) + '\n');

  // Check if cron is running
  console.log('📊 Current Status:');
  console.log(`  Cron Running: ${isDailyAgentCronRunning() ? 'Yes' : 'No'}`);
  console.log(`  Next Run: ${getNextCronRunTime()}`);
  console.log(`  Schedule: ${process.env.DAILY_AGENT_CRON_SCHEDULE || '0 9 * * *'}`);
  console.log(`  Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  console.log('');

  console.log('📝 Note: This test will:');
  console.log('  1. Manually trigger the daily agent');
  console.log('  2. Process all users with active goals/monitors');
  console.log('  3. Generate and execute tasks for each user');
  console.log('  4. Log results to database');
  console.log('');

  try {
    console.log('🚀 Triggering daily agent manually...\n');

    const result = await triggerDailyAgentManually();

    console.log('\n' + '='.repeat(60));
    console.log('📊 RESULTS');
    console.log('='.repeat(60) + '\n');

    console.log('EXECUTION SUMMARY:');
    console.log(`  Cron Job ID: ${result.cronJobId}`);
    console.log(`  Duration: ${result.duration}ms (${Math.round(result.duration / 1000)}s)`);
    console.log('');

    console.log('USER PROCESSING:');
    console.log(`  Total Users: ${result.totalUsers}`);
    console.log(`  Successful: ${result.successfulUsers}`);
    console.log(`  Failed: ${result.failedUsers}`);
    console.log('');

    console.log('TASK STATISTICS:');
    console.log(`  Tasks Generated: ${result.totalTasksGenerated}`);
    console.log(`  Tasks Executed: ${result.totalTasksExecuted}`);
    console.log(`  Successful Executions: ${result.totalSuccessfulTasks}`);
    console.log(`  Interesting Results: ${result.totalInterestingResults}`);
    console.log('');

    if (result.userResults.length > 0) {
      console.log('USER DETAILS:');
      result.userResults.forEach((userResult, i) => {
        const statusEmoji = userResult.error ? '❌' : '✅';
        console.log(`  ${i + 1}. ${statusEmoji} ${userResult.userId}`);
        console.log(`     Tasks Generated: ${userResult.tasksGenerated}`);
        console.log(`     Tasks Executed: ${userResult.successful}/${userResult.tasksExecuted} successful`);
        console.log(`     Interesting: ${userResult.interesting}`);
        if (userResult.error) {
          console.log(`     Error: ${userResult.error}`);
        }
      });
      console.log('');
    }

    console.log('='.repeat(60));
    console.log('✅ TEST COMPLETE');
    console.log('='.repeat(60) + '\n');

    if (result.totalUsers === 0) {
      console.log('⚠️  No users with active goals/monitors found');
      console.log('   To test with users, add active monitors in the database');
    }

    process.exit(0);

  } catch (error: any) {
    console.error('\n❌ TEST FAILED:', error.message);
    console.error('');
    console.error('Possible causes:');
    console.error('  - Supabase not connected (DATABASE_URL)');
    console.error('  - Claude API key not configured (ANTHROPIC_API_KEY)');
    console.error('  - wyshbone-ui not running (for task execution)');
    console.error('');
    process.exit(1);
  }
}

main();
