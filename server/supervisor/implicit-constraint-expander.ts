import type { ConstraintChecklist } from './mission-schema';

export interface InferredConstraint {
  type: string;
  field: string;
  operator: string;
  value: string | number | null;
  hardness: 'soft' | 'hard';
  source: string;
}

export interface ImplicitExpansionResult {
  explicit_constraints: string[];
  inferred_constraints: InferredConstraint[];
  inference_notes: string[];
  semantic_addendum: string | null;
}

const RANKING_PATTERNS = [
  /\bbest\b/i,
  /\btop\s+\d*/i,
  /\bhighest[\s-]rated\b/i,
  /\bhighly[\s-]rated\b/i,
  /\bmost\s+popular\b/i,
  /\btop[\s-]rated\b/i,
];

const WEBSITE_EVIDENCE_PATTERNS = [
  /\bon\s+their\s+website\b/i,
  /\bon\s+its\s+website\b/i,
  /\bon\s+their\s+site\b/i,
  /\bon\s+its\s+site\b/i,
  /\bwebsite\s+says\b/i,
  /\bwebsite\s+mentions?\b/i,
  /\bsite\s+mentions?\b/i,
  /\bmentions?\s+on\s+(their|its)\s+(website|site)\b/i,
  /\bsays\s+on\s+(their|its)\s+(website|site)\b/i,
];

const RELATIONSHIP_PATTERNS = [
  { re: /\bworks?\s+with\b/i, label: 'works with' },
  { re: /\bpartnered\s+with\b/i, label: 'partnered with' },
  { re: /\bsupplies\b/i, label: 'supplies' },
  { re: /\bserves\b/i, label: 'serves' },
  { re: /\baffiliated\s+with\b/i, label: 'affiliated with' },
  { re: /\bsupplied\s+by\b/i, label: 'supplied by' },
  { re: /\bpartners?\s+with\b/i, label: 'partners with' },
];

const NAME_TEXT_PATTERNS = [
  /\bin\s+the\s+name\b/i,
  /\bin\s+the\s+title\b/i,
  /\bcalled\b/i,
  /\bnamed\b/i,
  /\bwith\s+\w+\s+in\s+the\s+name\b/i,
  /\bname\s+(?:includes?|contains?)\b/i,
];

export function expandImplicitConstraints(
  rawUserInput: string,
  checklist: ConstraintChecklist | null,
  semanticInterpretation: string,
): ImplicitExpansionResult {
  const explicit: string[] = [];
  const inferred: InferredConstraint[] = [];
  const notes: string[] = [];
  const addendumParts: string[] = [];

  const raw = rawUserInput.toLowerCase();

  if (checklist) {
    if (checklist.has_text_compare) explicit.push('text_compare');
    if (checklist.has_attribute_check) explicit.push('attribute_check');
    if (checklist.has_relationship_check) explicit.push('relationship_check');
    if (checklist.has_website_evidence) explicit.push('website_evidence');
    if (checklist.has_numeric_range) explicit.push('numeric_range');
    if (checklist.has_time_constraint) explicit.push('time_constraint');
    if (checklist.has_status_check) explicit.push('status_check');
    if (checklist.has_contact_extraction) explicit.push('contact_extraction');
    if (checklist.has_ranking) explicit.push('ranking');
  }

  expandRanking(raw, rawUserInput, checklist, semanticInterpretation, explicit, inferred, notes, addendumParts);
  expandWebsiteEvidence(raw, checklist, explicit, inferred, notes, addendumParts);
  expandRelationship(raw, rawUserInput, checklist, explicit, inferred, notes, addendumParts);
  expandNameText(raw, checklist, explicit, inferred, notes, addendumParts);

  return {
    explicit_constraints: explicit,
    inferred_constraints: inferred,
    inference_notes: notes,
    semantic_addendum: addendumParts.length > 0 ? addendumParts.join(' ') : null,
  };
}

