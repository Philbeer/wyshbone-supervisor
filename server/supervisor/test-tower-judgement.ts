/**
 * Integration test script for Tower Judgement API connectivity.
 * 
 * Usage:
 *   npx tsx server/supervisor/test-tower-judgement.ts
 * 
 * Requires TOWER_URL (and optionally TOWER_API_KEY / EXPORT_KEY) in env.
 * Sends a sample evaluate request and prints the verdict.
 */

import {
  callTowerEvaluate,
  LEADGEN_SUCCESS_DEFAULTS,
  type TowerEvaluateRequest,
  type TowerSnapshot,
} from './tower-judgement';

async function main() {
  const towerUrl = process.env.TOWER_URL;
  if (!towerUrl) {
    console.error('[TEST] TOWER_URL is not set. Skipping integration test.');
    process.exit(1);
  }

  console.log(`[TEST] TOWER_URL = ${towerUrl.replace(/\/+$/, '')}`);

  const snapshot: TowerSnapshot = {
    steps_completed: 5,
    leads_found: 2,
    leads_new_last_window: 0,
    failures_count: 2,
    total_cost_gbp: 1.80,
    avg_quality_score: 0.5,
  };

  const request: TowerEvaluateRequest = {
    run_id: `test_run_${Date.now()}`,
    mission_type: 'leadgen',
    success: LEADGEN_SUCCESS_DEFAULTS,
    snapshot,
  };

  console.log('[TEST] Sending evaluate request:', JSON.stringify(request, null, 2));

  try {
    const verdict = await callTowerEvaluate(request);
    console.log('[TEST] Response received:');
    console.log(`  verdict:      ${verdict.verdict}`);
    console.log(`  reason_code:  ${verdict.reason_code}`);
    console.log(`  explanation:  ${verdict.explanation}`);
    console.log(`  evaluated_at: ${verdict.evaluated_at}`);
    console.log('[TEST] Integration test PASSED');
  } catch (err: any) {
    console.error(`[TEST] Integration test FAILED: ${err.message}`);
    process.exit(1);
  }
}

main();
