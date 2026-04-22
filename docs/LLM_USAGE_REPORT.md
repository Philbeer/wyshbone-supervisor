# Wyshbone Supervisor — LLM Usage Investigation Report

**Generated:** April 22, 2026  
**Scope:** Full codebase scan, read-only. No code was changed.

---

## Part 1 — Complete LLM Call Inventory

Each row represents one distinct callsite. "Hot path" means it fires on every user chat message.

### Table 1: All LLM Calls Found

| # | File Path | Function / Callsite | Provider | Model (default) | Model env override | Purpose | Importance | Sensible? | Suggested Alternatives | Downgrade? | Upgrade? | Hot Path? | Concerns |
|---|-----------|---------------------|----------|-----------------|-------------------|---------|-----------|-----------|----------------------|-----------|---------|-----------|----------|
| 1 | `server/supervisor/conversation-turn-classifier.ts` | `classifyTurn()` | Anthropic (Groq/OpenAI fallback) | `claude-haiku-4-5-20251001` | `TURN_CLASSIFIER_MODEL` | Classify conversation turn type (is user answering a question, refining a search, etc) | cheap / classification | ✅ Yes — Haiku is correct here | Groq `llama-3.3-70b-versatile`, `gpt-4o-mini` | Possibly — Groq is faster/cheaper | No | ✅ Yes, every message | 8 second timeout. Groq is ~2–3× faster and free-tier cheaper — worth as primary |
| 2 | `server/supervisor/conversation-router.ts` | `routeConversation()` | Anthropic → OpenAI → Groq | `claude-sonnet-4-5-20250929` | `ROUTER_LLM_MODEL` | Route message to SEARCH / CLARIFY / DISCUSS / ITERATE / CHAT | standard reasoning | ⚠️ Overkill — Sonnet for a routing decision | `claude-haiku-4-5-20251001`, `gpt-4o-mini`, Groq `llama-3.3-70b-versatile` | ✅ Yes — strong case for Haiku | No | ✅ Yes, every message | **Cost risk**: Sonnet on every single message is very expensive. The task is structured JSON classification with a well-defined schema — Haiku handles this reliably. Also uses `providerChain: ['anthropic', 'openai', 'groq']` which deliberately deprioritises Groq |
| 3 | `server/supervisor/chat-handler.ts` | DISCUSS/CHAT response generation | Anthropic (Groq/OpenAI fallback) | `claude-sonnet-4-6` | `CHAT_LLM_MODEL` | Generate streaming user-facing chat responses | standard reasoning | ✅ Yes — Sonnet appropriate for conversational quality | `claude-3-5-haiku-20241022` for simple CHAT, keep Sonnet for DISCUSS | Partial — CHAT route could use Haiku | Possibly for complex DISCUSS | Medium (only DISCUSS/CHAT routes) | `claude-sonnet-4-6` is a non-standard model name — verify it resolves correctly against Anthropic API |
| 4 | `server/supervisor/llm-failover.ts` | `callLLMStream()` | Groq → Anthropic | Groq: `llama-3.3-70b-versatile` / Anthropic: `claude-sonnet-4-6` | `GROQ_MODEL`, `CHAT_LLM_MODEL` | Streaming wrapper used by chat-handler | standard reasoning | ✅ Yes — Groq-first for streaming is smart | Same | No | No | Medium | Groq's streaming is significantly faster — good design. Falls back to Anthropic SSE stream correctly |
| 5 | `server/supervisor/mission-extractor.ts` | `extractMission()` — Pass 1 (semantic interpreter) | OpenAI → Anthropic (on 429) | `gpt-4o-mini` / fallback `claude-3-haiku-20240307` | None — hardcoded | Restate messy user query into clean semantic language | code / extraction | ✅ Yes | Groq, `claude-3-5-haiku-20241022` | Possibly — Groq for speed | No | Medium-high (SEARCH path) | No env override for main model. Hardcoded `gpt-4o-mini` as primary. Fallback uses old Claude 3 Haiku (deprecated) |
| 6 | `server/supervisor/mission-extractor.ts` | `extractMission()` — Pass 2 (schema mapper) | OpenAI → Anthropic (on 429) | `gpt-4o-mini` / fallback `claude-3-haiku-20240307` | None — hardcoded | Map semantic interpretation to structured JSON constraint schema | code / extraction | ✅ Yes | Same | Possibly | No | Medium-high (SEARCH path) | Same model as Pass 1 — both passes fire sequentially on every SEARCH |
| 7 | `server/supervisor/mission-extractor.ts` | `extractMission()` — Pass 3 (intent narrative) | OpenAI → Anthropic (on 429) | `gpt-4o-mini` / fallback `claude-3-haiku-20240307` | None — hardcoded | Generate research strategy narrative (findability, exclusions, discriminators) | standard reasoning | ⚠️ Marginal — Pass 3 requires decent reasoning about entity types and internet findability | `claude-3-5-haiku-20241022`, `gpt-4o` for hard queries | No | Possibly for complex/ambiguous queries | Medium-high (SEARCH path) | Three sequential LLM calls on every SEARCH is a latency multiplier. Passes 1 and 2 could potentially be merged |
| 8 | `server/supervisor/goal-to-constraints.ts` | `parseGoalToConstraints()` | OpenAI → Anthropic (on 429) | `gpt-4o-mini` / fallback `claude-3-haiku-20240307` | None — hardcoded | Parse raw goal string into typed constraint objects | code / extraction | ✅ Yes — `gpt-4o-mini` handles JSON extraction well | Groq | Possibly | No | Medium (SEARCH path) | This callsite exists alongside `mission-extractor.ts` — appears to be an older/parallel goal-parsing path. Relationship to mission extractor should be clarified to avoid redundant calls |
| 9 | `server/supervisor/gpt4o-search.ts` | `callGpt4oWebSearch()` | OpenAI (Responses API) | `gpt-4o` | `GPT4O_PRIMARY_MODEL` | Web search + entity discovery in a single call (up to 3 rounds) | premium / hard reasoning | ✅ Yes — `gpt-4o` with `web_search_preview` is the correct tool | `gpt-4o-mini` for simple/high-confidence queries | Carefully — search quality depends on model | No | ✅ Yes, every SEARCH execution | **Highest cost call in the system**. Fires up to 3 rounds. Each round is a full GPT-4o web search call. Cost scales with search volume. Should be the premium path, not the default for all queries |
| 10 | `server/supervisor/rescue-llm.ts` | `attemptRescueLLM()` | Anthropic | `claude-3-haiku-20240307` | `RESCUE_LLM_MODEL` | Self-heal or generate clarification when mission extraction fails | cheap / background | ✅ Yes — Haiku is correct, fires rarely | `claude-3-5-haiku-20241022` | No | No — self-healing should be fast | Failure path only | Uses old Claude 3 Haiku (deprecated). Should upgrade default to `claude-3-5-haiku-20241022`. `RESCUE_LLM_MODEL` is shared with smart-clarify, which has a *different* hardcoded default |
| 11 | `server/supervisor/smart-clarify.ts` | `generateSmartClarification()` | Anthropic | `claude-3-5-haiku-20241022` | `RESCUE_LLM_MODEL` | Generate contextual clarification question when intent is incomplete | cheap / background | ✅ Yes | Same | No | No | Failure/edge path | Shares `RESCUE_LLM_MODEL` env with rescue-llm.ts but has a **different** hardcoded default (`claude-3-5-haiku-20241022` vs `claude-3-haiku-20240307`). Setting the env var will affect both — but to different base levels. Inconsistency |
| 12 | `server/supervisor/result-discussion.ts` | `handleResultDiscussion()` | Anthropic (Groq/OpenAI failover) | `claude-3-haiku-20240307` | `DISCUSSION_LLM_MODEL` or `RESCUE_LLM_MODEL` | Answer user questions about delivered search results | cheap / background | ✅ Yes — Haiku suitable for factual Q&A over structured data | `claude-3-5-haiku-20241022`, Groq | Upgrade default to Haiku 3.5 | No | Medium (DISCUSS route) | Default is old Claude 3 Haiku. Falls back to `RESCUE_LLM_MODEL` if `DISCUSSION_LLM_MODEL` unset — couples discussion model to rescue model which is semantically odd |
| 13 | `server/supervisor/outreach-drafter.ts` | `draftOutreachEmail()` | OpenAI only | `gpt-4o-mini` | `OUTREACH_DRAFT_MODEL` | Draft personalised cold outreach emails for leads | standard reasoning | ✅ Yes | `claude-3-5-haiku-20241022`, `gpt-4o` for premium users | No | For premium users: `gpt-4o` | Low / on-demand | Throws hard if no `OPENAI_API_KEY`. No Anthropic fallback. Temp=0.7 for creative writing — appropriate |
| 14 | `server/supervisor/reloop/llm-planner.ts` | `llmPlan()` | OpenAI only | `gpt-4o-mini` | **None — hardcoded, no override** | Decide which search executor to use in re-loop iterations | cheap / background | ✅ Yes | Groq `llama-3.3-70b-versatile` | Possibly | No | Background / re-loop only | **No env override** — completely hardcoded to `gpt-4o-mini`. No Anthropic fallback. If OpenAI key is absent, throws. Should add `RELOOP_PLANNER_MODEL` override |
| 15 | `server/services/claude-api.ts` | `ClaudeAPIService.chat()` / `chatWithHistory()` | Anthropic | `claude-3-5-sonnet-20241022` | **None — hardcoded, no override** | Autonomous agent intelligence: goal generation, task planning, decision-making | premium / hard reasoning | ✅ Yes — Sonnet appropriate for autonomous agent reasoning | `claude-3-5-haiku-20241022` for simple tasks | Partially — depends on task type | No | Background / autonomous agent | **No env override**. Hardcoded. `temperature=1.0` — unusually high for structured reasoning tasks. Rate limited to 5 calls/min server-side. Used by `autonomous-agent.ts` and `autonomous-agent-with-memory.ts` |
| 16 | `server/supervisor/intent-extractor.ts` | `extractCanonicalIntent()` | OpenAI → Anthropic | `gpt-4o-mini` / fallback `claude-3-5-haiku-20241022` | None | Canonical intent extraction (appears to be a legacy/alternate path alongside mission-extractor) | code / extraction | ⚠️ Unclear — overlaps with mission-extractor passes | Same | — | — | Unknown — possibly legacy | This module defines its own `callLLM()` function independently from `llm-failover.ts`. Relationship to `mission-extractor.ts` is unclear. May be dead code or a parallel flow |
| 17 | `server/supervisor/explain-run.ts` | `callLLM()` | OpenAI → Anthropic | `gpt-4o-mini` / fallback `claude-3-5-haiku-20241022` | None | Generate human-readable run summary/explanation reports | cheap / background | ✅ Yes | Same | No | No | Background / on-demand | Independent `callLLM()` not using `llm-failover.ts`. No timeout handling |
| 18 | `server/supervisor/research-provider.ts` | `OpenAIResponsesProvider` | OpenAI (Responses API) | `gpt-4.1` | Constructor arg | Deep research with web search | premium / hard reasoning | ✅ Yes — full web search model | `gpt-4o` | No | — | Background / on-demand | `gpt-4.1` with Responses API. Verify this model name is valid on your OpenAI account |
| 19 | `server/supervisor/research-provider.ts` | `PerplexityResearchProvider` | Perplexity | `llama-3.1-sonar-large-128k-online` | Constructor arg | Deep research with live web access | standard reasoning | ✅ Yes — Perplexity sonar is designed for this | `llama-3.1-sonar-small-128k-online` for cost | Possibly small model | No | Background / on-demand | Perplexity API key not documented in `.env.example`. May not be configured in production |
| 20 | `server/supervisor/research-provider.ts` | `AnthropicResearchProvider` | Anthropic | `claude-sonnet-4-20250514` | Constructor arg | Deep research | premium / hard reasoning | ✅ Yes | Same | No | No | Background / on-demand | Verify model name `claude-sonnet-4-20250514` is current |

