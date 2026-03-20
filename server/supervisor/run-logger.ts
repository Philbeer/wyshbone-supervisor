/**
 * Run Logger — structured, per-run event logging to the run_logs Supabase table.
 *
 * Rules:
 *  - Always fire-and-forget (.then().catch()) — never await in the hot path.
 *  - Never throw or block the pipeline on a logging failure.
 *  - Wraps everything in try/catch.
 */

import { supabase } from '../supabase';

export interface RunLogParams {
  stage: string;
  level?: 'info' | 'warn' | 'error';
  message: string;
  metadata?: Record<string, unknown>;
  queryText?: string;
}

async function _insert(runId: string, params: RunLogParams): Promise<void> {
  console.log(`[RUN_LOGGER] Inserting: runId=${runId} stage=${params.stage} level=${params.level ?? 'info'} supabase_available=${!!supabase}`);

  if (!supabase) return;

  try {
    const { error } = await supabase.from('run_logs').insert({
      run_id: runId,
      query_text: params.queryText ?? null,
      stage: params.stage,
      level: params.level ?? 'info',
      message: params.message,
      metadata: params.metadata ?? {},
    });
    if (error) {
      console.warn(`[RUN_LOGGER] Supabase insert failed (non-fatal): ${error.message}`);
    } else {
      console.log(`[RUN_LOGGER] Insert OK: runId=${runId} stage=${params.stage}`);
    }
  } catch (err: any) {
    console.warn(`[RUN_LOGGER] Exception (non-fatal): ${err.message}`);
  }
}

export function logRunEvent(runId: string, params: RunLogParams): void {
  _insert(runId, params).catch(() => {});
}
