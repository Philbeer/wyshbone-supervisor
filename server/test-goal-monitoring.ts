/**
 * Test script for SUP-003: Goal Monitoring
 * 
 * This script demonstrates the goal monitoring functionality by:
 * 1. Running monitorGoalsOnce() to check goal status
 * 2. Publishing any detected issues
 * 
 * Run with: tsx server/test-goal-monitoring.ts
 */

import { monitorGoalsOnce, publishGoalMonitorEvents } from './goal-monitoring';

async function runGoalMonitoringTest() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║   SUP-003 Goal Monitoring Test        ║');
  console.log('╚════════════════════════════════════════╝\n');

  console.log('Running goal monitoring check...\n');

  try {
    // Run monitoring once
    const events = await monitorGoalsOnce();

    if (events.length === 0) {
      console.log('✅ No issues detected - all goals are progressing normally\n');
      console.log('This means either:');
      console.log('  - No active monitors/goals exist in the system');
      console.log('  - All active goals have recent activity (< 48 hours)');
      console.log('  - Supabase is not configured (check environment variables)\n');
      return;
    }

    // Publish events
    await publishGoalMonitorEvents(events);

    console.log('\n📊 Summary:');
    console.log(`  Total issues found: ${events.length}`);
    
    const byStatus = events.reduce((acc, event) => {
      acc[event.status] = (acc[event.status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    Object.entries(byStatus).forEach(([status, count]) => {
      console.log(`  - ${status.toUpperCase()}: ${count}`);
    });

    console.log('\n✅ Goal monitoring test completed');

  } catch (error) {
    console.error('\n❌ Error during goal monitoring test:', error);
    process.exit(1);
  }
}

// Run the test
runGoalMonitoringTest()
  .then(() => {
    console.log('\nTest finished successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Test failed:', error);
    process.exit(1);
  });
