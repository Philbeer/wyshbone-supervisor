// Pre-Execution Constraint Gate
// Runs BEFORE any tool execution, Google search, or SEARCH_PLACES call.
// Supervisor is the sole authority for constraint interpretation and verifiability.
// If any HARD constraint is unresolved, can_execute MUST be false.

import {
  type TimePredicateContract,
  type Hardness,
  buildTimePredicateContract,
  resolveProxyChoice,
  detectTimePredicate,
  inferHardness,
} from './time-predicate';

export type LiveMusicVerification = 'website_verify' | 'best_effort' | null;
export type TimePredicateResolution = 'news_mention' | 'recent_reviews' | 'best_effort' | null;

export interface AttributeConstraint {
  type: 'attribute';
  attribute: string;
  verifiability: 'verifiable' | 'proxy' | 'unverifiable';
  requires_clarification: boolean;
  chosen_verification: LiveMusicVerification;
  hardness: Hardness;
}

export type Constraint = TimePredicateContract | AttributeConstraint;

export interface ConstraintContract {
  constraints: Constraint[];
  can_execute: boolean;
  why_blocked: string | null;
  clarify_questions: string[];
  stop_recommended: boolean;
}

export interface PendingConstraintState {
  conversationId: string;
  originalMessage: string;
  contract: ConstraintContract;
  createdAt: number;
}

const pendingContracts = new Map<string, PendingConstraintState>();
const PENDING_TTL_MS = 15 * 60 * 1000;

const BLOCKING_ATTRIBUTES = new Set(['live_music']);

const ATTRIBUTE_PATTERNS: { pattern: RegExp; attribute: string }[] = [
  { pattern: /\b(?:have|has|with|offer(?:s|ing)?|featuring?)\s+live\s*music\b/i, attribute: 'live_music' },
  { pattern: /\blive\s*music\b/i, attribute: 'live_music' },
  { pattern: /\b(?:have|has|with|offer(?:s|ing)?|featuring?)\s+craft\s*beer\b/i, attribute: 'craft_beer' },
  { pattern: /\bcraft\s*beer\b/i, attribute: 'craft_beer' },
  { pattern: /\b(?:have|has|with|offer(?:s|ing)?|featuring?)\s+real\s*ale\b/i, attribute: 'real_ale' },
  { pattern: /\breal\s*ale\b/i, attribute: 'real_ale' },
  { pattern: /\b(?:have|has|with|offer(?:s|ing)?|featuring?)\s+(?:a\s+)?beer\s*garden\b/i, attribute: 'beer_garden' },
  { pattern: /\bbeer\s*garden\b/i, attribute: 'beer_garden' },
  { pattern: /\b(?:have|has|with|offer(?:s|ing)?|featuring?)\s+outdoor\s*seating\b/i, attribute: 'outdoor_seating' },
  { pattern: /\boutdoor\s*seating\b/i, attribute: 'outdoor_seating' },
  { pattern: /\b(?:have|has|with|offer(?:s|ing)?|featuring?)\s+(?:a\s+)?rooftop\b/i, attribute: 'rooftop' },
  { pattern: /\brooftop\b/i, attribute: 'rooftop' },
  { pattern: /\bdog\s*friendly\b/i, attribute: 'dog_friendly' },
  { pattern: /\bfamily\s*friendly\b/i, attribute: 'family_friendly' },
  { pattern: /\bfree\s*wifi\b/i, attribute: 'free_wifi' },
  { pattern: /\bwheelchair\s*accessible\b/i, attribute: 'wheelchair_accessible' },
  { pattern: /\bparking\b/i, attribute: 'parking' },
  { pattern: /\bvegan\b/i, attribute: 'vegan' },
  { pattern: /\bvegetarian\b/i, attribute: 'vegetarian' },
  { pattern: /\bfood\s*served\b/i, attribute: 'food_served' },
  { pattern: /\blate[- ]?\s*night\b/i, attribute: 'late_night' },
];