function expandRanking(
  raw: string,
  rawInput: string,
  checklist: ConstraintChecklist | null,
  semantic: string,
  explicit: string[],
  inferred: InferredConstraint[],
  notes: string[],
  addendum: string[],
): void {
  const hasRankingInChecklist = checklist?.has_ranking ?? false;
  const matchedPattern = RANKING_PATTERNS.find(p => p.test(raw));
  if (!matchedPattern) return;

  const matchStr = raw.match(matchedPattern)?.[0] ?? 'ranking language';

  if (hasRankingInChecklist) {
    notes.push(`Ranking language detected and already classified: "${matchStr}"`);
    return;
  }

  notes.push(`Detected ranking language: "${matchStr}"`);
  if (!explicit.includes('ranking')) explicit.push('ranking');

  const semanticLower = semantic.toLowerCase();
  const hasRatingInSemantic = /\brat(ing|ed)\b/.test(semanticLower);
  const hasReviewInSemantic = /\breview/.test(semanticLower);

  if (!hasRatingInSemantic) {
    inferred.push({
      type: 'ranking_signal',
      field: 'rating',
      operator: 'prefer_high',
      value: null,
      hardness: 'soft',
      source: `inferred_from_ranking_language: "${matchStr}"`,
    });
    notes.push(`Inferred soft ranking signal on rating from "${matchStr}"`);
  }

  if (!hasReviewInSemantic) {
    inferred.push({
      type: 'ranking_signal',
      field: 'review_count',
      operator: 'prefer_high',
      value: null,
      hardness: 'soft',
      source: `inferred_from_ranking_language: "${matchStr}"`,
    });
    notes.push(`Inferred soft ranking signal on review_count from "${matchStr}"`);
  }

  if (!hasRatingInSemantic && !hasReviewInSemantic) {
    addendum.push('Results may preferably be ranked by quality signals such as rating and review count.');
  }
}

function expandWebsiteEvidence(
  raw: string,
  checklist: ConstraintChecklist | null,
  explicit: string[],
  inferred: InferredConstraint[],
  notes: string[],
  addendum: string[],
): void {
  const hasWebsiteInChecklist = checklist?.has_website_evidence ?? false;
  const matched = WEBSITE_EVIDENCE_PATTERNS.find(p => p.test(raw));
  if (!matched) return;

  if (hasWebsiteInChecklist) {
    notes.push('Website evidence language detected and already classified by checklist');
    return;
  }

  notes.push('Detected website evidence language — reinforcing website_evidence constraint');
  if (!explicit.includes('website_evidence')) explicit.push('website_evidence');
  inferred.push({
    type: 'website_evidence_signal',
    field: 'website_text',
    operator: 'contains',
    value: null,
    hardness: 'soft',
    source: 'inferred_from_website_language',
  });
  addendum.push('Evidence may preferably be checked on the venue website.');
}

function expandRelationship(
  raw: string,
  rawInput: string,
  checklist: ConstraintChecklist | null,
  explicit: string[],
  inferred: InferredConstraint[],
  notes: string[],
  addendum: string[],
): void {
  const hasRelInChecklist = checklist?.has_relationship_check ?? false;
  const matched = RELATIONSHIP_PATTERNS.find(p => p.re.test(raw));
  if (!matched) return;

  if (hasRelInChecklist) {
    notes.push(`Relationship language detected and already classified: "${matched.label}"`);
    return;
  }

  notes.push(`Detected relationship language: "${matched.label}" — reinforcing relationship_check`);
  if (!explicit.includes('relationship_check')) explicit.push('relationship_check');
  inferred.push({
    type: 'relationship_signal',
    field: 'partner',
    operator: 'has',
    value: null,
    hardness: 'soft',
    source: `inferred_from_relationship_language: "${matched.label}"`,
  });
  addendum.push(`The business may preferably have a relationship indicated by "${matched.label}".`);
}

function expandNameText(
  raw: string,
  checklist: ConstraintChecklist | null,
  explicit: string[],
  inferred: InferredConstraint[],
  notes: string[],
  addendum: string[],
): void {
  const hasTextInChecklist = checklist?.has_text_compare ?? false;
  const matched = NAME_TEXT_PATTERNS.find(p => p.test(raw));
  if (!matched) return;

  if (hasTextInChecklist) {
    notes.push('Name/text matching language detected and already classified by checklist');
    return;
  }

  notes.push('Detected name/text matching language — reinforcing text_compare on name');
  if (!explicit.includes('text_compare')) explicit.push('text_compare');
  inferred.push({
    type: 'text_compare_signal',
    field: 'name',
    operator: 'contains',
    value: null,
    hardness: 'soft',
    source: 'inferred_from_name_language',
  });
  addendum.push('The business name may preferably match the specified text.');
}
