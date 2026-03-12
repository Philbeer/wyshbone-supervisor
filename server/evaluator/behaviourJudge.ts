import { supabase } from '../supabase';

export type BehaviourOutcome =
  | 'PASS'
  | 'PARTIAL_SUCCESS'
  | 'HONEST_PARTIAL'
  | 'BATCH_EXHAUSTED'
  | 'WRONG_DECISION'
  | 'CAPABILITY_FAIL'
  | 'FAIL'
  | 'BLOCKED'
  | 'TIMEOUT';

export interface BehaviourJudgeInput {
  run_id: string;
  query: string;
  query_class: string | null;
  tower_verdict: string | null;
  delivered_count: number;
  requested_count: number;
  websites_visited: boolean;
  tower_verified_phrase_on_page: boolean;
  tower_no_evidence_all_leads: boolean;
  artefact_summary: string;
}

export interface BehaviourJudgeOutput {
  run_id: string;
  outcome: BehaviourOutcome;
  confidence: number;
  reason: string;
  tower_verdict: string | null;
  delivered_count: number;
  requested_count: number;
}

const SYSTEM_PROMPT = `You are Judge B — the Behaviour Judge for Wyshbone Supervisor, a B2B lead generation agent system.

Your role is to evaluate whether the agent behaved correctly for the given query class, based on the evidence provided. You output a single JSON object. No prose, no markdown — only the JSON.

## Outcome Definitions

Choose exactly one outcome:

- **PASS** — The agent followed the correct methodology and delivered a reasonable count of verified leads.
- **PARTIAL_SUCCESS** — The agent followed the correct methodology but delivered fewer leads than requested, without a correctness fault. Some candidates were simply unavailable.
- **HONEST_PARTIAL** — The agent partially fulfilled the request and explicitly acknowledged the gap (e.g. stop reason, reduced count surfaced to user). No dishonesty.
- **BATCH_EXHAUSTED** — The agent exhausted the available candidate pool before reaching the requested count. Correct methodology; data was simply thin.
- **WRONG_DECISION** — The agent made a wrong strategic decision (e.g. wrong plan, wrong query shape, incorrect constraint handling) that caused a recoverable sub-optimal result.
- **CAPABILITY_FAIL** — The agent structurally could not satisfy the query class. See per-class rules below.
- **FAIL** — The agent failed to produce any useful result due to an execution error, interpretation failure, or planning failure.
- **BLOCKED** — The run was blocked before execution could start (e.g. clarify gate, constraint gate, policy gate).
- **TIMEOUT** — The run hit a time or iteration limit before completing.

## Per-Query-Class Rules

### website_evidence_required

This class applies when the user's query requires verifying a constraint phrase or attribute by visiting the business's actual website (e.g. "has a blog", "accepts pets", "mentions ISO 9001").

**Correct methodology for this class:**
Visiting the actual websites of candidate businesses and checking whether the constraint phrase is present on the page. If the agent did this, and Tower confirmed that the phrase was found on the page for the delivered leads, this is the COMPLETE correct methodology. There is nothing more a human verifier would do.

**CRITICAL RULE — website_evidence_required:**
If the agent visited the actual websites AND Tower verified the constraint phrase was present on the page, do NOT penalise for "relying on snippet evidence", "lack of additional verification", or any other secondary concern. Award PASS if verified leads were delivered and the count is reasonable relative to what was requested.

CAPABILITY_FAIL must NOT be used for website_evidence_required when:
- The agent visited actual websites, AND
- Tower verified the constraint phrase was present on at least some of the delivered leads.

CAPABILITY_FAIL MAY be used for website_evidence_required ONLY when one of the following is true:
1. The agent did NOT visit any websites at all.
2. The agent visited websites but did not check for the constraint phrase (e.g. checked irrelevant attributes).
3. Tower returned no_evidence for ALL delivered leads (none passed verification).

### general_leadgen

Standard lead generation without a website constraint. Evaluate on: correct business type, location match, count reasonableness, and Tower verdict.

### count_specific

User requested a precise count. Evaluate whether the delivered count is within an acceptable range (±1 is acceptable; more than 20% short without an explicit gap acknowledgement is PARTIAL_SUCCESS or HONEST_PARTIAL).

### location_bounded

Leads must be within the specified geographic area. Evaluate on: geo verification, out-of-area leads, Tower verdict.

## Confidence

Express confidence as a decimal from 0.0 to 1.0. Use:
- 0.9–1.0: All key signals are unambiguous.
- 0.7–0.89: Minor uncertainty in one dimension.
- 0.5–0.69: Conflicting signals; reasonable judgement call.
- Below 0.5: Evidence is too sparse to be confident; note this in reason.

## Output Format

Respond with ONLY this JSON object — no markdown, no surrounding text:

{
  "outcome": "<one of the outcome values above>",
  "confidence": <0.0–1.0>,
  "reason": "<one or two sentences explaining the outcome, referencing specific evidence>"
}`;

