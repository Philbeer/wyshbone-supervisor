import { storage } from '../storage';
import type { DeliverySummaryPayload } from './delivery-summary';
import type { InsertBeliefStore } from '@shared/schema';

export interface BeliefWriterInput {
  runId: string;
  goalId?: string | null;
  deliverySummary: DeliverySummaryPayload;
}

function deriveBeliefs(input: BeliefWriterInput): InsertBeliefStore[] {
  const beliefs: InsertBeliefStore[] = [];
  const { deliverySummary: ds, runId, goalId } = input;
  const maxBeliefs = 3;

  if (ds.cvl_summary && ds.cvl_summary.hard_unverifiable.length > 0) {
    beliefs.push({
      runId,
      goalId: goalId ?? null,
      claim: `Hard constraint unverifiable: ${ds.cvl_summary.hard_unverifiable.join(', ')}`,
      confidence: '0.95',
      evidenceRunIds: [runId],
      evidence: {
        source: 'cvl',
        hard_unverifiable: ds.cvl_summary.hard_unverifiable,
        verified_exact: ds.cvl_summary.verified_exact_count,
      },
    });
  }

  if (ds.tower_verdict === 'STOP' && ds.stop_reason) {
    beliefs.push({
      runId,
      goalId: goalId ?? null,
      claim: `Tower stopped execution: ${ds.stop_reason}`,
      confidence: '0.90',
      evidenceRunIds: [runId],
      evidence: {
        source: 'tower',
        tower_verdict: ds.tower_verdict,
        stop_reason: ds.stop_reason,
      },
    });
  }

  if (ds.status === 'PARTIAL' && ds.shortfall > 0) {
    beliefs.push({
      runId,
      goalId: goalId ?? null,
      claim: `Partial delivery: ${ds.delivered_exact_count} of ${ds.requested_count} verified (shortfall=${ds.shortfall})`,
      confidence: '0.85',
      evidenceRunIds: [runId],
      evidence: {
        source: 'delivery_summary',
        delivered_exact: ds.delivered_exact_count,
        requested: ds.requested_count,
        shortfall: ds.shortfall,
      },
    });
  }

  if (ds.status === 'PASS' && beliefs.length === 0) {
    beliefs.push({
      runId,
      goalId: goalId ?? null,
      claim: `Goal fully satisfied: ${ds.delivered_exact_count} of ${ds.requested_count} delivered`,
      confidence: '1.00',
      evidenceRunIds: [runId],
      evidence: {
        source: 'delivery_summary',
        status: 'PASS',
        delivered_exact: ds.delivered_exact_count,
        requested: ds.requested_count,
      },
    });
  }

  return beliefs.slice(0, maxBeliefs);
}

export async function writeBeliefs(input: BeliefWriterInput): Promise<void> {
  const beliefs = deriveBeliefs(input);
  if (beliefs.length === 0) return;

  for (const belief of beliefs) {
    try {
      await storage.createBelief(belief);
    } catch (err: any) {
      console.error(`[BELIEF_WRITER] Failed to write belief: ${err.message}`);
    }
  }

  console.log(`[BELIEF_WRITER] Wrote ${beliefs.length} beliefs for run ${input.runId}`);
}
