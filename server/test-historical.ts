/**
 * SUP-012: Test script for historical performance integration
 * 
 * This script demonstrates how historical execution data guides future planning.
 */

import { planLeadGenerationWithHistory } from "./types/lead-gen-plan";
import type { LeadGenGoal, LeadGenContext } from "./types/lead-gen-plan";
import { db } from "./db";
import { planExecutions, suggestedLeads } from "@shared/schema";
import { sql } from "drizzle-orm";

async function seedHistoricalData() {
  console.log('\n[TEST] Seeding historical performance data...\n');
  
  // Create some historical plan executions with varying success
  const testUserId = "test-user-123";
  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  
  // Successful execution: pubs in North West via email
  const execution1 = await db.insert(planExecutions).values({
    planId: 'test-plan-1',
    userId: testUserId,
    accountId: 'test-account', // SUP-012: Account isolation
    goalText: 'Find pubs in North West and email landlords',
    overallStatus: 'succeeded',
    startedAt: twoWeeksAgo,
    finishedAt: twoWeeksAgo,
    stepResults: [],
    metadata: {
      niche: 'pub landlords',
      region: 'North West',
      totalLeadsFound: 45
    }
  }).returning();
  
  // Add leads for this execution (high score = successful)
  for (let i = 0; i < 45; i++) {
    await db.insert(suggestedLeads).values({
      userId: testUserId,
      accountId: 'test-account', // SUP-012: Account isolation
      rationale: `High-quality pub match in North West`,
      source: 'google_places',
      score: 85,
      lead: {
        businessName: `Pub ${i + 1}`,
        niche: 'pub landlords',
        region: 'North West',
        emailCandidates: ['landlord@pub.com'],
        tags: ['pubs', 'hospitality'],
        planExecutionId: execution1[0].id
      }
    });
  }
  
  // Failed execution: restaurants in South East via phone
  const execution2 = await db.insert(planExecutions).values({
    planId: 'test-plan-2',
    userId: testUserId,
    accountId: 'test-account', // SUP-012: Account isolation
    goalText: 'Find restaurants in South East for phone outreach',
    overallStatus: 'failed',
    startedAt: oneWeekAgo,
    finishedAt: oneWeekAgo,
    stepResults: [],
    metadata: {
      niche: 'restaurant owners',
      region: 'South East',
      totalLeadsFound: 5
    }
  }).returning();
  
  // Add minimal leads (low score = unsuccessful)
  for (let i = 0; i < 5; i++) {
    await db.insert(suggestedLeads).values({
      userId: testUserId,
      accountId: 'test-account', // SUP-012: Account isolation
      rationale: `Low-quality restaurant match, no emails found`,
      source: 'hunter_io',
      score: 25,
      lead: {
        businessName: `Restaurant ${i + 1}`,
        niche: 'restaurant owners',
        region: 'South East',
        emailCandidates: [],
        tags: ['restaurants'],
        planExecutionId: execution2[0].id
      }
    });
  }
  
  // Another successful execution: cafes in North West via email
  const execution3 = await db.insert(planExecutions).values({
    planId: 'test-plan-3',
    userId: testUserId,
    accountId: 'test-account', // SUP-012: Account isolation
    goalText: 'Find cafes in North West and email owners',
    overallStatus: 'succeeded',
    startedAt: oneWeekAgo,
    finishedAt: oneWeekAgo,
    stepResults: [],
    metadata: {
      niche: 'cafe owners',
      region: 'North West',
      totalLeadsFound: 38
    }
  }).returning();
  
  // Add leads for this execution
  for (let i = 0; i < 38; i++) {
    await db.insert(suggestedLeads).values({
      userId: testUserId,
      accountId: 'test-account', // SUP-012: Account isolation
      rationale: `Quality cafe match in North West`,
      source: 'google_places',
      score: 78,
      lead: {
        businessName: `Cafe ${i + 1}`,
        niche: 'cafe owners',
        region: 'North West',
        emailCandidates: ['owner@cafe.com'],
        tags: ['cafes', 'hospitality'],
        planExecutionId: execution3[0].id
      }
    });
  }
  
  console.log('[TEST] Seeded 3 plan executions with 88 total leads');
  console.log('  - Execution 1: pubs in North West (45 leads, succeeded)');
  console.log('  - Execution 2: restaurants in South East (5 leads, failed)');
  console.log('  - Execution 3: cafes in North West (38 leads, succeeded)\n');
}

