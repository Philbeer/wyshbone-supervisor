/**
 * Conversation Turn Classifier
 *
 * Pure context analysis — knows NOTHING about routes (SEARCH/CLARIFY/etc).
 * Output feeds into the router as authoritative conversational context.
 *
 * Runs in ~300-500ms on Haiku 4.5.
 */

import { callLLMText } from './llm-failover';

// ─── Types ──────────────────────────────────────────────────────────────────

export type LastAssistantTurnType =
  | 'SEARCH_RESULTS'
  | 'ASKED_QUESTION'
  | 'CHAT_REPLY'
  | 'CLARIFICATION_REQUEST'
  | 'NONE';

export type UserMessageRelation =
  | 'ANSWERING_QUESTION'
  | 'CONTINUING_CHAT'
  | 'PROVIDING_CLARIFICATION'
  | 'DISCUSSING_RESULTS'
  | 'REFINING_SEARCH'
  | 'NEW_SEARCH_REQUEST'
  | 'GREETING_OR_OFFTOPIC';

export interface TurnAnalysis {
  last_assistant_turn_type: LastAssistantTurnType;
  last_assistant_summary: string;       // 1 sentence — what the assistant said/asked
  user_message_relation: UserMessageRelation;
  reasoning: string;                     // why this classification
}

export interface TurnClassifierInput {
  currentMessage: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  previousResultsExist: boolean;         // were businesses delivered in this conversation?
}

// ─── System prompt ──────────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM_PROMPT = `You analyse conversations. Your ONLY job is to understand what just happened between the user and assistant.

You do NOT decide any action or route. You do NOT recommend what to do next. You describe what IS happening in the conversation.

Return ONLY a JSON object. No markdown, no backticks, no commentary.

## WHAT TO ANALYSE

Given the conversation history and the user's current message, identify two things:

### 1. What kind of message was the LAST ASSISTANT TURN?

- SEARCH_RESULTS: The assistant delivered a list of businesses/leads in a previous turn (PREVIOUS_RESULTS_EXIST is true).
- ASKED_QUESTION: The assistant's last message ended with a question to the user (asking for preference, cooking style, clarifying something, etc).
- CHAT_REPLY: The assistant gave information, advice, opinion, or recommendation in a conversational way. No search results delivered.
- CLARIFICATION_REQUEST: The assistant asked for missing information needed to perform a task (e.g. "what type of businesses?", "which location?").
- NONE: There is no previous assistant turn (this is the user's first message).

Note: ASKED_QUESTION vs CLARIFICATION_REQUEST — if the assistant's question is asking for search parameters (business type, location), it's CLARIFICATION_REQUEST. If the question is conversational (cooking style, preferences, opinions), it's ASKED_QUESTION.

### 2. What is the USER'S CURRENT MESSAGE doing in relation to that?

- ANSWERING_QUESTION: Replying to the assistant's non-clarification question. Often short. May contain nouns that look like business types but are actually answers.
- CONTINUING_CHAT: Following up on the conversational topic the assistant was discussing. Asking for more of the same content, refining the topic, asking related questions.
- PROVIDING_CLARIFICATION: Giving the missing info the assistant asked for (location, entity type, etc).
- DISCUSSING_RESULTS: Talking about the businesses/leads the assistant delivered (only possible when PREVIOUS_RESULTS_EXIST).
- REFINING_SEARCH: Wanting to modify an existing search — different location, different entity, extra filter (only possible when PREVIOUS_RESULTS_EXIST).
- NEW_SEARCH_REQUEST: Explicitly asking to find businesses. Uses search verbs (find, search, show me, look for) AND provides a business type AND a location (or at least intent to start a new search).
- GREETING_OR_OFFTOPIC: Greetings, thanks, or unrelated messages that don't fit the flow.

## OUTPUT FORMAT

{
  "last_assistant_turn_type": "SEARCH_RESULTS" | "ASKED_QUESTION" | "CHAT_REPLY" | "CLARIFICATION_REQUEST" | "NONE",
  "last_assistant_summary": "one sentence describing what the assistant's last message said or asked",
  "user_message_relation": "ANSWERING_QUESTION" | "CONTINUING_CHAT" | "PROVIDING_CLARIFICATION" | "DISCUSSING_RESULTS" | "REFINING_SEARCH" | "NEW_SEARCH_REQUEST" | "GREETING_OR_OFFTOPIC",
  "reasoning": "one sentence explaining why this relation fits"
}`;

// ─── Builder ────────────────────────────────────────────────────────────────

function buildClassifierInput(input: TurnClassifierInput): string {
  const parts: string[] = [];

  parts.push(`PREVIOUS_RESULTS_EXIST: ${input.previousResultsExist}`);
  parts.push('');

  if (input.conversationHistory.length === 0) {
    parts.push('CONVERSATION HISTORY: (none — this is the first message)');
  } else {
    parts.push('CONVERSATION HISTORY:');
    // Last 6 turns is plenty for turn classification
    const recent = input.conversationHistory.slice(-6);
    for (const msg of recent) {
      const role = msg.role === 'user' ? 'user' : 'assistant';
      const content = msg.content.length > 600
        ? msg.content.substring(0, 600) + '...'
        : msg.content;
      parts.push(`[${role}] ${content}`);
    }
  }
  parts.push('');
  parts.push(`USER'S CURRENT MESSAGE: ${input.currentMessage}`);

  return parts.join('\n');
}

