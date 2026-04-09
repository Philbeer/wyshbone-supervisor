import type { IntentNarrative } from './mission-schema';

export type MessageClass = 'search' | 'chat' | 'followup' | 'clarify_response' | 'outreach_request' | 'monitor_request';

export interface ClassificationResult {
  messageClass: MessageClass;
  confidence: number;
  reason: string;
}

const OUTREACH_PATTERNS = [
  /\b(email|send|draft|outreach|message|contact|reach out)\b.*\b(them|this|that|lead|company|business)\b/i,
  /\b(email|send|draft)\b.*\b(to|for)\b/i,
];

const MONITOR_PATTERNS = [
  /\b(monitor|watch|keep.+eye|alert.+me|notify|track|check.+regularly|keep.+checking)\b/i,
];

export function classifyMessage(message: string): ClassificationResult {
  const trimmed = message.trim();

  // Single-character junk
  if (trimmed.length < 2) {
    return { messageClass: 'chat', confidence: 0.95, reason: 'very_short_message' };
  }

  // Outreach requests — the conversation router doesn't handle these
  for (const pattern of OUTREACH_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { messageClass: 'outreach_request', confidence: 0.8, reason: 'outreach_pattern_match' };
    }
  }

  // Monitor requests — the conversation router doesn't handle these
  for (const pattern of MONITOR_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { messageClass: 'monitor_request', confidence: 0.8, reason: 'monitor_pattern_match' };
    }
  }

  // Everything else goes to the conversation router via the search pipeline
  return { messageClass: 'search', confidence: 0.6, reason: 'default_to_router' };
}