---

## Section A — Summary by Provider

| Provider | Call Count | Notes |
|----------|-----------|-------|
| **Anthropic** | 13 | Dominant provider. Powers routing, chat, mission extraction (fallback), rescue, clarify, discussion, autonomous agent, research |
| **OpenAI** | 12 | Web search (gpt-4o), mini model workhorses (mission extraction, goal parsing, planner), outreach, explain, research |
| **Groq** | 2 | Available as failover in `llm-failover.ts` (turn classifier, router, chat). Not used as primary for any callsite by default |
| **Perplexity** | 1 | Deep research provider only. No key documented in `.env.example` |
| **Google / Gemini** | 0 | Not present anywhere |
| **Together / OpenRouter / DeepSeek / Ollama** | 0 | Not present anywhere |

---

## Section B — Summary by Model

### Models in Active Use

| Model | Provider | Used In | Frequency | Cost Tier |
|-------|----------|---------|-----------|-----------|
| `claude-sonnet-4-5-20250929` | Anthropic | Router | Every message | 💰💰💰 High |
| `claude-sonnet-4-6` | Anthropic | Chat handler / Stream | DISCUSS/CHAT messages | 💰💰💰 High |
| `claude-sonnet-4-20250514` | Anthropic | Research provider | Background | 💰💰💰 High |
| `claude-3-5-sonnet-20241022` | Anthropic | Autonomous agent | Background | 💰💰 Medium-high |
| `claude-haiku-4-5-20251001` | Anthropic | Turn classifier | Every message | 💰 Low |
| `claude-3-5-haiku-20241022` | Anthropic | Smart clarify, intent extractor, explain-run | Edge/failure paths | 💰 Low |
| `claude-3-haiku-20240307` | Anthropic | Rescue LLM, result discussion | Failure/DISCUSS paths | 💰 Very low (but deprecated) |
| `gpt-4o` | OpenAI | GPT-4o web search | Every SEARCH (up to 3×) | 💰💰💰 Very high |
| `gpt-4.1` | OpenAI | Research provider | Background | 💰💰💰 High |
| `gpt-4o-mini` | OpenAI | Mission extract (×3 passes), goal parser, reloop planner, outreach, explain-run | Every SEARCH | 💰 Low |
| `llama-3.3-70b-versatile` | Groq | Failover (not primary anywhere) | Rarely | Free-tier / very cheap |
| `llama-3.1-sonar-large-128k-online` | Perplexity | Research provider | Background | 💰 Low |

