import {
  type StructuredMission,
  type MissionExtractionTrace,
  type MissionValidationResult,
  type MissionFailureStage,
  parseAndValidateMissionJSON,
  MISSION_CONSTRAINT_TYPES,
  MISSION_MODES,
  TEXT_COMPARE_OPERATORS,
  NUMERIC_OPERATORS,
  ATTRIBUTE_CHECK_OPERATORS,
  RELATIONSHIP_CHECK_OPERATORS,
  TIME_CONSTRAINT_OPERATORS,
  STATUS_CHECK_OPERATORS,
  WEBSITE_EVIDENCE_OPERATORS,
  CONTACT_EXTRACTION_OPERATORS,
  RANKING_OPERATORS,
  ENTITY_DISCOVERY_OPERATORS,
  LOCATION_CONSTRAINT_OPERATORS,
  HARDNESS_VALUES,
} from './mission-schema';

const PASS1_SYSTEM_PROMPT = `You are a semantic interpreter for a business search system. Your job is to read a messy user message and restate what the user is actually asking for in clean, unambiguous language.

YOUR SOLE TASK: strip away surface phrasing and restate the underlying meaning. You are a translator from casual language to precise semantic language.

CORE RULES:
1. Restate the user's intent in plain semantic English. NEVER preserve their exact wording or phrasing wrappers.
2. Identify the entity type (e.g. pubs, cafes, breweries, hospitals).
3. Identify the location if given.
4. Identify ALL constraints the user cares about. Each constraint must be restated as a clean semantic fact.
5. Identify the mission mode: is this a one-time search, ongoing monitoring, alert-on-change, or recurring check?
6. Do NOT output JSON. Output a short paragraph of clean English.
7. Do NOT invent constraints the user did not express. Only extract what is actually stated or clearly implied.

SEMANTIC STRIPPING RULES — these are critical:

Name filters — the user's phrasing wraps a simple text match. Strip the wrapper, keep only the search token.
  "have the word swan in the name" → name contains "swan"
  "called The Red Lion" → name contains "The Red Lion"
  "name includes craft" → name contains "craft"
  "with swan in the name" → name contains "swan"
  "starting with A" → name starts with "A"
  WRONG: name contains "have the word swan in the name"
  WRONG: name contains "swan in the name"
  RIGHT: name contains "swan"

Website evidence — the user is asking for proof from a website. Strip the delivery wrapper, keep only the content to find.
  "mention live music on their website" → website text contains "live music"
  "that mention vegan food on their website" → website text contains "vegan food"
  "website says dog friendly" → website text contains "dog friendly"
  "their site talks about craft beer" → website text contains "craft beer"
  WRONG: website text contains "mention live music on their website"
  RIGHT: website text contains "live music"

Time constraints — restate the time window cleanly.
  "opened in the last 6 months" → opened within the last 6 months
  "opened recently" → opened recently (timeframe unspecified)
  "new breweries" → opened recently (timeframe unspecified)
  "established before 2020" → established before 2020

Attribute checks — venue features and amenities stated as requirements.
  "with a beer garden" → has a beer garden
  "dog friendly" → is dog friendly
  "that serve food" → serves food
  "with outdoor seating" → has outdoor seating
  These are physical features of a venue, NOT text to search for on websites.

Status checks — current state of a service or offering.
  "offer the sleep apnea implant" → offers the service "sleep apnea implant"
  "currently open" → operating status is open
  "accepting new patients" → accepting new patients

Relationship checks — business-to-business or business-to-entity relationships.
  "works with NHS" → has a client/partner relationship with NHS
  "supplied by local farms" → supplied by local farms

Website evidence vs attribute check — IMPORTANT DISTINCTION:
  "mention vegan food on their website" → website_evidence (user wants proof FROM the website)
  "serve vegan food" → attribute_check (user wants venues that HAVE this feature)
  "on their website" / "from their website" / "website says" / "site mentions" → always website_evidence
  No website reference → attribute_check or status_check

Attribute check vs status check vs relationship check — IMPORTANT DISTINCTION:
  attribute_check = physical features or amenities a venue HAS: beer garden, outdoor seating, parking, food service, live music, dog friendly.
    "serve food" → attribute_check (food service is an amenity)
    "with a beer garden" → attribute_check
    "dog friendly" → attribute_check
  status_check = whether a business currently offers a specific service, programme, or operational state:
    "offer the sleep apnea implant" → status_check (a specific medical service)
    "accepting new patients" → status_check (an operational status)
    "currently open" → status_check
    "offers NHS dental services" → status_check (a specific programme)
  relationship_check = a business-to-business or business-to-entity relationship:
    "works with NHS" → relationship_check (the business has a relationship WITH the NHS)
    "supplied by local farms" → relationship_check
    "partners with university" → relationship_check
  KEY RULE: "serves food" / "serve drinks" / "has parking" = attribute_check (amenity). "offers X service" / "provides X programme" = status_check. "works with X" / "supplied by X" = relationship_check.

Mission mode:
  "find..." / "search for..." / no temporal signal → one-time search (research_now)
  "keep checking..." / "monitor..." / "watch for..." → ongoing monitoring (monitor)
  "alert me if..." / "notify me when..." / "let me know if..." → alert on change (alert_on_change)
  "check every week..." / "monthly update..." → recurring check (recurring_check)
  When BOTH "keep checking" AND "alert me" appear → alert_on_change takes precedence

EXAMPLES:

User: "find pubs in arundel that have the word swan in the name"
Output: The user wants pubs in Arundel whose business name contains "swan". This is a one-time search.

User: "find pubs in arundel that mention live music on their website"
Output: The user wants pubs in Arundel whose website text contains "live music". This is a one-time search.

User: "find cafes in manchester that mention vegan food on their website"
Output: The user wants cafes in Manchester whose website text contains "vegan food". This is a one-time search.

User: "find breweries in texas opened in the last 6 months"
Output: The user wants breweries in Texas that opened within the last 6 months. This is a one-time search.

User: "keep checking which hospitals in the UK offer the sleep apnea implant and alert me if it starts near my area"
Output: The user wants hospitals in the UK that offer the service "sleep apnea implant". They want ongoing monitoring with alerts when this service becomes available near their area. The mission mode is alert-on-change, with a location proximity filter for the user's area.

User: "find 10 italian restaurants in Brighton with outdoor seating and at least 4.5 stars"
Output: The user wants 10 Italian restaurants in Brighton that have outdoor seating and a rating of at least 4.5 stars. This is a one-time search.

User: "find pubs in sussex called The Swan with a beer garden"
Output: The user wants pubs in Sussex whose business name contains "The Swan" and that have a beer garden. This is a one-time search.

User: "find dentists near Bristol that work with NHS and have good reviews"
Output: The user wants dentists near Bristol that have a relationship with the NHS. This is a one-time search.

User: "watch for new co-working spaces in London and let me know when one opens"
Output: The user wants co-working spaces in London. They want to be alerted when new ones open. The mission mode is alert-on-change with a time constraint for newly opened venues.`;

