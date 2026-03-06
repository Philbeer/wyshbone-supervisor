import { logAFREvent } from './afr-logger';
import { storage } from '../storage';

export type TowerSemanticStatus = 'verified' | 'weak_match' | 'no_evidence' | 'insufficient_evidence';

export interface TowerSemanticRequest {
  run_id: string;
  original_user_goal: string;
  lead_name: string;
  lead_place_id: string;
  constraint_to_check: string;
  source_url: string;
  evidence_text: string;
  extracted_quotes: string[];
  page_title: string | null;
}

export interface TowerSemanticResponse {
  status: TowerSemanticStatus;
  confidence: number;
  reasoning: string;
  matched_snippets?: string[];
}

function getTowerBaseUrl(): string | null {
  const raw = process.env.TOWER_BASE_URL || process.env.TOWER_URL;
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

function isStubMode(): boolean {
  return process.env.TOWER_ARTEFACT_JUDGE_STUB === 'true';
}

function stubSemanticVerification(request: TowerSemanticRequest): TowerSemanticResponse {
  const hasQuotes = request.extracted_quotes.length > 0;
  const hasEvidence = request.evidence_text.length > 100;

  if (hasQuotes && hasEvidence) {
    return {
      status: 'verified',
      confidence: 0.8,
      reasoning: `Stub mode: auto-verified "${request.constraint_to_check}" for "${request.lead_name}" based on available evidence snippets.`,
      matched_snippets: request.extracted_quotes.slice(0, 2),
    };
  }
  if (hasEvidence) {
    return {
      status: 'weak_match',
      confidence: 0.4,
      reasoning: `Stub mode: weak match for "${request.constraint_to_check}" at "${request.lead_name}" — evidence text present but no strong snippets.`,
    };
  }
  return {
    status: 'insufficient_evidence',
    confidence: 0.1,
    reasoning: `Stub mode: insufficient evidence for "${request.constraint_to_check}" at "${request.lead_name}".`,
  };
}

async function callTowerSemanticVerify(
  request: TowerSemanticRequest,
): Promise<TowerSemanticResponse> {
  const baseUrl = getTowerBaseUrl();
  if (!baseUrl) {
    throw new Error('TOWER_BASE_URL / TOWER_URL not configured');
  }

  const endpoint = `${baseUrl}/api/tower/semantic-verify`;
  const apiKey = process.env.TOWER_API_KEY || process.env.EXPORT_KEY || '';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'X-TOWER-API-KEY': apiKey } : {}),
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Tower semantic-verify HTTP ${response.status}: ${body.substring(0, 200)}`);
  }

  const data = (await response.json()) as TowerSemanticResponse;

  const validStatuses: TowerSemanticStatus[] = ['verified', 'weak_match', 'no_evidence', 'insufficient_evidence'];
  if (!validStatuses.includes(data.status)) {
    console.warn(`[TOWER_SEMANTIC] Unknown status "${data.status}" — mapping to insufficient_evidence`);
    data.status = 'insufficient_evidence';
  }

  return data;
}

export interface SemanticVerifyResult {
  towerResponse: TowerSemanticResponse;
  stubbed: boolean;
  towerAvailable: boolean;
  error?: string;
}

export async function requestSemanticVerification(params: {
  request: TowerSemanticRequest;
  userId: string;
  conversationId?: string;
  clientRequestId?: string;
}): Promise<SemanticVerifyResult> {
  const { request, userId, conversationId, clientRequestId } = params;

  await logAFREvent({
    userId,
    runId: request.run_id,
    conversationId,
    clientRequestId,
    actionTaken: 'tower_semantic_verify_requested',
    status: 'pending',
    taskGenerated: `Requesting Tower semantic verification: "${request.constraint_to_check}" for "${request.lead_name}"`,
    runType: 'plan',
    metadata: {
      lead_name: request.lead_name,
      lead_place_id: request.lead_place_id,
      constraint: request.constraint_to_check,
      source_url: request.source_url,
      evidence_length: request.evidence_text.length,
      extracted_quotes_count: request.extracted_quotes.length,
    },
  });

  if (isStubMode()) {
    const stubResult = stubSemanticVerification(request);
    console.log(`[TOWER_SEMANTIC] Stub: ${stubResult.status} for "${request.lead_name}" + "${request.constraint_to_check}" (confidence=${stubResult.confidence})`);

    await logAFREvent({
      userId,
      runId: request.run_id,
      conversationId,
      clientRequestId,
      actionTaken: 'tower_semantic_verify_completed',
      status: 'success',
      taskGenerated: `Tower semantic verify (stub): ${stubResult.status} for "${request.lead_name}" + "${request.constraint_to_check}"`,
      runType: 'plan',
      metadata: { ...stubResult, stubbed: true },
    });

    return { towerResponse: stubResult, stubbed: true, towerAvailable: true };
  }

  const baseUrl = getTowerBaseUrl();
  if (!baseUrl) {
    const errorMsg = 'TOWER_BASE_URL / TOWER_URL not configured for semantic verification';
    console.error(`[TOWER_SEMANTIC] ${errorMsg}`);

    await logAFREvent({
      userId,
      runId: request.run_id,
      conversationId,
      clientRequestId,
      actionTaken: 'tower_semantic_verify_failed',
      status: 'failed',
      taskGenerated: errorMsg,
      runType: 'plan',
      metadata: { error: errorMsg },
    });

    return {
      towerResponse: {
        status: 'insufficient_evidence',
        confidence: 0,
        reasoning: errorMsg,
      },
      stubbed: false,
      towerAvailable: false,
      error: errorMsg,
    };
  }

  try {
    const towerResponse = await callTowerSemanticVerify(request);

    console.log(`[TOWER_SEMANTIC] ${towerResponse.status} for "${request.lead_name}" + "${request.constraint_to_check}" (confidence=${towerResponse.confidence})`);

    await logAFREvent({
      userId,
      runId: request.run_id,
      conversationId,
      clientRequestId,
      actionTaken: 'tower_semantic_verify_completed',
      status: 'success',
      taskGenerated: `Tower semantic verify: ${towerResponse.status} for "${request.lead_name}" + "${request.constraint_to_check}" — ${towerResponse.reasoning}`,
      runType: 'plan',
      metadata: {
        status: towerResponse.status,
        confidence: towerResponse.confidence,
        reasoning: towerResponse.reasoning,
        matched_snippets_count: towerResponse.matched_snippets?.length ?? 0,
      },
    });

    return { towerResponse, stubbed: false, towerAvailable: true };
  } catch (err: any) {
    const errorMsg = err.message || 'Tower semantic-verify call failed';
    console.error(`[TOWER_SEMANTIC] Call failed for "${request.lead_name}" + "${request.constraint_to_check}": ${errorMsg}`);

    await logAFREvent({
      userId,
      runId: request.run_id,
      conversationId,
      clientRequestId,
      actionTaken: 'tower_semantic_verify_failed',
      status: 'failed',
      taskGenerated: `Tower semantic verify failed: ${errorMsg}`,
      runType: 'plan',
      metadata: {
        error: errorMsg,
        lead_name: request.lead_name,
        constraint: request.constraint_to_check,
      },
    });

    return {
      towerResponse: {
        status: 'insufficient_evidence',
        confidence: 0,
        reasoning: `Tower call failed: ${errorMsg}`,
      },
      stubbed: false,
      towerAvailable: false,
      error: errorMsg,
    };
  }
}

export function towerStatusToVerdict(status: TowerSemanticStatus): {
  verdict: 'yes' | 'no' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  evidenceStrength: 'strong' | 'weak' | 'none';
} {
  switch (status) {
    case 'verified':
      return { verdict: 'yes', confidence: 'high', evidenceStrength: 'strong' };
    case 'weak_match':
      return { verdict: 'yes', confidence: 'low', evidenceStrength: 'weak' };
    case 'no_evidence':
      return { verdict: 'unknown', confidence: 'high', evidenceStrength: 'none' };
    case 'insufficient_evidence':
      return { verdict: 'unknown', confidence: 'low', evidenceStrength: 'none' };
    default:
      return { verdict: 'unknown', confidence: 'low', evidenceStrength: 'none' };
  }
}
