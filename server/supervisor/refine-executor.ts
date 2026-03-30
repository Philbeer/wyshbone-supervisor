import { storage } from '../storage';
import { createArtefact } from './artefacts';
import { logAFREvent } from './afr-logger';
import { supabase } from '../supabase';

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
}

function extractDomain(url: string): string {
  try {
    return url.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  } catch {
    return '';
  }
}

function checkConstraint(
  pageText: string,
  constraint: string,
): { match: boolean; snippet?: string } {
  const text = pageText.toLowerCase();
  const words = constraint.toLowerCase().split(/\s+/).filter(Boolean);

  const allPresent = words.every(w => text.includes(w));
  if (!allPresent) return { match: false };

  const idx = text.indexOf(words[0]);
  const start = Math.max(0, idx - 100);
  const end = Math.min(text.length, idx + 200);
  const snippet = pageText.substring(start, end).trim();
  return { match: true, snippet: `...${snippet}...` };
}

function normalizeArtefact(raw: any): any {
  return {
    ...raw,
    payloadJson: raw.payloadJson ?? raw.payload_json ?? null,
    runId: raw.runId ?? raw.run_id ?? '',
    title: raw.title ?? '',
  };
}

// Internal helper — query web_visit_pages artefacts for a specific, already-resolved run_id.
// Does NOT do ID resolution (avoids recursion). Used by fetchWebVisitArtefacts.
async function queryWebVisitsByRunId(runId: string): Promise<any[]> {
  // ── 1. Try local Drizzle DB ────────────────────────────────────────────────
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

  // ── 2. Supabase REST fallback ──────────────────────────────────────────────
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

  // ── Primary lookup: treat source_run_id as agent_runs.id ──────────────────
  const primaryResults = await queryWebVisitsByRunId(sourceRunId);
  if (primaryResults.length > 0) return primaryResults;

  // ── Fallback: source_run_id might actually be a client_request_id ─────────
  // This happens when the UI passes the clientRequestId instead of the actual
  // run UUID. Resolve via agent_runs table and retry.
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
      console.log(`[REFINE_LOOKUP] No client_request_id match found for "${sourceRunId}" — confirmed empty`);
      return [];
    }

    console.log(`[REFINE_LOOKUP] Resolved client_request_id "${sourceRunId}" → run_id="${runRow.id}"`);
    return queryWebVisitsByRunId(runRow.id);
  } catch (err: any) {
    console.warn(`[REFINE_LOOKUP] client_request_id resolution error: ${err.message}`);
    return [];
  }
}

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

  if (noCachedPages) {
    console.log(`[REFINE] No cached web pages found for source run ${sourceRunId}`);
  }

  const matchingLeads: RefineMatchedLead[] = [];
  const nonMatchingLeads: RefineNonMatchedLead[] = [];

  for (const lead of leads) {
    if (noCachedPages) {
      nonMatchingLeads.push({ ...lead, refine_match: false, reason: 'no_cached_pages' });
      continue;
    }

    const matchingArtefacts = webVisitArtefacts.filter(a => artefactMatchesLead(a, lead));

    if (matchingArtefacts.length === 0) {
      console.log(`[REFINE] No artefacts matched lead "${lead.name}" — marking unmatched`);
      nonMatchingLeads.push({ ...lead, refine_match: false, reason: 'no_cached_pages' });
      continue;
    }

    const fullText = matchingArtefacts.map(buildPageText).join(' ');
    const result = checkConstraint(fullText, constraint);

    if (result.match) {
      console.log(`[REFINE] "${lead.name}" → MATCH for "${constraint}"`);
      matchingLeads.push({ ...lead, refine_match: true, refine_evidence: result.snippet ?? '' });
    } else {
      console.log(`[REFINE] "${lead.name}" → NO MATCH for "${constraint}"`);
      nonMatchingLeads.push({ ...lead, refine_match: false });
    }
  }

  let message: string;
  if (noCachedPages) {
    message = `I don't have cached website data from that search. Would you like me to run a new search with "${constraint}" included as a requirement?`;
  } else if (matchingLeads.length === 0) {
    message = `None of the ${leads.length} results mention "${constraint}" on their websites. This doesn't mean they don't have it — it just wasn't visible on their site. Would you like me to run a fresh search specifically looking for "${constraint}"?`;
  } else {
    message = `Of the ${leads.length} results, ${matchingLeads.length} mention "${constraint}" on their website.`;
  }

  console.log(`[REFINE] Complete — matched=${matchingLeads.length}/${leads.length} cached=${!noCachedPages}`);

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
    },
  }).catch(() => {});

  return { message, matchingLeads, nonMatchingLeads, totalChecked: leads.length, noCachedPages };
}
