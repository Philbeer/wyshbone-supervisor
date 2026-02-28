# Wyshbone Supervisor — Forensic Report

**Scope:** clarify_for_run behaviour, draft request construction, "search now" recognition, and turn classification.

**Date:** 28 February 2026

---

## A) Clarify-for-Run Handler

### Where it lives

The handler is split across three files:

| File | Role |
|---|---|
| `server/supervisor/clarify-gate.ts` | First-contact gate. Function `evaluateClarifyGate(userMessage)` decides whether a message should be answered directly, clarified before running, or executed immediately. |
| `server/supervisor/clarify-session.ts` | Stateful multi-turn session. Manages the draft, classifies follow-ups, and decides when the draft is "complete enough" to launch a search. |
| `server/supervisor.ts` (lines 735–873 of `processChatTask`) | Orchestrator. Wires the gate and session together, writes messages and artefacts to Supabase, and hands off to `executeTowerLoopChat` when ready. |

### Inputs it receives from the UI

The handler receives a `SupervisorTask` row claimed from the `supervisor_tasks` Supabase table. The payload that matters is:

```
task.request_data = {
  user_message: string,       // raw text typed by the user
  run_id?: string,             // UI-assigned run identifier
  client_request_id?: string,  // correlation ID for UI updates
  search_query?: {             // optional; may be absent on first turn
    business_type?: string,
    location?: string,
  }
}
```

The raw message is extracted at line 659: `const rawMsg = String(requestData.user_message || '')`.

`evaluateClarifyGate` itself receives only the raw string (`userMessage: string`). It does no database lookups.

### Outputs it emits

Depending on route, the handler writes:

1. **A message row** (`messages` table) with `role: 'assistant'`, `source: 'supervisor'`, and metadata that includes:
   - `clarify_gate`: one of `'direct_response'`, `'clarify_before_run'`, or `'clarify_session_continue'`.
   - `reason`, `questions`, `session_summary`, `collected_fields` (varies by route).

2. **A diagnostic artefact** (`artefacts` table) recording the gate decision and collected fields.

3. **An agent_run status update** (`agent_runs` table) with `terminalState` set to `'clarification_needed'` or `'direct_response'`.

4. **A task completion update** (`supervisor_tasks` table) with the task marked `status: 'completed'`.

No search is executed and no Tower call is made while the handler is in clarify mode.

### Internal states

The code does not use an explicit state enum. The effective states are:

| Effective state | How it manifests | What happens |
|---|---|---|
| **ask_more** (initial clarify) | `evaluateClarifyGate` returns `route: 'clarify_before_run'`. A `ClarifySession` is created via `createClarifySession` and stored in an in-memory `Map<string, ClarifySession>`. The system sends the user 1–3 clarifying questions. | The task completes with `terminalState: 'clarification_needed'`. No search runs. |
| **waiting** (session exists, follow-up arrives) | On the next user turn, `getClarifySession(conversation_id)` returns a live session. The follow-up is classified by `classifyFollowUp`. If it is an `ANSWER_TO_MISSING_FIELD` or `REFINEMENT`, `applyFollowUp` merges it. If `sessionIsComplete` is still `false`, the system sends remaining questions (same response pattern as ask_more). | Task completes with `clarify_gate: 'clarify_session_continue'`. Still no search. |
| **ready_to_search** (session complete) | `sessionIsComplete(session)` returns `true` (all `missingFields` resolved and at least `businessType` or `relationship` present). `buildSearchFromSession` produces `{ businessType, location, attribute, count }`. A synthetic message is composed and injected into `task.request_data.user_message`. The session is closed. Control falls through to `executeTowerLoopChat`. | The agent run actually fires. |

### What causes it to remain in clarify mode across turns

The system stays in clarify mode as long as **all three** conditions hold:

1. A `ClarifySession` exists for the `conversation_id` in the in-memory map (TTL: 15 minutes, constant `SESSION_TTL_MS`).
2. `classifyFollowUp` does **not** return `'NEW_REQUEST'`.
3. `sessionIsComplete` returns `false` — meaning either `missingFields` is non-empty, or both `businessType` and `relationship` are null.