### Models Probably Too Expensive for Their Job

| Model | Callsite | Why It's Overkill |
|-------|----------|------------------|
| `claude-sonnet-4-5-20250929` | Router (`conversation-router.ts`) | Routing to SEARCH/CLARIFY/DISCUSS etc is a well-defined structured JSON classification task. Haiku does this reliably at ~10× lower cost |
| `gpt-4o` (web search) | GPT-4o search | Running up to 3 rounds per SEARCH at full `gpt-4o` pricing is the biggest cost driver. `gpt-4o-mini` with web search (via Responses API) should be tested as a first pass |

### Models Probably Too Weak for Their Job

| Model | Callsite | Why It Needs Upgrading |
|-------|----------|----------------------|
| `claude-3-haiku-20240307` | Rescue LLM, Result Discussion | This is the old Claude 3 Haiku — deprecated. Should be `claude-3-5-haiku-20241022` at minimum |
| `gpt-4o-mini` | Mission extractor Pass 3 (intent narrative) | Pass 3 requires genuine reasoning about entity types, Google Places misclassifications, and internet findability. `gpt-4o-mini` may produce shallow narratives — consider `gpt-4o` or `claude-3-5-haiku-20241022` for Pass 3 specifically |

### Calls That Look Suitable for Cheaper Workhorse Models

