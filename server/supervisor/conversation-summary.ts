/**
 * Conversation Summary — rolling LLM-generated memory.
 *
 * Maintains one summary row per conversation that captures everything a
 * future chat / router LLM call needs to stay coherent beyond the literal
 * sliding window of recent messages.
 *
 * Read path:  getConversationSummary(conversationId) -> string | null
 * Write path: maybeRefreshSummary(conversationId) -> void  (fire-and-forget)
 *
 * Failure modes are silent: if the table is missing, the LLM call fails,
 * or any DB op errors, callers fall through to no-summary mode.
 */

import { supabase } from '../supabase';
import { callLLMText } from './llm-failover';

const SUMMARY_ENABLED = process.env.CONVERSATION_SUMMARY_ENABLED !== 'false';
const REFRESH_THRESHOLD = parseInt(
  process.env.CONVERSATION_SUMMARY_REFRESH_THRESHOLD || '6',
  10,
);
const MAX_HISTORY = parseInt(
  process.env.CONVERSATION_SUMMARY_MAX_HISTORY || '30',
  10,
);
const SUMMARIZER_MODEL =
  process.env.CONVERSATION_SUMMARY_MODEL || 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = parseInt(
  process.env.CONVERSATION_SUMMARY_TIMEOUT_MS || '12000',
  10,
);

const SUMMARY_SYSTEM_PROMPT = `You are a conversation memory summariser for Wyshbone, a B2B lead-generation app that finds and verifies businesses for users.

Your job: read a recent conversation between a user and Wyshbone, and produce a tight, factual summary that captures everything a future Wyshbone reply will need to stay coherent.

The summary will be pinned to the top of every future LLM call in this conversation as background context. It must let the assistant pick up exactly where things left off, even when older messages are no longer visible in the literal window.

WHAT TO INCLUDE:
- Topics and entities discussed (e.g. "pubs in Arundel", "wine merchants", "the Wine Society")
- Locations and geographic constraints mentioned
- The user's stated preferences, intent, and goals
- Searches that were run (entity + location + key constraints) and roughly how many results were delivered
- Open threads — questions the assistant asked that have not yet been answered, suggestions not yet acted on
- Tone or relationship cues if clearly stated (e.g. "user prefers concise replies", "user is a brewery owner")
- Any specific facts the user has shared that future replies must respect (names, dates, requirements)

WHAT TO EXCLUDE:
- Generic chitchat, greetings, sign-offs
- Long verbatim retellings of search result lists — note what was searched and roughly how many delivered, not each business name
- Inferred psychology or anything not actually said
- Verbatim quotes — paraphrase tightly

FORMAT:
- Plain prose. 100 to 300 words.
- No bullet points, no markdown headers, no lists.
- Past tense, third-person ("the user asked about...", not "you asked about...").
- If a previous summary is provided, integrate new information into it — do not append. The output replaces the old summary entirely.

Return ONLY the summary text. No preamble, no commentary, no quotes around it.`;

export async function getConversationSummary(
  conversationId: string,
): Promise<string | null> {
  if (!SUMMARY_ENABLED || !supabase || !conversationId) return null;

  try {
    const { data, error } = await supabase
      .from('conversation_summaries')
      .select('summary')
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (error) {
      if (error.code === 'PGRST205' || error.code === '42P01') return null;
      console.warn(`[CONV_SUMMARY] Read failed (non-fatal): ${error.message}`);
      return null;
    }

    return data?.summary || null;
  } catch (err: any) {
    console.warn(`[CONV_SUMMARY] Read exception (non-fatal): ${err.message}`);
    return null;
  }
}

export async function maybeRefreshSummary(
  conversationId: string,
): Promise<void> {
  if (!SUMMARY_ENABLED || !supabase || !conversationId) return;

  try {
    const { data: existing, error: readErr } = await supabase
      .from('conversation_summaries')
      .select('last_summarized_message_count, summary')
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (readErr) {
      if (
        readErr.code === 'PGRST205' ||
        readErr.code === '42P01' ||
        readErr.code === 'PGRST116'
      ) {
        // Table missing or no row — both fine, fall through.
      } else {
        console.warn(`[CONV_SUMMARY] Refresh read failed: ${readErr.message}`);
        return;
      }
    }

    const lastCount = existing?.last_summarized_message_count || 0;
    const existingSummary = existing?.summary || null;

    const { count: currentCount, error: countErr } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId);

    if (countErr) {
      console.warn(`[CONV_SUMMARY] Count failed: ${countErr.message}`);
      return;
    }

    const messageCount = currentCount || 0;
    const delta = messageCount - lastCount;

    if (delta < REFRESH_THRESHOLD) return;

    console.log(
      `[CONV_SUMMARY] Refreshing — conversation=${conversationId.slice(0, 8)} ` +
        `messages=${messageCount} lastSummarized=${lastCount} delta=${delta}`,
    );

    const { data: messages, error: msgErr } = await supabase
      .from('messages')
      .select('role, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(MAX_HISTORY);

    if (msgErr || !messages || messages.length === 0) {
      console.warn(
        `[CONV_SUMMARY] Message fetch failed: ${msgErr?.message || 'no messages'}`,
      );
      return;
    }

    const ordered = messages.reverse();

    const parts: string[] = [];
    if (existingSummary) {
      parts.push('PREVIOUS SUMMARY (update and integrate, do not just append):');
      parts.push(existingSummary);
      parts.push('');
    }
    parts.push('RECENT CONVERSATION:');
    for (const msg of ordered) {
      const role = msg.role === 'user' ? 'User' : 'Wyshbone';
      const content = String(msg.content || '').substring(0, 1200);
      parts.push(`${role}: ${content}`);
    }
    parts.push('');
    parts.push('Produce the updated summary now.');

    const userPrompt = parts.join('\n');

    let summary: string;
    try {
      summary = await callLLMText(
        SUMMARY_SYSTEM_PROMPT,
        userPrompt,
        'conv_summary',
        {
          preferredProvider: 'anthropic',
          anthropicModel: SUMMARIZER_MODEL,
          maxTokens: 800,
          temperature: 0.3,
          timeoutMs: TIMEOUT_MS,
        },
      );
    } catch (llmErr: any) {
      console.warn(`[CONV_SUMMARY] LLM failed: ${llmErr.message}`);
      return;
    }

    summary = summary.trim();
    if (summary.startsWith('```')) {
      summary = summary
        .replace(/^```(?:\w+)?\n?/, '')
        .replace(/```$/, '')
        .trim();
    }

    if (!summary || summary.length < 20) {
      console.warn(
        `[CONV_SUMMARY] LLM returned empty / too-short summary, skipping write`,
      );
      return;
    }

    const { error: writeErr } = await supabase
      .from('conversation_summaries')
      .upsert(
        {
          conversation_id: conversationId,
          summary,
          last_summarized_message_count: messageCount,
          last_summarized_at: new Date().toISOString(),
          version: 1,
        },
        { onConflict: 'conversation_id' },
      );

    if (writeErr) {
      console.warn(`[CONV_SUMMARY] Write failed: ${writeErr.message}`);
      return;
    }

    console.log(
      `[CONV_SUMMARY] Refreshed conversation=${conversationId.slice(0, 8)} ` +
        `length=${summary.length} chars messages=${messageCount}`,
    );
  } catch (err: any) {
    console.warn(`[CONV_SUMMARY] Refresh exception (non-fatal): ${err.message}`);
  }
}
