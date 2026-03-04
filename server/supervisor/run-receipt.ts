import { storage } from '../storage';
import { createArtefact } from './artefacts';

export interface DeliveredLeadRef {
  name: string;
  place_id: string;
}

export interface AttributeEvidenceRef {
  place_id: string;
  url: string;
  snippet?: string;
  matched_variant?: string;
}

export interface AttributeOutcome {
  attribute_raw: string;
  matched_count: number;
  matched_place_ids: string[];
  unknown_count: number;
  evidence_refs: AttributeEvidenceRef[];
}

export interface RunReceiptPayload {
  run_id: string;
  goal: string | null;
  mission_type: string;
  created_at: string;

  requested_count: number | null;
  delivered_count: number;
  candidate_count_from_google: number;
  plan_versions_used: number;
  replans_used: number;

  delivered_leads: DeliveredLeadRef[];

  websites_checked_count: number;
  website_missing_count: number;
  contact_extraction_attempted_count: number;

  contacts_proven: boolean;
  contact_sources_used: string[];
  unique_email_count: number | null;
  unique_phone_count: number | null;
  email_list_sample: string[];
  phone_list_sample: string[];

  outcomes?: {
    attributes: AttributeOutcome[];
  };

  narrative_lines: string[];

  debug: {
    counting_method: string;
    artefact_ids_used: {
      lead_pack: string[];
      contact_extract: string[];
      attribute_evidence: string[];
    };
    notes: string[];
  };
}

export interface BuildRunReceiptInput {
  runId: string;
  userId: string;
  conversationId?: string;
  goal: string | null;
  businessType: string;
  location: string;
  requestedCount: number | null;
  deliveredLeads: Array<{ name: string; placeId: string; website: string | null }>;
  candidateCountFromGoogle: number;
  planVersionsUsed: number;
  replansUsed: number;
}

function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function normalisePhone(raw: string): string {
  return raw.replace(/[\s\-\(\)\.]/g, '');
}

function matchesDeliveredLead(
  artefactTitle: string,
  artefactPayload: any,
  deliveredLeads: Array<{ name: string; placeId: string }>,
): boolean {
  const placeId =
    artefactPayload?.outputs?.lead_pack?.identity?.place_id ||
    artefactPayload?.inputs?.places_lead?.place_id ||
    artefactPayload?.place_id ||
    null;
  if (placeId && deliveredLeads.some(dl => dl.placeId === placeId)) return true;

  const leadName =
    artefactPayload?.outputs?.lead_pack?.identity?.name ||
    artefactPayload?.inputs?.places_lead?.name ||
    artefactPayload?.lead_name ||
    null;
  if (leadName) {
    const norm = leadName.trim().toLowerCase();
    if (deliveredLeads.some(dl => dl.name.trim().toLowerCase() === norm)) return true;
  }

  for (const dl of deliveredLeads) {
    if (artefactTitle && artefactTitle.includes(dl.name)) return true;
  }

  return false;
}