| Callsite | Current Model | Recommended Model |
|----------|-------------|------------------|
| Router (`conversation-router.ts`) | `claude-sonnet-4-5-20250929` | `claude-haiku-4-5-20251001` or `gpt-4o-mini` |
| GPT-4o search first round | `gpt-4o` | Test `gpt-4o-mini` for high-confidence searches, reserve `gpt-4o` for re-loops |
| Outreach drafter | `gpt-4o-mini` | Already cheap — fine as-is |

### Calls That Should Potentially Be Premium-Only

| Callsite | Rationale |
|----------|-----------|
| GPT-4o web search (all 3 rounds) | Very expensive per search. Consider gating full 3-round search behind premium plan |
| Deep research providers (`research-provider.ts`) | Already background / on-demand — fine |
| Chat handler Sonnet | Reasonable for paying users; could downgrade to Haiku for free tier |

---

## Section C — Suggested Model Routing Stack for Wyshbone

| Role | Recommended Model | Rationale |
|------|-----------------|-----------|
| **Fast chat / CHAT route** | `llama-3.3-70b-versatile` (Groq) → `claude-3-5-haiku-20241022` fallback | Ultra-low latency, near-zero cost for greetings and small talk |
| **Turn classification** | `claude-haiku-4-5-20251001` (current — keep) | Already correctly sized |
| **Conversation routing** | `claude-haiku-4-5-20251001` or `gpt-4o-mini` | Structured JSON — no need for Sonnet |
| **Extraction / classification** (mission passes 1–2, goal parser) | `gpt-4o-mini` (current — keep) | JSON extraction is `gpt-4o-mini`'s strong suit |
| **Intent narrative** (mission pass 3) | `claude-3-5-haiku-20241022` or `gpt-4o` for very hard queries | Pass 3 benefits from stronger semantic reasoning |
| **Web search / discovery** | `gpt-4o` round 1, optionally `gpt-4o-mini` for simple entity types | Consider cost-gating: use mini for easy entities, full `gpt-4o` for hard ones |
| **DISCUSS / result discussion** | `claude-3-5-haiku-20241022` | Factual Q&A over structured data — no need for Sonnet |
| **Premium users / complex DISCUSS** | `claude-sonnet-4-6` | Reserve Sonnet for high-value users or complex multi-lead analysis |
| **Outreach drafting** | `gpt-4o-mini` (free tier), `gpt-4o` (premium) | Creative quality matters for cold email — premium path warranted |
| **Autonomous agent reasoning** | `claude-3-5-sonnet-20241022` (current — keep) | Correct for complex multi-step autonomous work |
| **Rescue / clarification** | `claude-3-5-haiku-20241022` | Upgrade from deprecated Claude 3 Haiku |
| **Background batch / reloop planner** | `gpt-4o-mini` (current — keep) | Low token count, low frequency |
| **Deep research** | `gpt-4.1` with web search or `claude-sonnet-4-20250514` | Already background — keep as premium/on-demand |
| **Fallback / last resort** | Groq `llama-3.3-70b-versatile` | Already wired into `llm-failover.ts` |

