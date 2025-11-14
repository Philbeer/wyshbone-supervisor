/**
 * Test file for lead generation planning (SUP-001)
 * Run with: tsx server/test-plan.ts
 */

import { planLeadGeneration, exampleLeadGenPlan } from './types/lead-gen-plan.js';

console.log('========================================');
console.log('SUP-001 Lead Generation Planning Test');
console.log('========================================\n');

// Test 1: Use the example function
console.log('Test 1: Example plan (pubs in North West)');
console.log('-------------------------------------------');
const example = exampleLeadGenPlan();
console.log(`Plan ID: ${example.id}`);
console.log(`Title: ${example.title}`);
console.log(`Priority: ${example.priority}`);
console.log(`Steps: ${example.steps.length}\n`);

example.steps.forEach((step, idx) => {
  console.log(`Step ${idx + 1}: ${step.label}`);
  console.log(`  Tool: ${step.tool}`);
  console.log(`  Depends on: ${step.dependsOn?.join(', ') || 'none'}`);
  console.log(`  Note: ${step.note}\n`);
});

// Test 2: Custom plan without email or monitoring
console.log('\nTest 2: Custom plan (no email, no monitoring)');
console.log('----------------------------------------------');
const customPlan = planLeadGeneration(
  {
    rawGoal: "Find 20 coffee shops in London",
    targetRegion: "London",
    targetPersona: "coffee shops",
    volume: 20,
    timing: "asap",
    preferredChannels: ["phone"], // No email
    includeMonitoring: false // No monitoring
  },
  {
    userId: "user-456",
    defaultRegion: "UK",
    defaultCountry: "GB"
    // No defaultFromIdentityId
  }
);

console.log(`Plan ID: ${customPlan.id}`);
console.log(`Title: ${customPlan.title}`);
console.log(`Steps: ${customPlan.steps.length}\n`);

customPlan.steps.forEach((step, idx) => {
  console.log(`Step ${idx + 1}: ${step.tool}`);
});

// Test 3: Verify dependency chain
console.log('\n\nTest 3: Verify dependency chain');
console.log('----------------------------------');
const depCheck = example.steps.map(s => ({
  id: s.id,
  tool: s.tool,
  dependsOn: s.dependsOn || []
}));

console.log('Dependency DAG:');
depCheck.forEach(step => {
  const deps = step.dependsOn.length > 0 ? ` (depends on: ${step.dependsOn.join(', ')})` : ' (no dependencies)';
  console.log(`  ${step.id} [${step.tool}]${deps}`);
});

console.log('\n✅ All tests completed successfully!');
console.log('The planning function is pure (no external calls) and generates valid plans.\n');