export function buildRunReceiptFromArtefacts(
  input: BuildRunReceiptInput,
  allArtefacts: Array<{ id: string; type: string; title: string; payloadJson: any }>,
): RunReceiptPayload {
  const deliveredLeadRefs: DeliveredLeadRef[] = input.deliveredLeads.map(l => ({
    name: l.name,
    place_id: l.placeId,
  }));

  const leadPackArtefacts = allArtefacts.filter(a => a.type === 'lead_pack');
  const contactExtractArtefacts = allArtefacts.filter(a => a.type === 'contact_extract');

  const stepResultContactExtracts = allArtefacts.filter(a => {
    if (a.type !== 'step_result') return false;
    const p = a.payloadJson as any;
    return p?.step_type === 'CONTACT_EXTRACT';
  });

  const allContactExtractArtefacts = [...contactExtractArtefacts, ...stepResultContactExtracts];

  const matchedLeadPacks = leadPackArtefacts.filter(a =>
    matchesDeliveredLead(a.title, a.payloadJson, input.deliveredLeads),
  );
  const matchedContactExtracts = allContactExtractArtefacts.filter(a => {
    const p = a.payloadJson as any;
    if (matchesDeliveredLead(a.title, p, input.deliveredLeads)) return true;
    const parentStepTitle = p?.step_title || a.title || '';
    for (const dl of input.deliveredLeads) {
      if (parentStepTitle.includes(dl.name)) return true;
    }
    if (p?.lead_place_id && input.deliveredLeads.some(dl => dl.placeId === p.lead_place_id)) return true;
    if (p?.lead_name) {
      const norm = p.lead_name.trim().toLowerCase();
      if (input.deliveredLeads.some(dl => dl.name.trim().toLowerCase() === norm)) return true;
    }
    return false;
  });

  const websitesChecked = input.deliveredLeads.filter(l => l.website).length;
  const websiteMissing = input.deliveredLeads.filter(l => !l.website).length;
  const contactExtractionAttempted = matchedContactExtracts.length;

  const uniqueEmails = new Set<string>();
  const uniquePhones = new Set<string>();
  const contactSourcesUsed: Set<string> = new Set();
  const notes: string[] = [];

  for (const ce of matchedContactExtracts) {
    const p = ce.payloadJson as any;
    const contacts = p?.outputs?.contacts || p?.contacts || p?.contact_extract_outputs?.contacts;
    if (contacts?.emails) {
      contactSourcesUsed.add('contact_extract');
      for (const e of contacts.emails) {
        if (e && typeof e === 'string' && e.trim()) uniqueEmails.add(normaliseEmail(e));
      }
    }
    if (contacts?.phones) {
      contactSourcesUsed.add('contact_extract');
      for (const ph of contacts.phones) {
        if (ph && typeof ph === 'string' && ph.trim()) uniquePhones.add(normalisePhone(ph));
      }
    }
  }

  for (const lp of matchedLeadPacks) {
    const p = lp.payloadJson as any;
    const contacts = p?.outputs?.lead_pack?.contacts || p?.lead_pack?.contacts;
    if (contacts?.emails) {
      contactSourcesUsed.add('lead_pack');
      for (const e of contacts.emails) {
        const val = e?.value || (typeof e === 'string' ? e : null);
        if (val && val.trim()) uniqueEmails.add(normaliseEmail(val));
      }
    }
    if (contacts?.phones) {
      contactSourcesUsed.add('lead_pack');
      for (const ph of contacts.phones) {
        const val = ph?.value || (typeof ph === 'string' ? ph : null);
        if (val && val.trim()) uniquePhones.add(normalisePhone(val));
      }
    }
  }

  const hasMatchedArtefacts = matchedLeadPacks.length > 0 || matchedContactExtracts.length > 0;
  const hasAnyContact = uniqueEmails.size > 0 || uniquePhones.size > 0;
  const contactsProven = hasMatchedArtefacts && hasAnyContact;

  if (!hasMatchedArtefacts) {
    notes.push('No contact artefacts could be matched to delivered leads — counts marked as unproven.');
  } else if (!hasAnyContact) {
    notes.push('Contact artefacts matched but contained no emails or phones — counts marked as unproven to avoid false zero claims.');
  }

  const emailCount = contactsProven ? uniqueEmails.size : null;
  const phoneCount = contactsProven ? uniquePhones.size : null;

  const attributeEvidenceArtefacts = allArtefacts.filter(a => a.type === 'attribute_evidence');
  const attributeVerificationArtefacts = allArtefacts.filter(a => a.type === 'attribute_verification');

  const deliveredPlaceIds = new Set(input.deliveredLeads.map(dl => dl.placeId));

  const attrOutcomeMap = new Map<string, {
    matched_place_ids: Set<string>;
    unknown_count: number;
    evidence_refs: AttributeEvidenceRef[];
  }>();

  for (const ae of attributeEvidenceArtefacts) {
    const p = ae.payloadJson as any;
    const attrRaw: string = p?.attribute_raw || p?.attribute_label || '';
    const placeId: string = p?.lead_place_id || '';
    const verdict: string = p?.verdict || 'unknown';

    if (!attrRaw || !placeId || !deliveredPlaceIds.has(placeId)) continue;

    const key = attrRaw.toLowerCase();
    if (!attrOutcomeMap.has(key)) {
      attrOutcomeMap.set(key, { matched_place_ids: new Set(), unknown_count: 0, evidence_refs: [] });
    }
    const entry = attrOutcomeMap.get(key)!;

    if (verdict === 'yes') {
      const sourceUrl = p?.evidence?.source_url || '';
      if (sourceUrl) {
        entry.matched_place_ids.add(placeId);
        entry.evidence_refs.push({
          place_id: placeId,
          url: sourceUrl,
          ...(p?.evidence?.quote ? { snippet: String(p.evidence.quote).substring(0, 300) } : {}),
          ...(p?.matched_variant ? { matched_variant: p.matched_variant } : {}),
        });
      } else {
        entry.unknown_count++;
      }
    } else {
      entry.unknown_count++;
    }
  }

  if (attrOutcomeMap.size === 0) {
    for (const av of attributeVerificationArtefacts) {
      const p = av.payloadJson as any;
      const results: any[] = p?.results || [];
      for (const r of results) {
        const attrRaw: string = r?.attribute_raw || r?.attribute || '';
        const placeId: string = r?.lead_place_id || '';
        if (!attrRaw || !placeId || !deliveredPlaceIds.has(placeId)) continue;

        const key = attrRaw.toLowerCase();
        if (!attrOutcomeMap.has(key)) {
          attrOutcomeMap.set(key, { matched_place_ids: new Set(), unknown_count: 0, evidence_refs: [] });
        }
        const entry = attrOutcomeMap.get(key)!;

        if (r?.attribute_found && r?.url_visited) {
          entry.matched_place_ids.add(placeId);
          const snippet = Array.isArray(r?.snippets) && r.snippets.length > 0 ? String(r.snippets[0]).substring(0, 300) : undefined;
          entry.evidence_refs.push({
            place_id: placeId,
            url: r.url_visited,
            ...(snippet ? { snippet } : {}),
            ...(r?.matched_variant ? { matched_variant: r.matched_variant } : {}),
          });
        } else {
          entry.unknown_count++;
        }
      }
    }
  }

  const attributeOutcomes: AttributeOutcome[] = [];
  for (const [key, entry] of attrOutcomeMap) {
    const firstArtefact = attributeEvidenceArtefacts.find(a => {
      const p = a.payloadJson as any;
      return (p?.attribute_raw || p?.attribute_label || '').toLowerCase() === key;
    });
    const rawLabel = (firstArtefact?.payloadJson as any)?.attribute_raw || key;

    attributeOutcomes.push({
      attribute_raw: rawLabel,
      matched_count: entry.matched_place_ids.size,
      matched_place_ids: Array.from(entry.matched_place_ids),
      unknown_count: entry.unknown_count,
      evidence_refs: entry.evidence_refs,
    });
  }

  const narrativeLines = buildNarrativeLines({
    businessType: input.businessType,
    location: input.location,
    candidateCount: input.candidateCountFromGoogle,
    deliveredCount: input.deliveredLeads.length,
    requestedCount: input.requestedCount,
    websitesChecked,
    contactsProven,
    emailCount,
    phoneCount,
    attributeOutcomes,
  });

  const result: RunReceiptPayload = {
    run_id: input.runId,
    goal: input.goal,
    mission_type: 'leadgen',
    created_at: new Date().toISOString(),

    requested_count: input.requestedCount,
    delivered_count: input.deliveredLeads.length,
    candidate_count_from_google: input.candidateCountFromGoogle,
    plan_versions_used: input.planVersionsUsed,
    replans_used: input.replansUsed,

    delivered_leads: deliveredLeadRefs,

    websites_checked_count: websitesChecked,
    website_missing_count: websiteMissing,
    contact_extraction_attempted_count: contactExtractionAttempted,

    contacts_proven: contactsProven,
    contact_sources_used: Array.from(contactSourcesUsed),
    unique_email_count: emailCount,
    unique_phone_count: phoneCount,
    email_list_sample: contactsProven ? Array.from(uniqueEmails) : [],
    phone_list_sample: contactsProven ? Array.from(uniquePhones) : [],

    narrative_lines: narrativeLines,

    debug: {
      counting_method: 'Matched lead_pack and contact_extract artefacts to delivered leads by place_id, then by normalised name, then by artefact title substring. Emails extracted from contact_extract.outputs.contacts.emails (string[]) and lead_pack.outputs.lead_pack.contacts.emails[*].value. Phones extracted similarly. De-duplicated after normalisation. Attribute outcomes from attribute_evidence artefacts (verdict=yes with source_url → matched, else unknown).',
      artefact_ids_used: {
        lead_pack: matchedLeadPacks.map(a => a.id),
        contact_extract: matchedContactExtracts.map(a => a.id),
        attribute_evidence: attributeEvidenceArtefacts.filter(a => {
          const p = a.payloadJson as any;
          return deliveredPlaceIds.has(p?.lead_place_id || '');
        }).map(a => a.id),
      },
      notes,
    },
  };

  if (attributeOutcomes.length > 0) {
    result.outcomes = { attributes: attributeOutcomes };
  }

  return result;
}

