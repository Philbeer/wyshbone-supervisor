import { describe, it, expect } from 'vitest';
import {
  applyHardEvidenceFilter,
  type HardEvidenceFilterInput,
  type HardEvidenceConstraintRef,
} from './mission-executor';

interface StubLead {
  name: string;
  placeId: string;
}

function lead(name: string, placeId: string): StubLead {
  return { name, placeId };
}

function evidenceHit(leadIndex: number, field: string, value: string): HardEvidenceFilterInput {
  return { leadIndex, constraintField: field, constraintValue: value, evidenceFound: true };
}

function evidenceMiss(leadIndex: number, field: string, value: string): HardEvidenceFilterInput {
  return { leadIndex, constraintField: field, constraintValue: value, evidenceFound: false };
}

const LIVE_MUSIC_CONSTRAINT: HardEvidenceConstraintRef = {
  field: 'website_text',
  value: 'live music',
};

describe('applyHardEvidenceFilter', () => {
  it('removes leads that were never checked for hard evidence', () => {
    const leads = [
      lead('The Swan', 'p1'),
      lead('The Crown', 'p2'),
      lead('The Bull', 'p3'),
    ];

    const evidence: HardEvidenceFilterInput[] = [
      evidenceHit(0, 'website_text', 'live music'),
    ];

    const result = applyHardEvidenceFilter(leads, evidence, [LIVE_MUSIC_CONSTRAINT]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('The Swan');
  });

  it('keeps leads that were checked and had evidence', () => {
    const leads = [
      lead('The Swan', 'p1'),
      lead('The Crown', 'p2'),
    ];

    const evidence: HardEvidenceFilterInput[] = [
      evidenceHit(0, 'website_text', 'live music'),
      evidenceHit(1, 'website_text', 'live music'),
    ];

    const result = applyHardEvidenceFilter(leads, evidence, [LIVE_MUSIC_CONSTRAINT]);

    expect(result).toHaveLength(2);
  });

  it('removes leads that were checked but had no evidence', () => {
    const leads = [
      lead('The Swan', 'p1'),
      lead('The Crown', 'p2'),
    ];

    const evidence: HardEvidenceFilterInput[] = [
      evidenceHit(0, 'website_text', 'live music'),
      evidenceMiss(1, 'website_text', 'live music'),
    ];

    const result = applyHardEvidenceFilter(leads, evidence, [LIVE_MUSIC_CONSTRAINT]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('The Swan');
  });

  it('regression: unchecked leads do not survive when some leads were checked', () => {
    const leads = [
      lead('Pub A (checked, has evidence)', 'p1'),
      lead('Pub B (checked, no evidence)', 'p2'),
      lead('Pub C (never checked — no website)', 'p3'),
      lead('Pub D (never checked — batch limit)', 'p4'),
    ];

    const evidence: HardEvidenceFilterInput[] = [
      evidenceHit(0, 'website_text', 'live music'),
      evidenceMiss(1, 'website_text', 'live music'),
    ];

    const result = applyHardEvidenceFilter(leads, evidence, [LIVE_MUSIC_CONSTRAINT]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Pub A (checked, has evidence)');
    expect(result.some(l => l.name.includes('never checked'))).toBe(false);
  });

  it('handles multiple hard constraints — lead must match at least one', () => {
    const leads = [
      lead('The Swan', 'p1'),
      lead('The Crown', 'p2'),
    ];

    const constraints: HardEvidenceConstraintRef[] = [
      { field: 'website_text', value: 'live music' },
      { field: 'amenity', value: 'beer garden' },
    ];

    const evidence: HardEvidenceFilterInput[] = [
      evidenceMiss(0, 'website_text', 'live music'),
      evidenceHit(0, 'amenity', 'beer garden'),
      evidenceMiss(1, 'website_text', 'live music'),
      evidenceMiss(1, 'amenity', 'beer garden'),
    ];

    const result = applyHardEvidenceFilter(leads, evidence, constraints);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('The Swan');
  });

  it('returns empty array when no leads have evidence', () => {
    const leads = [
      lead('The Swan', 'p1'),
      lead('The Crown', 'p2'),
    ];

    const evidence: HardEvidenceFilterInput[] = [
      evidenceMiss(0, 'website_text', 'live music'),
      evidenceMiss(1, 'website_text', 'live music'),
    ];

    const result = applyHardEvidenceFilter(leads, evidence, [LIVE_MUSIC_CONSTRAINT]);

    expect(result).toHaveLength(0);
  });

  it('AFR regression: leads without websites are rejected when evidence was gathered for others', () => {
    const leads = [
      lead('The Black Horse', 'p1'),
      lead('The Red Lion', 'p2'),
      lead('The Kings Arms', 'p3'),
      lead('George & Dragon', 'p4'),
      lead('The Eagle Inn', 'p5'),
    ];

    const evidence: HardEvidenceFilterInput[] = [
      evidenceHit(0, 'website_text', 'live music'),
      evidenceHit(1, 'website_text', 'live music'),
      evidenceHit(3, 'website_text', 'live music'),
    ];

    const result = applyHardEvidenceFilter(leads, evidence, [LIVE_MUSIC_CONSTRAINT]);

    expect(result).toHaveLength(3);
    expect(result.map(l => l.name)).toEqual([
      'The Black Horse',
      'The Red Lion',
      'George & Dragon',
    ]);
    expect(result.some(l => l.name === 'The Kings Arms')).toBe(false);
    expect(result.some(l => l.name === 'The Eagle Inn')).toBe(false);
  });

  it('outer guard bypass: empty evidence array still filters all leads when hard constraints exist', () => {
    const leads = [
      lead('The Swan', 'p1'),
      lead('The Crown', 'p2'),
    ];

    const result = applyHardEvidenceFilter(leads, [], [LIVE_MUSIC_CONSTRAINT]);

    expect(result).toHaveLength(0);
  });

  it('handles empty evidence array with no hard constraints — should not be called but is safe', () => {
    const leads = [
      lead('The Swan', 'p1'),
    ];

    const result = applyHardEvidenceFilter(leads, [], [LIVE_MUSIC_CONSTRAINT]);

    expect(result).toHaveLength(0);
  });
});