---

## Section D — Cost-Risk Observations

### D1 — Expensive Models on Simple Work

| Issue | File | Detail |
|-------|------|--------|
| **🔴 Router uses Sonnet on every message** | `conversation-router.ts` | `claude-sonnet-4-5-20250929` fires on 100% of user messages including greetings, gibberish, and simple "find pubs in London" requests. The task is structured classification with a well-specified schema — Haiku produces equivalent accuracy here at ~10× lower token cost |
| **🟡 Chat handler defaults to Sonnet** | `chat-handler.ts` | `claude-sonnet-4-6` on DISCUSS/CHAT routes is reasonable for quality but could be tiered: Haiku for free users, Sonnet for paid |

### D2 — Weak Models on Difficult Work

| Issue | File | Detail |
|-------|------|--------|
| **🟡 Rescue LLM uses deprecated Claude 3 Haiku** | `rescue-llm.ts` | `claude-3-haiku-20240307` is the original Haiku (Feb 2024) — deprecated in favour of `claude-3-5-haiku-20241022`. The self-healing logic involves non-trivial inference from conversation context |
| **🟡 Result discussion defaults to old Haiku** | `result-discussion.ts` | Falls back through `DISCUSSION_LLM_MODEL` → `RESCUE_LLM_MODEL` → `claude-3-haiku-20240307`. This means result discussion quality depends on rescue model configuration — semantically wrong coupling |
| **🟡 Mission extractor Pass 3 on gpt-4o-mini** | `mission-extractor.ts` | Pass 3 generates entity descriptions, exclusion lists, findability assessments, and search strategies. This is reasoning-heavy work where `gpt-4o-mini` may produce shallower outputs than intended |

