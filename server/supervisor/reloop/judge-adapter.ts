import type { ExecutorOutput, JudgeVerdict, VariableState } from './types';

export function evaluate(params: {
  executorOutput: ExecutorOutput;
  requestedCount: number | null;
  knownEntityNames: string[];
  availableExecutors: string[];
  executorsTriedSoFar: string[];
}): JudgeVerdict {
  const RESULT_CONCERN_RATIO = parseFloat(process.env.RELOOP_RESULT_CONCERN_RATIO ?? '0.7');
  const COVERAGE_CONCERN_PCT = parseInt(process.env.RELOOP_COVERAGE_CONCERN_PCT ?? '70', 10);
  const EVIDENCE_QUALITY_RATIO = parseFloat(process.env.RELOOP_EVIDENCE_QUALITY_RATIO ?? '0.5');
  const CAPABILITY_FAIL_PCT = parseInt(process.env.RELOOP_CAPABILITY_FAIL_PCT ?? '50', 10);
  const PARTIAL_RELOOP_PCT = parseInt(process.env.RELOOP_PARTIAL_RELOOP_PCT ?? '60', 10);

  console.log(`[RELOOP_JUDGE] Thresholds: RESULT_CONCERN_RATIO=${RESULT_CONCERN_RATIO} COVERAGE_CONCERN_PCT=${COVERAGE_CONCERN_PCT} EVIDENCE_QUALITY_RATIO=${EVIDENCE_QUALITY_RATIO} CAPABILITY_FAIL_PCT=${CAPABILITY_FAIL_PCT} PARTIAL_RELOOP_PCT=${PARTIAL_RELOOP_PCT}`);

  const { executorOutput, requestedCount, knownEntityNames, availableExecutors, executorsTriedSoFar } = params;

  const entities = executorOutput.entities;
  const found = entities.length;
  const expected = requestedCount;

  const duplicates = entities.filter(e =>
    knownEntityNames.includes(e.name.toLowerCase().replace(/^the\s+/i, '').trim()),
  );
  const duplicateRate = knownEntityNames.length > 0 ? duplicates.length / Math.max(found, 1) : 0;

  const verifiedCount = entities.filter(e => e.verified).length;
  const totalCount = found;

  const coveragePercent = expected !== null && expected > 0
    ? Math.round((found / expected) * 100)
    : null;

  const toolExhausted = executorOutput.coverageSignals.maxResultsHit || executorOutput.coverageSignals.searchQueriesExhausted;

  const variableState: VariableState = {
    resultCount: {
      found,
      expected,
      concern: expected !== null ? found < expected * RESULT_CONCERN_RATIO : found === 0,
    },
    toolExhaustion: {
      exhausted: toolExhausted,
      tool: executorOutput.executorType,
      concern: toolExhausted,
    },
    coverageGap: {
      percentage: coveragePercent,
      concern: coveragePercent !== null ? coveragePercent < COVERAGE_CONCERN_PCT : false,
    },
    evidenceQuality: {
      verifiedCount,
      totalCount,
      concern: totalCount > 0 ? verifiedCount / totalCount < EVIDENCE_QUALITY_RATIO : false,
    },
    duplicateRate: {
      rate: duplicateRate,
      concern: duplicateRate > 0.5,
    },
  };

  const errors = executorOutput.executionMetadata.errorsEncountered;
  const rateLimitsHit = executorOutput.executionMetadata.rateLimitsHit;

  const hasErrors = errors.length > 0 || rateLimitsHit;
  const hasCoverage = !variableState.resultCount.concern;
  const toolMaxed = variableState.toolExhaustion.concern;
  const significantCoverageGap = variableState.coverageGap.concern && (coveragePercent !== null && coveragePercent < CAPABILITY_FAIL_PCT);

  let verdict: JudgeVerdict['verdict'];
  let confidence: number;
  let recommendation: JudgeVerdict['recommendation'];
  let recommendationReason: string;

  if (hasErrors && found === 0) {
    verdict = 'EXECUTION_FAIL';
    confidence = 0.9;
    recommendation = 're_loop';
    recommendationReason = `Execution errors (${errors.join(', ')}) prevented results. Retry recommended.`;
  } else if (toolMaxed && significantCoverageGap) {
    verdict = 'CAPABILITY_FAIL';
    confidence = 0.85;
    const untriedExecutors = availableExecutors.filter(e => !executorsTriedSoFar.includes(e));
    recommendation = untriedExecutors.length > 0 ? 're_loop_different_tool' : 'deliver';
    recommendationReason = `Tool ${executorOutput.executorType} hit its cap with only ${coveragePercent}% coverage. ${untriedExecutors.length > 0 ? 'Try a different tool.' : 'No more tools available.'}`;
  } else if (hasCoverage && !variableState.evidenceQuality.concern) {
    verdict = 'PASS';
    confidence = 0.85;
    recommendation = 'deliver';
    recommendationReason = `Sufficient results found (${found}${expected !== null ? '/' + expected : ''}) with adequate evidence quality.`;
  } else if (found > 0) {
    verdict = 'PARTIAL';
    confidence = 0.6;
    const untriedExecutors = availableExecutors.filter(e => !executorsTriedSoFar.includes(e));
    recommendation = (untriedExecutors.length > 0 && coveragePercent !== null && coveragePercent < PARTIAL_RELOOP_PCT)
      ? 're_loop'
      : 'deliver';
    recommendationReason = `Partial results (${found}${expected !== null ? '/' + expected : ''}). Coverage at ${coveragePercent ?? '?'}%.`;
  } else {
    verdict = 'PARTIAL';
    confidence = 0.4;
    recommendation = 'deliver';
    recommendationReason = `No results found. Delivering empty set.`;
  }

  const sourceTierMix: Record<string, number> = {};
  for (const entity of entities) {
    sourceTierMix[entity.source] = (sourceTierMix[entity.source] ?? 0) + 1;
  }

  const rawTowerVerdictFromResult = (executorOutput.rawResult as any)?.towerVerdict ?? null;

  console.log(`[RELOOP_JUDGE] executor=${executorOutput.executorType} verdict=${verdict} confidence=${confidence} recommendation=${recommendation} found=${found} expected=${expected}`);

  return {
    verdict,
    confidence,
    variableState,
    evidenceSummary: {
      totalChecks: totalCount,
      checksWithEvidence: verifiedCount,
      towerVerified: verifiedCount,
      sourceTierMix,
    },
    recommendation,
    recommendationReason,
    rawTowerVerdict: typeof rawTowerVerdictFromResult === 'string' ? rawTowerVerdictFromResult : null,
    rawTowerPayload: (executorOutput.rawResult as Record<string, unknown>) ?? null,
  };
}