function buildNarrativeLines(ctx: {
  businessType: string;
  location: string;
  candidateCount: number;
  deliveredCount: number;
  requestedCount: number | null;
  websitesChecked: number;
  contactsProven: boolean;
  emailCount: number | null;
  phoneCount: number | null;
  attributeOutcomes?: AttributeOutcome[];
}): string[] {
  const lines: string[] = [];

  lines.push(
    `I searched Google Places for ${ctx.businessType} in ${ctx.location} and found ${ctx.candidateCount} candidates.`,
  );

  if (ctx.requestedCount !== null) {
    lines.push(`You asked for ${ctx.requestedCount} and I delivered ${ctx.deliveredCount}.`);
  } else {
    lines.push(`I delivered ${ctx.deliveredCount} results.`);
  }

  if (ctx.websitesChecked > 0) {
    lines.push(
      `I checked the websites of ${ctx.websitesChecked} of the ${ctx.deliveredCount} delivered ${ctx.businessType} for contact details.`,
    );
  }

  if (ctx.contactsProven && ctx.emailCount !== null && ctx.phoneCount !== null) {
    const emailPart = ctx.emailCount > 0 ? `${ctx.emailCount} public email${ctx.emailCount !== 1 ? 's' : ''}` : 'no public emails';
    const phonePart = ctx.phoneCount > 0 ? `${ctx.phoneCount} phone number${ctx.phoneCount !== 1 ? 's' : ''}` : 'no phone numbers';
    lines.push(`I found ${emailPart} and ${phonePart} from those websites.`);
  } else {
    lines.push('Contact details varied by venue.');
  }

  if (ctx.attributeOutcomes && ctx.attributeOutcomes.length > 0) {
    for (const ao of ctx.attributeOutcomes) {
      if (ao.matched_count > 0) {
        lines.push(`I verified ${ao.matched_count} of the ${ctx.deliveredCount} ${ctx.businessType} mention "${ao.attribute_raw}" on their website.`);
      } else {
        lines.push(`I could not verify "${ao.attribute_raw}" from any of the websites checked.`);
      }
    }
  }

  return lines;
}