### D3 — Multiple LLM Calls That Could Be Merged

| Opportunity | Files | Saving |
|------------|-------|--------|
| **Turn classifier + Router could be one call** | `conversation-turn-classifier.ts` + `conversation-router.ts` | Currently 2 sequential LLM calls per message (~500ms + 1–2s). Could combine into a single call that classifies AND routes. The turn analysis is already fed directly into the router. A merged prompt would save one round-trip on every user message |
| **Mission extractor passes 1, 2, 3** | `mission-extractor.ts` | Three sequential `gpt-4o-mini` calls on every SEARCH. Passes 1 (semantic interpretation) and 2 (schema mapping) are tightly coupled — Pass 2 directly consumes Pass 1 output. A single combined pass is architecturally straightforward and would save ~1s per SEARCH |
| **`intent-extractor.ts` vs `mission-extractor.ts`** | Both files | Two separate intent/goal extraction systems exist. `intent-extractor.ts` appears to be an earlier or parallel approach. If it is no longer on the active path, it is dead code |

### D4 — Calls That Should Be Cached

| Callsite | Cacheable? | Detail |
|----------|-----------|--------|
| Mission extractor (all 3 passes) | ✅ Strongly | The same user query often repeats. Passes 1–3 could be memoised by normalised query hash. Cache TTL of ~1 hour would provide significant savings for power users |
| Rescue LLM patterns | ✅ Already partially | `rescue-llm.ts` loads learned patterns from DB with a 1-hour cache — good design. Could extend to also cache the LLM output for identical failure signatures |
| Turn classifier | 🟡 Marginally | Turn classification depends on conversation history, making it hard to cache. Not worth the complexity |
| Router | 🟡 Marginally | Router depends on full conversation state — not easily cacheable |

### D5 — Hardcoded Models with No Env Override

These callsites are **not configurable** without a code change:

| File | Hardcoded Model | Risk |
|------|----------------|------|
| `server/services/claude-api.ts` | `claude-3-5-sonnet-20241022` | Cannot swap the autonomous agent model without a code edit. Also `temperature=1.0` is high for structured reasoning — usually 0–0.3 is preferred |
| `server/supervisor/reloop/llm-planner.ts` | `gpt-4o-mini` | Cannot fallback if OpenAI key absent. No Anthropic path |
| `server/supervisor/mission-extractor.ts` | `gpt-4o-mini` primary | No override for the primary model — forces OpenAI. On 429, falls back to old `claude-3-haiku-20240307` not the newer Haiku |
| `server/supervisor/goal-to-constraints.ts` | `gpt-4o-mini` primary | Same pattern — primary hardcoded, 429 fallback to old Haiku |

