import { storage } from '../storage';
import { createArtefact } from './artefacts';
import { logAFREvent } from './afr-logger';
import { supabase } from '../supabase';
import { executeWebVisit } from './web-visit';

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

function fallbackKeywordCheck(
  pageText: string,
  constraint: string,
): { match: boolean; reasoning: string; snippet: string } {
  const text = pageText.toLowerCase();
  const cleaned = constraint
    .replace(/^(which|what|do any|are there any|can you check|tell me|show me|find|list)\s+(of\s+)?(those|them|the results?|these)?\s*(that\s+|which\s+|who\s+)?(mention|have|offer|provide|include|feature|do)?\s*/i, '')
    .replace(/\?+$/, '')
    .replace(/\bon their (website|homepage|site)\b/gi, '')
    .trim();

  const words = cleaned.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return { match: false, reasoning: 'no keywords extracted', snippet: '' };

  const threshold = words.length <= 2 ? words.length : words.length - 1;
  const foundWords = words.filter(w => text.includes(w));

  if (foundWords.length >= threshold) {
    const idx = text.indexOf(foundWords[0]);
    const start = Math.max(0, idx - 100);
    const end = Math.min(text.length, idx + 200);
    return { match: true, reasoning: `Keywords found: ${foundWords.join(', ')}`, snippet: pageText.substring(start, end).trim() };
  }

  return { match: false, reasoning: `Keywords not found: ${words.join(', ')}`, snippet: '' };
}

async function llmCheckConstraint(
  pageText: string,
  leadName: string,
  userQuestion: string,
): Promise<{ match: boolean; reasoning: string; snippet: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return fallbackKeywordCheck(pageText, userQuestion);
  }

  const model = process.env.REFINE_LLM_MODEL || 'claude-3-haiku-20240307';
  const truncatedPage = pageText.substring(0, 8000);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      temperature: 0,
      system: `You check whether a business's website content answers a user's question. Respond with JSON only, no other text.`,
      messages: [{
        role: 'user',
        content: `Business: "${leadName}"

Website content (truncated):
${truncatedPage}

User's question about this business: "${userQuestion}"

Does the website content contain information that answers or relates to the user's question?

Respond with JSON only:
{"match": true/false, "reasoning": "one sentence why", "snippet": "the relevant quote from the website, or empty string"}`,
      }],
    }),
  });

  if (!resp.ok) {
    console.warn(`[REFINE_LLM] API error for "${leadName}": ${resp.status}`);
    return fallbackKeywordCheck(pageText, userQuestion);
  }

  const data = await resp.json() as any;
  const text = data.content?.[0]?.text || '';

  try {
    const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      match: !!parsed.match,
      reasoning: parsed.reasoning || '',
      snippet: parsed.snippet || '',
    };
  } catch {
    console.warn(`[REFINE_LLM] Failed to parse response for "${leadName}": ${text.substring(0, 100)}`);
    return fallbackKeywordCheck(pageText, userQuestion);
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

// ── Live homepage fetch (used when no cached pages exist) ──────────────────────

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

  const withWebsite = leads.filter(l => !!l.website);
  const withoutWebsite = leads.filter(l => !l.website);

  for (const lead of withoutWebsite) {
    nonMatchingLeads.push({ ...lead, refine_match: false, reason: 'no_website' });
  }

  if (withWebsite.length === 0) {
    return { matchingLeads, nonMatchingLeads, fetchedCount: 0 };
  }

  console.log(`[REFINE_LIVE] Fetching ${withWebsite.length} homepage(s) in parallel for constraint="${constraint}"`);

  // Fetch all homepages in parallel — max_pages: 1 = homepage only
  const fetchSettled = await Promise.allSettled(
    withWebsite.map(async (lead) => {
      const url = lead.website!;
      console.log(`[REFINE_LIVE] Fetching ${url} for lead "${lead.name}"`);
      const envelope = await executeWebVisit({ url, max_pages: 1 }, runId);
      const pages: any[] = (envelope.outputs as any)?.pages ?? [];
      return { lead, pages, url };
    }),
  );

  let fetchedCount = 0;

  // Process results sequentially (no concurrency issues writing to shared arrays)
  const cacheWrites: Promise<any>[] = [];

  // Collect successfully fetched leads for batched LLM checks
  const toCheck: { lead: RefineLead; pages: any[]; url: string }[] = [];

  for (const settled of fetchSettled) {
    if (settled.status === 'rejected') {
      // Find which lead this was — not directly available but we warned in executeWebVisit
      console.warn(`[REFINE_LIVE] A homepage fetch threw: ${settled.reason}`);
      continue;
    }

    const { lead, pages, url } = settled.value;

    if (pages.length === 0) {
      console.log(`[REFINE_LIVE] No pages returned for "${lead.name}" (${url}) — marking unmatched`);
      nonMatchingLeads.push({ ...lead, refine_match: false, reason: 'fetch_failed' });
      continue;
    }

    fetchedCount++;

    // Cache under the source run so future refinements reuse the data
    const cacheWrite = createArtefact({
      runId: sourceRunId,
      type: 'web_visit_pages',
      title: `${lead.name} — ${extractDomain(url)}`,
      summary: `Homepage fetched live during refinement`,
      payload: {
        outputs: {
          pages,
          site_summary: `Live-fetched homepage for lead: ${lead.name}`,
          site_language: 'en',
          crawl: { attempted_pages: 1, fetched_pages: pages.length, blocked: false, retryable: false, http_failures_count: 0 },
        },
      },
      userId,
      conversationId,
    }).catch((err: any) =>
      console.warn(`[REFINE_LIVE] Cache write failed for "${lead.name}": ${err.message}`),
    );
    cacheWrites.push(cacheWrite);

    toCheck.push({ lead, pages, url });
  }

  // Run LLM constraint checks in batches of 5 (concurrency limit)
  const BATCH_SIZE = 5;
  for (let i = 0; i < toCheck.length; i += BATCH_SIZE) {
    const batch = toCheck.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async ({ lead, pages }) => {
        const fullText = pages.map((p: any) => (typeof p.text_clean === 'string' ? p.text_clean : '')).join(' ');
        const result = await llmCheckConstraint(fullText, lead.name, constraint);
        return { lead, result };
      }),
    );

    for (const settled of batchResults) {
      if (settled.status === 'rejected') {
        console.warn(`[REFINE_LIVE] LLM check threw: ${settled.reason}`);
        continue;
      }
      const { lead, result } = settled.value;
      if (result.match) {
        console.log(`[REFINE_LIVE] "${lead.name}" → MATCH for "${constraint}"`);
        matchingLeads.push({ ...lead, refine_match: true, refine_evidence: result.snippet || result.reasoning || '' });
      } else {
        console.log(`[REFINE_LIVE] "${lead.name}" → NO MATCH for "${constraint}"`);
        nonMatchingLeads.push({ ...lead, refine_match: false });
      }
    }
  }

  // Fire cache writes without blocking the response
  Promise.allSettled(cacheWrites).catch(() => {});

  console.log(`[REFINE_LIVE] Complete — fetched=${fetchedCount} matched=${matchingLeads.length}/${leads.length}`);
  return { matchingLeads, nonMatchingLeads, fetchedCount };
}