There is **no turn counter or maximum number of clarification rounds**. The session loops indefinitely until one of:
- All missing fields are answered (auto-proceeds to search).
- The user sends something classified as `NEW_REQUEST` (session is closed, message re-evaluated from scratch).
- 15 minutes elapse (session expires on next `getClarifySession` call).

---

## B) Draft Request Representation

### The draft object

The pending search request is represented by `ClarifySession` (defined in `server/supervisor/clarify-session.ts`, lines 3–15):

```typescript
interface ClarifySession {
  conversationId: string;
  originalUserRequest: string;
  missingFields: MissingField[];  // 'location' | 'entity_type' | 'relationship_clarification'
  collectedFields: {
    businessType: string | null;
    location: string | null;
    attribute: string | null;    // e.g. "dog friendly", "real ale"
    count: number | null;
    relationship: string | null; // e.g. "yes" or user's confirmation text
  };
  createdAt: number;             // epoch ms, used for TTL
}
```

Storage: an in-memory `Map<string, ClarifySession>` keyed by `conversationId` (line 25). **Not persisted to database.** If the server restarts, all active clarify sessions are lost.

### How refinements are merged

Function: `applyFollowUp(session, result)` (lines 201–222).

| Follow-up classification | Merge behaviour |
|---|---|
| `ANSWER_TO_MISSING_FIELD` with `updatedField: 'location'` | Sets `collectedFields.location`. Removes `'location'` from `missingFields`. |
| `ANSWER_TO_MISSING_FIELD` with `updatedField: 'entity_type'` | Sets `collectedFields.businessType`. Removes `'entity_type'` from `missingFields`. |
| `ANSWER_TO_MISSING_FIELD` with `updatedField: 'relationship_clarification'` | Sets `collectedFields.relationship`. Removes `'relationship_clarification'` from `missingFields`. |
| `REFINEMENT` where value matches `BUSINESS_MODIFIERS` regex | Sets `collectedFields.attribute` (e.g. "dog friendly"). |
| `REFINEMENT` where `businessType` is already set | Sets `collectedFields.attribute` to the refinement value. |
| `REFINEMENT` where `businessType` is null | Sets `collectedFields.businessType` to the refinement value. |

Refinements **replace** the target field; they do not append. There is no accumulation of multiple attributes.

### What triggers a reset

1. `classifyFollowUp` returns `'NEW_REQUEST'` → `closeClarifySession` is called (line 753), session deleted from map.
2. `evaluateClarifyGate` returns `'direct_response'` for a fresh message → `closeClarifySession` is called (line 825).
3. TTL expiry: if `Date.now() - session.createdAt > 15 * 60 * 1000`, `getClarifySession` returns null and deletes the entry (lines 55–58).
4. Session completion: `sessionIsComplete` returns true → `closeClarifySession` called (line 762), then search proceeds.

### How "micropubs in Sussex that opened in last 12 months" becomes "12 pubs for me"

This is a data-loss scenario caused by how `buildSearchFromSession` and `renderClarifySummary` flatten the draft.

`buildSearchFromSession` (line 249) returns only four fields: `businessType`, `location`, `attribute`, `count`. The function `renderClarifySummary` (line 224) concatenates them as: `"Find [count] [businessType] in [location] ([attribute])"`.

The synthetic message composed at line 765 is:
```
`find ${count ? count + ' ' : ''}${businessType} in ${location}${attribute ? ' with ' + attribute : ''}`
```

**Problem 1 — No temporal filter field.** "Opened in last 12 months" has nowhere to go. `collectedFields` has no `temporal`, `filter`, or `since` field. If the original message was "micropubs in Sussex that opened in last 12 months" and was routed to clarify (say, location was ambiguous), the temporal constraint would be stored at best as part of `attribute` or silently dropped.

**Problem 2 — Attribute is a single string.** If "opened in last 12 months" lands in `attribute`, and the user later refines with "dog friendly", the temporal clause is overwritten.

