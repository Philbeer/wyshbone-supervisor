# Full Cost Audit Report — Supervisor Codebase
*Generated: March 29, 2026 | Investigation scope: `server/` directory*

---

## PART 1 — All OpenAI Calls

### 1. `server/supervisor/mission-extractor.ts` — Pass 1 (Semantic Interpretation)
- **Lines:** 662–666, 659–690 (callOpenAI/callAnthropic helpers)
- **Model:** `gpt-4o-mini` (primary); falls back to `claude-3-haiku-20240307` on 429
- **Max tokens:** 2,000
- **What it does:** Converts the raw user message into a clean semantic interpretation + constraint checklist (Pass 1 of the 3-pass mission extraction pipeline).
- **How often:** Once per run (1 LLM call)
- **Approx cost:** ~$0.00008 input (~500 tokens) + ~$0.00012 output (~200 tokens) ≈ **$0.0002/run**
- **Classification:** ✅ ESSENTIAL

---

### 2. `server/supervisor/mission-extractor.ts` — Pass 2 (Structured Mission JSON)
- **Lines:** ~938 (second `callLLM` call)
- **Model:** `gpt-4o-mini` (primary); fallback to Claude haiku on 429
- **Max tokens:** 2,000
- **What it does:** Takes Pass 1's semantic output and builds the full structured mission JSON (entity type, location, constraints, requested count, etc.).
- **How often:** Once per run (1 LLM call)
- **Approx cost:** ~**$0.0002/run**
- **Classification:** ✅ ESSENTIAL

---

### 3. `server/supervisor/mission-extractor.ts` — Pass 3 (Intent Narrative)
- **Lines:** ~874 (third `callLLM` call)
- **Model:** `gpt-4o-mini` (primary); fallback to Claude haiku on 429
- **Max tokens:** 2,000
- **What it does:** Generates a rich intent narrative — a prose description of what the user actually wants — used downstream by `generatePlacesQueries` and evidence extraction.
- **How often:** Once per run (1 LLM call)
- **Approx cost:** ~**$0.0002/run**
- **Classification:** ✅ ESSENTIAL (feeds query generation and evidence scoring)

---

### 4. `server/supervisor/intent-extractor.ts` — Intent Shadow Extractor
- **Lines:** 291–330
- **Model:** `gpt-4o-mini` (primary); fallback to `claude-3-5-haiku-20241022`
- **Max tokens:** 2,000
- **What it does:** A parallel/shadow intent extraction run — separate from mission-extractor — that validates/cross-checks intent. Controlled by `INTENT_EXTRACTOR_MODE` env var ('off' | 'shadow' | 'active').
- **How often:** Once per run **if shadow/active mode enabled** (conditional on env var)
- **Approx cost:** ~**$0.0002/run** (when enabled)
- **Classification:** ⚠️ OPTIMIZABLE — Redundant with Pass 1/3 of mission-extractor. In shadow mode it fires but the result may not be used. Disabling (`INTENT_EXTRACTOR_MODE=off`) saves one LLM call per run with no user-facing impact.

---

### 5. `server/supervisor/goal-to-constraints.ts` — Goal Parser
- **Lines:** 195–220
- **Model:** `gpt-4o-mini` (primary); `claude-3-haiku-20240307` (fallback or if no OpenAI key)
- **Max tokens:** 2,000
- **What it does:** Converts a high-level user goal into structured constraints before the mission pipeline runs.
- **How often:** Once per run (1 LLM call)
- **Approx cost:** ~**$0.0002/run**
- **Classification:** ✅ ESSENTIAL

---

### 6. `server/supervisor/mission-executor.ts:generatePlacesQueries` — Places Query Generator
- **Lines:** 429–490
- **Model:** `gpt-4o-mini`
- **Max tokens:** 512
- **What it does:** Takes the intent narrative and generates 1–3 optimised text queries to pass to Google Places Text Search.
- **How often:** Once per run (1 LLM call)
- **Approx cost:** ~$0.00004 input + $0.00003 output ≈ **$0.00007/run**
- **Classification:** ✅ ESSENTIAL (dramatically improves Places query quality)

---

