import { supabase } from '../supabase';
import { storage } from '../storage';
import type { Artefact } from '../schema';
import type { Request, Response } from 'express';

const RATE_LIMIT_MS = 30_000;
const recentCalls = new Map<string, number>();

function truncate(text: string | null | undefined, max = 300): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '… [truncated]';
}

function compactPayload(type: string, payload: Record<string, unknown> | null): Record<string, unknown> {
  if (!payload) return {};

  switch (type) {
    case 'plan':
      return {
        original_user_goal: truncate(payload.original_user_goal as string),
        normalized_goal: truncate(payload.normalized_goal as string),
        constraints: payload.constraints ?? payload.hard_constraints ?? null,
        soft_constraints: payload.soft_constraints ?? null,
        assumptions: payload.assumptions ?? null,
        steps: payload.steps ?? null,
        requested_count_user: payload.requested_count_user ?? null,
        search_budget_count: payload.search_budget_count ?? null,
        plan_version: payload.plan_version ?? null,
        radius_km: payload.radius_km ?? null,
        base_location: payload.base_location ?? null,
      };

    case 'step_result':
      return {
        step_status: payload.step_status ?? payload.status ?? null,
        step_type: payload.step_type ?? null,
        inputs_summary: truncate(JSON.stringify(payload.inputs_summary ?? payload.inputs ?? payload.search_params ?? null), 200),
        outputs_summary: truncate(JSON.stringify(payload.outputs_summary ?? payload.outputs ?? null), 200),
        result_count: payload.result_count ?? payload.leads_count ?? null,
      };

    case 'leads_list':
    case 'leads':
      return {
        delivered_count: payload.delivered_count ?? payload.count ?? null,
        requested_count_user: payload.requested_count_user ?? null,
        requested_count_internal: payload.requested_count_internal ?? payload.requested_count ?? null,
        constraints_relaxed: payload.relaxed_constraints ?? payload.constraints_relaxed ?? null,
        constraint_diffs: payload.constraint_diffs ?? null,
        location: payload.location ?? null,
        business_type: payload.business_type ?? null,
        name_filter: payload.name_filter ?? null,
        prefix_filter: payload.prefix_filter ?? null,
        structured_constraints: payload.structured_constraints ?? null,
      };

    case 'tower_judgement':
      return {
        verdict: payload.verdict ?? null,
        action: payload.action ?? null,
        delivered: payload.delivered ?? payload.delivered_count ?? null,
        requested: payload.requested ?? payload.requested_count ?? null,
        gaps: payload.gaps ?? null,
        confidence: payload.confidence ?? null,
        rationale: truncate(payload.rationale as string ?? payload.reason as string, 400),
        suggested_changes: payload.suggested_changes ?? null,
      };

    case 'terminal':
    case 'halted':
      return {
        stop_reason: payload.stop_reason ?? payload.reason ?? payload.error ?? null,
      };

    default:
      return {
        summary: truncate(JSON.stringify(payload), 300),
      };
  }
}

function buildEvidenceBundle(runId: string, artefacts: Artefact[], afrEvents: any[]) {
  const artefactEntries = artefacts.map(a => {
    const payload = a.payloadJson as Record<string, unknown> | null;
    return {
      artefact_id: a.id,
      created_at: a.createdAt,
      type: a.type,
      title: a.title,
      summary: truncate(a.summary, 200),
      plan_version: (payload?.plan_version as string) ?? null,
      payload_excerpt: compactPayload(a.type, payload),
    };
  });

  const afrEntries = afrEvents.map(e => ({
    action: e.action_taken,
    status: e.status,
    timestamp: e.timestamp,
    metadata_excerpt: truncate(JSON.stringify(e.metadata ?? {}), 200),
  }));

  return {
    run_id: runId,
    artefact_count: artefacts.length,
    afr_event_count: afrEvents.length,
    artefacts: artefactEntries,
    afr_events: afrEntries,
  };
}

const SYSTEM_PROMPT = `You are a run-report analyst for a B2B lead generation system called Wyshbone Supervisor.
You produce factual markdown reports explaining what happened during a specific run, based ONLY on the evidence bundle provided.

STRICT RULES:
1. You must ONLY use information present in the evidence bundle. Never invent, assume, or infer data that isn't explicitly stated.
2. If any information is missing or unclear, you must say "Unknown from artefacts" — never guess.
3. You must explicitly call out any "goal drift" or "label dishonesty":
   - Where a plan relaxed constraints (e.g. prefix dropped, location expanded) but titles or summaries still claim the original constraint.
   - Where the delivered count differs from what the user originally asked for.
   - Where the normalized goal differs from the original user goal.
4. Structure the report with these sections:
   ## Run Summary
   Brief overview: what was requested, what was delivered, final verdict.
   ## Timeline
   Chronological walkthrough of each artefact and significant event.
   ## Constraint Analysis
   What was originally requested (hard vs soft constraints), what changed during replans.
   ## Tower Judgements
   Each Tower call: what it judged, verdict, action taken, rationale.
   ## Goal Drift & Label Honesty Audit
   Explicit analysis of whether titles, summaries, and delivered results accurately reflect the actual constraints used.
   ## Outcome
   Final status, leads delivered vs requested, any issues flagged.
5. Use concise markdown. Reference artefact IDs and types when citing evidence.
6. If the run was halted or failed, explain why based on the evidence.`;

async function callLLM(evidenceBundle: Record<string, unknown>): Promise<string> {
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const userPrompt = `Analyse this run and produce a factual report. Evidence bundle:\n\n${JSON.stringify(evidenceBundle, null, 2)}`;

  if (openaiKey) {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: openaiKey });
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });
    return response.choices[0]?.message?.content || 'No response from model.';
  }

  if (anthropicKey) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 4000,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    const data = await response.json() as any;
    return data.content?.[0]?.text || 'No response from model.';
  }

  throw new Error('No LLM API key configured (need OPENAI_API_KEY or ANTHROPIC_API_KEY)');
}

export async function handleExplainRun(req: Request, res: Response): Promise<void> {
  const devAllowed =
    process.env.NODE_ENV !== 'production' ||
    process.env.DEV_EXPLAIN_RUN === 'true';

  if (!devAllowed) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const { runId } = req.body;
  if (!runId || typeof runId !== 'string') {
    res.status(400).json({ error: 'runId is required (string)' });
    return;
  }

  const lastCall = recentCalls.get(runId);
  if (lastCall && Date.now() - lastCall < RATE_LIMIT_MS) {
    const waitSec = Math.ceil((RATE_LIMIT_MS - (Date.now() - lastCall)) / 1000);
    res.status(429).json({ error: `Rate limited. Try again in ${waitSec}s for this runId.` });
    return;
  }

  try {
    const artefacts = await storage.getArtefactsByRunId(runId);
    artefacts.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    let afrEvents: any[] = [];
    if (supabase) {
      const { data } = await supabase
        .from('agent_activities')
        .select('action_taken, status, timestamp, metadata, run_id')
        .eq('run_id', runId)
        .order('timestamp', { ascending: true })
        .limit(200);
      if (data) afrEvents = data;
    }

    if (artefacts.length === 0 && afrEvents.length === 0) {
      res.status(404).json({ error: `No artefacts or AFR events found for runId=${runId}` });
      return;
    }

    const evidenceBundle = buildEvidenceBundle(runId, artefacts, afrEvents);

    recentCalls.set(runId, Date.now());
    const reportMarkdown = await callLLM(evidenceBundle);

    res.json({ runId, report_markdown: reportMarkdown });
  } catch (err: any) {
    console.error(`[EXPLAIN_RUN] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}