const NO_PROXY_PATTERNS = /\b(?:no\s+prox(?:y|ies)|must\s+be\s+certain|must\s+be\s+(?:guaranteed|verified|exact|accurate)|no\s+approximation|don'?t\s+use\s+(?:any\s+)?prox(?:y|ies)|without\s+prox(?:y|ies)|certain\s+(?:about|of))\b/i;

const PROXY_SELECTION_PATTERNS: { pattern: RegExp; proxyId: string }[] = [
  { pattern: /\b(?:use|accept|try|go\s+with|pick|choose|select)\s+(?:the\s+)?(?:first\s+)?(?:recent\s*)?reviews?\s*(?:proxy)?\b/i, proxyId: 'recent_reviews' },
  { pattern: /\b(?:use|accept|try|go\s+with|pick|choose|select)\s+(?:the\s+)?(?:first\s+)?news\s*(?:mention)?\s*(?:proxy)?\b/i, proxyId: 'news_mention' },
  { pattern: /\brecent\s*reviews?\s*(?:proxy|option|method)?\b/i, proxyId: 'recent_reviews' },
  { pattern: /\bnews\s*mentions?\s*(?:proxy|option|method)?\b/i, proxyId: 'news_mention' },
  { pattern: /\boption\s*[Aa]\b/i, proxyId: 'news_mention' },
  { pattern: /\boption\s*[Bb]\b/i, proxyId: 'recent_reviews' },
  { pattern: /\bfirst\s+(?:option|one|proxy)\b/i, proxyId: 'news_mention' },
  { pattern: /\bsecond\s+(?:option|one|proxy)\b/i, proxyId: 'recent_reviews' },
  { pattern: /\b[Aa]\b\)?.*news/i, proxyId: 'news_mention' },
  { pattern: /\b[Bb]\b\)?.*reviews?/i, proxyId: 'recent_reviews' },
  { pattern: /^[Aa]\s*\)\s*$/i, proxyId: 'news_mention' },
  { pattern: /^[Bb]\s*\)\s*$/i, proxyId: 'recent_reviews' },
];

const BEST_EFFORT_PATTERNS = /\b(?:best[- ]?effort|unverified\s+(?:is\s+)?(?:ok|fine|acceptable|good)|don'?t\s+(?:need\s+to\s+)?verify|skip\s+verif|proceed\s+(?:unverified|without\s+verif)|that'?s?\s+(?:ok|fine)|option\s*(?:3|three|[Cc])\b|[Cc]\))/i;