### 7. `server/supervisor/mission-executor.ts:filterByEntityExclusions` — Exclusion Filter
- **Lines:** 495–561
- **Model:** `gpt-4o-mini`
- **Max tokens:** 512 per batch
- **What it does:** Receives the raw Google Places results (up to 50 leads) and asks the LLM to flag any that are obviously wrong entity types (e.g. a hotel showing up in a pub search). `BATCH_SIZE = 5`.
- **How often:** `ceil(leads / 5)` calls — typically **4–10 calls** for a standard run (20–50 raw leads)
- **Approx cost:** ~$0.00003/call × 6 calls avg ≈ **$0.0002/run**
- **Classification:** ⚠️ OPTIMIZABLE — Batch size of 5 is very conservative. Increasing to 20–25 would reduce calls by 4–5× with no meaningful accuracy loss. Could also be replaced with keyword/category filtering for most cases.

---

### 8. `server/supervisor/constraint-led-extractor.ts` — Evidence Judge (LAYER 2)
- **Lines:** 912–923
- **Model:** `gpt-4o-mini` (overridable via `EVIDENCE_JUDGE_MODEL` env var)
- **Max tokens:** 200
- **What it does:** For each lead being enriched, judges evidence text windows extracted from the website to determine whether they confirm a constraint. Fires per lead × per constraint.
- **How often:** Up to `enrichableLeads × constraints` calls. For 10 leads with 2 constraints = up to **20 calls**, though in practice many are skipped when no evidence is found.
- **Approx cost:** ~$0.000015/call × 10 avg ≈ **$0.00015/run** (simple); up to $0.0003 (complex)
- **Classification:** ✅ ESSENTIAL (core evidence scoring logic)

---

### 9. `server/supervisor/mission-executor.ts` — GPT-4o Web Search Fallback
- **Lines:** 1443–1570 (`[GPT4O_FALLBACK]` block)
- **Model:** `gpt-4o-mini` by default (overridable via `GPT4O_FALLBACK_MODEL` env var). Uses **OpenAI Responses API** (`/v1/responses`) with live web search enabled.
- **What it does:** For any lead where website visit failed (bot-blocked) or returned no evidence, fires a web-search-enabled LLM call to verify the constraint directly via web search.
- **How often:** One call **per lead with no evidence** — can be 0 to 20+ calls depending on bot-blocking rate. Runs sequentially.
- **Approx cost per call:** Web search Responses API pricing is additive. At gpt-4o-mini rates + search tool: ~$0.001–$0.003/call. At 10 fallback leads: **$0.01–$0.03/run**
- **Classification:** ✅ ESSENTIAL (only source of truth for bot-blocked sites) — but **expensive at scale** — consider a hard cap lower than current (currently only deadline-gated).

---

### 10. `server/supervisor/mission-executor.ts` — Discovery Cascade
- **Lines:** 1604–1800 (`[DISCOVERY_CASCADE]` block)
- **Model:** `gpt-4o-mini` by default (overridable via `GPT4O_CASCADE_MODEL` env var). Uses **OpenAI Responses API** with live web search.
- **What it does:** When the initial Places search + enrichment yields fewer verified leads than requested, triggers additional web-search-based discovery to find more candidates from unconventional sources.
- **How often:** Fires **only when lead count falls short** — 0 calls in successful simple runs; 1–3 calls in complex/short-supply runs.
- **Approx cost per call:** ~$0.001–$0.003/call (web search Responses API)
- **Classification:** ✅ ESSENTIAL for complex runs — but is a 0-cost path in simple runs.

---

### 11. `server/supervisor/gpt4o-search.ts` — GPT-4o Primary Web Search Path
- **Lines:** 121–136
- **Model:** `gpt-4o` by default (overridable via `GPT4O_PRIMARY_MODEL` env var). Uses **OpenAI Responses API** with `web_search_preview` tool.
- **What it does:** An alternative execution path (`gpt4o_primary`) that bypasses Google Places entirely and uses GPT-4o with web search to find leads directly.
- **How often:** Only fires if execution path is `gpt4o_primary`. In the default `gp_cascade` path (Google Places first), this does **not** fire.
- **Approx cost:** gpt-4o + web search: **$0.01–$0.05/call** — significantly more expensive than gpt-4o-mini
- **Classification:** ✅ ESSENTIAL (for gpt4o_primary path) — but confirm whether this path is ever triggered in production. If not, **0 cost**.