async function callLLM(input: BehaviourJudgeInput): Promise<{ outcome: BehaviourOutcome; confidence: number; reason: string }> {
  const userContent = JSON.stringify(input, null, 2);

  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (openaiKey) {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: openaiKey });
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? '';
    return parseResponse(raw);
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
        max_tokens: 512,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    const data = await response.json() as { content?: Array<{ text?: string }> };
    const raw = data.content?.[0]?.text ?? '';
    return parseResponse(raw);
  }

  throw new Error('[BEHAVIOUR_JUDGE] No LLM API key configured (OPENAI_API_KEY or ANTHROPIC_API_KEY required)');
}

function parseResponse(raw: string): { outcome: BehaviourOutcome; confidence: number; reason: string } {
  const trimmed = raw.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`[BEHAVIOUR_JUDGE] LLM returned non-JSON: ${trimmed.slice(0, 200)}`);
  }
  const parsed = JSON.parse(jsonMatch[0]);

  const validOutcomes: BehaviourOutcome[] = [
    'PASS', 'PARTIAL_SUCCESS', 'HONEST_PARTIAL', 'BATCH_EXHAUSTED',
    'WRONG_DECISION', 'CAPABILITY_FAIL', 'FAIL', 'BLOCKED', 'TIMEOUT',
  ];

  const outcome = parsed.outcome as BehaviourOutcome;
  if (!validOutcomes.includes(outcome)) {
    throw new Error(`[BEHAVIOUR_JUDGE] Unknown outcome from LLM: ${parsed.outcome}`);
  }

  const confidence = typeof parsed.confidence === 'number'
    ? Math.min(1, Math.max(0, parsed.confidence))
    : 0.5;

  const reason = typeof parsed.reason === 'string' ? parsed.reason : 'No reason provided.';

  return { outcome, confidence, reason };
}

export async function runBehaviourJudge(input: BehaviourJudgeInput): Promise<BehaviourJudgeOutput | null> {
  const tag = `[BEHAVIOUR_JUDGE] run_id=${input.run_id}`;

  try {
    const { outcome, confidence, reason } = await callLLM(input);

    const result: BehaviourJudgeOutput = {
      run_id: input.run_id,
      outcome,
      confidence,
      reason,
      tower_verdict: input.tower_verdict,
      delivered_count: input.delivered_count,
      requested_count: input.requested_count,
    };

    if (supabase) {
      const { error } = await supabase.from('behaviour_judge_results').upsert(
        {
          run_id: result.run_id,
          outcome: result.outcome,
          confidence: result.confidence,
          reason: result.reason,
          tower_verdict: result.tower_verdict,
          delivered_count: result.delivered_count,
          requested_count: result.requested_count,
        },
        { onConflict: 'run_id' },
      );
      if (error) {
        console.error(`${tag} Supabase upsert failed: ${error.message}`);
      } else {
        console.log(`${tag} Written to behaviour_judge_results — outcome=${outcome} confidence=${confidence}`);
      }
    } else {
      console.warn(`${tag} Supabase not configured — result not persisted`);
    }

    return result;
  } catch (err: any) {
    console.error(`${tag} Failed: ${err.message}`);
    return null;
  }
}