const PASS2_SYSTEM_PROMPT = `You are a schema mapper for a business search system. You receive a clean semantic interpretation of a user request. Your job is to convert it into a fixed JSON schema using ONLY the allowed types, operators, and values.

OUTPUT SCHEMA (return ONLY this JSON object, no markdown fences, no commentary):
{
  "entity_category": string,
  "location_text": string or null,
  "requested_count": number or null,
  "constraints": [ ... ],
  "mission_mode": one of ${JSON.stringify(MISSION_MODES)}
}

REQUESTED_COUNT RULES:
- If the user explicitly asked for a specific number of results (e.g. "find 10 pubs", "give me 5 restaurants"), set requested_count to that number.
- If no count is mentioned or implied, set requested_count to null.
- NEVER invent a count — only extract what the user explicitly stated.

Each constraint object:
{
  "type": one of ${JSON.stringify(MISSION_CONSTRAINT_TYPES)},
  "field": string,
  "operator": string (MUST be from the allowed list for this type),
  "value": string or number or boolean or null,
  "value_secondary": string or number or null (only for "between"),
  "hardness": one of ${JSON.stringify(HARDNESS_VALUES)}
}

ALLOWED OPERATORS PER TYPE — you MUST only use operators from this list:

text_compare: ${JSON.stringify(TEXT_COMPARE_OPERATORS)}
  field: the text field being compared (e.g. "name")
  value: the CLEAN search token ONLY — never the user's wrapper phrase
  Examples:
    "name contains swan" → { "type": "text_compare", "field": "name", "operator": "contains", "value": "swan", "hardness": "hard" }
    "name contains The Red Lion" → { "type": "text_compare", "field": "name", "operator": "contains", "value": "The Red Lion", "hardness": "hard" }
    "name starts with A" → { "type": "text_compare", "field": "name", "operator": "starts_with", "value": "A", "hardness": "hard" }
  CRITICAL — value must be the bare search term:
    WRONG: "swan in the name"
    WRONG: "have the word swan"
    WRONG: "the word swan in the name"
    RIGHT: "swan"

website_evidence: ${JSON.stringify(WEBSITE_EVIDENCE_OPERATORS)}
  field: always "website_text"
  value: the CLEAN content to search for — never the delivery wrapper
  Examples:
    "website text contains live music" → { "type": "website_evidence", "field": "website_text", "operator": "contains", "value": "live music", "hardness": "hard" }
    "website text contains vegan food" → { "type": "website_evidence", "field": "website_text", "operator": "contains", "value": "vegan food", "hardness": "hard" }
  CRITICAL — value must be the bare content term:
    WRONG: "mention live music on their website"
    WRONG: "vegan food on their website"
    RIGHT: "live music"
    RIGHT: "vegan food"

attribute_check: ${JSON.stringify(ATTRIBUTE_CHECK_OPERATORS)}
  field: "amenity" for venue features, or the specific attribute domain
  value: the attribute name
  Examples:
    "has outdoor seating" → { "type": "attribute_check", "field": "amenity", "operator": "has", "value": "outdoor seating", "hardness": "hard" }
    "has a beer garden" → { "type": "attribute_check", "field": "amenity", "operator": "has", "value": "beer garden", "hardness": "hard" }
    "serves food" → { "type": "attribute_check", "field": "amenity", "operator": "has", "value": "serves food", "hardness": "hard" }
    "dog friendly" → { "type": "attribute_check", "field": "amenity", "operator": "has", "value": "dog friendly", "hardness": "hard" }
  IMPORTANT: venue amenities like "serves food", "has parking", "live music" are ALWAYS attribute_check, never status_check.
  status_check is for specific services/programmes like "offers sleep apnea implant", "accepting new patients".
  relationship_check is for business-to-entity relationships like "works with NHS", "supplied by local farms".

time_constraint: ${JSON.stringify(TIME_CONSTRAINT_OPERATORS)}
  field: the relevant date field (e.g. "opening_date", "established_date")
  value: the time window description
  Examples:
    "opened within the last 6 months" → { "type": "time_constraint", "field": "opening_date", "operator": "within_last", "value": "6 months", "hardness": "hard" }
    "opened recently" → { "type": "time_constraint", "field": "opening_date", "operator": "within_last", "value": "recent", "hardness": "hard" }
    "established before 2020" → { "type": "time_constraint", "field": "established_date", "operator": "before", "value": "2020", "hardness": "hard" }

status_check: ${JSON.stringify(STATUS_CHECK_OPERATORS)}
  field: the status aspect (e.g. "service_offered", "operating_status", "availability")
  value: the expected status or service
  Examples:
    "offers sleep apnea implant" → { "type": "status_check", "field": "service_offered", "operator": "has", "value": "sleep apnea implant", "hardness": "hard" }
    "currently open" → { "type": "status_check", "field": "operating_status", "operator": "equals", "value": "open", "hardness": "hard" }
    "accepting new patients" → { "type": "status_check", "field": "availability", "operator": "equals", "value": "accepting new patients", "hardness": "hard" }

relationship_check: ${JSON.stringify(RELATIONSHIP_CHECK_OPERATORS)}
  field: the relationship domain (e.g. "client", "supplier", "partner")
  value: the related entity
  Examples:
    "has relationship with NHS" → { "type": "relationship_check", "field": "client", "operator": "serves", "value": "NHS", "hardness": "hard" }
    "supplied by local farms" → { "type": "relationship_check", "field": "supplier", "operator": "has", "value": "local farms", "hardness": "hard" }

numeric_range: ${JSON.stringify(NUMERIC_OPERATORS)}
  field: "rating", "review_count", "price_level", etc.
  value: MUST be a number
  Examples:
    "rating at least 4.5" → { "type": "numeric_range", "field": "rating", "operator": "gte", "value": 4.5, "hardness": "hard" }
    "more than 50 reviews" → { "type": "numeric_range", "field": "review_count", "operator": "gte", "value": 50, "hardness": "hard" }

ranking: ${JSON.stringify(RANKING_OPERATORS)}
  field: ranking criterion (e.g. "rating", "review_count")
  value: count (number) or null
  Example: "top 10 by rating" → { "type": "ranking", "field": "rating", "operator": "top", "value": 10, "hardness": "hard" }

contact_extraction: ${JSON.stringify(CONTACT_EXTRACTION_OPERATORS)}
  field: contact type (e.g. "email", "phone", "website")
  value: null
  Example: "extract email addresses" → { "type": "contact_extraction", "field": "email", "operator": "extract", "value": null, "hardness": "hard" }

entity_discovery: ${JSON.stringify(ENTITY_DISCOVERY_OPERATORS)}
  Only use if there is an ADDITIONAL category filter beyond entity_category.

location_constraint: ${JSON.stringify(LOCATION_CONSTRAINT_OPERATORS)}
  Only use if there is an ADDITIONAL or complex location filter beyond location_text (e.g. "near my area" as a secondary proximity filter).
  Example: "near my area" → { "type": "location_constraint", "field": "location", "operator": "near", "value": "user_area", "hardness": "soft" }

MISSION MODE RULES:
- "research_now": one-time search. Default for most queries.
- "monitor": ongoing monitoring ("keep checking", "watch for", "monitor").
- "alert_on_change": notify on change ("alert me if", "notify me when", "let me know if"). When BOTH monitoring and alert signals appear, use "alert_on_change".
- "recurring_check": periodic re-checks ("check every week", "monthly update").

HARDNESS RULES:
- "hard": stated as a requirement without hedging. Default for explicit constraints.
- "soft": uses hedging language ("preferably", "if possible", "ideally", "nice to have").

CRITICAL RULES:
- NEVER invent constraint types not in the allowed list.
- NEVER use operators not in the allowed list for each type.
- value must ALWAYS be the clean extracted semantic token, NEVER the user's original wrapper phrase.
- Do NOT duplicate information already captured in entity_category or location_text as constraints.

FULL EXAMPLES:

Semantic input: The user wants pubs in Arundel whose business name contains "swan". This is a one-time search.
{
  "entity_category": "pubs",
  "location_text": "Arundel",
  "requested_count": null,
  "constraints": [
    { "type": "text_compare", "field": "name", "operator": "contains", "value": "swan", "hardness": "hard" }
  ],
  "mission_mode": "research_now"
}

Semantic input: The user wants pubs in Arundel whose website text contains "live music". This is a one-time search.
{
  "entity_category": "pubs",
  "location_text": "Arundel",
  "requested_count": null,
  "constraints": [
    { "type": "website_evidence", "field": "website_text", "operator": "contains", "value": "live music", "hardness": "hard" }
  ],
  "mission_mode": "research_now"
}

Semantic input: The user wants cafes in Manchester whose website text contains "vegan food". This is a one-time search.
{
  "entity_category": "cafes",
  "location_text": "Manchester",
  "requested_count": null,
  "constraints": [
    { "type": "website_evidence", "field": "website_text", "operator": "contains", "value": "vegan food", "hardness": "hard" }
  ],
  "mission_mode": "research_now"
}

Semantic input: The user wants breweries in Texas that opened within the last 6 months. This is a one-time search.
{
  "entity_category": "breweries",
  "location_text": "Texas",
  "requested_count": null,
  "constraints": [
    { "type": "time_constraint", "field": "opening_date", "operator": "within_last", "value": "6 months", "hardness": "hard" }
  ],
  "mission_mode": "research_now"
}

Semantic input: The user wants hospitals in the UK that offer the service "sleep apnea implant". They want ongoing monitoring with alerts when this service becomes available near their area. The mission mode is alert-on-change, with a location proximity filter for the user's area.
{
  "entity_category": "hospitals",
  "location_text": "UK",
  "requested_count": null,
  "constraints": [
    { "type": "status_check", "field": "service_offered", "operator": "has", "value": "sleep apnea implant", "hardness": "hard" },
    { "type": "location_constraint", "field": "location", "operator": "near", "value": "user_area", "hardness": "soft" }
  ],
  "mission_mode": "alert_on_change"
}

Semantic input: The user wants 10 Italian restaurants in Brighton that have outdoor seating and a rating of at least 4.5 stars. This is a one-time search.
{
  "entity_category": "Italian restaurants",
  "location_text": "Brighton",
  "requested_count": 10,
  "constraints": [
    { "type": "attribute_check", "field": "amenity", "operator": "has", "value": "outdoor seating", "hardness": "hard" },
    { "type": "numeric_range", "field": "rating", "operator": "gte", "value": 4.5, "hardness": "hard" }
  ],
  "mission_mode": "research_now"
}

Semantic input: The user wants pubs in Sussex whose business name contains "The Swan" and that have a beer garden. This is a one-time search.
{
  "entity_category": "pubs",
  "location_text": "Sussex",
  "requested_count": null,
  "constraints": [
    { "type": "text_compare", "field": "name", "operator": "contains", "value": "The Swan", "hardness": "hard" },
    { "type": "attribute_check", "field": "amenity", "operator": "has", "value": "beer garden", "hardness": "hard" }
  ],
  "mission_mode": "research_now"
}

Semantic input: The user wants dentists near Bristol that have a relationship with the NHS. This is a one-time search.
{
  "entity_category": "dentists",
  "location_text": "Bristol",
  "requested_count": null,
  "constraints": [
    { "type": "relationship_check", "field": "client", "operator": "serves", "value": "NHS", "hardness": "hard" }
  ],
  "mission_mode": "research_now"
}

Semantic input: The user wants 5 vets in London that extract email addresses. This is a one-time search.
{
  "entity_category": "vets",
  "location_text": "London",
  "requested_count": 5,
  "constraints": [
    { "type": "contact_extraction", "field": "email", "operator": "extract", "value": null, "hardness": "hard" }
  ],
  "mission_mode": "research_now"
}

Return ONLY valid JSON. No markdown fences, no commentary, no explanation.`;