---

### 12. `server/supervisor/reloop/llm-planner.ts` — Reloop LLM Planner
- **Lines:** 126–145
- **Model:** `gpt-4o-mini`
- **Max tokens:** 256
- **What it does:** At the end of a run where results are insufficient, plans the next iteration — decides what queries to try differently, what constraints to relax, etc.
- **How often:** Once per reloop iteration — 0 calls if run succeeds; 1–3 calls if reloop activates.
- **Approx cost:** ~$0.0001/call × 1–3 ≈ **$0.0001–$0.0003** (only on reloop)
- **Classification:** ✅ ESSENTIAL (for reloop runs)

---

### 13. `server/supervisor/reloop/outreach-adapter.ts` — Contact Finder (Web Search)
- **Lines:** 145–175
- **Model:** `gpt-4o-mini`. Uses **OpenAI Responses API** with `web_search` tool.
- **What it does:** For leads that need outreach but have no contact email, fires a web search to locate contact details.
- **How often:** Once **per lead needing email** that has no existing contact — only fires when outreach is triggered.
- **Approx cost:** ~$0.001–$0.003/lead
- **Classification:** ✅ ESSENTIAL (when outreach is used) — **0 cost** if outreach not triggered.

---

### 14. `server/supervisor/outreach-drafter.ts` — Email Drafter
- **Lines:** 100–130
- **Model:** `gpt-4o-mini` (overridable via `OUTREACH_DRAFT_MODEL` env var)
- **Max tokens:** 1,024
- **What it does:** Drafts a personalised outreach email for each lead.
- **How often:** Once per lead where outreach is triggered.
- **Approx cost:** ~$0.0007/lead
- **Classification:** ✅ ESSENTIAL (when outreach used) — **0 cost** otherwise.

---

### 15. `server/supervisor/run-narrative.ts` — Run Narrative Generator
- **Lines:** 399–433
- **Model:** `gpt-4o-mini` (primary); `claude-3-5-haiku-20241022` (fallback)
- **Max tokens:** 2,000
- **What it does:** After a run completes, generates a human-readable summary of what the run found and why.
- **How often:** Once per completed run.
- **Approx cost:** ~$0.001–$0.0015/run
- **Classification:** ✅ ESSENTIAL (user-facing output)

---

### 16. `server/supervisor/explain-run.ts` — Run Explainer
- **Lines:** 146–177
- **Model:** `gpt-4o-mini` (primary); `claude-3-5-haiku-20241022` (fallback)
- **Max tokens:** 4,000
- **What it does:** Provides a detailed step-by-step explanation of a run on user request — shows why each decision was made.
- **How often:** Only fires when user explicitly requests explanation — **not part of standard run flow**.
- **Approx cost:** ~$0.002–$0.003/request
- **Classification:** ✅ ESSENTIAL (on-demand) — **0 cost** if not requested.

---

### 17. `server/supervisor/research-provider.ts` — Deep Research (OpenAI gpt-4.1)
- **Lines:** 44–115
- **Model:** `gpt-4.1` (default). Uses **OpenAI Responses API** with `web_search` tool.
- **What it does:** Runs a deep research job (background async process) using GPT-4.1 with live web search for comprehensive topic research.
- **How often:** Only fires when a deep research job is explicitly triggered — not part of standard lead-gen run.
- **Approx cost:** gpt-4.1 is expensive — estimated **$0.05–$0.50/call** depending on research depth.
- **Classification:** ✅ ESSENTIAL (when deep research triggered) — **0 cost** in standard runs.

---

## PART 2 — All Anthropic/Claude Calls

