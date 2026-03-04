import { describe, it, expect } from 'vitest';
import { buildRunReceiptFromArtefacts, type BuildRunReceiptInput } from './run-receipt';

function makeInput(overrides?: Partial<BuildRunReceiptInput>): BuildRunReceiptInput {
  return {
    runId: 'run-001',
    userId: 'user-001',
    conversationId: 'conv-001',
    goal: 'Find 10 pubs in Arundel and include email',
    businessType: 'pubs',
    location: 'Arundel',
    requestedCount: 10,
    deliveredLeads: [
      { name: 'The Red Lion', placeId: 'place_1', website: 'https://redlion.co.uk' },
      { name: 'The Black Rabbit', placeId: 'place_2', website: 'https://blackrabbit.co.uk' },
      { name: 'The Kings Arms', placeId: 'place_3', website: null },
      { name: 'The White Hart', placeId: 'place_4', website: null },
      { name: 'George & Dragon', placeId: 'place_5', website: 'https://georgedragon.co.uk' },
      { name: "The St Mary's Gate Inn", placeId: 'place_6', website: 'https://stmarysgate.co.uk' },
      { name: 'The Old Stables', placeId: 'place_7', website: 'https://oldstables.co.uk' },
      { name: 'The Bridge Inn', placeId: 'place_8', website: 'https://bridgeinn.co.uk' },
      { name: "The World's End", placeId: 'place_9', website: 'https://worldsend.co.uk' },
      { name: 'The White Swan', placeId: 'place_10', website: 'https://whiteswan.co.uk' },
    ],
    candidateCountFromGoogle: 30,
    planVersionsUsed: 1,
    replansUsed: 0,
    ...overrides,
  };
}

function makeLeadPackArtefact(id: string, name: string, placeId: string, emails: string[], phones: string[]) {
  return {
    id,
    type: 'lead_pack' as const,
    title: `LEAD_ENRICH: ${name}`,
    payloadJson: {
      outputs: {
        lead_pack: {
          identity: { name, place_id: placeId },
          contacts: {
            emails: emails.map(e => ({ value: e, verified: true, source_type: 'official_site', evidence: [] })),
            phones: phones.map(p => ({ value: p, verified: true, source_type: 'official_site', evidence: [] })),
          },
        },
      },
    },
  };
}

function makeContactExtractArtefact(id: string, name: string, emails: string[], phones: string[]) {
  return {
    id,
    type: 'contact_extract' as const,
    title: `CONTACT_EXTRACT: ${name}`,
    payloadJson: {
      outputs: {
        contacts: {
          emails,
          phones,
        },
      },
    },
  };
}

function makeStepResultContactExtract(id: string, name: string, placeId: string, emails: string[], phones: string[]) {
  return {
    id,
    type: 'step_result' as const,
    title: `Step result: CONTACT_EXTRACT – "${name}"`,
    payloadJson: {
      step_type: 'CONTACT_EXTRACT',
      step_title: `CONTACT_EXTRACT – ${name}`,
      lead_place_id: placeId,
      lead_name: name,
      contact_extract_outputs: {
        contacts: {
          emails,
          phones,
        },
      },
    },
  };
}

