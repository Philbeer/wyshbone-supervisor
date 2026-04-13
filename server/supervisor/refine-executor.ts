import { getCurrentDatePreamble, getTemporalVerificationRules } from './current-context';
import { storage } from '../storage';
import { createArtefact } from './artefacts';
import { logAFREvent } from './afr-logger';
import { supabase } from '../supabase';
import { executeWebVisit } from './web-visit';
import { extractConstraintLedEvidence, getPageHintsForConstraint, type ConstraintContext, type ConstraintLedExtractionResult } from './constraint-led-extractor';
import { batchGpt4oVerification } from './mission-executor';

const EVIDENCE_MODE = (process.env.EVIDENCE_MODE || 'gpt4o_primary') as 'gpt4o_primary' | 'web_crawl_first';

export interface RefineLead {
  name: string;
  address?: string;
  phone?: string | null;
  website?: string | null;
  placeId?: string;
  [key: string]: unknown;
}

export interface RefineMatchedLead extends RefineLead {
  refine_match: true;
  refine_evidence: string;
}

export interface RefineNonMatchedLead extends RefineLead {
  refine_match: false;
  reason?: string;
}

export interface RefineResult {
  message: string;
  matchingLeads: RefineMatchedLead[];
  nonMatchingLeads: RefineNonMatchedLead[];
  totalChecked: number;
  noCachedPages: boolean;
  liveFetched: boolean;
}

function extractDomain(url: string): string {
  try {
    return url.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  } catch {
    return '';
  }
}

async function extractConstraintValue(userQuestion: string): Promise<{ value: string; type: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const cleaned = userQuestion
      .replace(/^(which|what|do any|are there any|can you check|tell me|show me|find|list|any)\s+(of\s+)?(those|them|the results?|these)?\s*(that\s+|which\s+|who\s+)?(mention|have|offer|provide|include|feature|do|say|advertise|list|show)?\s*/i, '')
      .replace(/\?+$/, '')
      .replace(/\bon their (website|homepage|site|page)\b/gi, '')
      .trim();
    return { value: cleaned || userQuestion, type: 'attribute_check' };
  }

  const model = process.env.REFINE_LLM_MODEL || 'claude-3-haiku-20240307';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 100,
        temperature: 0,
        system: 'Extract the specific thing the user wants to check for on a business website. Respond with JSON only.',
        messages: [{
          role: 'user',
          content: `User question: "${userQuestion}"

What specific attribute, feature, or content is the user looking for? Extract just the key thing to search for on the website.

JSON only: {"value": "the thing to search for", "type": "attribute_check"}

Examples:
- "which of those mention live music?" → {"value": "live music", "type": "attribute_check"}
- "do any of them do loft conversions?" → {"value": "loft conversions", "type": "attribute_check"}
- "which ones mention eco homes or green building" → {"value": "eco homes or green building", "type": "website_evidence"}
- "any of them have beer gardens?" → {"value": "beer garden", "type": "attribute_check"}
- "which seem high end or premium" → {"value": "high end or premium", "type": "attribute_check"}`,
        }],
      }),
    });

    if (!resp.ok) throw new Error(`API ${resp.status}`);
    const data = await resp.json() as any;
    const text = data.content?.[0]?.text || '';
    const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    console.log(`[REFINE_EXTRACT] "${userQuestion}" → constraint value: "${parsed.value}" type: "${parsed.type}"`);
    return { value: parsed.value || userQuestion, type: parsed.type || 'attribute_check' };
  } catch (err: any) {
    console.warn(`[REFINE_EXTRACT] LLM extraction failed: ${err.message}`);
    const cleaned = userQuestion
      .replace(/^(which|what|do any|are there any|can you check|tell me|show me|find|list|any)\s+(of\s+)?(those|them|the results?|these)?\s*(that\s+|which\s+|who\s+)?(mention|have|offer|provide|include|feature|do|say|advertise|list|show)?\s*/i, '')
      .replace(/\?+$/, '')
      .replace(/\bon their (website|homepage|site|page)\b/gi, '')
      .trim();
    return { value: cleaned || userQuestion, type: 'attribute_check' };
  }
}