| File | Model | Role | When |
|------|-------|------|------|
| `mission-extractor.ts` | `claude-3-haiku-20240307` | Fallback for Pass 1/2/3 | Only on OpenAI 429 |
| `intent-extractor.ts` | `claude-3-5-haiku-20241022` | Fallback intent extraction | Only on OpenAI 429 or if no OpenAI key |
| `goal-to-constraints.ts` | `claude-3-haiku-20240307` | Fallback goal parser | Primary if no OpenAI key; fallback on 429 |
| `explain-run.ts` | `claude-3-5-haiku-20241022` | Run explainer fallback | Only on OpenAI 429 |
| `run-narrative.ts` | `claude-3-5-haiku-20241022` | Narrative generator fallback | Only on OpenAI 429 |
| `mission-extractor.ts:675` | Direct fetch to `/v1/messages` | Claude haiku via raw HTTP | Part of callAnthropic() helper |
| `research-provider.ts` | `claude-sonnet-4-20250514` | Deep research provider | If Anthropic key set and OpenAI key absent |
| `services/claude-api.ts` | `claude-3-5-sonnet-20241022` | Autonomous agent (daily tasks) | Daily cron — separate from lead-gen |
| `services/task-interpreter.ts` | `claude-3-5-sonnet-20241022` | Task interpreter | Separate from lead-gen pipeline |

**Key observation:** All Claude calls in the core lead-gen pipeline are **fallbacks only** — they don't fire under normal operation if `OPENAI_API_KEY` is set. The `claude-api.ts` service (Sonnet) is used by the autonomous daily-tasks agent, which is a completely separate pipeline.

---

## PART 3 — All Google API Calls

### 1. `server/supervisor/google-places.ts` — Places v1 Text Search
- **Endpoint:** `https://places.googleapis.com/v1/places:searchText`
- **Lines:** 254–300
- **What it does:** Primary lead discovery — searches Google Places for businesses matching the query, returning name, address, website, phone, etc.
- **How often:** One call **per generated query** — typically 1–3 calls per run (depending on how many queries `generatePlacesQueries` produced). Each call returns up to 20 results (v1 API max per page).
- **Approx cost:** Google Places Text Search = **$32 per 1,000 requests** = $0.032/call. A run with 2 queries = **$0.064**
- **Classification:** ✅ ESSENTIAL

### 2. `server/supervisor/google-places.ts` — Geocoding API
- **Endpoint:** `https://maps.googleapis.com/maps/api/geocode/json`
- **Lines:** 137
- **What it does:** Converts a human-readable location string (e.g. "Brighton") to lat/lng coordinates for geographic bias in Places search.
- **How often:** Once per run (cached in `geoCache` in-memory map — subsequent calls for the same location are free).
- **Approx cost:** **$5 per 1,000 requests** = $0.005/call (first call for a location)
- **Classification:** ✅ ESSENTIAL — already cached

---

## PART 4 — All Other External HTTP Calls

| Service | File | What it does | When | Classification |
|---------|------|-------------|------|----------------|
| **Brave Search** | `supervisor/web-search.ts` | Web search for evidence during lead enrichment | Per lead + constraint that needs web evidence | ✅ ESSENTIAL |
| **Hunter.io** | `routes/routes-outreach.ts` | Email lookup by domain for outreach | User-triggered per lead, not part of run | ✅ ESSENTIAL (when used) |
| **Resend** | `services/email-notifier.ts` | Sends email notifications | Event-triggered notifications | ✅ ESSENTIAL (when used) |
| **Xero** | `jobs/handlers/xero-sync.ts` | Syncs contacts/invoices from Xero | Scheduled job, separate from lead-gen | ✅ ESSENTIAL (when used) |
| **Tavily** | `jobs/handlers/deep-research-poll.ts` | Polls status of a Tavily deep research job | Only during async deep research | ✅ ESSENTIAL (when used) |
| **Perplexity** | `research-provider.ts` | Deep research via Perplexity Sonar | If `PERPLEXITY_API_KEY` set (alternative to OpenAI/Anthropic research) | ✅ ESSENTIAL (when used) |
| **Tower (internal)** | `tower-judgement.ts`, `tower-semantic-verify.ts`, `tower-artefact-judge.ts` | External judgement/verification service | Per step (judgement) + per lead (semantic verify) | ✅ ESSENTIAL (when TOWER_BASE_URL configured) |
| **Web Visit** | `supervisor/web-visit.ts` | Scrapes lead websites for evidence | Per enrichable lead | ✅ ESSENTIAL |

---

## PART 5 — Per-Run Call Count Analysis: "Find pubs in Brighton"

### Execution trace (default config: OpenAI key set, Google Places key set, no Tower URL)