describe('buildRunReceiptFromArtefacts', () => {
  it('produces correct proven counts with matched contact artefacts', () => {
    const input = makeInput();
    const artefacts = [
      makeLeadPackArtefact('lp1', 'The Red Lion', 'place_1', ['admin@redlion.co.uk'], ['01903 882214']),
      makeLeadPackArtefact('lp2', 'The Black Rabbit', 'place_2', [], ['01903 882638']),
      makeLeadPackArtefact('lp3', 'George & Dragon', 'place_5', ['info@georgedragon.co.uk'], ['01798 831559']),
      makeLeadPackArtefact('lp4', "The St Mary's Gate Inn", 'place_6', ['info@stmarysgate.co.uk'], ['01903 883145']),
      makeLeadPackArtefact('lp5', 'The Old Stables', 'place_7', [], ['01243 543082']),
      makeLeadPackArtefact('lp6', 'The Bridge Inn', 'place_8', ['bridge@btinternet.com'], ['01798 831619']),
      makeLeadPackArtefact('lp7', "The World's End", 'place_9', [], ['01903 871346']),
      makeLeadPackArtefact('lp8', 'The White Swan', 'place_10', [], ['01903 882677']),
      makeLeadPackArtefact('lp9', 'The Kings Arms', 'place_3', ['info@kingsarms.co.uk'], []),
      makeContactExtractArtefact('ce1', 'The Red Lion', ['admin@redlion.co.uk'], ['01903 882214']),
      makeContactExtractArtefact('ce2', 'The Black Rabbit', [], ['01903 882638']),
      makeContactExtractArtefact('ce3', 'George & Dragon', ['info@georgedragon.co.uk'], ['01798 831559']),
      makeContactExtractArtefact('ce4', "The St Mary's Gate Inn", ['info@stmarysgate.co.uk'], ['01903 883145']),
      makeContactExtractArtefact('ce5', 'The Old Stables', [], ['01243 543082']),
      makeContactExtractArtefact('ce6', 'The Bridge Inn', ['bridge@btinternet.com'], ['01798 831619']),
      makeContactExtractArtefact('ce7', "The World's End", [], ['01903 871346']),
      makeContactExtractArtefact('ce8', 'The White Swan', [], ['01903 882677']),
      makeContactExtractArtefact('ce9', 'The Kings Arms', ['info@kingsarms.co.uk'], []),
    ];

    const receipt = buildRunReceiptFromArtefacts(input, artefacts);

    expect(receipt.contacts_proven).toBe(true);
    expect(receipt.unique_email_count).toBe(5);
    expect(receipt.unique_phone_count).toBe(8);
    expect(receipt.delivered_count).toBe(10);
    expect(receipt.requested_count).toBe(10);
    expect(receipt.candidate_count_from_google).toBe(30);
    expect(receipt.websites_checked_count).toBe(8);
    expect(receipt.website_missing_count).toBe(2);
    expect(receipt.contact_extraction_attempted_count).toBe(9);
    expect(receipt.contact_sources_used).toContain('lead_pack');
    expect(receipt.contact_sources_used).toContain('contact_extract');
    expect(receipt.email_list_sample).toHaveLength(5);
    expect(receipt.phone_list_sample).toHaveLength(8);
    expect(receipt.debug.artefact_ids_used.lead_pack).toHaveLength(9);
    expect(receipt.debug.artefact_ids_used.contact_extract).toHaveLength(9);

    expect(receipt.narrative_lines.length).toBeGreaterThanOrEqual(3);
    expect(receipt.narrative_lines.some(l => l.includes('5 public emails'))).toBe(true);
    expect(receipt.narrative_lines.some(l => l.includes('8 phone numbers'))).toBe(true);
    expect(receipt.narrative_lines.every(l => !l.includes('artefact'))).toBe(true);
    expect(receipt.narrative_lines.every(l => !l.includes('Tower'))).toBe(true);
  });

  it('excludes contacts from non-delivered leads', () => {
    const input = makeInput({
      deliveredLeads: [
        { name: 'The Red Lion', placeId: 'place_1', website: 'https://redlion.co.uk' },
      ],
    });
    const artefacts = [
      makeLeadPackArtefact('lp1', 'The Red Lion', 'place_1', ['admin@redlion.co.uk'], ['01903 882214']),
      makeLeadPackArtefact('lp2', 'Some Other Pub', 'place_999', ['other@pub.co.uk'], ['01234 567890']),
      makeContactExtractArtefact('ce1', 'The Red Lion', ['admin@redlion.co.uk'], ['01903 882214']),
      makeContactExtractArtefact('ce2', 'Some Other Pub', ['other@pub.co.uk'], ['01234 567890']),
    ];

    const receipt = buildRunReceiptFromArtefacts(input, artefacts);

    expect(receipt.contacts_proven).toBe(true);
    expect(receipt.unique_email_count).toBe(1);
    expect(receipt.unique_phone_count).toBe(1);
    expect(receipt.email_list_sample).toEqual(['admin@redlion.co.uk']);
  });

  it('marks contacts_proven=false when no contact artefacts match', () => {
    const input = makeInput();
    const artefacts: any[] = [];

    const receipt = buildRunReceiptFromArtefacts(input, artefacts);

    expect(receipt.contacts_proven).toBe(false);
    expect(receipt.unique_email_count).toBeNull();
    expect(receipt.unique_phone_count).toBeNull();
    expect(receipt.email_list_sample).toEqual([]);
    expect(receipt.phone_list_sample).toEqual([]);
    expect(receipt.narrative_lines.some(l => l.includes('Contact details varied by venue'))).toBe(true);
    expect(receipt.narrative_lines.every(l => !l.includes('0 public emails'))).toBe(true);
    expect(receipt.debug.notes.length).toBeGreaterThan(0);
  });

  it('marks contacts_proven=false when artefacts match but contain no contacts', () => {
    const input = makeInput({
      deliveredLeads: [
        { name: 'The Red Lion', placeId: 'place_1', website: 'https://redlion.co.uk' },
      ],
    });
    const artefacts = [
      makeLeadPackArtefact('lp1', 'The Red Lion', 'place_1', [], []),
      makeContactExtractArtefact('ce1', 'The Red Lion', [], []),
    ];

    const receipt = buildRunReceiptFromArtefacts(input, artefacts);

    expect(receipt.contacts_proven).toBe(false);
    expect(receipt.unique_email_count).toBeNull();
    expect(receipt.unique_phone_count).toBeNull();
    expect(receipt.narrative_lines.some(l => l.includes('Contact details varied by venue'))).toBe(true);
    expect(receipt.debug.notes.some(n => n.includes('no emails or phones'))).toBe(true);
  });

  it('deduplicates emails and phones across artefact types', () => {
    const input = makeInput({
      deliveredLeads: [
        { name: 'The Red Lion', placeId: 'place_1', website: 'https://redlion.co.uk' },
      ],
    });
    const artefacts = [
      makeLeadPackArtefact('lp1', 'The Red Lion', 'place_1', ['Admin@RedLion.co.uk'], ['01903 882214']),
      makeContactExtractArtefact('ce1', 'The Red Lion', ['admin@redlion.co.uk'], ['01903 882 214']),
    ];

    const receipt = buildRunReceiptFromArtefacts(input, artefacts);

    expect(receipt.unique_email_count).toBe(1);
    expect(receipt.unique_phone_count).toBe(1);
  });

  it('handles null requestedCount correctly', () => {
    const input = makeInput({ requestedCount: null });
    const artefacts: any[] = [];
    const receipt = buildRunReceiptFromArtefacts(input, artefacts);

    expect(receipt.requested_count).toBeNull();
    expect(receipt.narrative_lines.some(l => l.includes('delivered 10 results'))).toBe(true);
    expect(receipt.narrative_lines.every(l => !l.includes('asked for'))).toBe(true);
  });

  it('includes correct identity fields', () => {
    const input = makeInput();
    const receipt = buildRunReceiptFromArtefacts(input, []);

    expect(receipt.run_id).toBe('run-001');
    expect(receipt.goal).toBe('Find 10 pubs in Arundel and include email');
    expect(receipt.mission_type).toBe('leadgen');
    expect(receipt.created_at).toBeTruthy();
    expect(receipt.plan_versions_used).toBe(1);
    expect(receipt.replans_used).toBe(0);
    expect(receipt.delivered_leads).toHaveLength(10);
    expect(receipt.delivered_leads[0]).toEqual({ name: 'The Red Lion', place_id: 'place_1' });
  });

  it('detects CONTACT_EXTRACT from step_result artefacts (production format)', () => {
    const input = makeInput({
      deliveredLeads: [
        { name: 'The Red Lion', placeId: 'place_1', website: 'https://redlion.co.uk' },
        { name: 'The Black Rabbit', placeId: 'place_2', website: 'https://blackrabbit.co.uk' },
        { name: 'The Kings Arms', placeId: 'place_3', website: null },
      ],
    });
    const artefacts = [
      makeLeadPackArtefact('lp1', 'The Red Lion', 'place_1', ['admin@redlion.co.uk'], ['01903 882214']),
      makeLeadPackArtefact('lp2', 'The Black Rabbit', 'place_2', [], []),
      makeStepResultContactExtract('sr-ce1', 'The Red Lion', 'place_1', ['admin@redlion.co.uk'], ['01903 882214']),
      makeStepResultContactExtract('sr-ce2', 'The Black Rabbit', 'place_2', ['info@blackrabbit.co.uk'], ['01903 882638']),
    ];

    const receipt = buildRunReceiptFromArtefacts(input, artefacts);

    expect(receipt.contact_extraction_attempted_count).toBe(2);
    expect(receipt.contact_sources_used).toContain('contact_extract');
    expect(receipt.contact_sources_used).toContain('lead_pack');
    expect(receipt.contacts_proven).toBe(true);
    expect(receipt.unique_email_count).toBe(2);
    expect(receipt.unique_phone_count).toBe(2);
    expect(receipt.debug.artefact_ids_used.contact_extract).toEqual(['sr-ce1', 'sr-ce2']);
  });

  it('handles mixed contact_extract and step_result artefact types', () => {
    const input = makeInput({
      deliveredLeads: [
        { name: 'The Red Lion', placeId: 'place_1', website: 'https://redlion.co.uk' },
        { name: 'The Black Rabbit', placeId: 'place_2', website: 'https://blackrabbit.co.uk' },
      ],
    });
    const artefacts = [
      makeContactExtractArtefact('ce1', 'The Red Lion', ['admin@redlion.co.uk'], []),
      makeStepResultContactExtract('sr-ce1', 'The Black Rabbit', 'place_2', ['info@blackrabbit.co.uk'], ['01903 882638']),
    ];

    const receipt = buildRunReceiptFromArtefacts(input, artefacts);

    expect(receipt.contact_extraction_attempted_count).toBe(2);
    expect(receipt.contacts_proven).toBe(true);
    expect(receipt.unique_email_count).toBe(2);
    expect(receipt.unique_phone_count).toBe(1);
  });

  it('counts step_result CONTACT_EXTRACT as attempted even when no contacts found', () => {
    const input = makeInput({
      deliveredLeads: [
        { name: 'The Red Lion', placeId: 'place_1', website: 'https://redlion.co.uk' },
      ],
    });
    const artefacts = [
      makeStepResultContactExtract('sr-ce1', 'The Red Lion', 'place_1', [], []),
    ];

    const receipt = buildRunReceiptFromArtefacts(input, artefacts);

    expect(receipt.contact_extraction_attempted_count).toBe(1);
    expect(receipt.contacts_proven).toBe(false);
    expect(receipt.debug.artefact_ids_used.contact_extract).toEqual(['sr-ce1']);
  });
});