**Problem 3 — `count` extraction is never populated by the gate.** `extractBusinessType` in `clarify-gate.ts` strips "for me" and similar phrases but never parses a count from the message. The `count` field in `collectedFields` remains `null` unless explicitly set (it currently never is). This means the user's "12" would either be absorbed into `businessType` as a prefix or lost.

**Net effect:** A rich request like "micropubs in Sussex that opened in last 12 months" could plausibly degrade to "find pubs in Sussex" — losing the "micro" prefix (if vagueness triggers entity_type clarification), the temporal filter, and any count.

---

## C) Execute Signal Handling

### Where it checks for execution signals

**There is no dedicated "search now" / "execute" command handler anywhere in the Supervisor.**

The closest mechanisms are:

1. **Implicit execution on session completion.** When `sessionIsComplete` returns true (all missing fields filled, businessType present), the system automatically proceeds to search. The user does not need to say "search now" — merely answering the last question triggers execution.

2. **Affirmative phrases during `relationship_clarification`.** In `clarify-session.ts` line 99 and line 168, the following are recognised as answers to the relationship clarification question:
   ```
   /\b(?:yes|yeah|yep|sure|ok|okay|go ahead|just|any|fine|proceed|do it)\b/i
   ```
   These are **not** general "execute" commands. They only fire when `missingFields` includes `'relationship_clarification'` and they resolve that specific field. They do not trigger a search if other fields are still missing.

3. **No "search now" keyword match.** There is no regex, no string comparison, and no special handling for phrases like "search now", "run it", "execute", "start searching", or "go". These phrases would be classified by `classifyFollowUp` using its general heuristics and could be misrouted.

### Exact matching logic

Since no explicit execute-signal handler exists, the closest matching logic is the affirmative pattern at line 168:
```
/\b(?:yes|yeah|yep|sure|ok|okay|go ahead|just|any|research|proceed|do it|that's fine|fine)\b/i
```
- Case-insensitive.
- Word-boundary delimited.
- Only checked when `relationship_clarification` is a missing field.
- Leading/trailing whitespace is trimmed, trailing punctuation is stripped.

### Whether execution is allowed while in clarify state

**No.** While a `ClarifySession` exists and `sessionIsComplete` is false, the system always returns early at line 805 (`return;`) after sending clarification questions. It never falls through to `executeTowerLoopChat`.

The only way to reach execution from a clarify state is:
- All missing fields are resolved and `sessionIsComplete` flips to true (automatic).
- The user sends a `NEW_REQUEST`, which closes the session and re-evaluates from scratch through the gate.

### What happens if execution is received but draft is incomplete

If the user types "search now" or "go ahead" while location is still missing:

1. `classifyFollowUp` runs on "search now".
2. `looksLikeNewRequest` checks: it does **not** match `QUESTION_PATTERNS`. It checks `NEW_REQUEST_SIGNALS`: the word "search" is not in the signal patterns, but "go ahead" matches `/\b(?:go ahead)\b/` inside `isShortFieldAnswer` — which returns true **only** if `relationship_clarification` is a missing field.
3. If location is missing (but not relationship_clarification), "go ahead" hits `NEW_REQUEST_SIGNALS` (line 78 doesn't match, but "go ahead" is not in the main `NEW_REQUEST_SIGNALS` — it's only in the affirmative list). Actually, "search now" with 2 words would fall through to the final catch-all at line 184 (`trimmed.split(/\s+/).length <= 3 && !looksLikeNewRequest`), which would classify it as `ANSWER_TO_MISSING_FIELD` for location — treating "search now" as a location name.
4. **Result: "search now" could be stored as the location**, leading to a search query like "find pubs in search now".

This is a concrete bug: there is no guard against execute-intent phrases being absorbed as field values.

---

## D) Turn Boundary / Intent Classification

### Where it decides

Classification happens in two stages within `processChatTask` (`server/supervisor.ts`, lines 735–873):

**Stage 1 — Session check (line 735–808):**
If `getClarifySession(conversation_id)` returns a session, the message is routed to `classifyFollowUp` (`clarify-session.ts`, line 140). This classifies the turn as one of:
- `ANSWER_TO_MISSING_FIELD` — stays in session, merges data.
- `REFINEMENT` — stays in session, merges data.
- `NEW_REQUEST` — closes session, falls through to Stage 2.