const LIVE_MUSIC_VERIFY_PATTERNS = /(?:\bverify\s+(?:[\w\s]*?)(?:via|through|using)\s+(?:website|listings?|web)\b|\bverify\s+via\s+(?:website|listings?|web)\b|\bcheck\s+(?:website|listings?)\b|\bwebsite\s+verif|\boption\s*(?:1|one)\b|\b[Aa]\b\s*\)|\b[Aa]\b\s*(?:for\s+live))/i;
const LIVE_MUSIC_BEST_EFFORT_PATTERNS = /(?:\bbest[- ]?effort\b|\bunverified\s+(?:is\s+)?(?:ok|fine|acceptable|good)\b|\bdon'?t\s+(?:need\s+to\s+)?verify\b|\bskip\s+verif|\boption\s*(?:2|two)\b|\b[Bb]\b\s*\)|\b[Bb]\b\s*(?:for\s+live))/i;

export function extractAttributes(msg: string): AttributeConstraint[] {
  const found = new Set<string>();
  const result: AttributeConstraint[] = [];

  for (const entry of ATTRIBUTE_PATTERNS) {
    if (entry.pattern.test(msg) && !found.has(entry.attribute)) {
      found.add(entry.attribute);
      const isBlocking = BLOCKING_ATTRIBUTES.has(entry.attribute);
      result.push({
        type: 'attribute',
        attribute: entry.attribute,
        verifiability: isBlocking ? 'proxy' : 'verifiable',
        requires_clarification: isBlocking,
        chosen_verification: null,
        hardness: inferHardness(msg),
      });
    }
  }

  return result;
}

export function extractAllConstraints(msg: string): Constraint[] {
  const constraints: Constraint[] = [];

  const timePredicate = buildTimePredicateContract(msg);
  if (timePredicate) {
    constraints.push(timePredicate);
  }

  const attributes = extractAttributes(msg);
  for (const attr of attributes) {
    constraints.push(attr);
  }

  return constraints;
}

export function detectNoProxySignal(msg: string): boolean {
  return NO_PROXY_PATTERNS.test(msg);
}

export function detectProxySelection(msg: string): string | null {
  if (BEST_EFFORT_PATTERNS.test(msg)) return null;

  for (const entry of PROXY_SELECTION_PATTERNS) {
    if (entry.pattern.test(msg)) {
      return entry.proxyId;
    }
  }
  return null;
}

export function detectBestEffort(msg: string): boolean {
  return BEST_EFFORT_PATTERNS.test(msg);
}

export function detectLiveMusicChoice(msg: string): LiveMusicVerification {
  if (LIVE_MUSIC_VERIFY_PATTERNS.test(msg)) return 'website_verify';
  if (LIVE_MUSIC_BEST_EFFORT_PATTERNS.test(msg)) return 'best_effort';
  return null;
}

function detectWindowFromFollowUp(msg: string): { window: string; window_days: number } | null {
  const windowPattern = /\b(?:last|past)\s+(\d+)\s+(months?|years?|weeks?|days?)\b/i;
  const match = msg.match(windowPattern);
  if (match) {
    const n = parseInt(match[1], 10);
    const unit = match[2].toLowerCase().replace(/s$/, '');
    let days = n * 30;
    if (unit === 'day') days = n;
    else if (unit === 'week') days = n * 7;
    else if (unit === 'year') days = n * 365;
    return { window: `${n} ${match[2].toLowerCase()}`, window_days: days };
  }

  if (/\bthis\s+year\b/i.test(msg)) {
    return { window: 'this year', window_days: 365 };
  }

  return null;
}

const TIME_PREDICATE_QUESTION = `I can't guarantee opening dates from listings. Do you want me to use a proxy or treat this as best-effort unverified?\n\nA) Use news mentions proxy\nB) Use first reviews proxy\nC) Best-effort, unverified is OK`;

const LIVE_MUSIC_QUESTION = `Live music isn't reliably verified from Places data. Do you want me to verify via website / listings (slower) or treat as best-effort unverified?\n\nA) Verify via website / listings\nB) Best-effort, unverified is OK`;

function isTimePredicateUnresolved(c: Constraint): boolean {
  if (c.type !== 'time_predicate') return false;
  return !c.can_execute;
}

function isLiveMusicUnresolved(c: Constraint): boolean {
  if (c.type !== 'attribute') return false;
  if (c.attribute !== 'live_music') return false;
  return c.requires_clarification && c.chosen_verification === null;
}

function buildGateState(constraints: Constraint[], isNoProxy: boolean): ConstraintContract {
  const clarify_questions: string[] = [];
  const blockReasons: string[] = [];
  let stop_recommended = false;

  const hasTimePredicate = constraints.some(c => c.type === 'time_predicate');
  const hasLiveMusic = constraints.some(c => c.type === 'attribute' && c.attribute === 'live_music');

  for (const c of constraints) {
    if (c.type === 'time_predicate') {
      if (isNoProxy || (c.verifiability === 'unverifiable' && c.hardness === 'hard')) {
        stop_recommended = true;
        blockReasons.push(c.why_blocked || 'Opening dates cannot be verified from any available data source. This constraint cannot be satisfied.');
      } else if (!c.can_execute) {
        clarify_questions.push(TIME_PREDICATE_QUESTION);
        blockReasons.push(c.why_blocked || 'Time predicate requires proxy selection or best-effort acceptance.');
      }
    } else if (c.type === 'attribute' && c.attribute === 'live_music') {
      if (c.requires_clarification && c.chosen_verification === null) {
        clarify_questions.push(LIVE_MUSIC_QUESTION);
        blockReasons.push('Live music cannot be reliably verified from Places data alone.');
      }
    }
  }

  const anyBlocked =
    constraints.some(c => isTimePredicateUnresolved(c)) ||
    constraints.some(c => isLiveMusicUnresolved(c));

  const can_execute = !anyBlocked && !stop_recommended;

  return {
    constraints,
    can_execute,
    why_blocked: blockReasons.length > 0 ? blockReasons.join(' ') : null,
    clarify_questions,
    stop_recommended,
  };
}

export function preExecutionConstraintGate(msg: string): ConstraintContract {
  const constraints = extractAllConstraints(msg);

  if (constraints.length === 0) {
    return {
      constraints: [],
      can_execute: true,
      why_blocked: null,
      clarify_questions: [],
      stop_recommended: false,
    };
  }

  const isNoProxy = detectNoProxySignal(msg);

  if (isNoProxy) {
    for (const c of constraints) {
      if (c.type === 'time_predicate') {
        c.hardness = 'hard';
        c.verifiability = 'unverifiable';
        c.can_execute = false;
        c.why_blocked = 'User requires certainty but opening dates cannot be verified from any available data source. This constraint cannot be satisfied.';
        c.suggested_rephrase = null;
      }
    }
  }

  return buildGateState(constraints, isNoProxy);
}

export function resolveFollowUp(
  existingContract: ConstraintContract,
  followUpMsg: string,
): ConstraintContract {
  const noProxy = detectNoProxySignal(followUpMsg);
  const proxyChoice = detectProxySelection(followUpMsg);
  const bestEffort = detectBestEffort(followUpMsg);
  const windowInfo = detectWindowFromFollowUp(followUpMsg);
  const liveMusicChoice = detectLiveMusicChoice(followUpMsg);

  const updatedConstraints = existingContract.constraints.map(c => {
    if (c.type === 'time_predicate') {
      let updated = { ...c };

      if (windowInfo && updated.required_inputs_missing.includes('time_window')) {
        updated = {
          ...updated,
          window: windowInfo.window,
          window_days: windowInfo.window_days,
          required_inputs_missing: updated.required_inputs_missing.filter(f => f !== 'time_window'),
        };
      }

      if (noProxy) {
        updated = {
          ...updated,
          hardness: 'hard',
          verifiability: 'unverifiable',
          can_execute: false,
          why_blocked: 'User rejected all proxy options. Opening dates cannot be verified, so this constraint cannot be satisfied.',
          suggested_rephrase: null,
          chosen_proxy: null,
        };
      } else if (bestEffort) {
        updated = {
          ...updated,
          hardness: 'soft',
          verifiability: 'unverifiable',
          can_execute: true,
          why_blocked: null,
          suggested_rephrase: null,
          chosen_proxy: 'best_effort',
        };
      } else if (proxyChoice) {
        updated = resolveProxyChoice(updated, proxyChoice);
      }

      return updated;
    }

    if (c.type === 'attribute' && c.attribute === 'live_music' && c.requires_clarification && c.chosen_verification === null) {
      if (liveMusicChoice) {
        return { ...c, chosen_verification: liveMusicChoice, requires_clarification: false };
      }
      if (bestEffort && !existingContract.constraints.some(x => x.type === 'time_predicate')) {
        return { ...c, chosen_verification: 'best_effort' as LiveMusicVerification, requires_clarification: false };
      }
    }

    return c;
  });

  return buildGateState(updatedConstraints, noProxy);
}

export function storePendingContract(conversationId: string, originalMessage: string, contract: ConstraintContract): void {
  pendingContracts.set(conversationId, {
    conversationId,
    originalMessage,
    contract,
    createdAt: Date.now(),
  });
}

export function getPendingContract(conversationId: string): PendingConstraintState | null {
  const state = pendingContracts.get(conversationId);
  if (!state) return null;
  if (Date.now() - state.createdAt > PENDING_TTL_MS) {
    pendingContracts.delete(conversationId);
    return null;
  }
  return state;
}

export function clearPendingContract(conversationId: string): void {
  pendingContracts.delete(conversationId);
}

export function buildConstraintGateMessage(contract: ConstraintContract): string {
  if (contract.stop_recommended) {
    const reason = contract.why_blocked || 'One or more constraints cannot be verified from available data sources.';
    return `I need to stop here. ${reason}\n\nIf you'd like, you can rephrase your request without the unverifiable requirement, and I'll try again.`;
  }

  if (contract.clarify_questions.length > 0) {
    if (contract.clarify_questions.length === 1) {
      return `Before I search, I need to check one thing:\n\n${contract.clarify_questions[0]}`;
    }
    const bullets = contract.clarify_questions.map((q, i) => `${i + 1}. ${q}`).join('\n\n');
    return `Before I search, I need to check a couple of things:\n\n${bullets}`;
  }

  return contract.why_blocked || 'Some constraints need clarification before I can proceed.';
}
