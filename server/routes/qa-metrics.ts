import type { Express } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';

export function registerQaMetricsRoutes(app: Express, supabase: SupabaseClient | null): void {
  app.get('/api/qa-metrics/history', async (req, res) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const userId = req.query.user_id as string | undefined;

      let query = supabase
        .from('qa_run_metrics')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (userId) {
        query = query.eq('user_id', userId);
      }

      const { data: rows, error: rowsErr } = await query;

      if (rowsErr) {
        console.error('[QA_METRICS] Failed to fetch qa_run_metrics:', rowsErr.message);
        return res.status(500).json({ error: rowsErr.message });
      }

      const results = rows ?? [];

      const runIds = results
        .filter((r: any) => r.run_id && (!r.behaviour_result || r.behaviour_result === ''))
        .map((r: any) => r.run_id as string);

      if (runIds.length > 0) {
        const { data: judgeRows, error: judgeErr } = await supabase
          .from('behaviour_judge_results')
          .select('run_id, outcome, confidence, reason')
          .in('run_id', runIds);

        if (!judgeErr && judgeRows && judgeRows.length > 0) {
          const judgeMap = new Map<string, { outcome: string; confidence: number; reason: string }>();
          for (const jr of judgeRows) {
            judgeMap.set(jr.run_id, jr);
          }

          for (const row of results as any[]) {
            if (!row.behaviour_result || row.behaviour_result === '') {
              const judge = judgeMap.get(row.run_id);
              if (judge?.outcome) {
                row.behaviour_result = judge.outcome.toUpperCase();
                row.behaviour_confidence = judge.confidence ?? null;
                row.behaviour_reason = judge.reason ?? null;
              }
            }
          }
        } else if (judgeErr) {
          console.warn('[QA_METRICS] Failed to fetch behaviour_judge_results (non-fatal):', judgeErr.message);
        }
      }

      return res.json(results);
    } catch (err: any) {
      console.error('[QA_METRICS] Unexpected error:', err.message);
      return res.status(500).json({ error: err.message || 'Failed to fetch QA metrics history' });
    }
  });
}
