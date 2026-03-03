import { createArtefact } from './artefacts';
import type { ExactnessMode } from './goal-to-constraints';

export interface SearchQueryCompiledPayload {
  interpreted_location: string;
  interpreted_query: string;
  requested_count: number | null;
  exactness_mode: ExactnessMode;
  do_not_stop_ignored: boolean;
  search_mode: string;
  pages_budget_allowed: number;
  pages_budget_used: number;
  radius_start: number;
  radius_current: number;
  radius_escalated: boolean;
  candidate_count_from_google: number;
  final_returned_count: number;
  stop_reason: string;
  original_goal: string;
  query_broadening_applied: boolean;
  query_broadening_terms: string | null;
  replans_used: number;
  max_replans: number;
}

export async function emitSearchQueryCompiled(params: {
  runId: string;
  userId: string;
  conversationId?: string;
  payload: SearchQueryCompiledPayload;
}): Promise<void> {
  const { runId, userId, conversationId, payload } = params;

  const title = `Search Query Compiled: ${payload.interpreted_query} in ${payload.interpreted_location}`;
  const summary = `query="${payload.interpreted_query}" location="${payload.interpreted_location}" requested=${payload.requested_count ?? 'any'} exactness=${payload.exactness_mode} candidates_from_google=${payload.candidate_count_from_google} final=${payload.final_returned_count} stop=${payload.stop_reason}`;

  try {
    await createArtefact({
      runId,
      type: 'search_query_compiled',
      title,
      summary,
      payload: payload as unknown as Record<string, unknown>,
      userId,
      conversationId,
    });
    console.log(`[SEARCH_QUERY_COMPILED] runId=${runId} location="${payload.interpreted_location}" query="${payload.interpreted_query}" requested=${payload.requested_count} exactness=${payload.exactness_mode} candidates=${payload.candidate_count_from_google} final=${payload.final_returned_count} stop=${payload.stop_reason}`);
  } catch (err: any) {
    console.error(`[SEARCH_QUERY_COMPILED] Failed to emit artefact: ${err.message}`);
  }
}
