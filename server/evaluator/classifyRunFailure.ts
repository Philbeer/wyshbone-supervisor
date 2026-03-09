import { FailureClassification } from './failureClassification';

export interface RunContext {
  missionParsed: boolean;
  constraintsValid: boolean;
  planGenerated: boolean;
  planEmpty: boolean;
  candidatePoolSize: number;
  requestedCount: number;
  crawlerFailed: boolean;
  crawlerReturnedEmpty: boolean;
  pagesFetched: boolean;
  evidenceItemCount: number;
  evidenceHasQuotes: boolean;
  towerRejectedStrongEvidence: boolean;
}

export interface PlanHistoryEntry {
  version: number;
  strategyId?: string;
  radiusKm?: number;
  queryText?: string;
}

function normalizeVerdict(v: string): string {
  return v.toUpperCase().replace(/[^A-Z]/g, '');
}

export function classifyRunFailure(
  runContext: RunContext,
  towerVerdict: string | null,
  planHistory: PlanHistoryEntry[],
  uiVerdict?: string | null,
): FailureClassification {
  if (!runContext.missionParsed || !runContext.constraintsValid) {
    return FailureClassification.INTERPRETATION_FAILURE;
  }

  if (runContext.planGenerated && runContext.planEmpty) {
    return FailureClassification.PLANNER_FAILURE;
  }

  if (runContext.requestedCount > 0 && runContext.candidatePoolSize < runContext.requestedCount / 2) {
    return FailureClassification.DISCOVERY_FAILURE;
  }

  if (runContext.crawlerFailed || runContext.crawlerReturnedEmpty) {
    return FailureClassification.CRAWL_FAILURE;
  }

  if (runContext.pagesFetched && (runContext.evidenceItemCount === 0 || !runContext.evidenceHasQuotes)) {
    return FailureClassification.EVIDENCE_EXTRACTION_FAILURE;
  }

  if (runContext.towerRejectedStrongEvidence) {
    return FailureClassification.TOWER_JUDGEMENT_FAILURE;
  }

  const towerRequestedReplan = towerVerdict !== null &&
    normalizeVerdict(towerVerdict) === 'CHANGEPLAN';
  if (towerRequestedReplan && planHistory.length >= 2) {
    const last = planHistory[planHistory.length - 1];
    const prev = planHistory[planHistory.length - 2];
    const identical =
      last.strategyId === prev.strategyId &&
      last.radiusKm === prev.radiusKm &&
      last.queryText === prev.queryText;
    if (identical) {
      return FailureClassification.REPLAN_FAILURE;
    }
  }

  if (
    uiVerdict !== undefined &&
    uiVerdict !== null &&
    towerVerdict !== null &&
    normalizeVerdict(uiVerdict) !== normalizeVerdict(towerVerdict)
  ) {
    return FailureClassification.UI_TRUTH_FAILURE;
  }

  return FailureClassification.NONE;
}
