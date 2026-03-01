// Supervisor is the sole authority for constraint interpretation and verifiability.
// UI and Tower must not invent or infer time predicate fields — they consume this contract as-is.

export type TimePredicateVerb = 'opened' | 'closed' | 'renovated' | 'new_listing' | 'recent_reviews' | 'news_mention';
export type Verifiability = 'verifiable' | 'proxy' | 'unverifiable';
export type Hardness = 'hard' | 'soft';

export interface ProxyOption {
  id: string;
  label: string;
  description: string;
  supported: boolean;
}

export interface TimePredicateContract {
  type: 'time_predicate';
  predicate: TimePredicateVerb;
  window: string | null;
  window_days: number | null;
  reference_date: 'now';
  hardness: Hardness;
  verifiability: Verifiability;
  required_inputs_missing: string[];
  can_execute: boolean;
  why_blocked: string | null;
  suggested_rephrase: string | null;
  proxy_options: ProxyOption[];
  chosen_proxy: string | null;
  must_be_certain?: boolean;
}

const PROXY_OPTIONS: ProxyOption[] = [
  {
    id: 'recent_reviews',
    label: 'Recent reviews',
    description: 'Venues with first Google review within the specified window, or an unusually recent spike in review activity',
    supported: true,
  },
  {
    id: 'news_mention',
    label: 'News/web mentions',
    description: 'Web evidence (news articles, blog posts) mentioning opening within the specified window',
    supported: true,
  },
  {
    id: 'new_listing',
    label: 'New listing date',
    description: 'First-seen listing date from our index (not currently available)',
    supported: false,
  },
  {
    id: 'companies_house_incorp',
    label: 'Companies House incorporation',
    description: 'Companies House incorporation date — only applies to registered companies, not venues (not currently available)',
    supported: false,
  },
];

const TIME_PHRASES: { pattern: RegExp; predicate: TimePredicateVerb; extractWindow: (match: RegExpMatchArray) => { window: string | null; window_days: number | null } }[] = [
  {
    pattern: /\b(?:opened|started|founded|established|launched)\s+(?:in\s+(?:the\s+)?)?(?:last|past)\s+(\d+)\s+(months?|years?|weeks?|days?)\b/i,
    predicate: 'opened',
    extractWindow: (m) => {
      const n = parseInt(m[1], 10);
      const unit = m[2].toLowerCase().replace(/s$/, '');
      const days = unitToDays(n, unit);
      return { window: `${n} ${m[2].toLowerCase()}`, window_days: days };
    },
  },
  {
    pattern: /\b(?:opened|started|founded|established|launched)\s+this\s+year\b/i,
    predicate: 'opened',
    extractWindow: () => ({ window: 'this year', window_days: 365 }),
  },
  {
    pattern: /\b(?:opened|started|founded|established|launched)\s+recently\b/i,
    predicate: 'opened',
    extractWindow: () => ({ window: null, window_days: null }),
  },
  {
    pattern: /\bnewly\s+(?:opened|started|founded|established|launched)\b/i,
    predicate: 'opened',
    extractWindow: () => ({ window: null, window_days: null }),
  },
  {
    pattern: /\bjust\s+(?:opened|started|founded|established|launched)\b/i,
    predicate: 'opened',
    extractWindow: () => ({ window: null, window_days: null }),
  },
  {
    pattern: /\b(?:new|brand\s*new)\s+(?:businesses?|shops?|stores?|venues?|restaurants?|cafes?|bars?|pubs?|dentists?|salons?|gyms?|clinics?|offices?)\b/i,
    predicate: 'opened',
    extractWindow: () => ({ window: null, window_days: null }),
  },
  {
    pattern: /\bclosed\s+(?:in\s+(?:the\s+)?)?(?:last|past)\s+(\d+)\s+(months?|years?|weeks?|days?)\b/i,
    predicate: 'closed',
    extractWindow: (m) => {
      const n = parseInt(m[1], 10);
      const unit = m[2].toLowerCase().replace(/s$/, '');
      return { window: `${n} ${m[2].toLowerCase()}`, window_days: unitToDays(n, unit) };
    },
  },
  {
    pattern: /\bclosed\s+recently\b/i,
    predicate: 'closed',
    extractWindow: () => ({ window: null, window_days: null }),
  },
  {
    pattern: /\brenovated\s+(?:in\s+(?:the\s+)?)?(?:last|past)\s+(\d+)\s+(months?|years?|weeks?|days?)\b/i,
    predicate: 'renovated',
    extractWindow: (m) => {
      const n = parseInt(m[1], 10);
      const unit = m[2].toLowerCase().replace(/s$/, '');
      return { window: `${n} ${m[2].toLowerCase()}`, window_days: unitToDays(n, unit) };
    },
  },
  {
    pattern: /\brenovated\s+recently\b/i,
    predicate: 'renovated',
    extractWindow: () => ({ window: null, window_days: null }),
  },
];

const HARD_SIGNALS = /\b(?:must\s+have|definitely|only\s+(?:those|ones)\s+(?:that|which)|strictly|guaranteed|certainly|exactly)\b/i;

function unitToDays(n: number, unit: string): number {
  switch (unit) {
    case 'day': return n;
    case 'week': return n * 7;
    case 'month': return n * 30;
    case 'year': return n * 365;
    default: return n * 30;
  }
}

export function detectTimePredicate(msg: string): { predicate: TimePredicateVerb; window: string | null; window_days: number | null } | null {
  for (const entry of TIME_PHRASES) {
    const match = msg.match(entry.pattern);
    if (match) {
      const { window, window_days } = entry.extractWindow(match);
      return { predicate: entry.predicate, window, window_days };
    }
  }
  return null;
}

