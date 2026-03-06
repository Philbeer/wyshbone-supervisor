import type { CanonicalIntent } from './canonical-intent';

export interface IntentPreviewFields {
  business_type: string | null;
  location: string | null;
  count: number | null;
  time_filter: string | null;
}

export interface ParsedGoalBridge {
  business_type: string;
  location: string;
  requested_count_user: number | null;
  constraints_hint: Array<{ type: string; raw: string; hardness: string }>;
}

export function canonicalIntentToPreviewFields(intent: CanonicalIntent): IntentPreviewFields {
  const timeConstraint = intent.constraints.find(c => c.type === 'time');
  return {
    business_type: intent.entity_category,
    location: intent.location_text,
    count: intent.requested_count,
    time_filter: timeConstraint?.raw ?? null,
  };
}

export function canonicalIntentToParsedGoalBridge(intent: CanonicalIntent): ParsedGoalBridge {
  return {
    business_type: intent.entity_category ?? '',
    location: intent.location_text ?? '',
    requested_count_user: intent.requested_count,
    constraints_hint: intent.constraints.map(c => ({
      type: c.type,
      raw: c.raw,
      hardness: c.hardness,
    })),
  };
}

export function buildConversationContextString(
  messages: Array<{ role: string; content: string }>,
  maxTurns: number = 6,
): string {
  const recent = messages.slice(-maxTurns);
  return recent
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.substring(0, 500)}`)
    .join('\n');
}
