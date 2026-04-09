/**
 * LLM Failover Utility
 * 
 * Single shared function for all LLM calls across the supervisor pipeline.
 * Tries the primary provider with a timeout. If it fails (timeout, API error,
 * rate limit), automatically falls back to the other provider.
 * 
 * Usage:
 *   import { callLLM } from './llm-failover';
 *   const text = await callLLM({ system: '...', user: '...', label: 'router' });
 */

// ─── Types ──────────────────────────────────────────────────────────────────

type Provider = 'anthropic' | 'openai';

export interface CallLLMOptions {
  /** System prompt */
  system: string;
  /** User message */
  user: string;
  /** Label for logging (e.g. 'router', 'discussion', 'rescue') */
  label: string;
  /** Max tokens in response (default: 500) */
  maxTokens?: number;
  /** Temperature (default: 0) */
  temperature?: number;
  /** Override Anthropic model (default: claude-3-5-haiku-20241022) */
  anthropicModel?: string;
  /** Override OpenAI model (default: gpt-4o-mini) */
  openaiModel?: string;
  /** Timeout in ms (default: 15000) */
  timeoutMs?: number;
  /** Which provider to try first. Defaults to whichever key is set, preferring Anthropic */
  preferredProvider?: Provider;
}

export interface CallLLMResult {
  text: string;
  provider: Provider;
  failedOver: boolean;
  primaryError: string | null;
  durationMs: number;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-haiku-20241022';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_TOKENS = 500;

// ─── Provider Calls ─────────────────────────────────────────────────────────

async function callAnthropic(
  system: string,
  user: string,
  model: string,
  maxTokens: number,
  temperature: number,
  signal: AbortSignal,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal,
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '(no body)');
    throw new Error(`Anthropic ${resp.status}: ${body.substring(0, 200)}`);
  }

  const data = (await resp.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const textBlock = data.content?.find((b) => b.type === 'text');
  return textBlock?.text || '';
}

async function callOpenAI(
  system: string,
  user: string,
  model: string,
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey, timeout: timeoutMs });
  const response = await client.chat.completions.create({
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return response.choices[0]?.message?.content || '';
}

// ─── Main Export ─────────────────────────────────────────────────────────────

/**
 * Call an LLM with automatic failover between providers.
 * 
 * Tries the preferred provider first (default: Anthropic if key exists).
 * If it fails (timeout, error, rate limit), tries the other provider.
 * If both fail, throws the last error.
 * 
 * Every call has a timeout via AbortController (Anthropic) or SDK timeout (OpenAI).
 */
export async function callLLM(options: CallLLMOptions): Promise<CallLLMResult> {
  const {
    system,
    user,
    label,
    maxTokens = DEFAULT_MAX_TOKENS,
    temperature = 0,
    anthropicModel = process.env[`${label.toUpperCase()}_LLM_MODEL`] || DEFAULT_ANTHROPIC_MODEL,
    openaiModel = DEFAULT_OPENAI_MODEL,
    timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10),
  } = options;

  // Determine provider order
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;

  if (!hasAnthropic && !hasOpenAI) {
    throw new Error(`[LLM:${label}] No LLM API key configured (need ANTHROPIC_API_KEY or OPENAI_API_KEY)`);
  }

  let preferred: Provider;
  if (options.preferredProvider) {
    preferred = options.preferredProvider;
  } else if (hasAnthropic) {
    preferred = 'anthropic';
  } else {
    preferred = 'openai';
  }

  const fallback: Provider = preferred === 'anthropic' ? 'openai' : 'anthropic';
  const hasFallback = fallback === 'anthropic' ? hasAnthropic : hasOpenAI;

  const startTime = Date.now();

  // ── Try primary provider ──
  try {
    const text = await callProvider(preferred, system, user, anthropicModel, openaiModel, maxTokens, temperature, timeoutMs, label);
    return {
      text,
      provider: preferred,
      failedOver: false,
      primaryError: null,
      durationMs: Date.now() - startTime,
    };
  } catch (primaryErr: any) {
    const errMsg = primaryErr.name === 'AbortError'
      ? `timeout after ${timeoutMs}ms`
      : primaryErr.message || String(primaryErr);
    
    console.warn(`[LLM:${label}] ${preferred} failed: ${errMsg}${hasFallback ? ` — failing over to ${fallback}` : ' — no fallback available'}`);

    if (!hasFallback) {
      throw new Error(`[LLM:${label}] ${preferred} failed and ${fallback} not available: ${errMsg}`);
    }
  }

  // ── Try fallback provider ──
  const failoverStart = Date.now();
  try {
    const text = await callProvider(fallback, system, user, anthropicModel, openaiModel, maxTokens, temperature, timeoutMs, label);
    const totalMs = Date.now() - startTime;
    console.log(`[LLM:${label}] Failover to ${fallback} succeeded (${Date.now() - failoverStart}ms, total ${totalMs}ms)`);
    return {
      text,
      provider: fallback,
      failedOver: true,
      primaryError: `${preferred} failed`,
      durationMs: totalMs,
    };
  } catch (fallbackErr: any) {
    const fallbackMsg = fallbackErr.name === 'AbortError'
      ? `timeout after ${timeoutMs}ms`
      : fallbackErr.message || String(fallbackErr);
    
    throw new Error(`[LLM:${label}] Both providers failed. ${preferred}: see previous log. ${fallback}: ${fallbackMsg}`);
  }
}

// ─── Internal dispatcher ────────────────────────────────────────────────────

async function callProvider(
  provider: Provider,
  system: string,
  user: string,
  anthropicModel: string,
  openaiModel: string,
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
  label: string,
): Promise<string> {
  if (provider === 'anthropic') {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.warn(`[LLM:${label}] Anthropic call timed out after ${timeoutMs}ms — aborting`);
      controller.abort();
    }, timeoutMs);
    try {
      return await callAnthropic(system, user, anthropicModel, maxTokens, temperature, controller.signal);
    } finally {
      clearTimeout(timeoutId);
    }
  } else {
    return await callOpenAI(system, user, openaiModel, maxTokens, temperature, timeoutMs);
  }
}


// ─── Convenience: simple text call (for quick migration) ────────────────────

/**
 * Drop-in replacement for existing callXxxLLM(system, user) functions.
 * Returns just the text string. Throws on total failure.
 */
export async function callLLMText(
  system: string,
  user: string,
  label: string,
  overrides?: Partial<CallLLMOptions>,
): Promise<string> {
  const result = await callLLM({ system, user, label, ...overrides });
  return result.text;
}
