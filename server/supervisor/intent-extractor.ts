import {
  type CanonicalIntent,
  type IntentValidationResult,
  parseAndValidateIntentJSON,
  MISSION_TYPE_ENUM,
  CONSTRAINT_TYPE_ENUM,
  HARDNESS_ENUM,
  EVIDENCE_MODE_ENUM,
  GEO_MODE_ENUM,
  DEFAULT_COUNT_POLICY_ENUM,
  PLAN_TEMPLATE_HINT_ENUM,
} from './canonical-intent';

const INTENT_EXTRACTOR_SYSTEM_PROMPT = `You are a strict intent classifier for a B2B lead generation system. Given a user message, extract the canonical intent as JSON.

SCHEMA (all fields required):
{
  "mission_type": one of ${JSON.stringify(MISSION_TYPE_ENUM)},
  "entity_kind": string or null (core entity type, e.g. "pubs", "dentists", "cafes"),
  "entity_category": string or null (broad vertical, e.g. "hospitality", "healthcare", "retail", "professional_services"),
  "location_text": string or null (geographic location verbatim from user, e.g. "Arundel", "central London", "near Brighton"),
  "geo_mode": one of ${JSON.stringify(GEO_MODE_ENUM)} (
    "city" = single city/town,
    "region" = county/state/area,
    "radius" = user said "near"/"within X miles",
    "national" = whole country,
    "unspecified" = no location given
  ),
  "radius_km": number or null (only when geo_mode is "radius" — convert miles to km if needed, otherwise null),
  "requested_count": number or null (explicit count from user, null if not specified),
  "default_count_policy": one of ${JSON.stringify(DEFAULT_COUNT_POLICY_ENUM)} (
    "explicit" = user gave a number,
    "page_1" = no count, just first page of results,
    "best_effort" = user said "all", "as many as possible", etc.
  ),
  "constraints": [
    {
      "type": one of ${JSON.stringify(CONSTRAINT_TYPE_ENUM)},
      "raw": string (verbatim phrase from user message that triggered this constraint),
      "hardness": one of ${JSON.stringify(HARDNESS_ENUM)},
      "evidence_mode": one of ${JSON.stringify(EVIDENCE_MODE_ENUM)},
      "clarify_if_needed": boolean (true if this constraint is ambiguous or unverifiable),
      "clarify_question": string or null (if clarify_if_needed is true, a concise question to ask the user; otherwise null)
    }
  ],
  "plan_template_hint": one of ${JSON.stringify(PLAN_TEMPLATE_HINT_ENUM)} (
    "simple_search" = just find businesses, no verification needed,
    "search_and_verify" = find + verify attributes via website/web,
    "search_verify_enrich" = find + verify + extract contacts,
    "deep_research" = deep research task,
    "unknown" = cannot determine
  ),
  "preferred_evidence_order": array of evidence_mode values, ordered by preference for this query (e.g. ["website_text", "google_places"] if user wants website verification first)
}

CONSTRAINT CLASSIFICATION RULES:
- "serve food", "beer garden", "outdoor seating", "air conditioning", "parking", "wifi", "wheelchair accessible", "dog friendly" → type: "attribute", evidence_mode: "website_text"
- "on their website", "from their website", "website says" → sets evidence_mode to "website_text" for the associated constraint
- "in <place>", "near <place>" → type: "location", evidence_mode: "google_places"
- "find N", "top N" → type: "count", evidence_mode: "not_applicable"
- "opened in last N months", "opened recently", "new" → type: "time", evidence_mode: "web_search" or "news" or "registry"
- "with the word X in the name", "called X" → type: "name_filter", evidence_mode: "google_places"
- "works with", "supplies", "owned by", "run by" → type: "relationship", evidence_mode: "web_search", clarify_if_needed: true
- "serve food", "serves drinks" → type: "attribute", evidence_mode: "website_text" (NOT relationship)
- Phrases you cannot classify → type: "unknown_constraint", evidence_mode: "unknown", clarify_if_needed: true

HARDNESS RULES:
- "must", "only", "exactly", "strict" → hard
- "preferably", "if possible", "ideally", "nice to have" → soft
- Attributes stated as requirements (no hedging) → hard
- Location → soft unless "only in" / "must be in"

PLAN_TEMPLATE_HINT RULES:
- No constraints that need verification → "simple_search"
- Has attribute/time constraints requiring website or web checks → "search_and_verify"
- Has attribute constraints + user asked for email/phone/website → "search_verify_enrich"
- mission_type is "deep_research" → "deep_research"
- Cannot determine → "unknown"

PREFERRED_EVIDENCE_ORDER RULES:
- If user mentions "on their website" → put "website_text" first
- If user mentions "reviews say" → put "review_text" first
- Default for attribute constraints: ["website_text", "google_places"]
- Default for time constraints: ["news", "web_search", "registry"]
- Include only modes relevant to the constraints in this query

DO NOT include these old-schema fields: action, business_type, country, delivery_requirements, confidence, raw_input, value.

Return ONLY valid JSON. No markdown fences, no commentary, no explanation.`;

export interface IntentExtractionResult {
  validation: IntentValidationResult;
  model: string;
  duration_ms: number;
  raw_response: string;
}

export async function extractCanonicalIntent(
  userMessage: string,
  conversationContext?: string,
): Promise<IntentExtractionResult> {
  const startMs = Date.now();
  const model = selectModel();

  let userPrompt = `Extract the canonical intent from this user message:\n\n"${userMessage}"`;
  if (conversationContext) {
    userPrompt = `Conversation context:\n${conversationContext}\n\nExtract the canonical intent from this latest user message:\n\n"${userMessage}"`;
  }

  let rawResponse: string;
  try {
    rawResponse = await callLLM(model, userPrompt);
  } catch (err: any) {
    const duration_ms = Date.now() - startMs;
    return {
      validation: { ok: false, intent: null, errors: [`LLM call failed: ${err.message}`] },
      model,
      duration_ms,
      raw_response: '',
    };
  }

  const duration_ms = Date.now() - startMs;
  const cleaned = cleanJsonResponse(rawResponse);
  const validation = parseAndValidateIntentJSON(cleaned);

  return { validation, model, duration_ms, raw_response: rawResponse };
}

function selectModel(): string {
  if (process.env.OPENAI_API_KEY) return 'gpt-4o-mini';
  if (process.env.ANTHROPIC_API_KEY) return 'claude-3-5-haiku-20241022';
  return 'none';
}

async function callLLM(model: string, userPrompt: string): Promise<string> {
  if (model === 'gpt-4o-mini') {
    return callOpenAI(userPrompt);
  }
  if (model.startsWith('claude-')) {
    return callAnthropic(model, userPrompt);
  }
  throw new Error('No LLM API key available (OPENAI_API_KEY or ANTHROPIC_API_KEY required)');
}

async function callOpenAI(userPrompt: string): Promise<string> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: INTENT_EXTRACTOR_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });
  return response.choices[0]?.message?.content || '';
}

async function callAnthropic(model: string, userPrompt: string): Promise<string> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      temperature: 0,
      system: INTENT_EXTRACTOR_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${body.substring(0, 200)}`);
  }

  const data = await resp.json() as { content: Array<{ type: string; text?: string }> };
  const textBlock = data.content?.find((b) => b.type === 'text');
  return textBlock?.text || '';
}

function cleanJsonResponse(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('```json')) s = s.slice(7);
  else if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  return s.trim();
}
