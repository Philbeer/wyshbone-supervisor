import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { callLLMText } from '../supervisor/llm-failover';
import { getRelevantReferenceKnowledge } from '../supervisor/reference-knowledge';
import { getCurrentContextPreamble } from '../supervisor/current-context';
import { supabase } from '../supabase';

export const chatDirectRouter = Router();

/**
 * Direct chat endpoint — no agent plumbing.
 *
 * Receives: { message: string, conversationId?: string, conversationHistory?: Array<{ role: 'user'|'assistant', content: string }> }
 * Returns: { response: string, messageId: string, conversationId: string, durationMs: number }
 *
 * Designed for chat-only tenants (e.g. the Wine Society demo). Does NOT:
 *   - claim a supervisor task
 *   - call the conversation router
 *   - call the turn classifier
 *   - send run-bridge requests
 *   - post Tower artefacts
 *   - log AFR events
 *
 * Just: optional reference knowledge → LLM → DB save → return.
 */

const SYSTEM_PROMPT = `${getCurrentContextPreamble()}

You are a knowledgeable, conversational assistant. Answer the user's question directly and naturally.

Guidelines:
- Concise — 2-5 sentences for simple questions, longer only when complexity requires it
- Conversational tone, not corporate
- Use **bold** sparingly (max 2-3 per response) to highlight key recommendations or names
- For multi-point answers, use line breaks between distinct ideas — no markdown headers, numbered lists, or bullet points
- If reference knowledge is provided about the user's topic, base your answer on it rather than general knowledge
- Never fabricate specific facts (prices, addresses, dates) you are not confident about — say "I'm not sure" if you don't know`;

chatDirectRouter.post('/direct', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const { message, conversationId: incomingConvId, conversationHistory } = req.body || {};

    if (typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'message is required (non-empty string)' });
    }

    const conversationId = incomingConvId || randomUUID();
    const messageId = randomUUID();

    const history: Array<{ role: 'user' | 'assistant'; content: string }> =
      Array.isArray(conversationHistory) ? conversationHistory.slice(-8) : [];

    // 1. Look up relevant reference knowledge (in-memory, ~10ms)
    const referenceKnowledge = getRelevantReferenceKnowledge(message, history);

    // 2. Build the user prompt
    const promptParts: string[] = [];

    if (history.length > 0) {
      promptParts.push('CONVERSATION HISTORY:');
      for (const h of history) {
        const role = h.role === 'user' ? 'User' : 'Assistant';
        const content = (h.content || '').length > 500 ? h.content.substring(0, 500) + '...' : (h.content || '');
        promptParts.push(`${role}: ${content}`);
      }
      promptParts.push('');
    }

    if (referenceKnowledge) {
      promptParts.push('REFERENCE KNOWLEDGE (use this for accurate facts about the topic):');
      promptParts.push(referenceKnowledge);
      promptParts.push('');
    }

    promptParts.push(`User: ${message}`);
    const userPrompt = promptParts.join('\n');

    // 3. Call LLM via failover chain (Groq+Llama first, fast)
    const response = await callLLMText(SYSTEM_PROMPT, userPrompt, 'chat_direct', {
      maxTokens: 1024,
      temperature: 0.7,
      timeoutMs: 15_000,
    });

    // 4. Save to DB (non-blocking — don't make the user wait for this)
    if (supabase) {
      supabase.from('messages').insert({
        id: messageId,
        conversation_id: conversationId,
        role: 'assistant',
        content: response,
        source: 'chat_direct',
        metadata: { handler: 'chat_direct', has_reference: !!referenceKnowledge },
        created_at: Date.now(),
      }).then((result: any) => {
        if (result?.error) {
          console.warn(`[CHAT_DIRECT] DB save failed (non-fatal): ${result.error.message}`);
        }
      }, (err: any) => {
        console.warn(`[CHAT_DIRECT] DB save threw (non-fatal): ${err?.message}`);
      });
    }

    const durationMs = Date.now() - startTime;
    console.log(`[CHAT_DIRECT] Responded in ${durationMs}ms — ${response.length} chars, conv=${conversationId.slice(0, 8)}, ref=${!!referenceKnowledge}`);

    return res.json({
      response,
      messageId,
      conversationId,
      durationMs,
    });
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    console.error(`[CHAT_DIRECT] Failed in ${durationMs}ms: ${err.message}`);
    return res.status(500).json({
      error: err.message || 'Internal error',
      durationMs,
    });
  }
});