function normalizeArtefact(raw: any): any {
  return {
    ...raw,
    payloadJson: raw.payloadJson ?? raw.payload_json ?? null,
    runId: raw.runId ?? raw.run_id ?? '',
    title: raw.title ?? '',
  };
}

// ── Cached artefact lookup ─────────────────────────────────────────────────────

async function queryWebVisitsByRunId(runId: string): Promise<any[]> {
  let localAll: any[] = [];
  try {
    localAll = await storage.getArtefactsByRunId(runId);
    const localTypes = [...new Set(localAll.map((a: any) => a.type))];
    console.log(`[REFINE_LOOKUP] Local storage run_id="${runId}": ${localAll.length} total, types=[${localTypes.join(', ')}]`);

    const local = localAll.filter((a: any) => a.type === 'web_visit_pages');
    if (local.length > 0) {
      console.log(`[REFINE_LOOKUP] Local hit: ${local.length} web_visit_pages for run_id="${runId}"`);
      return local.map(normalizeArtefact);
    }
  } catch (err: any) {
    console.warn(`[REFINE_LOOKUP] Local storage error: ${err.message}`);
  }

  if (!supabase) return [];

  try {
    const { data: allRows, error: diagErr } = await supabase
      .from('artefacts')
      .select('id, type')
      .eq('run_id', runId);

    if (!diagErr) {
      const sbTypes = [...new Set((allRows ?? []).map((r: any) => r.type))];
      console.log(`[REFINE_LOOKUP] Supabase run_id="${runId}": ${(allRows ?? []).length} total, types=[${sbTypes.join(', ')}]`);
    }

    const { data, error } = await supabase
      .from('artefacts')
      .select('*')
      .eq('run_id', runId)
      .eq('type', 'web_visit_pages');

    if (error) {
      console.warn(`[REFINE_LOOKUP] Supabase web_visit_pages query failed: ${error.message}`);
      return [];
    }

    const results = (data ?? []).map(normalizeArtefact);
    console.log(`[REFINE_LOOKUP] Supabase ${results.length > 0 ? 'hit' : 'miss'}: ${results.length} web_visit_pages for run_id="${runId}"`);
    return results;
  } catch (err: any) {
    console.warn(`[REFINE_LOOKUP] Supabase fallback error: ${err.message}`);
    return [];
  }
}

async function fetchWebVisitArtefacts(sourceRunId: string): Promise<any[]> {
  console.log(`[REFINE_LOOKUP] Querying artefacts for source_run_id="${sourceRunId}"`);

  const primaryResults = await queryWebVisitsByRunId(sourceRunId);
  if (primaryResults.length > 0) return primaryResults;

  // Fallback: source_run_id might be a client_request_id — resolve via agent_runs
  if (!supabase) {
    console.warn(`[REFINE_LOOKUP] No Supabase client — cannot resolve client_request_id fallback`);
    return [];
  }

  console.log(`[REFINE_LOOKUP] Zero results — attempting client_request_id resolution for "${sourceRunId}"`);
  try {
    const { data: runRow, error: runErr } = await supabase
      .from('agent_runs')
      .select('id')
      .eq('client_request_id', sourceRunId)
      .limit(1)
      .maybeSingle();

    if (runErr) {
      console.warn(`[REFINE_LOOKUP] agent_runs lookup failed: ${runErr.message}`);
      return [];
    }

    if (!runRow?.id || runRow.id === sourceRunId) {
      console.log(`[REFINE_LOOKUP] No client_request_id match found for "${sourceRunId}" — proceeding to live fetch`);
      return [];
    }

    console.log(`[REFINE_LOOKUP] Resolved client_request_id "${sourceRunId}" → run_id="${runRow.id}"`);
    return queryWebVisitsByRunId(runRow.id);
  } catch (err: any) {
    console.warn(`[REFINE_LOOKUP] client_request_id resolution error: ${err.message}`);
    return [];
  }
}

// ── Live fetch (crawls up to 5 pages per website using the full evidence pipeline) ──

