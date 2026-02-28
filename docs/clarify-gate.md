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

## Implementation

- **File:** `server/supervisor/clarify-gate.ts`
- **Function:** `evaluateClarifyGate(userMessage: string): ClarifyGateResult`
- **Returns:** `{ route, reason, questions? }`
- **Integration point:** `processChatTask()` in `server/supervisor.ts`, runs before `executeTowerLoopChat()`
- **Logging:** Every routing decision is logged to console (`[CLARIFY_GATE]`) and emitted as a `diagnostic` artefact

## Relationship to Existing Gates

The Clarify Gate runs **before** `executeTowerLoopChat` and before goal parsing. The existing `evaluatePrePlanGate` (which checks vertical mismatch, informational queries, and merged queries) runs later, inside `executeTowerLoopChat`, after LLM-based goal parsing. The Clarify Gate is a fast, deterministic pre-filter that prevents unnecessary LLM calls entirely.
