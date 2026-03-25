import type { IntentNarrative } from './mission-schema';

export type MessageClass = 'search' | 'chat' | 'followup' | 'clarify_response' | 'outreach_request' | 'monitor_request';

export interface ClassificationResult {
  messageClass: MessageClass;
  confidence: number;
  reason: string;
}

const CHAT_PATTERNS = [
  /^(hi|hello|hey|howdy|morning|afternoon|evening|yo|sup)\b/i,
  /^(thanks|thank you|cheers|ta|appreciated|great|perfect|ok|okay|cool|nice|got it|understood)\b/i,
  /^(what can you do|how do you work|help|what are you|who are you|tell me about yourself)/i,
  /^(bye|goodbye|see you|later|cya|ttyl)\b/i,
];

const OUTREACH_PATTERNS = [
  /\b(email|send|draft|outreach|message|contact|reach out)\b.*\b(them|this|that|lead|company|business)\b/i,
  /\b(email|send|draft)\b.*\b(to|for)\b/i,
];

const MONITOR_PATTERNS = [
  /\b(monitor|watch|keep.+eye|alert.+me|notify|track|check.+regularly|keep.+checking)\b/i,
];

const FOLLOWUP_PATTERNS = [
  /\b(show.+more|tell.+more|details|expand|what about|how about|also|and what|the (first|second|third|fourth|fifth|\d+th) one)\b/i,
  /\b(now find|now show|add.+filter|narrow|refine|with.+(beer garden|outdoor|live music|food))\b/i,
  /\b(number\s*\d+|#\d+|\d+(?:st|nd|rd|th)\s+(?:one|result|lead)|the\s+(?:first|second|third|fourth|fifth)\s+(?:one|result|lead)?)\b/i,
];

export function classifyMessage(message: string): ClassificationResult {
  const trimmed = message.trim();

  // Very short messages are almost always chat
  if (trimmed.length < 4) {
    return { messageClass: 'chat', confidence: 0.95, reason: 'very_short_message' };
  }

  // Check chat patterns first (highest priority for routing away from pipeline)
  for (const pattern of CHAT_PATTERNS) {
    if (pattern.test(trimmed)) {
      // But if it also contains search-like content, don't classify as chat
      if (trimmed.length > 30 && /\b(find|search|look for|get me|show me)\b/i.test(trimmed)) {
        break; // Fall through to search
      }
      return { messageClass: 'chat', confidence: 0.9, reason: 'chat_pattern_match' };
    }
  }

  // Check outreach patterns
  for (const pattern of OUTREACH_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { messageClass: 'outreach_request', confidence: 0.8, reason: 'outreach_pattern_match' };
    }
  }

  // Check monitor patterns
  for (const pattern of MONITOR_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { messageClass: 'monitor_request', confidence: 0.8, reason: 'monitor_pattern_match' };
    }
  }

  // Check followup patterns
  for (const pattern of FOLLOWUP_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { messageClass: 'followup', confidence: 0.75, reason: 'followup_pattern_match' };
    }
  }

  // Default: treat as search (let the full pipeline handle it)
  return { messageClass: 'search', confidence: 0.6, reason: 'default_to_search' };
}
