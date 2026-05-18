import { getCurrentDatePreamble, getTemporalVerificationRules } from './current-context';
import { storage } from '../storage';
import { createArtefact } from './artefacts';
import { logAFREvent } from './afr-logger';
import { supabase } from '../supabase';
import { executeWebVisit } from './web-visit';
import { extractConstraintLedEvidence, getPageHintsForConstraint, type ConstraintContext, type ConstraintLedExtractionResult } from './constraint-led-extractor';
import { extractStructuredMission } from './mission-extractor';
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
  constraints: ConstraintContext[],
  entityType: string | null,
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

  // Collect page hints across all constraints
  const pageHints = Array.from(new Set(constraints.flatMap(c => getPageHintsForConstraint(c))));

  const withWebsite = leads.filter(l => !!l.website);
  const withoutWebsite = leads.filter(l => !l.website);
  for (const lead of withoutWebsite) {
    nonMatchingLeads.push({ ...lead, refine_match: false, reason: 'no_website' });
  }
  if (withWebsite.length === 0) {
    return { matchingLeads, nonMatchingLeads, fetchedCount: 0 };
  }

  let fetchedCount = 0;
  const cacheWrites: Promise<any>[] = [];
  const BATCH_SIZE = 5;

  // ── gpt4o_primary mode: skip crawl, use GPT-4o verification on each constraint ──
  if (EVIDENCE_MODE === 'gpt4o_primary') {
    console.log(`[REFINE_LIVE] EVIDENCE_MODE=gpt4o_primary — verifying ${withWebsite.length} leads against ${constraints.length} constraint(s)`);

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

    const missionStyleConstraints = constraints.map(c => ({
      type: c.type as any,
      field: c.field,
      operator: c.operator as any,
      value: c.value,
      hardness: c.hardness as any,
      synonyms: c.synonyms,
      reasoning_mode: c.reasoning_mode,
    }));

    const location = (withWebsite[0]?.address || '').replace(/,\s*UK$/i, '').split(',').pop()?.trim() || 'UK';
    const constraintSummary = constraints.map(c => c.value).filter(Boolean).join(' AND ');

    const gpt4oResults = await batchGpt4oVerification(
      discoveredLeads, missionStyleConstraints, location, constraintSummary,
      runId, userId, conversationId,
    );

    for (let i = 0; i < withWebsite.length; i++) {
      const lead = withWebsite[i];
      const leadResults = gpt4oResults.filter(r => r.leadIndex === i);
      // Lead must satisfy every constraint that had a verification
      const verified = leadResults.length > 0 && leadResults.every(r => r.evidenceFound);
      if (verified) {
        const evidenceBits = leadResults
          .map(r => r.snippets?.[0] || r.towerReasoning || '')
          .filter(Boolean);
        matchingLeads.push({
          ...lead,
          refine_match: true,
          refine_evidence: evidenceBits.join(' | ') || 'Verified via web search',
        });
      } else {
        nonMatchingLeads.push({ ...lead, refine_match: false, reason: 'no_evidence' });
      }
    }

    fetchedCount = withWebsite.length;
    return { matchingLeads, nonMatchingLeads, fetchedCount };
  }

  // ── crawl path: visit websites, run constraint-led extraction per constraint ──
  console.log(`[REFINE_LIVE] Crawling ${withWebsite.length} websites for ${constraints.length} constraint(s)`);

  for (let batchStart = 0; batchStart < withWebsite.length; batchStart += BATCH_SIZE) {
    const batch = withWebsite.slice(batchStart, batchStart + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map(async (lead) => {
        const url = lead.website!;
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
          return { lead, match: false, evidence: '', reason: 'fetch_failed' };
        }
        fetchedCount++;

        // Cache pages under source run
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
          userId, conversationId,
        }).catch((err: any) =>
          console.warn(`[REFINE_LIVE] Cache write failed for "${lead.name}": ${err.message}`),
        );
        cacheWrites.push(cacheWrite);

        // Run every constraint against the lead's pages
        const results = await Promise.all(
          constraints.map(c => extractConstraintLedEvidence(pages, c, [], 3, lead.name, entityType ?? undefined)),
        );

        const hard = constraints.map((c, i) => ({ c, r: results[i] })).filter(x => x.c.hardness === 'hard');
        const allHardMet = hard.length === 0 || hard.every(x => !x.r.no_evidence);

        if (allHardMet) {
          const evidenceBits = results
            .filter(r => !r.no_evidence && r.evidence_items.length > 0)
            .map(r => r.evidence_items[0].direct_quote || r.evidence_items[0].context_snippet || '')
            .filter(Boolean);
          return { lead, match: true, evidence: evidenceBits.join(' | ') || 'verified', reason: '' };
        }
        return { lead, match: false, evidence: '', reason: 'no_evidence' };
      }),
    );

    for (const settled of batchResults) {
      if (settled.status === 'rejected') continue;
      const { lead, match, evidence, reason } = settled.value;
      if (match) {
        matchingLeads.push({ ...lead, refine_match: true, refine_evidence: evidence });
      } else {
        nonMatchingLeads.push({ ...lead, refine_match: false, reason });
      }
    }
  }

  // ── GPT-4o web search fallback for no-evidence leads (covers temporal / status / inferential cases) ──
  const noEvidenceLeads = nonMatchingLeads.filter(l => l.reason === 'no_evidence');
  if (noEvidenceLeads.length > 0 && process.env.OPENAI_API_KEY) {
    const constraintSummary = constraints.map(c => c.value).filter(Boolean).join(' AND ');
    const isTemporal = constraints.some(c =>
      c.type === 'time_constraint' || c.type === 'time_predicate' ||
      /\b(recent|opened|established|new|last\s+\d+\s+months?)\b/i.test(c.value),
    );
    const fallbackModel = isTemporal
      ? (process.env.TEMPORAL_OPENAI_MODEL || 'gpt-4o')
      : (process.env.GPT4O_FALLBACK_MODEL ?? 'gpt-4o-mini');
    const cutoffDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const FALLBACK_BATCH = 5;

    console.log(`[REFINE_FALLBACK] Running GPT-4o web search fallback for ${noEvidenceLeads.length} leads against "${constraintSummary}"`);

    for (let fi = 0; fi < noEvidenceLeads.length; fi += FALLBACK_BATCH) {
      const fbBatch = noEvidenceLeads.slice(fi, fi + FALLBACK_BATCH);
      const fbResults = await Promise.allSettled(
        fbBatch.map(async (lead) => {
          const prompt = `${getCurrentDatePreamble()}\n\n${getTemporalVerificationRules(cutoffDate)}\n\nSearch for "${lead.name}". Determine whether this business genuinely matches: ${constraintSummary}.\n\nRespond with JSON only:\n{"business_found": true/false, "constraint_met": true/false, "confidence": "high"/"medium"/"low", "reasoning": "one sentence"}`;

          const resp = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: fallbackModel, input: prompt, tools: [{ type: 'web_search' }], store: false }),
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
          return { lead, parsed: JSON.parse(jsonMatch[0]) };
        }),
      );

      for (const settled of fbResults) {
        if (settled.status === 'rejected') continue;
        const { lead, parsed } = settled.value;
        if (parsed.business_found && parsed.constraint_met) {
          const idx = nonMatchingLeads.findIndex(l => l.name === lead.name);
          if (idx >= 0) nonMatchingLeads.splice(idx, 1);
          matchingLeads.push({
            ...lead,
            refine_match: true,
            refine_evidence: parsed.reasoning || `Verified via web search (${parsed.confidence})`,
          });
        }
      }
    }
  }

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
  constraint: string,  // user's raw refine message
  runId: string,
  userId: string,
  conversationId: string | undefined,
): Promise<RefineResult> {
  console.log(`[REFINE] Starting — runId=${runId} source=${sourceRunId} userMessage="${constraint}" leads=${leads.length}`);

  // STEP 1: build previous-results context so mission-extractor knows what the user is refining
  const leadSummary = leads
    .slice(0, 10)
    .map((l, i) => `${i + 1}. ${l.name}${l.address ? ` (${l.address.split(',')[0]})` : ''}`)
    .join('\n');
  const conversationContext =
    `The user was just shown ${leads.length} business results. Top results:\n${leadSummary}` +
    `${leads.length > 10 ? `\n... and ${leads.length - 10} more` : ''}\n\n` +
    `The user is now asking a follow-up question to refine these results. Extract the structured constraint they want to apply to the existing list. Ignore entity_category and location_text — the entity and location are already fixed from the previous search.`;

  // STEP 2: run the main pipeline's mission extractor — same one used for fresh searches
  let missionConstraints: ConstraintContext[] = [];
  let entityType: string | null = null;
  let extractorOk = false;

  try {
    const missionResult = await extractStructuredMission(constraint, conversationContext, {
      runId, userId, conversationId,
    });
    if (missionResult.ok && missionResult.mission) {
      entityType = missionResult.mission.entity_category || null;
      const APPLICABLE_TYPES = new Set([
        'website_evidence', 'attribute_check', 'status_check',
        'relationship_check', 'time_constraint', 'time_predicate',
        'text_compare', 'numeric_range',
      ]);
      missionConstraints = missionResult.mission.constraints
        .filter(c => APPLICABLE_TYPES.has(c.type))
        .map(c => ({
          type: c.type,
          field: c.field,
          operator: c.operator,
          value: String(c.value ?? ''),
          hardness: c.hardness,
          synonyms: c.synonyms ?? null,
          reasoning_mode: c.reasoning_mode ?? null,
        }));
      extractorOk = missionConstraints.length > 0;
      console.log(`[REFINE] Mission extracted ${missionConstraints.length} constraint(s): ${missionConstraints.map(c => `${c.type}="${c.value}"(${c.hardness})`).join(', ')}`);
    }
  } catch (err: any) {
    console.warn(`[REFINE] Mission extractor failed: ${err.message}`);
  }

  // STEP 3: if no usable constraint, ask the user to be more specific
  if (!extractorOk) {
    const message =
      `I wasn't sure how you wanted to refine the results. Could you rephrase? ` +
      `For example: "which were established before 2020", "which serve food", "which are still trading".`;
    return {
      message,
      matchingLeads: [],
      nonMatchingLeads: leads.map(l => ({ ...l, refine_match: false as const, reason: 'unclear_refine_intent' })),
      totalChecked: leads.length,
      noCachedPages: false,
      liveFetched: false,
    };
  }

  // STEP 4: apply structured constraints to the existing leads
  const webVisitArtefacts = await fetchWebVisitArtefacts(sourceRunId);
  const noCachedPages = webVisitArtefacts.length === 0;

  let matchingLeads: RefineMatchedLead[] = [];
  let nonMatchingLeads: RefineNonMatchedLead[] = [];
  let liveFetched = false;
  let message: string;

  if (noCachedPages) {
    const liveResult = await liveRefineWithFetch(
      leads, missionConstraints, entityType, sourceRunId, runId, userId, conversationId,
    );
    matchingLeads = liveResult.matchingLeads;
    nonMatchingLeads = liveResult.nonMatchingLeads;
    liveFetched = true;
  } else {
    // cached path — apply each constraint per lead via cached pages
    for (const lead of leads) {
      const matchingArtefacts = webVisitArtefacts.filter(a => artefactMatchesLead(a, lead));
      if (matchingArtefacts.length === 0) {
        nonMatchingLeads.push({ ...lead, refine_match: false, reason: 'no_cached_pages' });
        continue;
      }
      const pages = matchingArtefacts.flatMap(a => a.payloadJson?.outputs?.pages ?? []);

      // Lead must satisfy ALL hard constraints; soft constraints only affect evidence richness
      const constraintResults = await Promise.all(
        missionConstraints.map(c => extractConstraintLedEvidence(pages, c, [], 3, lead.name, entityType ?? undefined)),
      );

      const hardConstraints = missionConstraints.map((c, i) => ({ c, result: constraintResults[i] })).filter(x => x.c.hardness === 'hard');
      const allHardMet = hardConstraints.length === 0 || hardConstraints.every(x => !x.result.no_evidence);

      if (allHardMet) {
        const evidenceBits = constraintResults
          .filter(r => !r.no_evidence && r.evidence_items.length > 0)
          .map(r => r.evidence_items[0].direct_quote || r.evidence_items[0].context_snippet || '')
          .filter(Boolean);
        matchingLeads.push({
          ...lead,
          refine_match: true,
          refine_evidence: evidenceBits.join(' | ') || 'verified',
        });
      } else {
        nonMatchingLeads.push({ ...lead, refine_match: false, reason: 'no_evidence' });
      }
    }
  }

  // STEP 5: humanise constraint summary for the message
  const constraintSummary = missionConstraints
    .map(c => c.value)
    .filter(Boolean)
    .join(' AND ');

  if (matchingLeads.length === 0) {
    message = `I checked ${leads.length} ${liveFetched ? 'website' + (leads.length !== 1 ? 's' : '') : 'cached results'} — none of them appear to match: ${constraintSummary}.`;
  } else {
    const matchNames = matchingLeads.slice(0, 3).map(l => l.name).join(', ');
    const andMore = matchingLeads.length > 3 ? ` and ${matchingLeads.length - 3} more` : '';
    message = `Found ${matchingLeads.length} of ${leads.length} matching ${constraintSummary}: ${matchNames}${andMore}.`;
  }

  console.log(`[REFINE] Complete — matched=${matchingLeads.length}/${leads.length} cached=${!noCachedPages} live=${liveFetched}`);

  await createArtefact({
    runId,
    type: 'refine_results',
    title: `Refinement: "${constraintSummary}" — ${matchingLeads.length}/${leads.length} matched`,
    summary: message,
    payload: {
      constraint,
      structured_constraints: missionConstraints,
      entity_type: entityType,
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
    userId, runId, conversationId,
    actionTaken: 'refine_completed',
    status: 'success',
    taskGenerated: message,
    runType: 'plan',
    metadata: {
      constraint,
      structured_constraints: missionConstraints,
      source_run_id: sourceRunId,
      total_checked: leads.length,
      matches: matchingLeads.length,
      no_cached_pages: noCachedPages,
      live_fetched: liveFetched,
    },
  }).catch(() => {});

  return { message, matchingLeads, nonMatchingLeads, totalChecked: leads.length, noCachedPages, liveFetched };
}