**Stage 2 — Fresh gate (line 810–873):**
If no session exists (or was just closed), `evaluateClarifyGate` (`clarify-gate.ts`, line 165) classifies the turn as one of:
- `direct_response` — meta question, greeting, trust query.
- `clarify_before_run` — search intent with missing/vague fields.
- `agent_run` — clear, runnable search request.

**Stage 2.5 — Pre-plan gate (not always reached):**
`evaluatePrePlanGate` (`server/supervisor/pre-plan-gate.ts`, line 62) runs inside the planning phase (after `agent_run` is chosen). It checks for:
- `vertical_mismatch` — query doesn't fit the account's vertical.
- `informational_query` — informational question that slipped through.
- `query_suspected_merged` — multiple queries concatenated.

### Whether it has a classifier, router, or heuristic

**All classification is heuristic — regex-based pattern matching. There is no LLM classifier, no ML model, no embedding similarity, and no external NLU service.**

Key heuristics in `clarify-gate.ts`:
- `isDirectResponse`: checks `DIRECT_RESPONSE_PATTERNS` (8 regexes matching question words, greetings, meta phrases). Returns false immediately if `hasSearchIntent` is true.
- `hasSearchIntent`: checks for lead-finding verbs (`find`, `search`, `list`, etc.), noun-phrase patterns (`list of ... in ...`), or location-indicator + plural-noun combos.
- `hasVagueEntityType`: checks if the message includes words from `VAGUE_ENTITY_TYPES` (organisations, companies, businesses, etc.) without a sector qualifier.
- `isMissingLocation`: checks for location prepositions and known region names.
- `hasRelationshipPredicate`: checks against 33 relationship phrases from `server/supervisor/relationship-predicate.ts`.

Key heuristics in `clarify-session.ts`:
- `looksLikeNewRequest`: checks question patterns, `NEW_REQUEST_SIGNALS` (regex array including trust words like "guarantee", "accurate", "trust"), word count > 10 with search verbs.
- `isShortFieldAnswer`: word count ≤ 5 with pattern matching for locations and entity types.
- `looksLikeRefinement`: word count ≤ 5 matching `BUSINESS_MODIFIERS` or simple lowercase words.

### Why trust questions might be routed into clarify_for_run

There are two distinct failure modes:

**Failure Mode 1 — Gate level (`clarify-gate.ts`):**
`isDirectResponse` (line 59) is short-circuited by `hasSearchIntent` (line 63). If a trust question contains search-like patterns, it is **not** classified as `direct_response`.

Example: *"Can I trust the list of businesses you find in London?"*
- `hasSearchIntent` → `true` (matches `NOUN_PHRASE_SEARCH` "list of" + `LOCATION_INDICATOR` "in London").
- `isDirectResponse` → `false` (line 63, early return).
- `hasVagueEntityType` → `true` (contains "businesses").
- Result: `clarify_before_run` with `entity_type` as a missing field.
- **The user receives a clarification question about business type instead of a trust answer.**

**Failure Mode 2 — Session level (`clarify-session.ts`):**
`NEW_REQUEST_SIGNALS` at line 78 includes: `/\b(?:guarantee|guaranteed|accurate|correct|reliable|trust|confident|sure)\b/i`.

If a user is in an active clarify session and asks *"Can I trust these results?"*, this matches `NEW_REQUEST_SIGNALS`, so `looksLikeNewRequest` returns `true` → classification is `NEW_REQUEST` → session closes → message goes to `evaluateClarifyGate` → could be routed to `direct_response` (if `hasSearchIntent` is false) or back to `clarify_before_run` (if search-like words are present).

**The net result: trust and meta questions have no guaranteed escape hatch during a clarify session.** Whether they are handled correctly depends on whether the phrasing accidentally triggers search-intent patterns.

### Missing "meta question escape hatch"