export type MissionExtractorMode = 'off' | 'shadow' | 'active';

export function getMissionExtractorMode(): MissionExtractorMode {
  const raw = (process.env.MISSION_EXTRACTOR_MODE || 'active').toLowerCase().trim();
  if (raw === 'off') return 'off';
  if (raw === 'shadow') return 'shadow';
  return 'active';
}

const MAX_CONTEXT_CHARS = 3000;

function truncateContext(ctx: string | undefined): string | undefined {
  if (!ctx) return ctx;
  if (ctx.length <= MAX_CONTEXT_CHARS) return ctx;
  return ctx.slice(-MAX_CONTEXT_CHARS);
}

export interface MissionExtractionResult {
  trace: MissionExtractionTrace;
  mission: StructuredMission | null;
  ok: boolean;
}

function selectModel(): string {
  if (process.env.OPENAI_API_KEY) return 'gpt-4o-mini';
  if (process.env.ANTHROPIC_API_KEY) return 'claude-3-5-haiku-20241022';
  return 'none';
}

async function callLLM(model: string, systemPrompt: string, userPrompt: string): Promise<string> {
  if (model === 'gpt-4o-mini') {
    return callOpenAI(systemPrompt, userPrompt);
  }
  if (model.startsWith('claude-')) {
    return callAnthropic(model, systemPrompt, userPrompt);
  }
  throw new Error('No LLM API key available (OPENAI_API_KEY or ANTHROPIC_API_KEY required)');
}