| # | Call Name | Model / Service | Fires per run | Est. cost/call | Total est. |
|---|-----------|----------------|--------------|---------------|-----------|
| 1 | Goal → Constraints | gpt-4o-mini | 1 | $0.0002 | $0.0002 |
| 2 | Mission Extractor — Pass 1 (semantic interp) | gpt-4o-mini | 1 | $0.0002 | $0.0002 |
| 3 | Mission Extractor — Pass 2 (structured JSON) | gpt-4o-mini | 1 | $0.0002 | $0.0002 |
| 4 | Mission Extractor — Pass 3 (intent narrative) | gpt-4o-mini | 1 | $0.0002 | $0.0002 |
| 5 | Intent Extractor shadow | gpt-4o-mini | 1 (if enabled) | $0.0002 | $0.0002 |
| 6 | Generate Places Queries | gpt-4o-mini | 1 | $0.00007 | $0.00007 |
| 7 | Google Geocoding | Google Maps API | 1 (cached) | $0.005 | $0.005 |
| 8 | Google Places Text Search | Google Places v1 | 1–3 | $0.032 | $0.032–$0.096 |
| 9 | Filter By Entity Exclusions | gpt-4o-mini | 4 (20 leads ÷ 5) | $0.00003 | $0.00012 |
| 10 | Web Visit (scrape) | HTTP fetch | up to 25 leads | ~$0 (bandwidth) | ~$0 |
| 11 | Constraint-led Evidence Judge | gpt-4o-mini | ~10 (per evidence window) | $0.000015 | $0.00015 |
| 12 | Tower Semantic Verify | TOWER_BASE_URL | per lead (if configured) | external | — |
| 13 | Brave Web Search (evidence) | Brave Search API | ~5 (blocked sites) | ~$0.003 | ~$0.015 |
| 14 | Run Narrative | gpt-4o-mini | 1 | $0.0012 | $0.0012 |
| **Simple run TOTAL** | | | | | **~$0.055–$0.13** |

**GPT-4o fallback, discovery cascade, reloop planner: 0 calls in a clean simple run.**

---

### Complex run (vague query, many bot-blocked sites, reloop, low initial yield)

| # | Call Name | Model / Service | Fires per run | Est. cost/call | Total est. |
|---|-----------|----------------|--------------|---------------|-----------|
| 1–14 | All simple run calls | Various | (as above) | | ~$0.10 |
| 15 | GPT-4o Web Search Fallback | gpt-4o-mini + web search | 10–20 leads | $0.001–$0.003 | $0.01–$0.06 |
| 16 | Discovery Cascade | gpt-4o-mini + web search | 1–3 | $0.001–$0.003 | $0.001–$0.009 |
| 17 | Reloop LLM Planner | gpt-4o-mini | 1–3 | $0.0001 | $0.0001–$0.0003 |
| 18 | Additional Places Searches (reloop) | Google Places v1 | 1–3 more | $0.032 | $0.032–$0.096 |
| **Complex run TOTAL** | | | | | **~$0.14–$0.27** |

---

## PART 6 — Master Summary Table