export async function emitRunReceipt(input: BuildRunReceiptInput): Promise<RunReceiptPayload> {
  const allArtefacts = await storage.getArtefactsByRunId(input.runId);

  const mapped = allArtefacts.map(a => ({
    id: a.id,
    type: a.type,
    title: a.title,
    payloadJson: a.payloadJson,
  }));

  const payload = buildRunReceiptFromArtefacts(input, mapped);

  const titleLocation = input.location || 'unknown location';
  const titleCount = input.requestedCount !== null ? ` (${input.requestedCount} requested)` : '';
  const title = `Run receipt: ${input.businessType} in ${titleLocation}${titleCount}`;

  await createArtefact({
    runId: input.runId,
    type: 'run_receipt',
    title,
    summary: `Delivered ${payload.delivered_count} | emails=${payload.unique_email_count ?? '?'} | phones=${payload.unique_phone_count ?? '?'} | proven=${payload.contacts_proven}`,
    payload: payload as unknown as Record<string, unknown>,
    userId: input.userId,
    conversationId: input.conversationId,
  });

  console.log(
    `[RUN_RECEIPT] runId=${input.runId} delivered=${payload.delivered_count} emails=${payload.unique_email_count} phones=${payload.unique_phone_count} proven=${payload.contacts_proven}`,
  );

  return payload;
}