async function callOpenAI(systemPrompt: string, userPrompt: string): Promise<string> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 2000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });
  return response.choices[0]?.message?.content || '';
}

async function callAnthropic(model: string, systemPrompt: string, userPrompt: string): Promise<string> {
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
      system: systemPrompt,
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

function cleanupMissionValues(mission: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(mission.constraints)) {
    for (const c of mission.constraints) {
      if (typeof c === 'object' && c !== null && typeof c.value === 'string') {
        c.value = c.value.trim();
      }
    }
  }

  if (typeof mission.entity_category === 'string') {
    mission.entity_category = mission.entity_category.trim();
  }
  if (typeof mission.location_text === 'string') {
    mission.location_text = mission.location_text.trim();
  }

  return mission;
}

export async function extractStructuredMission(
  userMessage: string,
  conversationContext?: string,
): Promise<MissionExtractionResult> {
  const model = selectModel();
  const timestamp = new Date().toISOString();

  if (model === 'none') {
    const trace: MissionExtractionTrace = {
      raw_user_input: userMessage,
      pass1_semantic_interpretation: '',
      pass2_structured_mission: null,
      pass2_raw_json: '',
      validation_result: { ok: false, mission: null, errors: ['No LLM API key available'] },
      model: 'none',
      pass1_duration_ms: 0,
      pass2_duration_ms: 0,
      total_duration_ms: 0,
      timestamp,
      failure_stage: 'no_api_key',
    };
    return { trace, mission: null, ok: false };
  }

  const truncatedContext = truncateContext(conversationContext);

  let pass1Prompt: string;
  if (truncatedContext) {
    pass1Prompt = `Recent conversation:\n${truncatedContext}\n\nInterpret the semantic meaning of the LATEST user message:\n\n"${userMessage}"`;
  } else {
    pass1Prompt = `Interpret the semantic meaning of this user message:\n\n"${userMessage}"`;
  }

  let pass1Result = '';
  const pass1Start = Date.now();
  try {
    pass1Result = await callLLM(model, PASS1_SYSTEM_PROMPT, pass1Prompt);
  } catch (err: any) {
    const duration = Date.now() - pass1Start;
    const trace: MissionExtractionTrace = {
      raw_user_input: userMessage,
      pass1_semantic_interpretation: '',
      pass2_structured_mission: null,
      pass2_raw_json: '',
      validation_result: { ok: false, mission: null, errors: [`Pass 1 LLM call failed: ${err.message}`] },
      model,
      pass1_duration_ms: duration,
      pass2_duration_ms: 0,
      total_duration_ms: duration,
      timestamp,
      failure_stage: 'pass1_llm_call',
    };
    console.error(`[MISSION_EXTRACTOR] Pass 1 failed: ${err.message}`);
    return { trace, mission: null, ok: false };
  }
  const pass1Duration = Date.now() - pass1Start;

  const pass2Prompt = `Convert this semantic interpretation into the structured mission JSON schema:\n\n"${pass1Result}"`;

  let pass2RawResponse = '';
  const pass2Start = Date.now();
  try {
    pass2RawResponse = await callLLM(model, PASS2_SYSTEM_PROMPT, pass2Prompt);
  } catch (err: any) {
    const pass2Duration = Date.now() - pass2Start;
    const totalDuration = pass1Duration + pass2Duration;
    const trace: MissionExtractionTrace = {
      raw_user_input: userMessage,
      pass1_semantic_interpretation: pass1Result,
      pass2_structured_mission: null,
      pass2_raw_json: '',
      validation_result: { ok: false, mission: null, errors: [`Pass 2 LLM call failed: ${err.message}`] },
      model,
      pass1_duration_ms: pass1Duration,
      pass2_duration_ms: pass2Duration,
      total_duration_ms: totalDuration,
      timestamp,
      failure_stage: 'pass2_llm_call',
    };
    console.error(`[MISSION_EXTRACTOR] Pass 2 failed: ${err.message}`);
    return { trace, mission: null, ok: false };
  }
  const pass2Duration = Date.now() - pass2Start;
  const totalDuration = pass1Duration + pass2Duration;

  const cleanedJson = cleanJsonResponse(pass2RawResponse);

  let parsedRaw: Record<string, unknown>;
  try {
    parsedRaw = JSON.parse(cleanedJson);
  } catch {
    const validation: MissionValidationResult = {
      ok: false,
      mission: null,
      errors: [`Pass 2 returned invalid JSON: ${cleanedJson.substring(0, 200)}`],
    };
    const trace: MissionExtractionTrace = {
      raw_user_input: userMessage,
      pass1_semantic_interpretation: pass1Result,
      pass2_structured_mission: null,
      pass2_raw_json: pass2RawResponse,
      validation_result: validation,
      model,
      pass1_duration_ms: pass1Duration,
      pass2_duration_ms: pass2Duration,
      total_duration_ms: totalDuration,
      timestamp,
      failure_stage: 'pass2_json_parse',
    };
    console.error(`[MISSION_EXTRACTOR] Pass 2 JSON parse failed`);
    return { trace, mission: null, ok: false };
  }

  const cleaned = cleanupMissionValues(parsedRaw);
  const validation = parseAndValidateMissionJSON(JSON.stringify(cleaned));

  const failureStage: MissionFailureStage = validation.ok ? 'none' : 'pass2_schema_validation';

  const trace: MissionExtractionTrace = {
    raw_user_input: userMessage,
    pass1_semantic_interpretation: pass1Result,
    pass2_structured_mission: validation.mission,
    pass2_raw_json: pass2RawResponse,
    validation_result: validation,
    model,
    pass1_duration_ms: pass1Duration,
    pass2_duration_ms: pass2Duration,
    total_duration_ms: totalDuration,
    timestamp,
    failure_stage: failureStage,
  };

  if (validation.ok) {
    console.log(
      `[MISSION_EXTRACTOR] Success — entity="${validation.mission!.entity_category}" ` +
      `location="${validation.mission!.location_text}" mode="${validation.mission!.mission_mode}" ` +
      `constraints=${validation.mission!.constraints.length} model=${model} ` +
      `pass1=${pass1Duration}ms pass2=${pass2Duration}ms total=${totalDuration}ms`
    );
  } else {
    console.warn(
      `[MISSION_EXTRACTOR] Validation failed — errors: ${validation.errors.join('; ')} ` +
      `model=${model} total=${totalDuration}ms`
    );
  }

  return { trace, mission: validation.mission, ok: validation.ok };
}