| Call Name | Model | Fires per simple run | Fires per complex run | Cost/call | Essential? |
|-----------|-------|---------------------|----------------------|-----------|-----------|
| Goal → Constraints | gpt-4o-mini | 1 | 1 | $0.0002 | ✅ YES |
| Mission Extractor Pass 1 | gpt-4o-mini | 1 | 1 | $0.0002 | ✅ YES |
| Mission Extractor Pass 2 | gpt-4o-mini | 1 | 1 | $0.0002 | ✅ YES |
| Mission Extractor Pass 3 | gpt-4o-mini | 1 | 1 | $0.0002 | ✅ YES |
| Intent Extractor Shadow | gpt-4o-mini | 1 (if on) | 1 (if on) | $0.0002 | ⚠️ REDUNDANT |
| Generate Places Queries | gpt-4o-mini | 1 | 1 | $0.00007 | ✅ YES |
| Google Geocoding | Google Maps | 1 (cached) | 1 (cached) | $0.005 | ✅ YES |
| Google Places Text Search | Google Places v1 | 1–3 | 3–6 | $0.032 | ✅ YES |
| Filter By Entity Exclusions | gpt-4o-mini | 4–10 | 4–10 | $0.00003 | ⚠️ OPTIMIZABLE |
| Evidence Judge (layer 2) | gpt-4o-mini | ~10 | ~20 | $0.000015 | ✅ YES |
| Web Visit (scrape) | HTTP | up to 25 | up to 50 | ~$0 | ✅ YES |
| Brave Web Search (evidence) | Brave Search | ~5 | ~10 | ~$0.003 | ✅ YES |
| GPT-4o Web Search Fallback | gpt-4o-mini + web | 0 | 10–20 | $0.001–$0.003 | ✅ YES |
| Discovery Cascade | gpt-4o-mini + web | 0 | 1–3 | $0.001–$0.003 | ✅ YES |
| Reloop LLM Planner | gpt-4o-mini | 0 | 1–3 | $0.0001 | ✅ YES |
| Run Narrative | gpt-4o-mini | 1 | 1 | $0.0012 | ✅ YES |
| Run Explainer | gpt-4o-mini | 0 | 0 | $0.002 | ✅ ON DEMAND |
| Outreach Contact Finder | gpt-4o-mini + web | 0 | 0 | $0.001 | ✅ ON DEMAND |
| Outreach Email Drafter | gpt-4o-mini | 0 | 0 | $0.0007 | ✅ ON DEMAND |
| GPT-4o Primary Path | gpt-4o + web | 0 (default path) | 0 (default path) | $0.01–$0.05 | ✅ CONDITIONAL |
| Deep Research (OpenAI) | gpt-4.1 + web | 0 | 0 | $0.05–$0.50 | ✅ ON DEMAND |
| Claude Sonnet (auto-agent) | claude-3-5-sonnet | 0 (daily cron) | 0 (daily cron) | $0.01–$0.05 | ✅ SEPARATE PIPELINE |
| Tower Semantic Verify | external service | per lead | per lead | varies | ✅ IF CONFIGURED |
| Tower Judgement | external service | per step | per step | varies | ✅ IF CONFIGURED |
| Hunter.io Email Lookup | Hunter.io | 0 | 0 | API plan | ✅ ON DEMAND |
| Xero Sync | Xero API | 0 | 0 | free tier | ✅ SEPARATE JOB |

---

## PART 7 — Top Findings & Recommendations

### 🔴 Biggest Single Cost: Google Places ($0.032/call)
Google Places Text Search is the **dominant cost driver** in a standard run — not LLMs. At 2 queries per run it's ~$0.064, which is more than all LLM calls combined in a simple run. This is irreducible but worth noting: **deduplication** (caching prior Places results for the same entity+location) could eliminate repeat calls across runs.

### 🟠 Scalable Risk: GPT-4o Fallback (web search, per lead)
The fallback block at lines 1443–1570 fires **per lead with no evidence** with no hard cap on number of leads processed (only a deadline gate). If 20 leads are bot-blocked, that's 20 web-search API calls. The model defaults to `gpt-4o-mini` but is overridable to `gpt-4o` — if someone sets `GPT4O_FALLBACK_MODEL=gpt-4o`, cost jumps **10–15×**. Recommend adding a hard cap (e.g. `MAX_FALLBACK_LEADS=10`).

### 🟡 Removable Call: Intent Extractor Shadow (saves 1 LLM call/run)
`intent-extractor.ts` fires once per run if `INTENT_EXTRACTOR_MODE` is `shadow` or `active`. In shadow mode the result is computed but may not influence the run. Since Pass 3 of `mission-extractor.ts` already produces an intent narrative, this is **functionally redundant** under the active mission extractor. Setting `INTENT_EXTRACTOR_MODE=off` eliminates 1 gpt-4o-mini call per run at no accuracy cost.

### 🟡 Easy Win: Increase Exclusion Filter Batch Size
`filterByEntityExclusions` uses `BATCH_SIZE = 5` — this means 4–10 LLM calls just to filter entity types. Increasing to 20 would reduce this to 1–2 calls. The LLM handles batches of this size easily. Savings: ~3–8 LLM calls per run.

### 🟢 Already Well Optimised
- Mission extractor uses gpt-4o-mini (not gpt-4o) — good choice.
- Geocoding is in-memory cached.
- Enrichment batches leads with `ENRICH_CONCURRENCY = 3`.
- Discovery cascade and reloop are conditional — zero cost on successful simple runs.
- All Claude calls are fallback-only (no cost under normal operation).