async function testHistoricalPlanning() {
  console.log('[TEST] Testing planLeadGenerationWithHistory...\n');
  
  // Test Case 1: User with historical data - vague goal should use history
  console.log('=== TEST CASE 1: User with history - vague goal ===\n');
  
  const vagueGoal: LeadGenGoal = {
    rawGoal: "Find some local businesses",
    volume: 50
  };
  
  const context: LeadGenContext = {
    userId: "test-user-123", // This user has historical data
    accountId: "test-account",
    defaultCountry: "GB"
  };
  
  const plan1 = await planLeadGenerationWithHistory(vagueGoal, context);
  
  console.log('\nGenerated Plan:');
  console.log('  ID:', plan1.id);
  console.log('  Title:', plan1.title);
  console.log('  Target Persona:', plan1.goal.targetPersona || 'not specified');
  console.log('  Target Region:', plan1.goal.targetRegion || plan1.context.defaultRegion || 'not specified');
  console.log('  Preferred Channels:', plan1.goal.preferredChannels || 'not specified');
  console.log('  Steps:', plan1.steps.length);
  
  // Test Case 2: User with historical data - specific goal should be respected
  console.log('\n\n=== TEST CASE 2: User with history - specific goal ===\n');
  
  const specificGoal: LeadGenGoal = {
    rawGoal: "Find gyms in London for linkedin outreach",
    targetPersona: "gym owners",
    targetRegion: "London",
    preferredChannels: ["linkedin"],
    volume: 30
  };
  
  const plan2 = await planLeadGenerationWithHistory(specificGoal, context);
  
  console.log('\nGenerated Plan:');
  console.log('  ID:', plan2.id);
  console.log('  Title:', plan2.title);
  console.log('  Target Persona:', plan2.goal.targetPersona);
  console.log('  Target Region:', plan2.goal.targetRegion);
  console.log('  Preferred Channels:', plan2.goal.preferredChannels);
  console.log('  Steps:', plan2.steps.length);
  
  // Test Case 3: New user (cold start) - should NOT see other users' history
  console.log('\n\n=== TEST CASE 3: New user cold start (CRITICAL: user isolation test) ===\n');
  
  const newUserContext: LeadGenContext = {
    userId: "new-user-456", // Different user - should not see test-user-123's data
    accountId: "new-account",
    defaultCountry: "GB",
    defaultRegion: "Scotland"
  };
  
  const newUserGoal: LeadGenGoal = {
    rawGoal: "Find tech startups in Edinburgh",
    volume: 20
  };
  
  const plan3 = await planLeadGenerationWithHistory(newUserGoal, newUserContext);
  
  console.log('\nGenerated Plan (should preserve user inputs, NOT use other user\'s history):');
  console.log('  ID:', plan3.id);
  console.log('  Title:', plan3.title);
  console.log('  Target Persona:', plan3.goal.targetPersona || 'not specified');
  console.log('  Target Region:', plan3.goal.targetRegion || plan3.context.defaultRegion);
  console.log('  Steps:', plan3.steps.length);
  
  // CRITICAL ASSERTION: New user should NOT get "cafe owners" from test-user-123's history
  if (plan3.goal.targetPersona === 'cafe owners' || plan3.goal.targetPersona === 'pub landlords') {
    console.error('\n❌ SECURITY FAILURE: New user received historical insights from another user!');
    console.error('   This is a critical data isolation/privacy violation.');
    throw new Error('User isolation test failed - cross-user data leakage detected');
  }
  
  console.log('\n✅ User isolation verified: New user did not receive other user\'s historical data');
  
  // ========================================
  // TEST CASE 4: Multi-account isolation
  // ========================================
  
  console.log('\n\n=== TEST CASE 4: Multi-account isolation (CRITICAL: account separation test) ===\n');
  
  // Same user, but different account with different history
  const accountTwoExecution = await db.insert(planExecutions).values({
    planId: 'test-plan-account2',
    userId: "test-user-123", // Same user!
    accountId: 'account-two', // Different account
    goalText: 'Find hotels in Scotland',
    overallStatus: 'succeeded',
    startedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    finishedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    stepResults: [],
    metadata: {
      niche: 'hotels',
      region: 'Scotland',
      totalLeadsFound: 60
    }
  }).returning();
  
  // Add leads for account-two
  for (let i = 0; i < 60; i++) {
    await db.insert(suggestedLeads).values({
      userId: "test-user-123",
      accountId: 'account-two',
      rationale: `Quality hotel match in Scotland`,
      source: 'google_places',
      score: 88,
      lead: {
        businessName: `Hotel ${i + 1}`,
        niche: 'hotels',
        region: 'Scotland',
        emailCandidates: ['manager@hotel.com'],
        tags: ['hotels', 'hospitality'],
        planExecutionId: accountTwoExecution[0].id
      }
    });
  }
  
  // Test: Same user, account-one should see pubs/cafes, NOT hotels
  const accountOneContext: LeadGenContext = {
    userId: "test-user-123",
    accountId: "test-account", // Original account
    defaultCountry: "GB"
  };
  
  const plan4a = await planLeadGenerationWithHistory(vagueGoal, accountOneContext);
  
  console.log('Account-One Plan (should see pubs/cafes history):');
  console.log(`  Target Persona: ${plan4a.goal.targetPersona || 'not specified'}`);
  
  // Test: Same user, account-two should see hotels, NOT pubs/cafes
  const accountTwoContext: LeadGenContext = {
    userId: "test-user-123",
    accountId: "account-two", // Different account
    defaultCountry: "GB"
  };
  
  const plan4b = await planLeadGenerationWithHistory(vagueGoal, accountTwoContext);
  
  console.log('Account-Two Plan (should see hotels history):');
  console.log(`  Target Persona: ${plan4b.goal.targetPersona || 'not specified'}`);
  
  // CRITICAL ASSERTION: Account isolation
  if (plan4a.goal.targetPersona === 'hotels') {
    console.error('\n❌ SECURITY FAILURE: Account-one received account-two data!');
    console.error('   This is a critical multi-account isolation violation.');
    throw new Error('Account isolation test failed - cross-account data leakage detected');
  }
  if (plan4b.goal.targetPersona === 'pubs' || plan4b.goal.targetPersona === 'cafes') {
    console.error('\n❌ SECURITY FAILURE: Account-two received account-one data!');
    console.error('   This is a critical multi-account isolation violation.');
    throw new Error('Account isolation test failed - cross-account data leakage detected');
  }
  
  console.log('\n✅ Account isolation verified: Same user\'s different accounts have separate histories');
  
  // Clean up account-two data
  await db.delete(suggestedLeads).where(sql`${suggestedLeads.accountId} = 'account-two'`);
  await db.delete(planExecutions).where(sql`${planExecutions.accountId} = 'account-two'`);
}

async function cleanup() {
  console.log('\n\n[TEST] Cleaning up test data...');
  
  // Clean up in reverse dependency order
  await db.delete(suggestedLeads).where(sql`user_id = 'test-user-123'`);
  await db.delete(planExecutions).where(sql`user_id = 'test-user-123'`);
  
  console.log('[TEST] Cleanup complete\n');
}

async function main() {
  try {
    console.log('\n========================================');
    console.log('SUP-012: Historical Performance Test');
    console.log('========================================\n');
    
    // Clean up any existing test data first
    await cleanup();
    
    // Seed historical data
    await seedHistoricalData();
    
    // Run tests
    await testHistoricalPlanning();
    
    // Clean up
    await cleanup();
    
    console.log('========================================');
    console.log('All tests completed successfully!');
    console.log('========================================\n');
    
  } catch (error) {
    console.error('\n[ERROR] Test failed:', error);
    await cleanup();
    process.exit(1);
  }
  
  process.exit(0);
}

main();
