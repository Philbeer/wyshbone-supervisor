import {
  type StructuredMission,
  type MissionExtractionTrace,
  type MissionValidationResult,
  type MissionFailureStage,
  type ConstraintChecklist,
  type ImplicitExpansionTrace,
  type IntentNarrative,
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
import { expandImplicitConstraints, type ImplicitExpansionResult } from './implicit-constraint-expander';

const PASS1_SYSTEM_PROMPT = `You are a semantic interpreter for a business search system. Your job is to read a messy user message and restate what the user is actually asking for in clean, unambiguous language.

YOUR SOLE TASK: strip away surface phrasing and restate the underlying meaning. You are a translator from casual language to precise semantic language.

OUTPUT FORMAT: Return a JSON object with exactly two fields:
1. "constraint_checklist" — classify which constraint categories appear in the user request (boolean for each).
2. "semantic_interpretation" — a short paragraph of clean English restating the user's intent.

CONSTRAINT CHECKLIST FIELDS (set true only if the user's request contains this type):
- has_entity: an entity type is mentioned (e.g. pubs, cafes, hospitals)
- has_location: a geographic location is specified (named town, city, or area — this will produce a hard location_constraint downstream in addition to location_text)
- has_text_compare: a name or text match is requested (e.g. "with Swan in the name")
- has_attribute_check: a venue feature or amenity is required (e.g. "with a beer garden", "dog friendly")
- has_relationship_check: a business-to-business or business-to-entity relationship (e.g. "works with NHS", "partnered with", "supplies", "serves [an entity]", "affiliated with")
- has_numeric_range: a numeric threshold or range (e.g. "at least 4.5 stars", "more than 50 reviews")
- has_time_constraint: a time-based filter (e.g. "opened recently", "established before 2020")
- has_status_check: a service or operational status (e.g. "accepting new patients", "offers X service")
- has_website_evidence: proof from a website is required (e.g. "mention vegan food on their website")
- has_contact_extraction: contact information extraction is requested (e.g. "extract email addresses")
- has_ranking: ranking or ordering language is used (e.g. "best", "top", "highest rated")
- has_requested_count: a specific number of results is requested (e.g. "find 10 pubs")
- has_monitoring_intent: ongoing monitoring or alerting is requested (e.g. "keep checking", "alert me when", "notify me if")

CORE RULES:
1. First, classify which constraint categories appear in the user request by filling out the constraint_checklist.
2. Then, write a clean semantic interpretation of the user's intent.
3. Restate the user's intent in plain semantic English. NEVER preserve their exact wording or phrasing wrappers.
4. Identify the entity type (e.g. pubs, cafes, breweries, hospitals).
5. Identify the location if given.
6. Identify ALL constraints the user cares about. Each constraint must be restated as a clean semantic fact.
7. Identify the mission mode: is this a one-time search, ongoing monitoring, alert-on-change, or recurring check?
8. Do NOT invent constraints the user did not express. Only extract what is actually stated or clearly implied.
9. Interpret meaning, not phrasing. Do not copy user phrasing into the semantic interpretation.
10. Do not drop constraints — every constraint in the checklist must appear in the semantic interpretation.
11. Detect relationship language: "works with", "partnered with", "supplies", "serves [entity]", "affiliated with".
12. Detect ranking language: "best", "top", "highest rated".
13. Detect monitoring intent: "keep checking", "alert me when", "notify me if".

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
Output:
{
  "constraint_checklist": {
    "has_entity": true, "has_location": true, "has_text_compare": true,
    "has_attribute_check": false, "has_relationship_check": false, "has_numeric_range": false,
    "has_time_constraint": false, "has_status_check": false, "has_website_evidence": false,
    "has_contact_extraction": false, "has_ranking": false, "has_requested_count": false,
    "has_monitoring_intent": false
  },
  "semantic_interpretation": "The user wants pubs in Arundel whose business name contains \\"swan\\". This is a one-time search."
}

User: "find pubs in arundel that mention live music on their website"
Output:
{
  "constraint_checklist": {
    "has_entity": true, "has_location": true, "has_text_compare": false,
    "has_attribute_check": false, "has_relationship_check": false, "has_numeric_range": false,
    "has_time_constraint": false, "has_status_check": false, "has_website_evidence": true,
    "has_contact_extraction": false, "has_ranking": false, "has_requested_count": false,
    "has_monitoring_intent": false
  },
  "semantic_interpretation": "The user wants pubs in Arundel whose website text contains \\"live music\\". This is a one-time search."
}

User: "keep checking which hospitals in the UK offer the sleep apnea implant and alert me if it starts near my area"
Output:
{
  "constraint_checklist": {
    "has_entity": true, "has_location": true, "has_text_compare": false,
    "has_attribute_check": false, "has_relationship_check": false, "has_numeric_range": false,
    "has_time_constraint": false, "has_status_check": true, "has_website_evidence": false,
    "has_contact_extraction": false, "has_ranking": false, "has_requested_count": false,
    "has_monitoring_intent": true
  },
  "semantic_interpretation": "The user wants hospitals in the UK that offer the service \\"sleep apnea implant\\". They want ongoing monitoring with alerts when this service becomes available near their area. The mission mode is alert-on-change, with a location proximity filter for the user's area."
}

User: "find 10 italian restaurants in Brighton with outdoor seating and at least 4.5 stars"
Output:
{
  "constraint_checklist": {
    "has_entity": true, "has_location": true, "has_text_compare": false,
    "has_attribute_check": true, "has_relationship_check": false, "has_numeric_range": true,
    "has_time_constraint": false, "has_status_check": false, "has_website_evidence": false,
    "has_contact_extraction": false, "has_ranking": false, "has_requested_count": true,
    "has_monitoring_intent": false
  },
  "semantic_interpretation": "The user wants 10 Italian restaurants in Brighton that have outdoor seating and a rating of at least 4.5 stars. This is a one-time search."
}

User: "find dentists near Bristol that work with NHS and have good reviews"
Output:
{
  "constraint_checklist": {
    "has_entity": true, "has_location": true, "has_text_compare": false,
    "has_attribute_check": false, "has_relationship_check": true, "has_numeric_range": false,
    "has_time_constraint": false, "has_status_check": false, "has_website_evidence": false,
    "has_contact_extraction": false, "has_ranking": false, "has_requested_count": false,
    "has_monitoring_intent": false
  },
  "semantic_interpretation": "The user wants dentists near Bristol that have a relationship with the NHS. This is a one-time search."
}

User: "watch for new co-working spaces in London and let me know when one opens"
Output:
{
  "constraint_checklist": {
    "has_entity": true, "has_location": true, "has_text_compare": false,
    "has_attribute_check": false, "has_relationship_check": false, "has_numeric_range": false,
    "has_time_constraint": true, "has_status_check": false, "has_website_evidence": false,
    "has_contact_extraction": false, "has_ranking": false, "has_requested_count": false,
    "has_monitoring_intent": true
  },
  "semantic_interpretation": "The user wants co-working spaces in London. They want to be alerted when new ones open. The mission mode is alert-on-change with a time constraint for newly opened venues."
}

Return ONLY valid JSON matching this structure. No markdown fences, no commentary.`;

const PASS2_SYSTEM_PROMPT = `You are a schema mapper for a business search system. You receive a clean semantic interpretation of a user request and, when available, an INTENT ANALYSIS CONTEXT section produced by a prior intent analysis pass. Your job is to convert the semantic interpretation into a fixed JSON schema using ONLY the allowed types, operators, and values.

WHEN INTENT ANALYSIS CONTEXT IS PROVIDED, follow these rules before extracting any constraint:
- entity_description tells you what the user actually wants. Use this, not the raw query phrasing, as your primary guide.
- entity_exclusions list things that look similar but are wrong. These are NOT constraints to verify — they are exclusion signals. NEVER create a constraint whose value matches or targets something in entity_exclusions.
- key_discriminator is the single most important signal separating a correct result from a plausible-but-wrong one. Ground your constraints in this signal.
- commercial_context explains why the user wants this. If a phrase in the raw query is better explained by commercial_context than by a verifiable constraint, do NOT create a constraint for it.

Extract ONLY constraints that:
1. Can be verified by visiting a business website or checking a directory
2. Follow from the entity_description and key_discriminator — NOT from literal words in the raw query
3. Would genuinely distinguish a correct result from something in entity_exclusions

EXAMPLE — bottle shop query:
- entity_description: independent retail shops stocking craft beer from multiple producers
- entity_exclusions: ["breweries selling their own beer", "supermarkets and chain off-licences"]
- key_discriminator: sells multiple brands of craft beer — not a single producer's own products
- commercial_context: brewery owner seeking retail stockists for their product
→ CORRECT constraint: website_evidence containing "craft beer" or "bottle shop" or "independent off-licence"
→ WRONG constraint: relationship_check for "brewery" — brewery appears in entity_exclusions, NOT as a target
→ WRONG constraint: any constraint derived from "sell my beer from my brewery" — this is commercial_context only

If no constraint can be reliably verified from a website visit, return an empty constraints array. A clean entity_category with good discovery is always better than a wrong constraint.


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
  NAMED LOCATION RULE (ALWAYS APPLY):
  When the user specifies a named location — a specific town, city, or area (e.g. "in Arundel", "in Leeds", "in Bath", "in Manchester") —
  you MUST emit a hard location_constraint in the constraints array IN ADDITION to setting location_text.
  Use field "address", operator "within", hardness "hard", value = the place name exactly as it appears in location_text.
  Named location example: "pubs in Arundel" → { "type": "location_constraint", "field": "address", "operator": "within", "value": "Arundel", "hardness": "hard" }
  Named location example: "cafes in central London" → { "type": "location_constraint", "field": "address", "operator": "within", "value": "central London", "hardness": "hard" }

  VAGUE PROXIMITY (soft, no named place):
  "near my area" / "nearby" / "close to me" → soft proximity only, no hard location_constraint:
  Example: "near my area" → { "type": "location_constraint", "field": "location", "operator": "near", "value": "user_area", "hardness": "soft" }

  RULE SUMMARY: Named town/city/area → hard "in" constraint. Vague proximity phrase → soft "near" constraint or omit entirely.

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
- Do NOT duplicate information already captured in entity_category as constraints.
- EXCEPTION: location_text MUST always also appear as a hard location_constraint in the constraints array (see location_constraint rules above). This is the one field that intentionally appears in both places.

FULL EXAMPLES:

Semantic input: The user wants pubs in Arundel whose business name contains "swan". This is a one-time search.
{
  "entity_category": "pubs",
  "location_text": "Arundel",
  "requested_count": null,
  "constraints": [
    { "type": "location_constraint", "field": "address", "operator": "within", "value": "Arundel", "hardness": "hard" },
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
    { "type": "location_constraint", "field": "address", "operator": "within", "value": "Arundel", "hardness": "hard" },
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
    { "type": "location_constraint", "field": "address", "operator": "within", "value": "Manchester", "hardness": "hard" },
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
    { "type": "location_constraint", "field": "address", "operator": "within", "value": "Texas", "hardness": "hard" },
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
    { "type": "location_constraint", "field": "address", "operator": "within", "value": "Brighton", "hardness": "hard" },
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
    { "type": "location_constraint", "field": "address", "operator": "within", "value": "Sussex", "hardness": "hard" },
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
    { "type": "location_constraint", "field": "address", "operator": "within", "value": "London", "hardness": "hard" },
    { "type": "contact_extraction", "field": "email", "operator": "extract", "value": null, "hardness": "hard" }
  ],
  "mission_mode": "research_now"
}

Return ONLY valid JSON. No markdown fences, no commentary, no explanation.`;

const PASS3_SYSTEM_PROMPT = `You are an expert research strategist for a business intelligence agent. You receive a user's search goal and the structured intent extracted from it. Your job is to produce an intent narrative that tells the agent exactly what to look for, how hard it will be to find, and what to do if the primary approach fails.

Think like an experienced human researcher who understands what is and isn't findable on the internet. Every search eventually reduces to keywords and signals that appear on web pages. Your job is to work out what those signals are.

INPUT:
- original_message: the user's raw input
- semantic_interpretation: Pass 1 output — a clean restatement of what the user is asking for
- conversation_context: (optional) prior conversation turns. If this shows the user was previously asked a clarification question and has now answered it, set clarification_needed=false and proceed with what they have provided — do not ask again unless genuinely still unclear.

NOTE: You run BEFORE structured constraint extraction. Your entity_description, entity_exclusions, and key_discriminator will be used to guide the constraint extractor — so be precise about what is a genuine search constraint versus what is the user's commercial motivation or context.

OUTPUT SCHEMA (JSON only, no markdown):
{
  "entity_description": "specific plain English description of what the user actually wants",
  "entity_exclusions": ["things that look similar but are wrong"],
  "commercial_context": "why the user likely wants this and what they will do with the results",
  "key_discriminator": "the single most important signal that separates a correct result from a plausible but wrong one",
  "findability": "easy | moderate | hard | very_hard",
  "findability_reason": "one sentence explaining why this is easy or hard to find on the internet",
  "suggested_approaches": [
    "first thing to try on the internet",
    "second thing to try if first fails",
    "third fallback if second fails"
  ],
  "fallback_intent": "what to search for if all primary approaches fail — a related but more findable proxy for what the user wants",
  "scarcity_expectation": "abundant | moderate | scarce | unknown",
  "clarification_needed": true | false,
  "clarification_question": "the single most useful question to ask the user if clarification would significantly improve the result. null if not needed.",
  "ambiguity_flags": ["any parts of the query that are genuinely unclear"]
}

FINDABILITY SCORING:
- easy: attribute is commonly stated on business websites (opening hours, menus, services offered)
- moderate: attribute is findable but requires visiting pages and reading content
- hard: relationship or attribute is rarely stated directly — needs indirect evidence or third-party sources
- very_hard: no reliable web signal exists — agent should clarify with user before attempting

RULES:
- entity_description must be specific. Do not just repeat the category label. Describe the type of business in plain terms.
- entity_exclusions must list realistic confusables — things a Places search could return that would look right but are wrong.
- commercial_context is a single sentence about the user's likely intent. Do not speculate wildly.
- key_discriminator is a single sentence. It is the most important signal Tower should use to accept or reject a result.
- suggested_approaches must have exactly 3 entries, ordered from most to least promising.
- fallback_intent describes a more findable proxy query if all primary approaches fail.
- scarcity_expectation: "abundant" >50 findable results, "moderate" 10–50, "scarce" <10, "unknown" when genuinely unclear.
- clarification_question must be null if clarification_needed is false.
- ambiguity_flags: empty array [] if no genuine ambiguity.

EXAMPLE 1 — "find bottle shops in East Sussex that sell craft beer":
{
  "entity_description": "independent retail shops that stock craft beer from multiple producers for sale to the public",
  "entity_exclusions": ["breweries selling their own beer", "supermarkets and chain off-licences", "online-only retailers"],
  "commercial_context": "likely a craft brewer seeking independent stockists to place their product in",
  "key_discriminator": "sells multiple brands of craft beer from different producers — not a single producer's own shop",
  "findability": "moderate",
  "findability_reason": "bottle shops often have websites listing their stock or mentioning craft beer explicitly",
  "suggested_approaches": [
    "search Google Places for bottle shops and off-licences in East Sussex",
    "visit each website and look for mentions of craft beer, local beer, or multiple brewery names",
    "search for East Sussex craft beer retailers and independent off-licences"
  ],
  "fallback_intent": "independent off-licences and specialist drink retailers in East Sussex",
  "scarcity_expectation": "scarce",
  "clarification_needed": false,
  "clarification_question": null,
  "ambiguity_flags": []
}

EXAMPLE 2 — "find organisations that work with the local authority in Blackpool":
{
  "entity_description": "organisations that have a formal or funded relationship with Blackpool Council",
  "entity_exclusions": ["organisations merely located in Blackpool", "organisations that mention Blackpool without a council relationship", "national organisations with no local Blackpool presence"],
  "commercial_context": "likely researching the council supply chain or partnership ecosystem, possibly to identify decision-makers or entry points",
  "key_discriminator": "explicit named relationship with Blackpool Council — not just operating in Blackpool",
  "findability": "hard",
  "findability_reason": "council relationships are rarely stated as searchable text on an organisation's own website — more likely found in council documents, tender records, or press releases",
  "suggested_approaches": [
    "check Blackpool Council website for named partners, suppliers, and funded organisations",
    "search for organisations that mention Blackpool Council in their own content",
    "search council meeting minutes and procurement records for named suppliers"
  ],
  "fallback_intent": "charities, housing associations, and social enterprises operating in Blackpool that typically work with local authorities",
  "scarcity_expectation": "unknown",
  "clarification_needed": true,
  "clarification_question": "Are you looking for funded partners and grant recipients, or suppliers and contractors — or both?",
  "ambiguity_flags": ["works with is vague — could mean funded, contracted, or informally partnered"]
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
  intentNarrative: IntentNarrative | null;
  ok: boolean;
}

function selectModel(): string {
  if (process.env.OPENAI_API_KEY) return 'gpt-4o-mini';
  if (process.env.ANTHROPIC_API_KEY) return 'claude-3-5-haiku-20241022';
  return 'none';
}

async function callLLM(model: string, systemPrompt: string, userPrompt: string): Promise<string> {
  if (model === 'gpt-4o-mini') {
    try {
      return await callOpenAI(systemPrompt, userPrompt);
    } catch (err: any) {
      const is429 = err?.status === 429 || String(err?.message ?? '').includes('429');
      if (is429 && process.env.ANTHROPIC_API_KEY) {
        console.warn('[MISSION_EXTRACTOR] OpenAI 429 — falling back to Claude haiku for routing');
        return callAnthropic('claude-3-haiku-20240307', systemPrompt, userPrompt);
      }
      throw err;
    }
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

const EMPTY_CHECKLIST: ConstraintChecklist = {
  has_entity: false,
  has_location: false,
  has_text_compare: false,
  has_attribute_check: false,
  has_relationship_check: false,
  has_numeric_range: false,
  has_time_constraint: false,
  has_status_check: false,
  has_website_evidence: false,
  has_contact_extraction: false,
  has_ranking: false,
  has_requested_count: false,
  has_monitoring_intent: false,
};

function parsePass1Response(raw: string): { semantic_interpretation: string; constraint_checklist: ConstraintChecklist | null } {
  const cleaned = cleanJsonResponse(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && typeof parsed.semantic_interpretation === 'string') {
      const checklist: ConstraintChecklist = { ...EMPTY_CHECKLIST };
      if (parsed.constraint_checklist && typeof parsed.constraint_checklist === 'object') {
        for (const key of Object.keys(EMPTY_CHECKLIST) as (keyof ConstraintChecklist)[]) {
          if (typeof parsed.constraint_checklist[key] === 'boolean') {
            checklist[key] = parsed.constraint_checklist[key];
          }
        }
      }
      return { semantic_interpretation: parsed.semantic_interpretation, constraint_checklist: checklist };
    }
  } catch {}
  return { semantic_interpretation: raw.trim(), constraint_checklist: null };
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
      pass1_constraint_checklist: null,
      implicit_expansion: null,
      pass2_structured_mission: null,
      pass2_raw_json: '',
      validation_result: { ok: false, mission: null, errors: ['No LLM API key available'] },
      pass3_intent_narrative: null,
      pass3_raw_json: '',
      pass3_duration_ms: 0,
      model: 'none',
      pass1_duration_ms: 0,
      pass2_duration_ms: 0,
      total_duration_ms: 0,
      timestamp,
      failure_stage: 'no_api_key',
    };
    return { trace, mission: null, intentNarrative: null, ok: false };
  }

  const truncatedContext = truncateContext(conversationContext);

  let pass1Prompt: string;
  if (truncatedContext) {
    pass1Prompt = `Recent conversation:\n${truncatedContext}\n\nInterpret the semantic meaning of the LATEST user message:\n\n"${userMessage}"`;
  } else {
    pass1Prompt = `Interpret the semantic meaning of this user message:\n\n"${userMessage}"`;
  }

  let pass1RawResult = '';
  const pass1Start = Date.now();
  try {
    pass1RawResult = await callLLM(model, PASS1_SYSTEM_PROMPT, pass1Prompt);
  } catch (err: any) {
    const duration = Date.now() - pass1Start;
    const trace: MissionExtractionTrace = {
      raw_user_input: userMessage,
      pass1_semantic_interpretation: '',
      pass1_constraint_checklist: null,
      implicit_expansion: null,
      pass2_structured_mission: null,
      pass2_raw_json: '',
      validation_result: { ok: false, mission: null, errors: [`Pass 1 LLM call failed: ${err.message}`] },
      pass3_intent_narrative: null,
      pass3_raw_json: '',
      pass3_duration_ms: 0,
      model,
      pass1_duration_ms: duration,
      pass2_duration_ms: 0,
      total_duration_ms: duration,
      timestamp,
      failure_stage: 'pass1_llm_call',
    };
    console.error(`[MISSION_EXTRACTOR] Pass 1 failed: ${err.message}`);
    return { trace, mission: null, intentNarrative: null, ok: false };
  }
  const pass1Duration = Date.now() - pass1Start;

  const { semantic_interpretation: pass1Result, constraint_checklist: pass1Checklist } = parsePass1Response(pass1RawResult);

  if (pass1Checklist) {
    console.log(`[MISSION_EXTRACTOR] Pass 1 checklist: ${JSON.stringify(pass1Checklist)}`);
  } else {
    console.warn(`[MISSION_EXTRACTOR] Pass 1 returned non-JSON — checklist unavailable, falling back to raw text`);
  }

  const expansion = expandImplicitConstraints(userMessage, pass1Checklist, pass1Result);
  const expansionTrace: ImplicitExpansionTrace = {
    explicit_constraints: expansion.explicit_constraints,
    inferred_constraints: expansion.inferred_constraints,
    inference_notes: expansion.inference_notes,
    had_addendum: expansion.semantic_addendum !== null,
  };

  if (expansion.inferred_constraints.length > 0) {
    console.log(`[MISSION_EXTRACTOR] Implicit expansion: ${expansion.inferred_constraints.length} inferred constraint(s)`);
    for (const note of expansion.inference_notes) {
      console.log(`[MISSION_EXTRACTOR]   ${note}`);
    }
  }

  let pass2Input = pass1Result;
  if (expansion.semantic_addendum) {
    pass2Input = `${pass1Result} ${expansion.semantic_addendum}`;
    console.log(`[MISSION_EXTRACTOR] Pass 2 input enriched with addendum: "${expansion.semantic_addendum}"`);
  }

  console.log(`[MISSION] Pass 1 complete`);

  // === PASS 3: intent narrative — runs BEFORE Pass 2 to guide constraint extraction ===
  let pass3IntentNarrative: IntentNarrative | null = null;
  let pass3RawJson = '';
  let pass3DurationMs = 0;

  const pass3Prompt = `Original user message: "${userMessage}"

Pass 1 semantic interpretation: "${pass1Result}"
${truncatedContext ? `\nConversation context (prior turns):\n${truncatedContext}\n` : ''}
Produce the intent narrative JSON for this search.`;

  const pass3Start = Date.now();
  try {
    pass3RawJson = await callLLM(model, PASS3_SYSTEM_PROMPT, pass3Prompt);
    pass3DurationMs = Date.now() - pass3Start;
    const pass3Cleaned = cleanJsonResponse(pass3RawJson);
    const pass3Parsed = JSON.parse(pass3Cleaned);
    if (
      pass3Parsed &&
      typeof pass3Parsed.entity_description === 'string' &&
      Array.isArray(pass3Parsed.entity_exclusions) &&
      typeof pass3Parsed.commercial_context === 'string' &&
      typeof pass3Parsed.key_discriminator === 'string' &&
      typeof pass3Parsed.findability === 'string' &&
      typeof pass3Parsed.findability_reason === 'string' &&
      Array.isArray(pass3Parsed.suggested_approaches) &&
      typeof pass3Parsed.fallback_intent === 'string' &&
      typeof pass3Parsed.scarcity_expectation === 'string' &&
      typeof pass3Parsed.clarification_needed === 'boolean' &&
      Array.isArray(pass3Parsed.ambiguity_flags)
    ) {
      const scarcity = pass3Parsed.scarcity_expectation;
      const findability = pass3Parsed.findability;
      pass3IntentNarrative = {
        entity_description: pass3Parsed.entity_description,
        entity_exclusions: pass3Parsed.entity_exclusions,
        commercial_context: pass3Parsed.commercial_context,
        key_discriminator: pass3Parsed.key_discriminator,
        findability: (findability === 'easy' || findability === 'moderate' || findability === 'hard' || findability === 'very_hard') ? findability : 'moderate',
        findability_reason: pass3Parsed.findability_reason,
        suggested_approaches: pass3Parsed.suggested_approaches,
        fallback_intent: pass3Parsed.fallback_intent,
        scarcity_expectation: (scarcity === 'abundant' || scarcity === 'moderate' || scarcity === 'scarce' || scarcity === 'unknown') ? scarcity : 'unknown',
        clarification_needed: pass3Parsed.clarification_needed,
        clarification_question: typeof pass3Parsed.clarification_question === 'string' ? pass3Parsed.clarification_question : null,
        ambiguity_flags: pass3Parsed.ambiguity_flags,
      };
      console.log(`[MISSION] Pass 3 complete — entity: ${pass3IntentNarrative.entity_description.substring(0, 100)}`);
      console.log(`[MISSION_EXTRACTOR] Pass 3 — findability=${pass3IntentNarrative.findability} scarcity=${pass3IntentNarrative.scarcity_expectation} clarification_needed=${pass3IntentNarrative.clarification_needed} exclusions=${pass3IntentNarrative.entity_exclusions.length} duration=${pass3DurationMs}ms`);
    } else {
      console.warn(`[MISSION_EXTRACTOR] Pass 3 returned unexpected shape — skipping (non-fatal), Pass 2 will run without context`);
    }
  } catch (err: any) {
    pass3DurationMs = Date.now() - pass3Start;
    console.warn(`[MISSION_EXTRACTOR] Pass 3 failed (non-fatal): ${err.message} — Pass 2 will run without context`);
  }

  // === PASS 2: schema mapping — receives Pass 3 context when available ===
  let pass2Prompt: string;
  if (pass3IntentNarrative) {
    pass2Prompt = `INTENT ANALYSIS CONTEXT (use this to guide constraint extraction):
entity_description: ${pass3IntentNarrative.entity_description}
entity_exclusions: ${JSON.stringify(pass3IntentNarrative.entity_exclusions)}
commercial_context: ${pass3IntentNarrative.commercial_context}
key_discriminator: ${pass3IntentNarrative.key_discriminator}
suggested_approaches: ${JSON.stringify(pass3IntentNarrative.suggested_approaches)}

Convert this semantic interpretation into the structured mission JSON schema:

"${pass2Input}"`;
  } else {
    pass2Prompt = `Convert this semantic interpretation into the structured mission JSON schema:\n\n"${pass2Input}"`;
  }

  let pass2RawResponse = '';
  const pass2Start = Date.now();
  try {
    pass2RawResponse = await callLLM(model, PASS2_SYSTEM_PROMPT, pass2Prompt);
  } catch (err: any) {
    const pass2Duration = Date.now() - pass2Start;
    const totalDuration = pass1Duration + pass3DurationMs + pass2Duration;
    const trace: MissionExtractionTrace = {
      raw_user_input: userMessage,
      pass1_semantic_interpretation: pass1Result,
      pass1_constraint_checklist: pass1Checklist,
      implicit_expansion: expansionTrace,
      pass2_structured_mission: null,
      pass2_raw_json: '',
      validation_result: { ok: false, mission: null, errors: [`Pass 2 LLM call failed: ${err.message}`] },
      pass3_intent_narrative: pass3IntentNarrative,
      pass3_raw_json: pass3RawJson,
      pass3_duration_ms: pass3DurationMs,
      model,
      pass1_duration_ms: pass1Duration,
      pass2_duration_ms: pass2Duration,
      total_duration_ms: totalDuration,
      timestamp,
      failure_stage: 'pass2_llm_call',
    };
    console.error(`[MISSION_EXTRACTOR] Pass 2 failed: ${err.message}`);
    return { trace, mission: null, intentNarrative: pass3IntentNarrative, ok: false };
  }
  const pass2Duration = Date.now() - pass2Start;
  const totalDuration = pass1Duration + pass3DurationMs + pass2Duration;

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
      pass1_constraint_checklist: pass1Checklist,
      implicit_expansion: expansionTrace,
      pass2_structured_mission: null,
      pass2_raw_json: pass2RawResponse,
      validation_result: validation,
      pass3_intent_narrative: pass3IntentNarrative,
      pass3_raw_json: pass3RawJson,
      pass3_duration_ms: pass3DurationMs,
      model,
      pass1_duration_ms: pass1Duration,
      pass2_duration_ms: pass2Duration,
      total_duration_ms: totalDuration,
      timestamp,
      failure_stage: 'pass2_json_parse',
    };
    console.error(`[MISSION_EXTRACTOR] Pass 2 JSON parse failed`);
    return { trace, mission: null, intentNarrative: pass3IntentNarrative, ok: false };
  }

  const cleaned = cleanupMissionValues(parsedRaw);
  const validation = parseAndValidateMissionJSON(JSON.stringify(cleaned));

  const failureStage: MissionFailureStage = validation.ok ? 'none' : 'pass2_schema_validation';

  if (validation.ok && validation.mission) {
    console.log(`[MISSION] Pass 2 complete — constraints derived from Pass 3: ${JSON.stringify(validation.mission.constraints)}`);
  }

  const trace: MissionExtractionTrace = {
    raw_user_input: userMessage,
    pass1_semantic_interpretation: pass1Result,
    pass1_constraint_checklist: pass1Checklist,
    implicit_expansion: expansionTrace,
    pass2_structured_mission: validation.mission,
    pass2_raw_json: pass2RawResponse,
    validation_result: validation,
    pass3_intent_narrative: pass3IntentNarrative,
    pass3_raw_json: pass3RawJson,
    pass3_duration_ms: pass3DurationMs,
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
      `pass1=${pass1Duration}ms pass3=${pass3DurationMs}ms pass2=${pass2Duration}ms total=${totalDuration}ms`
    );
  } else {
    console.warn(
      `[MISSION_EXTRACTOR] Validation failed — errors: ${validation.errors.join('; ')} ` +
      `model=${model} total=${totalDuration}ms`
    );
  }

  return { trace, mission: validation.mission, intentNarrative: pass3IntentNarrative, ok: validation.ok };
}
