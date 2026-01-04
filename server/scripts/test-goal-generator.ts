/**
 * Test Script for Autonomous Goal Generator
 *
 * Usage: npm run test:goals
 * Or: tsx server/scripts/test-goal-generator.ts
 */

import { config } from 'dotenv';
import { generateDailyTasks, generateTasksForAllUsers } from '../autonomous-agent';
import { claudeAPI } from '../services/claude-api';

// Load environment variables
config();

console.log('='.repeat(70));
console.log('🤖 AUTONOMOUS GOAL GENERATOR TEST');
console.log('='.repeat(70));
console.log('');

async function testSingleUser() {
  console.log('📊 Test 1: Generate tasks for single user');
  console.log('-'.repeat(70));

  // You need to provide a test user ID
  const testUserId = process.env.TEST_USER_ID || 'test-user-id';

  if (testUserId === 'test-user-id') {
    console.log('⚠️  TEST_USER_ID not set in .env');
    console.log('   Skipping single user test');
    console.log('');
    return;
  }

  try {
    const result = await generateDailyTasks(testUserId);

    console.log('');
    console.log('✅ Tasks generated successfully!');
    console.log('');
    console.log('User ID:', result.userId);
    console.log('Tasks Generated:', result.tasks.length);
    console.log('Model:', result.model);
    console.log('Tokens Used:', result.tokensUsed.input + result.tokensUsed.output);
    console.log('');

    if (result.tasks.length > 0) {
      console.log('📋 Generated Tasks:');
      console.log('');
      result.tasks.forEach((task, i) => {
        console.log(`${i + 1}. ${task.title} [${task.priority.toUpperCase()}]`);
        console.log(`   ${task.description}`);
        console.log(`   Duration: ${task.estimatedDuration}`);
        console.log(`   Reasoning: ${task.reasoning}`);
        console.log('');
      });
    }

    console.log('📊 Context Used:');
    console.log('   Goals:', result.contextUsed.goals.join(', '));
    console.log('   Monitors:', result.contextUsed.monitors.join(', ') || 'None');
    console.log('   Activity:', result.contextUsed.recentActivity);
    console.log('');

  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }

  console.log('');
}

async function testAllUsers() {
  console.log('📊 Test 2: Generate tasks for all users');
  console.log('-'.repeat(70));

  try {
    const result = await generateTasksForAllUsers();

    console.log('');
    console.log('✅ Bulk generation complete!');
    console.log('');
    console.log('Success:', result.success);
    console.log('Failed:', result.failed);
    console.log('Total Users:', result.results.length);
    console.log('');

    if (result.results.length > 0) {
      console.log('📊 Results by User:');
      console.log('');
      result.results.forEach(r => {
        const status = r.error ? '❌' : '✅';
        console.log(`${status} ${r.userId}: ${r.taskCount} tasks${r.error ? ` (${r.error})` : ''}`);
      });
      console.log('');
    }

  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }

  console.log('');
}

async function testRateLimits() {
  console.log('📊 Test 3: Check rate limit status');
  console.log('-'.repeat(70));

  const status = claudeAPI.getRateLimitStatus();
  console.log('');
  console.log('Rate Limit Status:');
  console.log('  Remaining calls:', status.remaining);
  console.log('  Reset in:', Math.round(status.resetIn / 1000), 'seconds');
  console.log('');
  console.log('');
}

async function main() {
  // Check if API is available
  if (!claudeAPI.isAvailable()) {
    console.error('❌ Claude API not available!');
    console.error('');
    console.error('Please set ANTHROPIC_API_KEY in your .env file:');
    console.error('  ANTHROPIC_API_KEY=sk-ant-...');
    console.error('');
    console.error('Get your API key from: https://console.anthropic.com/');
    console.error('');
    process.exit(1);
  }

  console.log('✅ Claude API initialized');
  console.log('');

  // Run tests
  await testRateLimits();
  await testSingleUser();
  await testAllUsers();

  console.log('='.repeat(70));
  console.log('🎉 TEST COMPLETE');
  console.log('='.repeat(70));
  console.log('');
}

// Run tests
main().catch(error => {
  console.error('');
  console.error('='.repeat(70));
  console.error('❌ TEST FAILED');
  console.error('='.repeat(70));
  console.error('');
  console.error('Error:', error.message);
  console.error('');
  process.exit(1);
});
