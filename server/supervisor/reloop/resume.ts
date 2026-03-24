import { supabase } from '../../supabase';
import type {
  ExecutorEntity, ExecutorOutput, LoopRecord, PlannerDecision,
  JudgeVerdict, GateDecision, VariableState, ResumeCheckpoint,
} from './types';

export async function checkForResumableState(runId: string): Promise<ResumeCheckpoint | null> {
  try {
    if (!supabase) return null;

    const { data: rows, error } = await supabase
      .from('loop_state')
      .select('*')
      .eq('run_id', runId)
      .order('loop_number', { ascending: true });

    if (error || !rows || rows.length === 0) return null;

    const lastRow = rows[rows.length - 1];

    // Fully completed rows: completed_at is set and status is not 'active'
    const completedRows = rows.filter(
      r => r.completed_at !== null && r.status !== 'active',
    );

    // ── Determine resumeFrom ──
    let resumeFrom: ResumeCheckpoint['resumeFrom'];
    let lastCompletedLoop: number;
    let lastExecutorOutput: ExecutorOutput | undefined;
    let lastPlannerDecision: PlannerDecision | undefined;

    const lastRowFullyCompleted = lastRow.completed_at !== null;
    const lastRowGateDecision = lastRow.gate_decision as Record<string, unknown> | null;

    if (lastRowFullyCompleted) {
      const gateDecisionStr = lastRowGateDecision?.decision as string | undefined;

      if (gateDecisionStr === 'stop_deliver') {
        // TODO: resume from combined delivery phase
        return null;
      }

      // Case A: completed loop, gate said re_loop — crashed before next loop started
      resumeFrom = 'planner';
      lastCompletedLoop = lastRow.loop_number;
    } else if (lastRow.executor_completed === true) {
      // Case C: executor done but judge/gate never ran
      resumeFrom = 'judge';
      lastCompletedLoop = lastRow.loop_number - 1;

      if (lastRow.executor_output_full) {
        lastExecutorOutput = lastRow.executor_output_full as unknown as ExecutorOutput;
      }
      if (lastRow.planner_decision) {
        lastPlannerDecision = lastRow.planner_decision as unknown as PlannerDecision;
      }
    } else {
      // Case D: executor didn't even finish — redo this loop from scratch
      resumeFrom = 'planner';
      lastCompletedLoop = lastRow.loop_number - 1;
    }

    // ── Rebuild accumulatedEntities ──
    let accumulatedEntities: ExecutorEntity[] = [];
    const sourceForEntities =
      resumeFrom === 'judge'
        ? lastRow
        : completedRows[completedRows.length - 1] ?? null;

    if (sourceForEntities?.accumulated_entities) {
      try {
        const parsed = JSON.parse(sourceForEntities.accumulated_entities as string);
        if (Array.isArray(parsed)) accumulatedEntities = parsed as ExecutorEntity[];
      } catch {
        // leave as empty array
      }
    }

    // ── Rebuild loopHistory from fully completed rows ──
    const loopHistory: LoopRecord[] = completedRows.map(row => {
      const judgeVerdictRaw = row.judge_verdict as Record<string, unknown>;
      const gateRaw = row.gate_decision as Record<string, unknown>;
      const variableState = (judgeVerdictRaw?.variableState ?? {}) as VariableState;

      const gateDecision: GateDecision = {
        decision: gateRaw.decision as 're_loop' | 'stop_deliver',
        loopNumber: gateRaw.loopNumber as number,
        circuitBreaker: gateRaw.circuitBreaker as boolean,
        contextForward: {
          accumulatedEntities: [],
          loopHistory: [],
          variableState,
          suggestedNextExecutor: (gateRaw.suggestedNextExecutor as string | null) ?? null,
          failureContext: (gateRaw.failureContext as string) ?? '',
        },
      };

      const judgeVerdict = judgeVerdictRaw as unknown as JudgeVerdict;
      const plannerDecision = row.planner_decision as unknown as PlannerDecision;
      const executorOutput = row.executor_output_full as unknown as ExecutorOutput;

      const startedAt = row.created_at as string;
      const completedAt = row.completed_at as string;
      const durationMs = Date.parse(completedAt) - Date.parse(startedAt);

      return {
        loopNumber: row.loop_number as number,
        plannerDecision,
        executorOutput,
        judgeVerdict,
        gateDecision,
        startedAt,
        completedAt,
        durationMs,
      };
    });

    // ── Rebuild executorsTriedSoFar ──
    const executorsTriedSoFar: string[] = completedRows.map(r => r.executor_type as string);
    if (resumeFrom === 'judge' && lastRow.executor_type) {
      executorsTriedSoFar.push(lastRow.executor_type as string);
    }

    // ── chainId ──
    const chainId = rows[0].chain_id as string;

    // ── finalRawResult ──
    let finalRawResult: Record<string, unknown> = {};
    const lastCompleted = completedRows[completedRows.length - 1];
    if (lastCompleted?.executor_output_full) {
      const full = lastCompleted.executor_output_full as Record<string, unknown>;
      if (full.rawResult && typeof full.rawResult === 'object') {
        finalRawResult = full.rawResult as Record<string, unknown>;
      }
    }

    const checkpoint: ResumeCheckpoint = {
      canResume: true,
      chainId,
      lastCompletedLoop,
      resumeFrom,
      accumulatedEntities,
      loopHistory,
      executorsTriedSoFar,
      lastExecutorOutput,
      lastPlannerDecision,
      finalRawResult,
    };

    console.log(
      `[RECOVERY] checkForResumableState runId=${runId}: found ${rows.length} loop_state rows, resumeFrom=${checkpoint.resumeFrom}, lastCompletedLoop=${checkpoint.lastCompletedLoop}`,
    );

    return checkpoint;
  } catch (err: any) {
    console.warn(`[RECOVERY] checkForResumableState failed (non-fatal): ${err.message}`);
    return null;
  }
}