### D6 — Prompts That Justify Premium Models

| Callsite | Why Premium is Justified |
|----------|------------------------|
| GPT-4o web search (`gpt4o-search.ts`) | Temporal constraint detection, evidence reasoning, finding newly-opened businesses — these require strong web grounding and reasoning. `gpt-4o` is appropriate here |
| Autonomous agent (`claude-api.ts`) | Multi-step planning and goal decomposition — Sonnet is the right tool |
| Mission extractor Pass 3 | Entity exclusion generation and findability assessment benefit from stronger models; this could be an `upgrade` path for complex queries |
| Outreach drafter | Cold email quality directly affects user results — a premium option for `gpt-4o` or `claude-sonnet` is reasonable |

### D7 — Other Concerns

| Concern | Detail |
|---------|--------|
| **`RESCUE_LLM_MODEL` shared between two modules with different defaults** | `rescue-llm.ts` defaults to `claude-3-haiku-20240307`; `smart-clarify.ts` defaults to `claude-3-5-haiku-20241022`. One env var controls both but they have different hardcoded fallbacks. Setting `RESCUE_LLM_MODEL` to the new Haiku would fix both, but this coupling is fragile — they should have separate env vars |
| **`result-discussion.ts` couples to rescue model** | Falls through `DISCUSSION_LLM_MODEL` → `RESCUE_LLM_MODEL` — semantically wrong. Discussion quality should not be contingent on the rescue model configuration |
| **`claude-sonnet-4-6` is a non-standard model name** | Should be verified against Anthropic's current model list. May resolve to an internal alias or fail silently |
| **`gpt-4.1` in `research-provider.ts`** | Verify this is an available model name on your OpenAI tier |
| **Perplexity key not documented** | `PERPLEXITY_API_KEY` is not in `.env.example` — this provider may never be configured in production |
| **`callLLMStream()` Groq fallback inconsistency** | `callLLMStream` uses Groq-first (fast, good for streaming) but `callLLMText` used by the router uses `providerChain: ['anthropic', 'openai', 'groq']` — deliberately avoiding Groq for non-streaming. This is intentional per the code comments but worth being explicit about |
| **No Anthropic fallback in `reloop/llm-planner.ts` and `outreach-drafter.ts`** | Both throw hard if OpenAI key is absent. Given the rest of the system supports Anthropic, these should have fallback paths |

---

## Quick-Win Summary

| Priority | Action | Files | Est. Impact |
|----------|--------|-------|------------|
| 🔴 High | Downgrade router from Sonnet → Haiku | `conversation-router.ts` | ~70–80% cost reduction on routing (runs on every message) |
| 🔴 High | Upgrade deprecated `claude-3-haiku-20240307` to `claude-3-5-haiku-20241022` | `rescue-llm.ts`, `result-discussion.ts` | Quality + future-proofing |
| 🟡 Medium | Add `RELOOP_PLANNER_MODEL` and `AUTONOMOUS_AGENT_MODEL` env overrides | `reloop/llm-planner.ts`, `claude-api.ts` | Configurability without code changes |
| 🟡 Medium | Merge Turn Classifier + Router into one LLM call | `conversation-turn-classifier.ts` + `conversation-router.ts` | ~300–500ms latency saving per message |
| 🟡 Medium | Give `result-discussion.ts` its own default (not inherited from rescue model) | `result-discussion.ts` | Correct semantic coupling |
| 🟢 Low | Consider `gpt-4o-mini` web search for Groq fallback on simple entity types | `gpt4o-search.ts` | Cost reduction for simple searches |
| 🟢 Low | Cache mission extractor output by normalised query hash | `mission-extractor.ts` | Cost reduction for repeat queries |
| 🟢 Low | Add `PERPLEXITY_API_KEY` to `.env.example` | `.env.example` | Documentation |