export function inferHardness(msg: string): Hardness {
  return HARD_SIGNALS.test(msg) ? 'hard' : 'soft';
}

export function buildTimePredicateContract(
  msg: string,
  overrides?: { chosen_proxy?: string | null; window?: string | null; window_days?: number | null },
): TimePredicateContract | null {
  const detected = detectTimePredicate(msg);
  if (!detected) return null;

  const hardness = inferHardness(msg);

  const supportedProxies = PROXY_OPTIONS.filter(p => p.supported);
  const allProxies = [...PROXY_OPTIONS];

  const effectiveWindow = overrides?.window ?? detected.window;
  const effectiveWindowDays = overrides?.window_days ?? detected.window_days;

  const required_inputs_missing: string[] = [];
  if (effectiveWindow === null) {
    required_inputs_missing.push('time_window');
  }

  const chosenProxy = overrides?.chosen_proxy ?? null;
  const proxyIsValid = chosenProxy ? supportedProxies.some(p => p.id === chosenProxy) : false;

  let can_execute = false;
  let why_blocked: string | null = null;
  let suggested_rephrase: string | null = null;

  const windowMissing = required_inputs_missing.includes('time_window');

  if (chosenProxy && proxyIsValid && !windowMissing) {
    can_execute = true;
  } else if (chosenProxy && proxyIsValid && windowMissing) {
    can_execute = false;
    why_blocked = 'Time window is ambiguous (e.g. "recently"). Please specify a concrete window like "last 12 months" or "last 6 months".';
    suggested_rephrase = 'How recently? e.g. "in the last 12 months", "in the last 6 months", "this year".';
  } else if (chosenProxy && !proxyIsValid) {
    can_execute = false;
    why_blocked = `The chosen proxy "${chosenProxy}" is not supported in our current toolset.`;
    suggested_rephrase = 'Choose from the supported proxy options, or accept that opening dates cannot be verified.';
  } else if (hardness === 'hard') {
    can_execute = false;
    why_blocked = 'Opening dates cannot be verified directly from Google Places. A proxy must be accepted, or the constraint must be relaxed.';
    suggested_rephrase = 'Would you accept a proxy check (e.g. recent reviews or news mentions) instead of guaranteed opening dates?';
  } else {
    can_execute = false;
    why_blocked = 'Opening dates cannot be verified directly. Please choose an acceptable proxy or I should stop.';
    suggested_rephrase = 'Try: "use recent reviews as a proxy" or "use news mentions as a proxy".';
  }

  return {
    type: 'time_predicate',
    predicate: detected.predicate,
    window: effectiveWindow,
    window_days: effectiveWindowDays,
    reference_date: 'now',
    hardness,
    verifiability: 'proxy',
    required_inputs_missing,
    can_execute,
    why_blocked,
    suggested_rephrase,
    proxy_options: allProxies,
    chosen_proxy: proxyIsValid ? chosenProxy : null,
  };
}

export function resolveProxyChoice(
  contract: TimePredicateContract,
  choice: string | null,
): TimePredicateContract {
  if (choice === null || choice === 'none' || choice === 'no proxies') {
    return {
      ...contract,
      hardness: 'hard',
      verifiability: 'unverifiable',
      can_execute: false,
      why_blocked: 'User rejected all proxy options. Opening dates cannot be verified, so this constraint cannot be satisfied.',
      suggested_rephrase: null,
      chosen_proxy: null,
    };
  }

  const supported = contract.proxy_options.find(p => p.id === choice && p.supported);
  if (!supported) {
    return {
      ...contract,
      can_execute: false,
      why_blocked: `The proxy "${choice}" is not supported in our current toolset.`,
      suggested_rephrase: 'Choose from the supported proxy options: ' + contract.proxy_options.filter(p => p.supported).map(p => p.label).join(', ') + '.',
      chosen_proxy: null,
    };
  }

  const windowStillMissing = contract.required_inputs_missing.includes('time_window');
  if (windowStillMissing) {
    return {
      ...contract,
      verifiability: 'proxy',
      can_execute: false,
      why_blocked: 'Time window is ambiguous (e.g. "recently"). Please specify a concrete window like "last 12 months" or "last 6 months".',
      suggested_rephrase: 'How recently? e.g. "in the last 12 months", "in the last 6 months", "this year".',
      chosen_proxy: choice,
    };
  }

  return {
    ...contract,
    verifiability: 'proxy',
    can_execute: true,
    why_blocked: null,
    suggested_rephrase: null,
    chosen_proxy: choice,
  };
}

export function buildClarifyQuestion(contract: TimePredicateContract): string {
  const supportedProxies = contract.proxy_options.filter(p => p.supported);
  const windowMissing = contract.required_inputs_missing.includes('time_window');
  const windowDesc = contract.window ? `within ${contract.window}` : 'recently';
  const options = supportedProxies.map((p, i) => `(${i + 1}) ${p.description}`).join(', or ');

  let question = `I can't guarantee opening dates from Places data. Which proxy is acceptable for "${contract.predicate} ${windowDesc}": ${options}? If none are acceptable, I should stop.`;

  if (windowMissing) {
    question += ` Also, how recently do you mean? Please specify a window, e.g. "last 12 months" or "last 6 months".`;
  }

  return question;
}

export function buildHonestyLine(contract: TimePredicateContract): string | null {
  if (!contract.chosen_proxy) return null;
  const proxy = contract.proxy_options.find(p => p.id === contract.chosen_proxy);
  const label = proxy ? proxy.label.toLowerCase() : contract.chosen_proxy;
  return `Opening date can't be guaranteed; results use proxy: ${label}.`;
}

export function getSupportedProxyIds(): string[] {
  return PROXY_OPTIONS.filter(p => p.supported).map(p => p.id);
}