// ─── Parser ─────────────────────────────────────────────────────────────────

const VALID_TURN_TYPES: LastAssistantTurnType[] = [
  'SEARCH_RESULTS', 'ASKED_QUESTION', 'CHAT_REPLY', 'CLARIFICATION_REQUEST', 'NONE',
];

const VALID_RELATIONS: UserMessageRelation[] = [
  'ANSWERING_QUESTION', 'CONTINUING_CHAT', 'PROVIDING_CLARIFICATION',
  'DISCUSSING_RESULTS', 'REFINING_SEARCH', 'NEW_SEARCH_REQUEST', 'GREETING_OR_OFFTOPIC',
];

function parseClassifierResponse(raw: string): TurnAnalysis {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) cleaned = match[0];

  const parsed = JSON.parse(cleaned);

  if (!VALID_TURN_TYPES.includes(parsed.last_assistant_turn_type)) {
    throw new Error(`Invalid turn type: ${parsed.last_assistant_turn_type}`);
  }
  if (!VALID_RELATIONS.includes(parsed.user_message_relation)) {
    throw new Error(`Invalid relation: ${parsed.user_message_relation}`);
  }

  return {
    last_assistant_turn_type: parsed.last_assistant_turn_type,
    last_assistant_summary: String(parsed.last_assistant_summary || '').substring(0, 300),
    user_message_relation: parsed.user_message_relation,
    reasoning: String(parsed.reasoning || '').substring(0, 300),
  };
}

// ─── Main export ────────────────────────────────────────────────────────────

export async function classifyTurn(input: TurnClassifierInput): Promise<TurnAnalysis> {
  const start = Date.now();

  const userMessage = buildClassifierInput(input);

  let raw: string;
  try {
    raw = await callLLMText(CLASSIFIER_SYSTEM_PROMPT, userMessage, 'turn_classifier', {
      anthropicModel: process.env.TURN_CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001',
      openaiModel: 'gpt-4o-mini',
      timeoutMs: parseInt(process.env.TURN_CLASSIFIER_TIMEOUT_MS || '8000', 10),
      maxTokens: 300,
      temperature: 0,
    });
  } catch (err: any) {
    console.warn(`[TURN_CLASSIFIER] LLM failed (${Date.now() - start}ms): ${err.message} — falling back to neutral analysis`);
    return fallbackAnalysis(input);
  }

  try {
    const analysis = parseClassifierResponse(raw);
    console.log(
      `[TURN_CLASSIFIER] turn=${analysis.last_assistant_turn_type} ` +
      `relation=${analysis.user_message_relation} (${Date.now() - start}ms)`
    );
    return analysis;
  } catch (err: any) {
    console.warn(`[TURN_CLASSIFIER] Parse failed (${Date.now() - start}ms): ${err.message} — falling back`);
    return fallbackAnalysis(input);
  }
}

function fallbackAnalysis(input: TurnClassifierInput): TurnAnalysis {
  // If classifier fails, return neutral analysis that doesn't over-constrain the router.
  // Router still has full history and makes its own decision.
  const isFirstMessage = input.conversationHistory.length === 0;
  return {
    last_assistant_turn_type: isFirstMessage ? 'NONE' : 'CHAT_REPLY',
    last_assistant_summary: 'unavailable',
    user_message_relation: isFirstMessage ? 'NEW_SEARCH_REQUEST' : 'CONTINUING_CHAT',
    reasoning: 'Classifier unavailable — neutral fallback',
  };
}
