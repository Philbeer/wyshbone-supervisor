/**
 * Conversation State Machine
 *
 * Tracks the phase of each conversation so the Supervisor can interpret
 * messages in context. "tell me about #3" means something completely
 * different when you just delivered results (reviewing) vs when you're
 * exploring what to search for.
 */

export type ConversationPhase =
  | 'idle'
  | 'exploring'
  | 'clarifying'
  | 'executing'
  | 'reviewing'
  | 'iterating';

export interface AccumulatedContext {
  urlContent?: string;
  productDescription?: string;
  suggestedSectors?: string[];
  userSector?: string;
  location?: string;
  entityType?: string;
  additionalConstraints?: string[];
  originalUserMessage?: string;
}

export interface LastDelivery {
  runId: string;
  leadCount: number;
  entityType: string;
  location: string;
  missionConfig: any;
}

export interface ConversationState {
  phase: ConversationPhase;
  conversationId: string;
  accumulatedContext: AccumulatedContext;
  lastDelivery: LastDelivery | null;
  lastActivityAt: number;
  phaseEnteredAt: number;
  turnCount: number;
  awaiting_chat_reply: boolean;
  awaiting_chat_reply_expires_at: number | null;
  consecutive_chat_questions: number;
}

export interface ConversationFlag {
  awaiting_chat_reply?: boolean;
  awaiting_chat_reply_expires_at?: number | null;
  consecutive_chat_questions?: number;
}

export interface PhaseDetectionInput {
  messageClass: string;
  currentPhase: ConversationPhase;
  hasLastDelivery: boolean;
  hasPendingContract: boolean;
  timeSinceLastActivity: number;
  rawMessage: string;
}

// ─── In-memory store ────────────────────────────────────────────────────────

const store = new Map<string, ConversationState>();

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const MAX_IDLE_MS = 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, state] of Array.from(store.entries())) {
    if (now - state.lastActivityAt > MAX_IDLE_MS) {
      store.delete(id);
    }
  }
}, CLEANUP_INTERVAL_MS);

// ─── Pattern arrays ──────────────────────────────────────────────────────────

const ITERATION_PATTERNS = [
  /now (?:try|find|search|do)/i,
  /same (?:but|in|for)/i,
  /(?:try|find) .+ instead/i,
  /(?:what about|how about) [A-Z]/i,
  /change .+ to/i,
];

const RESULT_QUESTION_PATTERNS = [
  /tell me (?:more|about)/i,
  /the (?:first|second|third|fourth|fifth|\d+(?:st|nd|rd|th))/i,
  /number \d+|#\d+/i,
  /how did you|what evidence/i,
  /contact (?:info|details)/i,
  /(?:their|its) (?:website|email|phone)/i,
];

// ─── Public API ──────────────────────────────────────────────────────────────

export function getConversationState(conversationId: string): ConversationState {
  const existing = store.get(conversationId);
  if (existing) return existing;

  const now = Date.now();
  const fresh: ConversationState = {
    phase: 'idle',
    conversationId,
    accumulatedContext: {},
    lastDelivery: null,
    lastActivityAt: now,
    phaseEnteredAt: now,
    turnCount: 0,
    awaiting_chat_reply: false,
    awaiting_chat_reply_expires_at: null,
    consecutive_chat_questions: 0,
  };
  store.set(conversationId, fresh);
  return fresh;
}

export function updateConversationPhase(
  conversationId: string,
  newPhase: ConversationPhase,
  extra?: { accumulatedContext?: Partial<AccumulatedContext>; lastDelivery?: LastDelivery },
): void {
  const state = getConversationState(conversationId);
  const oldPhase = state.phase;
  const now = Date.now();

  state.turnCount += 1;
  state.lastActivityAt = now;

  if (oldPhase !== newPhase) {
    state.phaseEnteredAt = now;
    state.phase = newPhase;
  }

  if (extra?.accumulatedContext) {
    state.accumulatedContext = { ...state.accumulatedContext, ...extra.accumulatedContext };
  }

  if (extra?.lastDelivery !== undefined) {
    state.lastDelivery = extra.lastDelivery;
  }

  console.log(
    `[CONV_STATE] ${conversationId.slice(0, 8)} phase: ${oldPhase} → ${newPhase} (turn ${state.turnCount})`,
  );
}

export function mergeAccumulatedContext(
  conversationId: string,
  context: Partial<AccumulatedContext>,
): void {
  const state = getConversationState(conversationId);
  state.accumulatedContext = { ...state.accumulatedContext, ...context };
}

export function setLastDelivery(conversationId: string, delivery: LastDelivery): void {
  const state = getConversationState(conversationId);
  state.lastDelivery = delivery;
}

export function resetConversationState(conversationId: string): void {
  store.delete(conversationId);
}

export function setConversationFlag(conversationId: string, flag: ConversationFlag): void {
  const state = getConversationState(conversationId);
  if (flag.awaiting_chat_reply !== undefined) {
    state.awaiting_chat_reply = flag.awaiting_chat_reply;
  }
  if (flag.awaiting_chat_reply_expires_at !== undefined) {
    state.awaiting_chat_reply_expires_at = flag.awaiting_chat_reply_expires_at;
  }
  if (flag.consecutive_chat_questions !== undefined) {
    state.consecutive_chat_questions = flag.consecutive_chat_questions;
  }
}

export function getConversationFlag(conversationId: string): Pick<ConversationState, 'awaiting_chat_reply' | 'awaiting_chat_reply_expires_at' | 'consecutive_chat_questions'> {
  const state = getConversationState(conversationId);
  return {
    awaiting_chat_reply: state.awaiting_chat_reply,
    awaiting_chat_reply_expires_at: state.awaiting_chat_reply_expires_at,
    consecutive_chat_questions: state.consecutive_chat_questions,
  };
}

export function suggestPhase(input: PhaseDetectionInput): ConversationPhase {
  const {
    messageClass,
    currentPhase,
    hasLastDelivery,
    hasPendingContract,
    timeSinceLastActivity,
    rawMessage,
  } = input;

  const THIRTY_MINUTES = 30 * 60 * 1000;

  if (timeSinceLastActivity > THIRTY_MINUTES) {
    return 'idle';
  }

  if (hasPendingContract) {
    return 'clarifying';
  }

  if (
    (currentPhase === 'exploring' || currentPhase === 'clarifying') &&
    messageClass !== 'chat'
  ) {
    return 'executing';
  }

  if (hasLastDelivery) {
    if (ITERATION_PATTERNS.some((re) => re.test(rawMessage))) {
      return 'iterating';
    }

    if (RESULT_QUESTION_PATTERNS.some((re) => re.test(rawMessage))) {
      return 'reviewing';
    }

    if (messageClass === 'followup') {
      return 'reviewing';
    }

    if (messageClass === 'search') {
      return 'idle';
    }
  }

  return currentPhase;
}