// ── Cached-artefact helpers ────────────────────────────────────────────────────

function buildPageText(artefact: any): string {
  const pages: any[] = artefact.payloadJson?.outputs?.pages ?? [];
  return pages
    .map((p: any) => (typeof p.text_clean === 'string' ? p.text_clean : ''))
    .join(' ');
}

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

  if (noCachedPages) {
    // ── Live fetch path ──────────────────────────────────────────────────────
    console.log(`[REFINE] No cached pages — fetching homepages live`);

    const liveResult = await liveRefineWithFetch(
      leads, constraint, sourceRunId, runId, userId, conversationId,
    );

    matchingLeads = liveResult.matchingLeads;
    nonMatchingLeads = liveResult.nonMatchingLeads;
    liveFetched = true;

    const leadsWithWebsite = leads.filter(l => !!l.website).length;
    const { fetchedCount } = liveResult;

    if (fetchedCount === 0 && leadsWithWebsite === 0) {
      message = `None of the ${leads.length} results have a website URL, so I couldn't check for "${constraint}".`;
    } else if (fetchedCount === 0) {
      message = `I tried to check the websites live but couldn't load any of them. Would you like me to run a fresh search specifically for "${constraint}"?`;
    } else if (matchingLeads.length === 0) {
      message = `I checked ${fetchedCount} website${fetchedCount !== 1 ? 's' : ''} live — none of the ${leads.length} results mention "${constraint}" on their homepage.`;
    } else {
      message = `I checked ${fetchedCount} website${fetchedCount !== 1 ? 's' : ''} live and found ${matchingLeads.length} of ${leads.length} result${leads.length !== 1 ? 's' : ''} mentioning "${constraint}" on their homepage.`;
    }
  } else {
    // ── Cached artefact path ─────────────────────────────────────────────────
    const cachedToCheck: { lead: RefineLead; fullText: string }[] = [];

    for (const lead of leads) {
      const matchingArtefacts = webVisitArtefacts.filter(a => artefactMatchesLead(a, lead));

      if (matchingArtefacts.length === 0) {
        console.log(`[REFINE] No artefacts matched lead "${lead.name}" — marking unmatched`);
        nonMatchingLeads.push({ ...lead, refine_match: false, reason: 'no_cached_pages' });
        continue;
      }

      const fullText = matchingArtefacts.map(buildPageText).join(' ');
      cachedToCheck.push({ lead, fullText });
    }

    // Run LLM constraint checks in batches of 5 (concurrency limit)
    const CACHED_BATCH_SIZE = 5;
    for (let i = 0; i < cachedToCheck.length; i += CACHED_BATCH_SIZE) {
      const batch = cachedToCheck.slice(i, i + CACHED_BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async ({ lead, fullText }) => {
          const result = await llmCheckConstraint(fullText, lead.name, constraint);
          return { lead, result };
        }),
      );

      for (const settled of batchResults) {
        if (settled.status === 'rejected') {
          console.warn(`[REFINE] LLM check threw: ${settled.reason}`);
          continue;
        }
        const { lead, result } = settled.value;
        if (result.match) {
          console.log(`[REFINE] "${lead.name}" → MATCH for "${constraint}"`);
          matchingLeads.push({ ...lead, refine_match: true, refine_evidence: result.snippet || result.reasoning || '' });
        } else {
          console.log(`[REFINE] "${lead.name}" → NO MATCH for "${constraint}"`);
          nonMatchingLeads.push({ ...lead, refine_match: false });
        }
      }
    }

    if (matchingLeads.length === 0) {
      message = `None of the ${leads.length} results mention "${constraint}" on their websites. This doesn't mean they don't have it — it just wasn't visible on their site. Would you like me to run a fresh search specifically looking for "${constraint}"?`;
    } else {
      message = `Of the ${leads.length} results, ${matchingLeads.length} mention "${constraint}" on their website.`;
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