async function liveRefineWithFetch(
  leads: RefineLead[],
  constraint: string,
  sourceRunId: string,
  runId: string,
  userId: string,
  conversationId: string | undefined,
): Promise<{
  matchingLeads: RefineMatchedLead[];
  nonMatchingLeads: RefineNonMatchedLead[];
  fetchedCount: number;
}> {
  const matchingLeads: RefineMatchedLead[] = [];
  const nonMatchingLeads: RefineNonMatchedLead[] = [];

  // Step 1: Extract the actual constraint value from the user's question
  const extracted = await extractConstraintValue(constraint);
  const constraintCtx: ConstraintContext = {
    type: extracted.type,
    field: 'website_content',
    operator: 'contains',
    value: extracted.value,
    hardness: 'soft',
  };

  console.log(`[REFINE_LIVE] Constraint extracted: "${constraint}" → value="${extracted.value}" type="${extracted.type}"`);

  // Step 2: Get page hints for this constraint (e.g., /events, /whats-on for "live music")
  const pageHints = getPageHintsForConstraint(constraintCtx);
  console.log(`[REFINE_LIVE] Page hints for "${extracted.value}": ${pageHints.join(', ') || 'none'}`);

  const withWebsite = leads.filter(l => !!l.website);
  const withoutWebsite = leads.filter(l => !l.website);

  for (const lead of withoutWebsite) {
    nonMatchingLeads.push({ ...lead, refine_match: false, reason: 'no_website' });
  }

  if (withWebsite.length === 0) {
    return { matchingLeads, nonMatchingLeads, fetchedCount: 0 };
  }

  let fetchedCount = 0;

  // If gpt4o_primary mode, skip website crawl and go straight to GPT-4o verification
  if (EVIDENCE_MODE === 'gpt4o_primary') {
    console.log(`[REFINE_LIVE] EVIDENCE_MODE=gpt4o_primary — using GPT-4o verification for all ${withWebsite.length} leads`);

    const discoveredLeads = withWebsite.map(l => ({
      name: l.name,
      address: l.address || '',
      phone: l.phone || null,
      website: l.website || null,
      placeId: l.placeId || '',
      source: 'refine',
      lat: null as number | null,
      lng: null as number | null,
    }));

    const missionConstraint = {
      type: extracted.type as any,
      field: 'website_content',
      operator: 'contains' as any,
      value: extracted.value,
      hardness: 'hard' as const,
    };

    const location = (withWebsite[0]?.address || '').replace(/,\s*UK$/i, '').split(',').pop()?.trim() || 'UK';

    const gpt4oResults = await batchGpt4oVerification(
      discoveredLeads,
      [missionConstraint],
      location,
      constraint,
      runId,
      userId,
      conversationId,
    );

    for (let i = 0; i < withWebsite.length; i++) {
      const lead = withWebsite[i];
      const leadResults = gpt4oResults.filter(r => r.leadIndex === i);
      const verified = leadResults.some(r => r.evidenceFound);

      if (verified) {
        const bestResult = leadResults.find(r => r.evidenceFound)!;
        console.log(`[REFINE_LIVE] "${lead.name}" → VERIFIED via GPT-4o`);
        matchingLeads.push({
          ...lead,
          refine_match: true,
          refine_evidence: bestResult.snippets[0] || bestResult.towerReasoning || 'Verified via web search',
        });
      } else {
        console.log(`[REFINE_LIVE] "${lead.name}" → NOT VERIFIED`);
        nonMatchingLeads.push({ ...lead, refine_match: false, reason: 'no_evidence' });
      }
    }

    fetchedCount = withWebsite.length;
    console.log(`[REFINE_LIVE] GPT-4o primary complete — ${matchingLeads.length}/${withWebsite.length} verified`);
    return { matchingLeads, nonMatchingLeads, fetchedCount };
  }

  console.log(`[REFINE_LIVE] Crawling ${withWebsite.length} websites (up to 5 pages each) for "${extracted.value}"`);
  const cacheWrites: Promise<any>[] = [];
  const BATCH_SIZE = 5;

  // Process leads in batches of 5
  for (let batchStart = 0; batchStart < withWebsite.length; batchStart += BATCH_SIZE) {
    const batch = withWebsite.slice(batchStart, batchStart + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map(async (lead) => {
        const url = lead.website!;

        // Crawl up to 5 pages with page hints (same as main pipeline)
        let pages: any[] = [];
        try {
          const envelope = await executeWebVisit(
            { url, max_pages: 5, same_domain_only: true, ...(pageHints.length > 0 ? { page_hints: pageHints.slice(0, 6) } : {}) },
            runId,
          );
          pages = (envelope.outputs as any)?.pages ?? [];
        } catch (err: any) {
          console.warn(`[REFINE_LIVE] Web visit failed for "${lead.name}": ${err.message}`);
        }

        if (pages.length === 0) {
          return { lead, match: false, evidence: '', reason: 'fetch_failed', pages: [] };
        }

        fetchedCount++;

        // Cache pages under the source run for future refinements
        const cacheWrite = createArtefact({
          runId: sourceRunId,
          type: 'web_visit_pages',
          title: `${lead.name} — ${extractDomain(url)}`,
          summary: `${pages.length} page(s) crawled during refinement`,
          payload: {
            outputs: {
              pages,
              site_summary: `Crawled for lead: ${lead.name}`,
              site_language: 'en',
              crawl: { attempted_pages: 5, fetched_pages: pages.length, blocked: false, retryable: false, http_failures_count: 0 },
            },
          },
          userId,
          conversationId,
        }).catch((err: any) =>
          console.warn(`[REFINE_LIVE] Cache write failed for "${lead.name}": ${err.message}`),
        );
        cacheWrites.push(cacheWrite);

        // Use the SAME evidence extraction as the main pipeline
        const extraction = await extractConstraintLedEvidence(
          pages,
          constraintCtx,
          [],
          3,
          lead.name,
        );

        if (!extraction.no_evidence && extraction.evidence_items.length > 0) {
          const bestEvidence = extraction.evidence_items[0];
          return {
            lead,
            match: true,
            evidence: bestEvidence.direct_quote || bestEvidence.context_snippet || '',
            reason: '',
            pages,
          };
        } else {
          return { lead, match: false, evidence: '', reason: 'no_evidence', pages };
        }
      }),
    );

    for (const settled of batchResults) {
      if (settled.status === 'rejected') {
        console.warn(`[REFINE_LIVE] Batch item threw: ${settled.reason}`);
        continue;
      }
      const { lead, match, evidence, reason } = settled.value;
      if (match) {
        console.log(`[REFINE_LIVE] "${lead.name}" → MATCH for "${extracted.value}"`);
        matchingLeads.push({ ...lead, refine_match: true, refine_evidence: evidence });
      } else {
        console.log(`[REFINE_LIVE] "${lead.name}" → NO MATCH for "${extracted.value}" (${reason})`);
        nonMatchingLeads.push({ ...lead, refine_match: false, reason });
      }
    }
  }

  // ── GPT-4o web search fallback for leads with no evidence ──
  const noEvidenceLeads = nonMatchingLeads.filter(l => l.reason === 'no_evidence');

  if (noEvidenceLeads.length > 0) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      console.log(`[REFINE_FALLBACK] Running GPT-4o web search fallback for ${noEvidenceLeads.length} leads with no website evidence`);

      const fallbackModel = process.env.GPT4O_FALLBACK_MODEL ?? 'gpt-4o-mini';
      const FALLBACK_BATCH = 5;
      const refineCutoffDate1 = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      for (let fi = 0; fi < noEvidenceLeads.length; fi += FALLBACK_BATCH) {
        const fbBatch = noEvidenceLeads.slice(fi, fi + FALLBACK_BATCH);

        const fbResults = await Promise.allSettled(
          fbBatch.map(async (lead) => {
            const prompt = `${getCurrentDatePreamble()}

${getTemporalVerificationRules(refineCutoffDate1)}

Search for "${lead.name}". Find their website, TripAdvisor page, Google reviews, social media, or any other source. Determine whether "${extracted.value}" is genuinely true for this specific business.

Respond with JSON only, no markdown fences:
{"business_found": true/false, "constraint_met": true/false, "confidence": "high"/"medium"/"low", "reasoning": "one sentence", "source_url": "URL or null"}

IMPORTANT:
- constraint_met means "${extracted.value}" IS genuinely true for this business
- Check review sites, event listings, social media — not just the business's own website
- If the business exists but does NOT match, set business_found=true, constraint_met=false`;

            const resp = await fetch('https://api.openai.com/v1/responses', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${openaiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model: fallbackModel,
                input: prompt,
                tools: [{ type: 'web_search' }],
                store: false,
              }),
            });

            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

            const data = await resp.json();
            let content = '';
            if (Array.isArray(data.output)) {
              for (const item of data.output) {
                if (item.type === 'message' && Array.isArray(item.content)) {
                  for (const block of item.content) {
                    if (block.type === 'output_text') content += block.text;
                  }
                }
              }
            }
            if (!content && data.output_text) content = data.output_text;

            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON');
            const parsed = JSON.parse(jsonMatch[0]);
            return { lead, parsed };
          }),
        );

        for (const settled of fbResults) {
          if (settled.status === 'rejected') continue;
          const { lead, parsed } = settled.value;

          if (parsed.business_found && parsed.constraint_met) {
            console.log(`[REFINE_FALLBACK] "${lead.name}" → VERIFIED via web search (${parsed.confidence}): ${(parsed.reasoning || '').substring(0, 100)}`);
            const idx = nonMatchingLeads.findIndex(l => l.name === lead.name);
            if (idx >= 0) nonMatchingLeads.splice(idx, 1);
            matchingLeads.push({
              ...lead,
              refine_match: true,
              refine_evidence: parsed.reasoning || `Verified via web search (${parsed.confidence})`,
            });
          } else {
            console.log(`[REFINE_FALLBACK] "${lead.name}" → NOT VERIFIED: ${(parsed.reasoning || '').substring(0, 100)}`);
          }
        }
      }

      console.log(`[REFINE_FALLBACK] After fallback: ${matchingLeads.length} total matches`);
    } else {
      console.warn(`[REFINE_FALLBACK] OPENAI_API_KEY not set — skipping web search fallback`);
    }
  }
  // ── end GPT-4o fallback ──

  // Fire cache writes without blocking
  Promise.allSettled(cacheWrites).catch(() => {});

  console.log(`[REFINE_LIVE] Complete — fetched=${fetchedCount} matched=${matchingLeads.length}/${leads.length}`);
  return { matchingLeads, nonMatchingLeads, fetchedCount };
}