There is no mechanism at the session level to detect and handle meta/trust questions. `classifyFollowUp` has exactly three outcomes: `ANSWER_TO_MISSING_FIELD`, `REFINEMENT`, and `NEW_REQUEST`. There is no `META_QUESTION` or `DIRECT_RESPONSE` classification. If a meta question is not classified as `NEW_REQUEST`, it will be absorbed as a field answer or refinement.

The `direct_response` route only exists at the gate level (`evaluateClarifyGate`), and the gate is only evaluated when no session is active (or when a session was just closed via `NEW_REQUEST`).

---

## E) Minimal Fix Targets

The smallest set of Supervisor modules that must change to support the four capabilities:

### 1. Turn boundary reclassification

**Goal:** Allow meta/trust questions to be correctly identified and answered regardless of whether a clarify session is active.

| Module | Change |
|---|---|
| `server/supervisor/clarify-session.ts` — `classifyFollowUp` | Add a fourth classification: `'META_QUESTION'`. Insert a check before the existing logic that tests for direct-response patterns (can reuse patterns from `clarify-gate.ts`'s `DIRECT_RESPONSE_PATTERNS`). |
| `server/supervisor.ts` — `processChatTask` (lines 738–808) | Handle the new `META_QUESTION` classification: answer the meta question directly without closing the session, so the user can return to clarification on their next turn. |

### 2. Bounded clarify mode

**Goal:** Prevent infinite clarification loops by capping the number of rounds.

| Module | Change |
|---|---|
| `server/supervisor/clarify-session.ts` — `ClarifySession` interface | Add a `turnCount: number` field. |
| `server/supervisor/clarify-session.ts` — `applyFollowUp` | Increment `turnCount` on each application. |
| `server/supervisor.ts` — `processChatTask` | After `applyFollowUp`, check if `turnCount` exceeds a threshold (e.g. 3). If so, either force-proceed with whatever fields are collected (using `buildSearchFromSession` with defaults) or close the session and inform the user. |

### 3. Typed execute parity

**Goal:** Recognise explicit "search now" / "go ahead" / "run it" commands as execution signals, not as field values.

| Module | Change |
|---|---|
| `server/supervisor/clarify-session.ts` — `classifyFollowUp` | Add a fifth classification: `'EXECUTE_NOW'`. Insert a check (before field-answer logic) for execution-intent phrases like "search now", "run it", "go", "do it", "proceed", "go ahead", "just search". |
| `server/supervisor.ts` — `processChatTask` | Handle `EXECUTE_NOW`: if `sessionIsComplete` → proceed normally; if session is **incomplete** → either proceed with defaults and a warning, or reply telling the user which fields are still needed. |

### 4. Safe structured request summaries

**Goal:** Prevent data loss when flattening the draft into a synthetic message. Ensure temporal filters, counts, and multiple attributes survive.

| Module | Change |
|---|---|
| `server/supervisor/clarify-session.ts` — `ClarifySession.collectedFields` | Extend with: `temporalFilter: string \| null`, `filters: string[] \| null` (replacing single `attribute`), and ensure `count` is actually populated. |
| `server/supervisor/clarify-gate.ts` — `extractBusinessType` | Parse and extract count (e.g. "find **10** micropubs") into `parsedFields.count`. |
| `server/supervisor/clarify-session.ts` — `buildSearchFromSession` and `renderClarifySummary` | Emit all collected fields (including temporal, multiple attributes) into both the human-readable summary and the structured search params. |
| `server/supervisor.ts` — line 765 (synthetic message construction) | Use the extended structured object from `buildSearchFromSession` rather than string interpolation, or at minimum include all fields in the synthetic message. |

### Summary of touched files

| File | Fix targets addressed |
|---|---|
| `server/supervisor/clarify-session.ts` | All four (reclassification, bounding, execute parity, safe summaries) |
| `server/supervisor.ts` (`processChatTask`) | Reclassification, bounding, execute parity |
| `server/supervisor/clarify-gate.ts` | Safe summaries (count extraction) |

No other Supervisor modules need to change. The gate, session, and orchestrator are the complete surface area.

---

*End of report.*
