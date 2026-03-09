type LayerStatus = 'pass' | 'fail' | 'blocked' | 'timeout' | 'unknown';
type OverallOutcome = 'PASS' | 'PARTIAL_SUCCESS' | 'BLOCKED' | 'TIMEOUT' | 'FAIL';

export interface QALayerSummaryPayload {
  query: string;
  benchmark_query: boolean;
  interpretation_status: LayerStatus;
  planning_status: LayerStatus;
  execution_status: LayerStatus;
  discovery_status: LayerStatus;
  delivery_status: LayerStatus;
  verification_status: LayerStatus;
  tower_status: LayerStatus;
  overall_outcome: OverallOutcome;
  outcome_reason: string;
}

export interface QALayerInput {
  query: string;
  isBenchmarkQuery: boolean;

  missionParsed: boolean;
  constraintsExtracted: boolean;
  planGenerated: boolean;
  planEmpty: boolean;

  executionStarted: boolean;
  executionSource: 'mission' | 'legacy' | null;
  runFailed: boolean;
  runTimedOut: boolean;

  blockedByClarify: boolean;
  blockedByGate: boolean;

  leadsDiscovered: number;
  leadsDelivered: number;
  leadsWithVerification: number;

  towerVerdict: string | null;
}

export function buildQALayerSummary(input: QALayerInput): QALayerSummaryPayload {
  const interpretation = deriveInterpretation(input);
  const planning = derivePlanning(input);
  const execution = deriveExecution(input);
  const discovery = deriveDiscovery(input);
  const delivery = deriveDelivery(input);
  const verification = deriveVerification(input);
  const tower = deriveTower(input);

  const { overall_outcome, outcome_reason } = deriveOverall(
    input, interpretation, planning, execution, discovery, delivery, verification, tower,
  );

  return {
    query: input.query,
    benchmark_query: input.isBenchmarkQuery,
    interpretation_status: interpretation,
    planning_status: planning,
    execution_status: execution,
    discovery_status: discovery,
    delivery_status: delivery,
    verification_status: verification,
    tower_status: tower,
    overall_outcome,
    outcome_reason,
  };
}

function deriveInterpretation(input: QALayerInput): LayerStatus {
  if (input.blockedByClarify) return 'blocked';
  if (input.missionParsed && input.constraintsExtracted) return 'pass';
  if (!input.missionParsed) return 'fail';
  return 'unknown';
}

function derivePlanning(input: QALayerInput): LayerStatus {
  if (input.blockedByClarify || input.blockedByGate) return 'blocked';
  if (input.planGenerated && !input.planEmpty) return 'pass';
  if (input.planGenerated && input.planEmpty) return 'fail';
  if (!input.planGenerated && input.missionParsed) return 'fail';
  return 'unknown';
}

function deriveExecution(input: QALayerInput): LayerStatus {
  if (input.blockedByClarify || input.blockedByGate) return 'blocked';
  if (input.runTimedOut) return 'timeout';
  if (input.executionStarted && !input.runFailed) return 'pass';
  if (input.executionStarted && input.runFailed) return 'fail';
  if (!input.executionStarted) return 'blocked';
  return 'unknown';
}

function deriveDiscovery(input: QALayerInput): LayerStatus {
  if (input.blockedByClarify || input.blockedByGate) return 'blocked';
  if (!input.executionStarted) return 'blocked';
  if (input.leadsDiscovered > 0) return 'pass';
  if (input.executionStarted && input.leadsDiscovered === 0) return 'fail';
  return 'unknown';
}

function deriveDelivery(input: QALayerInput): LayerStatus {
  if (input.blockedByClarify || input.blockedByGate) return 'blocked';
  if (!input.executionStarted) return 'blocked';
  if (input.leadsDelivered > 0) return 'pass';
  if (input.executionStarted && input.leadsDelivered === 0) return 'fail';
  return 'unknown';
}

function deriveVerification(input: QALayerInput): LayerStatus {
  if (input.blockedByClarify || input.blockedByGate) return 'blocked';
  if (!input.executionStarted) return 'blocked';
  if (input.leadsDelivered > 0 && input.leadsWithVerification > 0) return 'pass';
  if (input.leadsDelivered > 0 && input.leadsWithVerification === 0) return 'fail';
  if (input.leadsDelivered === 0) return 'blocked';
  return 'unknown';
}

function deriveTower(input: QALayerInput): LayerStatus {
  if (!input.towerVerdict) return 'unknown';
  const v = input.towerVerdict.toLowerCase();
  if (v === 'pass' || v === 'accepted' || v === 'continue') return 'pass';
  if (v === 'fail' || v === 'stop' || v === 'rejected') return 'fail';
  if (v === 'timeout') return 'timeout';
  if (v === 'error') return 'fail';
  return 'unknown';
}

function deriveOverall(
  input: QALayerInput,
  interpretation: LayerStatus,
  planning: LayerStatus,
  execution: LayerStatus,
  discovery: LayerStatus,
  delivery: LayerStatus,
  verification: LayerStatus,
  tower: LayerStatus,
): { overall_outcome: OverallOutcome; outcome_reason: string } {
  if (input.blockedByClarify || input.blockedByGate) {
    return { overall_outcome: 'BLOCKED', outcome_reason: input.blockedByClarify ? 'Clarify gate blocked execution' : 'Constraint gate blocked execution' };
  }

  if (input.runTimedOut) {
    return { overall_outcome: 'TIMEOUT', outcome_reason: 'Run timed out before completion' };
  }

  if (interpretation === 'fail') {
    return { overall_outcome: 'FAIL', outcome_reason: 'Mission interpretation failed' };
  }

  if (planning === 'fail') {
    return { overall_outcome: 'FAIL', outcome_reason: 'Plan generation failed' };
  }

  if (execution === 'fail') {
    return { overall_outcome: 'FAIL', outcome_reason: 'Execution failed with error' };
  }

  if (discovery === 'fail') {
    return { overall_outcome: 'FAIL', outcome_reason: 'Discovery found zero leads' };
  }

  if (delivery === 'fail') {
    return { overall_outcome: 'FAIL', outcome_reason: 'No leads delivered' };
  }

  const coreLayersPass = discovery === 'pass' && delivery === 'pass';

  if (coreLayersPass && verification === 'pass' && tower === 'pass') {
    return { overall_outcome: 'PASS', outcome_reason: 'All layers passed' };
  }

  if (coreLayersPass && (verification === 'fail' || tower === 'fail')) {
    const failedLayers: string[] = [];
    if (verification === 'fail') failedLayers.push('verification');
    if (tower === 'fail') failedLayers.push('tower');
    return { overall_outcome: 'PARTIAL_SUCCESS', outcome_reason: `Discovery and delivery passed but ${failedLayers.join(' and ')} failed` };
  }

  if (coreLayersPass && tower === 'unknown') {
    return { overall_outcome: verification === 'pass' ? 'PASS' : 'PARTIAL_SUCCESS', outcome_reason: verification === 'pass' ? 'Discovery, delivery, and verification passed; Tower did not run' : 'Discovery and delivery passed; verification incomplete; Tower did not run' };
  }

  return { overall_outcome: 'FAIL', outcome_reason: 'Run did not complete successfully' };
}
