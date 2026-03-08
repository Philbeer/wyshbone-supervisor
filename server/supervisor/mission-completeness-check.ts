import type { StructuredMission, MissionConstraintType } from './mission-schema';
import { logAFREvent } from './afr-logger';

export type DroppedConceptCategory =
  | 'relationship'
  | 'time'
  | 'website_evidence'
  | 'status'
  | 'ranking';

export type RecommendedAction = 'proceed' | 'clarify' | 'block';

export interface DroppedConcept {
  category: DroppedConceptCategory;
  matched_phrase: string;
  source: 'raw_input' | 'pass1';
  expected_constraint_type: MissionConstraintType;
  severity: 'hard' | 'soft';
}

export interface CompletenessWarning {
  code: string;
  message: string;
  category: DroppedConceptCategory;
}

export interface CompletenessCheckResult {
  ok: boolean;
  warnings: CompletenessWarning[];
  dropped_concepts: DroppedConcept[];
  recommended_action: RecommendedAction;
  checked_at: string;
}

interface ConceptPattern {
  category: DroppedConceptCategory;
  expected_constraint_type: MissionConstraintType;
  patterns: RegExp[];
  severity: 'hard' | 'soft';
}

const CONCEPT_PATTERNS: ConceptPattern[] = [
  {
    category: 'relationship',
    expected_constraint_type: 'relationship_check',
    severity: 'hard',
    patterns: [
      /\b(?:works?\s+with|working\s+with)\b/i,
      /\b(?:partner(?:s|ed|ing)?\s+with)\b/i,
      /\b(?:suppli(?:es|ed|er|ers)\s+(?:by|to|from))\b/i,
      /\b(?:supplied\s+by)\b/i,
      /\b(?:funded\s+by)\b/i,
      /\b(?:used\s+by)\b/i,
      /\b(?:managed\s+by)\b/i,
      /\b(?:owned\s+by)\b/i,
      /\b(?:affiliated\s+with)\b/i,
      /\b(?:associated\s+with)\b/i,
      /\b(?:contracted\s+(?:by|to|with))\b/i,
      /\b(?:endorsed\s+by)\b/i,
      /\b(?:backed\s+by)\b/i,
      /\b(?:supported\s+by)\b/i,
      /\b(?:accredited\s+by)\b/i,
      /\b(?:certified\s+by)\b/i,
      /\b(?:approved\s+by)\b/i,
      /\b(?:registered\s+with)\b/i,
    ],
  },
  {
    category: 'time',
    expected_constraint_type: 'time_constraint',
    severity: 'hard',
    patterns: [
      /\b(?:opened?\s+(?:in\s+(?:the\s+)?)?(?:last|past)\s+\d+\s+(?:day|week|month|year)s?)\b/i,
      /\b(?:opened?\s+recently)\b/i,
      /\b(?:(?:new(?:ly)?)\s+(?:opened?|established|launched|started))\b/i,
      /\b(?:established\s+(?:before|after|in|since)\s+\d{4})\b/i,
      /\b(?:(?:in\s+(?:the\s+)?)?(?:last|past)\s+\d+\s+(?:day|week|month|year)s?)\b/i,
      /\b(?:since\s+\d{4})\b/i,
      /\b(?:before\s+\d{4})\b/i,
      /\b(?:after\s+\d{4})\b/i,
      /\b(?:within\s+(?:the\s+)?(?:last|past)\s+\d+\s+(?:day|week|month|year)s?)\b/i,
    ],
  },
  {
    category: 'time',
    expected_constraint_type: 'time_constraint',
    severity: 'soft',
    patterns: [
      /\bnew\b(?!\s+(?:york|zealand|castle|jersey|delhi|orleans|hampshire|mexico|south\s+wales|brunswick))/i,
      /\brecently\b/i,
      /\brecent\b/i,
    ],
  },
  {
    category: 'website_evidence',
    expected_constraint_type: 'website_evidence',
    severity: 'hard',
    patterns: [
      /\b(?:mention(?:s|ed|ing)?\s+.{1,40}\s+(?:on\s+)?(?:their\s+)?(?:web\s*site|site|web\s*page))\b/i,
      /\b(?:(?:on\s+)?(?:their\s+)?(?:web\s*site|site|web\s*page)\s+(?:says?|mentions?|contains?|talks?\s+about|lists?|shows?))\b/i,
      /\b(?:(?:web\s*site|site)\s+(?:says?|mentions?|contains?))\b/i,
      /\b(?:says?\s+.{1,40}\s+on\s+(?:their\s+)?(?:web\s*site|site))\b/i,
      /\b(?:(?:on\s+)?(?:their\s+)?(?:web\s*site|site)\s+(?:has|have|includes?|features?)\s+.{1,40})\b/i,
    ],
  },
  {
    category: 'status',
    expected_constraint_type: 'status_check',
    severity: 'hard',
    patterns: [
      /\b(?:currently\s+(?:open|closed|operating|active|trading|accepting))\b/i,
      /\b(?:for\s+sale)\b/i,
      /\b(?:accepting\s+(?:new\s+)?(?:patient|client|customer|booking|reservation)s?)\b/i,
      /\b(?:offer(?:s|ing)?\s+(?:the\s+)?(?:service|programme|program))\b/i,
      /\b(?:provid(?:es?|ing)\s+(?:the\s+)?(?:service|programme|program))\b/i,
      /\b(?:(?:is|are)\s+(?:open|closed|shut|trading|operating))\b/i,
      /\b(?:still\s+(?:open|operating|trading|running|active))\b/i,
    ],
  },
  {
    category: 'ranking',
    expected_constraint_type: 'ranking',
    severity: 'soft',
    patterns: [
      /\bbest\b/i,
      /\btop\s*\d*/i,
      /\bhighest\s+rated\b/i,
      /\bmost\s+(?:popular|reviewed|visited|recommended)\b/i,
      /\blowest\s+(?:rated|ranked)\b/i,
      /\bbottom\s*\d*/i,
      /\bhighest\s+(?:rated|ranked|reviewed)\b/i,
    ],
  },
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function findMatchedPhrases(
  text: string,
  patterns: RegExp[],
): string[] {
  const matches: string[] = [];
  const normalizedText = normalize(text);
  for (const pattern of patterns) {
    const match = normalizedText.match(pattern);
    if (match) {
      matches.push(match[0].trim());
    }
  }
  return matches;
}

function missionHasConstraintType(
  mission: StructuredMission,
  constraintType: MissionConstraintType,
): boolean {
  return mission.constraints.some((c) => c.type === constraintType);
}

function detectDroppedConcepts(
  rawInput: string,
  pass1Text: string,
  mission: StructuredMission,
): { dropped: DroppedConcept[]; warnings: CompletenessWarning[] } {
  const dropped: DroppedConcept[] = [];
  const warnings: CompletenessWarning[] = [];

  for (const conceptDef of CONCEPT_PATTERNS) {
    const hasMissionConstraint = missionHasConstraintType(
      mission,
      conceptDef.expected_constraint_type,
    );

    if (hasMissionConstraint) {
      continue;
    }

    const rawMatches = findMatchedPhrases(rawInput, conceptDef.patterns);
    const pass1Matches = findMatchedPhrases(pass1Text, conceptDef.patterns);

    for (const phrase of rawMatches) {
      dropped.push({
        category: conceptDef.category,
        matched_phrase: phrase,
        source: 'raw_input',
        expected_constraint_type: conceptDef.expected_constraint_type,
        severity: conceptDef.severity,
      });
    }

    for (const phrase of pass1Matches) {
      const alreadyFromRaw = dropped.some(
        (d) =>
          d.category === conceptDef.category &&
          d.matched_phrase === phrase,
      );
      if (!alreadyFromRaw) {
        dropped.push({
          category: conceptDef.category,
          matched_phrase: phrase,
          source: 'pass1',
          expected_constraint_type: conceptDef.expected_constraint_type,
          severity: conceptDef.severity,
        });
      }
    }

    if (rawMatches.length > 0 || pass1Matches.length > 0) {
      const source =
        rawMatches.length > 0 && pass1Matches.length > 0
          ? 'raw input and pass 1'
          : rawMatches.length > 0
          ? 'raw input'
          : 'pass 1';

      warnings.push({
        code: `DROPPED_${conceptDef.category.toUpperCase()}`,
        message: `Detected ${conceptDef.category} meaning in ${source} but no ${conceptDef.expected_constraint_type} constraint exists in the structured mission.`,
        category: conceptDef.category,
      });
    }
  }

  return { dropped, warnings };
}

function determineAction(
  dropped: DroppedConcept[],
): RecommendedAction {
  const hasHardDrop = dropped.some((d) => d.severity === 'hard');
  const hasSoftDrop = dropped.some((d) => d.severity === 'soft');

  if (hasHardDrop) {
    return 'block';
  }
  if (hasSoftDrop) {
    return 'clarify';
  }
  return 'proceed';
}

export function checkMissionCompleteness(
  rawInput: string,
  pass1SemanticInterpretation: string,
  mission: StructuredMission,
): CompletenessCheckResult {
  const { dropped, warnings } = detectDroppedConcepts(
    rawInput,
    pass1SemanticInterpretation,
    mission,
  );

  const action = determineAction(dropped);

  return {
    ok: dropped.length === 0,
    warnings,
    dropped_concepts: dropped,
    recommended_action: action,
    checked_at: new Date().toISOString(),
  };
}

export async function logCompletenessToAFR(
  result: CompletenessCheckResult,
  userId: string,
  runId: string,
  conversationId?: string,
): Promise<void> {
  if (result.ok) {
    await logAFREvent({
      userId,
      runId,
      conversationId,
      actionTaken: 'mission_completeness_check',
      status: 'success',
      taskGenerated: 'Mission completeness check passed — no dropped concepts detected.',
      runType: 'plan',
      metadata: {
        ok: true,
        recommended_action: result.recommended_action,
        warning_count: 0,
        dropped_count: 0,
      },
    });
    return;
  }

  const droppedSummary = result.dropped_concepts
    .map(
      (d) =>
        `[${d.severity}] ${d.category}: "${d.matched_phrase}" (from ${d.source}, expected ${d.expected_constraint_type})`,
    )
    .join('; ');

  await logAFREvent({
    userId,
    runId,
    conversationId,
    actionTaken: 'mission_completeness_check',
    status: 'failed',
    taskGenerated: `Completeness check FAILED — ${result.dropped_concepts.length} dropped concept(s): ${droppedSummary}`,
    runType: 'plan',
    metadata: {
      ok: false,
      recommended_action: result.recommended_action,
      warning_count: result.warnings.length,
      dropped_count: result.dropped_concepts.length,
      dropped_concepts: result.dropped_concepts,
      warnings: result.warnings,
    },
  });
}
