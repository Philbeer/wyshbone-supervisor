/**
 * LLM Failover Utility
 * 
 * Provider order: Groq (if key set) → Anthropic → OpenAI
 * If the preferred provider fails, falls over to the next available one.
 */

type Provider = 'anthropic' | 'openai' | 'groq';

export interface CallLLMOptions {
  system: string;
  user: string;
  label: string;
  maxTokens?: number;
  temperature?: number;
  anthropicModel?: string;
  openaiModel?: string;
  groqModel?: string;
  timeoutMs?: number;
  preferredProvider?: Provider;
}

export interface CallLLMResult {
  text: string;
  provider: Provider;
  failedOver: boolean;
  primaryError: string | null;
  durationMs: number;
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-haiku-20241022';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_TOKENS = 500;

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

async function callGroq(
  system: string,
  user: string,
  model: string,
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.groq.com/openai/v1',
    timeout: timeoutMs,
  });
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

export async function callLLM(options: CallLLMOptions): Promise<CallLLMResult> {
  const {
    system,
    user,
    label,
    maxTokens = DEFAULT_MAX_TOKENS,
    temperature = 0,
    anthropicModel = process.env[`${label.toUpperCase()}_LLM_MODEL`] || DEFAULT_ANTHROPIC_MODEL,
    openaiModel = DEFAULT_OPENAI_MODEL,
    groqModel = process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL,
    timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10),
  } = options;

  const hasGroq = !!process.env.GROQ_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;

  if (!hasGroq && !hasAnthropic && !hasOpenAI) {
    throw new Error(`[LLM:${label}] No LLM API key configured (need GROQ_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY)`);
  }

  let preferred: Provider;
  if (options.preferredProvider) {
    preferred = options.preferredProvider;
  } else if (hasGroq) {
    preferred = 'groq';
  } else if (hasAnthropic) {
    preferred = 'anthropic';
  } else {
    preferred = 'openai';
  }

  const allProviders: Provider[] = ['groq', 'anthropic', 'openai'];
  const available = allProviders.filter(p =>
    p === 'groq' ? hasGroq : p === 'anthropic' ? hasAnthropic : hasOpenAI
  );
  const chain = [preferred, ...available.filter(p => p !== preferred)];

  const startTime = Date.now();
  let lastError = '';

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    const isFirst = i === 0;

    try {
      const text = await callProvider(provider, system, user, anthropicModel, openaiModel, groqModel, maxTokens, temperature, timeoutMs, label);
      if (!isFirst) {
        console.log(`[LLM:${label}] Failover to ${provider} succeeded (total ${Date.now() - startTime}ms)`);
      }
      return {
        text,
        provider,
        failedOver: !isFirst,
        primaryError: isFirst ? null : lastError,
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      lastError = err.name === 'AbortError'
        ? `timeout after ${timeoutMs}ms`
        : err.message || String(err);

      const nextProvider = chain[i + 1];
      console.warn(`[LLM:${label}] ${provider} failed: ${lastError}${nextProvider ? ` — trying ${nextProvider}` : ' — no more providers'}`);
    }
  }

  throw new Error(`[LLM:${label}] All providers failed. Last error: ${lastError}`);
}

async function callProvider(
  provider: Provider,
  system: string,
  user: string,
  anthropicModel: string,
  openaiModel: string,
  groqModel: string,
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
  label: string,
): Promise<string> {
  if (provider === 'groq') {
    return await callGroq(system, user, groqModel, maxTokens, temperature, timeoutMs);
  } else if (provider === 'anthropic') {
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

export async function callLLMText(
  system: string,
  user: string,
  label: string,
  overrides?: Partial<CallLLMOptions>,
): Promise<string> {
  const result = await callLLM({ system, user, label, ...overrides });
  return result.text;
}

export async function callLLMStream(
  system: string,
  user: string,
  label: string,
  onChunk: (accumulated: string, delta: string) => void,
  overrides?: Partial<CallLLMOptions>,
): Promise<string> {
  const anthropicModel = overrides?.anthropicModel || process.env.CHAT_LLM_MODEL || 'claude-sonnet-4-6';
  const groqModel = overrides?.groqModel || process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
  const maxTokens = overrides?.maxTokens || 2048;
  const temperature = overrides?.temperature ?? 0.7;
  const timeoutMs = overrides?.timeoutMs || 30000;

  if (process.env.GROQ_API_KEY) {
    try {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: 'https://api.groq.com/openai/v1',
        timeout: timeoutMs,
      });

      const stream = await client.chat.completions.create({
        model: groqModel,
        temperature,
        max_tokens: maxTokens,
        stream: true,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });

      let accumulated = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) {
          accumulated += delta;
          onChunk(accumulated, delta);
        }
      }

      console.log(`[LLM_STREAM:${label}] Groq completed — ${accumulated.length} chars`);
      return accumulated;
    } catch (err: any) {
      console.warn(`[LLM_STREAM:${label}] Groq stream failed (${err.message}) — falling back to Anthropic`);
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn(`[LLM_STREAM:${label}] No ANTHROPIC_API_KEY — falling back to non-streaming`);
    const text = await callLLMText(system, user, label, overrides);
    onChunk(text, text);
    return text;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: anthropicModel,
        max_tokens: maxTokens,
        temperature,
        stream: true,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '(no body)');
      throw new Error(`Anthropic ${resp.status}: ${body.substring(0, 200)}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error('No response body reader');

    const decoder = new TextDecoder();
    let accumulated = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const delta = event.delta.text || '';
            accumulated += delta;
            onChunk(accumulated, delta);
          }
        } catch {
          // skip unparseable lines
        }
      }
    }

    console.log(`[LLM_STREAM:${label}] Anthropic completed — ${accumulated.length} chars`);
    return accumulated;
  } catch (err: any) {
    clearTimeout(timeoutId);
    console.warn(`[LLM_STREAM:${label}] Anthropic stream failed (${err.message}) — falling back to non-streaming`);
    const text = await callLLMText(system, user, label, overrides);
    onChunk(text, text);
    return text;
  } finally {
    clearTimeout(timeoutId);
  }
}
