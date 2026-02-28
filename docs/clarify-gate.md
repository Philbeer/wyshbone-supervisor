# Clarify Gate

## Purpose

The Clarify Gate is a strict intent-routing layer that runs **before** any agent execution. If user intent is unclear, no tools are invoked — the system asks clarifying questions instead.

**Primary rule: IF IN DOUBT → CLARIFY, NEVER GUESS.**

## Routes

Every incoming message is classified into exactly one route:

| Route | When | What happens |
|---|---|---|
| `direct_response` | Explanations, definitions, advice, meta questions, trust questions | Responds directly, no agent run, no tools |
| `clarify_before_run` | Intent is ambiguous or missing key information | Asks 1–3 targeted questions, explicitly says execution will wait | 
| `agent_run` | Intent is clear and runnable | Proceeds to agent execution |

## Clarification Triggers

The gate triggers `clarify_before_run` if **any** of the following are true:

1. **Missing or vague location** — no city, region, or country specified and no explicit default
2. **Vague entity type** — generic terms like "organisations", "companies", "things" without a sector qualifier
3. **Relationship predicates** — phrases like "works with", "supplies", "supports", "partners with", "serves", "provides services to"
4. **Mixed or switched intent** — a single message containing both a question and a search request, or multiple search intents
5. **Malformed or concatenated input** — joined sentences, missing spaces, multiple questions mashed together
6. **False prior context** — references like "earlier you said…" or "you mentioned…" that don't exist

## Clarification Output Rules

- Maximum 3 questions per clarification
- Questions directly reduce uncertainty
- Always includes: "I'll run the search once you confirm"
- Never implies execution has started

## Clarify Session (Follow-up Handling)

When the gate triggers `clarify_before_run`, a **ClarifySession** is created in memory for the conversation. This prevents the merge/concatenation bug where follow-up answers get appended into the original query text.

### Session State

Each session tracks:
- `originalUserRequest` — immutable, the exact text the user first typed
- `missingFields` — which fields still need answers (e.g. `location`, `entity_type`)
- `collectedFields` — structured data: `{ businessType, location, attribute, count, relationship }`

### Follow-up Classification

When a user replies during an active session, the message is classified as:

| Classification | Meaning | Action |
|---|---|---|
| `ANSWER_TO_MISSING_FIELD` | Answers a pending question (e.g. "West Sussex" when location was asked) | Updates the structured field, removes from missing list |
| `REFINEMENT` | Adds detail consistent with the original request (e.g. "freehouses", "dog friendly") | Updates attribute field |
| `NEW_REQUEST` | Unrelated message, question, or new search (e.g. "are these results guaranteed correct", "can you help me with sales") | **Closes session immediately**, routes message normally — never merged |

### Key Guarantees

1. Raw user input is **never appended** to the query string
2. The clarify summary is always **re-rendered from structured fields** (`renderClarifySummary`)
3. `NEW_REQUEST` messages are **never merged** into the pending query — the session is closed first
4. Sessions auto-expire after 15 minutes

## Examples

| Input | Route | Reason |
|---|---|---|
| `"what does a lead generation agent do"` | `direct_response` | Informational question, no search needed |
| `"organisations that work with councils"` | `clarify_before_run` | Relationship predicate + vague entity type + no location |
| `"find 10 micropubs in Sussex UK"` | `agent_run` | Clear intent, specific entity, specific location |
| `"Find decision-makers at breweries in Waleswhat organisations support vulnerable adults in Leeds"` | `clarify_before_run` | Malformed input + mixed intent |
| `"companies in London"` | `clarify_before_run` | Vague entity type without sector |
| `"find pubs"` | `clarify_before_run` | No location specified |
| `"earlier you said you'd look into care homes"` | `clarify_before_run` | References false prior context |

### Session Follow-up Examples

| Session state | User says | Classification | Result |
|---|---|---|---|
| Missing: location, BT: pubs | `"west sussex"` | ANSWER_TO_MISSING_FIELD | location = "west sussex", session complete → run |
| Complete, BT: pubs, Loc: west sussex | `"freehouses"` | REFINEMENT | attribute = "freehouses" |
| Complete, BT: pubs, Loc: west sussex | `"are these results guaranteed correct"` | NEW_REQUEST | Session closed, routed as direct_response |
| Missing: relationship, BT: orgs, Loc: blackpool | `"any, just research it"` | ANSWER_TO_MISSING_FIELD | relationship confirmed |
| Missing: relationship, BT: orgs, Loc: blackpool | `"can you help me with sales"` | NEW_REQUEST | Session closed, routed normally |

## Implementation

- **Clarify Gate:** `server/supervisor/clarify-gate.ts` — `evaluateClarifyGate(userMessage): ClarifyGateResult`
- **Clarify Session:** `server/supervisor/clarify-session.ts` — session state, follow-up classification, structured field management
- **Integration point:** `processChatTask()` in `server/supervisor.ts`, runs before `executeTowerLoopChat()`
- **Logging:** `[CLARIFY_GATE]` and `[CLARIFY_SESSION]` console logs + `diagnostic` artefacts
- **Tests:** `server/supervisor/clarify-session.test.ts` (17 tests)

## Relationship to Existing Gates

The Clarify Gate runs **before** `executeTowerLoopChat` and before goal parsing. The existing `evaluatePrePlanGate` (which checks vertical mismatch, informational queries, and merged queries) runs later, inside `executeTowerLoopChat`, after LLM-based goal parsing. The Clarify Gate is a fast, deterministic pre-filter that prevents unnecessary LLM calls entirely.