// ── Cached-artefact helpers ────────────────────────────────────────────────────

function artefactMatchesLead(artefact: any, lead: RefineLead): boolean {
  const title = (artefact.title ?? '').toLowerCase();
  const leadName = (lead.name ?? '').toLowerCase();
  const leadDomain = lead.website ? extractDomain(lead.website) : '';

  if (leadName.length >= 5 && title.includes(leadName.substring(0, Math.min(leadName.length, 25)))) {
    return true;
  }

  if (leadDomain && title.includes(leadDomain)) {
    return true;
  }

  if (leadDomain) {
    const pages: any[] = artefact.payloadJson?.outputs?.pages ?? [];
    return pages.some((p: any) => extractDomain(p.url ?? '').includes(leadDomain));
  }

  return false;
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function executeRefine(
  sourceRunId: string,
  leads: RefineLead[],
  constraint: string,
  runId: string,
  userId: string,
  conversationId: string | undefined,
): Promise<RefineResult> {
  console.log(`[REFINE] Starting — runId=${runId} source=${sourceRunId} constraint="${constraint}" leads=${leads.length}`);

  const webVisitArtefacts = await fetchWebVisitArtefacts(sourceRunId);
  const noCachedPages = webVisitArtefacts.length === 0;

  let matchingLeads: RefineMatchedLead[] = [];
  let nonMatchingLeads: RefineNonMatchedLead[] = [];
  let message: string;
  let liveFetched = false;

  const extracted = await extractConstraintValue(constraint);
  const constraintValue = extracted.value;

  if (noCachedPages) {
    // ── Live fetch path ──────────────────────────────────────────────────────
    console.log(`[REFINE] No cached pages — fetching live with full evidence pipeline`);

    const liveResult = await liveRefineWithFetch(
      leads, constraint, sourceRunId, runId, userId, conversationId,
    );

    matchingLeads = liveResult.matchingLeads;
    nonMatchingLeads = liveResult.nonMatchingLeads;
    liveFetched = true;

    const leadsWithWebsite = leads.filter(l => !!l.website).length;
    const { fetchedCount } = liveResult;

    if (fetchedCount === 0 && leadsWithWebsite === 0) {
      message = `None of the ${leads.length} results have a website URL, so I couldn't check for ${constraintValue}.`;
    } else if (fetchedCount === 0) {
      message = `I tried to check the websites live but couldn't load any of them. Would you like me to run a fresh search specifically for ${constraintValue}?`;
    } else if (matchingLeads.length === 0) {
      message = `I checked ${fetchedCount} website${fetchedCount !== 1 ? 's' : ''} — none of the ${leads.length} results appear to have ${constraintValue} based on their website content.`;
    } else {
      const matchNames = matchingLeads.slice(0, 3).map(l => l.name).join(', ');
      const andMore = matchingLeads.length > 3 ? ` and ${matchingLeads.length - 3} more` : '';
      message = `Found ${matchingLeads.length} of ${leads.length} with ${constraintValue}: ${matchNames}${andMore}.`;
    }
  } else {
    // ── Cached artefact path ─────────────────────────────────────────────────
    const constraintCtx: ConstraintContext = {
      type: extracted.type,
      field: 'website_content',
      operator: 'contains',
      value: constraintValue,
      hardness: 'soft',
    };

    console.log(`[REFINE] Using cached pages — constraint: "${constraintValue}"`);

    const CACHED_BATCH_SIZE = 5;
    const cachedToCheck: { lead: RefineLead; pages: any[] }[] = [];

    for (const lead of leads) {
      const matchingArtefacts = webVisitArtefacts.filter(a => artefactMatchesLead(a, lead));
      if (matchingArtefacts.length === 0) {
        nonMatchingLeads.push({ ...lead, refine_match: false, reason: 'no_cached_pages' });
        continue;
      }
      const pages = matchingArtefacts.flatMap(a => a.payloadJson?.outputs?.pages ?? []);
      cachedToCheck.push({ lead, pages });
    }

    for (let i = 0; i < cachedToCheck.length; i += CACHED_BATCH_SIZE) {
      const batch = cachedToCheck.slice(i, i + CACHED_BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async ({ lead, pages }) => {
          const extraction = await extractConstraintLedEvidence(pages, constraintCtx, [], 3, lead.name);
          return { lead, extraction };
        }),
      );

      for (const settled of batchResults) {
        if (settled.status === 'rejected') continue;
        const { lead, extraction } = settled.value;
        if (!extraction.no_evidence && extraction.evidence_items.length > 0) {
          const bestEvidence = extraction.evidence_items[0];
          console.log(`[REFINE] "${lead.name}" → MATCH for "${constraintValue}"`);
          matchingLeads.push({ ...lead, refine_match: true, refine_evidence: bestEvidence.direct_quote || bestEvidence.context_snippet || '' });
        } else {
          console.log(`[REFINE] "${lead.name}" → NO MATCH for "${constraintValue}"`);
          nonMatchingLeads.push({ ...lead, refine_match: false, reason: 'no_evidence' });
        }
      }
    }

    // ── GPT-4o web search fallback for leads with no evidence ──
    const noEvidenceCached = nonMatchingLeads.filter(l => l.reason === 'no_evidence');

    if (noEvidenceCached.length > 0) {
      const openaiKey = process.env.OPENAI_API_KEY;
      if (openaiKey) {
        console.log(`[REFINE_FALLBACK] Running GPT-4o web search fallback for ${noEvidenceCached.length} leads with no cached evidence`);

        const fallbackModel = process.env.GPT4O_FALLBACK_MODEL ?? 'gpt-4o-mini';
        const FALLBACK_BATCH = 5;
        const refineCutoffDate2 = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        for (let fi = 0; fi < noEvidenceCached.length; fi += FALLBACK_BATCH) {
          const fbBatch = noEvidenceCached.slice(fi, fi + FALLBACK_BATCH);

          const fbResults = await Promise.allSettled(
            fbBatch.map(async (lead) => {
              const prompt = `${getCurrentDatePreamble()}

${getTemporalVerificationRules(refineCutoffDate2)}

Search for "${lead.name}". Find their website, TripAdvisor page, Google reviews, social media, or any other source. Determine whether "${constraintValue}" is genuinely true for this specific business.

Respond with JSON only, no markdown fences:
{"business_found": true/false, "constraint_met": true/false, "confidence": "high"/"medium"/"low", "reasoning": "one sentence", "source_url": "URL or null"}

IMPORTANT:
- constraint_met means "${constraintValue}" IS genuinely true for this business
- Check review sites, event listings, social media — not just the business's own website
- If the business exists but does NOT match, set business_found=true, constraint_met=false`;

              const resp = await fetch('https://api.openai.com/v1/responses', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${openaiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  model: fallbackModel,
                  input: prompt,
                  tools: [{ type: 'web_search' }],
                  store: false,
                }),
              });

              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

              const data = await resp.json();
              let content = '';
              if (Array.isArray(data.output)) {
                for (const item of data.output) {
                  if (item.type === 'message' && Array.isArray(item.content)) {
                    for (const block of item.content) {
                      if (block.type === 'output_text') content += block.text;
                    }
                  }
                }
              }
              if (!content && data.output_text) content = data.output_text;

              const jsonMatch = content.match(/\{[\s\S]*\}/);
              if (!jsonMatch) throw new Error('No JSON');
              const parsed = JSON.parse(jsonMatch[0]);
              return { lead, parsed };
            }),
          );

          for (const settled of fbResults) {
            if (settled.status === 'rejected') continue;
            const { lead, parsed } = settled.value;

            if (parsed.business_found && parsed.constraint_met) {
              console.log(`[REFINE_FALLBACK] "${lead.name}" → VERIFIED via web search (${parsed.confidence}): ${(parsed.reasoning || '').substring(0, 100)}`);
              const idx = nonMatchingLeads.findIndex(l => l.name === lead.name);
              if (idx >= 0) nonMatchingLeads.splice(idx, 1);
              matchingLeads.push({
                ...lead,
                refine_match: true,
                refine_evidence: parsed.reasoning || `Verified via web search (${parsed.confidence})`,
              });
            } else {
              console.log(`[REFINE_FALLBACK] "${lead.name}" → NOT VERIFIED: ${(parsed.reasoning || '').substring(0, 100)}`);
            }
          }
        }

        console.log(`[REFINE_FALLBACK] After fallback: ${matchingLeads.length} total matches`);
      } else {
        console.warn(`[REFINE_FALLBACK] OPENAI_API_KEY not set — skipping web search fallback`);
      }
    }
    // ── end GPT-4o fallback ──

    if (matchingLeads.length === 0) {
      message = `I checked ${leads.length} websites — none of the ${leads.length} results appear to have ${constraintValue} based on their website content.`;
    } else {
      const matchNames = matchingLeads.slice(0, 3).map(l => l.name).join(', ');
      const andMore = matchingLeads.length > 3 ? ` and ${matchingLeads.length - 3} more` : '';
      message = `Found ${matchingLeads.length} of ${leads.length} with ${constraintValue}: ${matchNames}${andMore}.`;
    }
  }

  console.log(`[REFINE] Complete — matched=${matchingLeads.length}/${leads.length} cached=${!noCachedPages} live=${liveFetched}`);

  await createArtefact({
    runId,
    type: 'refine_results',
    title: `Refinement: "${constraint}" — ${matchingLeads.length}/${leads.length} matched`,
    summary: message,
    payload: {
      constraint,
      source_run_id: sourceRunId,
      total_checked: leads.length,
      matches: matchingLeads.length,
      cached_pages_available: !noCachedPages,
      live_fetched: liveFetched,
      web_visit_artefacts_used: webVisitArtefacts.length,
      matching_leads: matchingLeads,
      non_matching_leads: nonMatchingLeads,
    },
    userId,
    conversationId,
  }).catch((err: any) => console.warn(`[REFINE] Failed to write refine_results artefact (non-fatal): ${err.message}`));

  await logAFREvent({
    userId,
    runId,
    conversationId,
    actionTaken: 'refine_completed',
    status: 'success',
    taskGenerated: message,
    runType: 'plan',
    metadata: {
      constraint,
      source_run_id: sourceRunId,
      total_checked: leads.length,
      matches: matchingLeads.length,
      no_cached_pages: noCachedPages,
      live_fetched: liveFetched,
    },
  }).catch(() => {});

  return { message, matchingLeads, nonMatchingLeads, totalChecked: leads.length, noCachedPages, liveFetched };
}
