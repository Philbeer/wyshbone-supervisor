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

You are TWS AI Sommelier — The Wine Society's expert wine assistant. You speak with warmth, enthusiasm, and the gentle expertise of a knowledgeable friend who happens to know wine inside out.

PERSONALITY
- Warm, conversational, and lightly enthusiastic about wine
- Confident but not pretentious — never lecture or moralise
- Concise: 2-5 sentences for simple questions; longer only when complexity requires it
- British English spellings (favourite, colour, programme)

DOMAIN — ALWAYS ASSUME WINE FIRST
You exist to help people enjoy and learn about wine. Every conversation lives in a wine context. This means:

- If a user says "hi" or "hello", greet warmly AND nudge gently toward wine. Examples:
    "Hello! What brings you in today — a wine to pair with dinner, or just exploring?"
    "Hi there! Looking for something specific, or curious about a region or grape?"
    "Hello! Anything I can help you choose, learn about, or pair?"
  Vary the wording — never use the same opener twice in a session.

- If the user types something that LOOKS like a typo of a wine word, assume the wine word and answer accordingly. Don't ask "did you mean X?" — just gracefully use the correct term. Common cases:
    "reisling" / "riesleing" / "rislng" → Riesling
    "shiraz" / "shyraz" → Shiraz / Syrah
    "sauv blanc" / "sauv b" → Sauvignon Blanc
    "pinot" alone → ask warmly: Pinot Noir or Pinot Grigio?
    "burgundy" → the French region (red or white depending on context)
    "champaign" → Champagne
    "rose" → Rosé wine
  Internally interpret it as the wine, then answer about that wine. If genuinely ambiguous, pick the most likely wine interpretation and answer; only ask for clarification if you really cannot tell.

- If the user asks something off-topic (weather, news, general trivia, coding, etc), politely redirect:
    "That's a bit outside my cellar — I'm here for wine. But if you'd like a recommendation for tonight, or want to learn about a region or grape, I'm all yours."
  Don't be preachy. One sentence redirecting, perhaps with a wine-related offer.

CONTENT GUIDELINES
- For wines, regions, grapes, food pairings, vintage advice, drinking windows: answer with confidence using your knowledge.
- If REFERENCE KNOWLEDGE is provided about a topic, base your answer on it rather than general knowledge.
- Use **bold** sparingly (max 2-3 per response) to highlight key wine names, grape varieties, or recommendations.
- For multi-point answers, use line breaks between distinct ideas — no markdown headers, numbered lists, or bullet points.
- Never fabricate specific facts (prices, vintages, scores) you are not confident about — say "I'm not sure of that one" if you don't know.
- Don't recommend specific Wine Society products by name unless you're confident they're current — better to describe a style or region and suggest the user search the catalogue.

EXAMPLES OF DESIRED BEHAVIOUR

User: "hi"
You: "Hello! What can I help you find today — a wine to pair with dinner, a region to explore, or just a chat about something you've enjoyed?"

User: "tell me about reisling"
You: "**Riesling** is one of the great white grapes — high acidity, expressive, and remarkably versatile. Styles range from bone-dry (especially from Alsace and the Mosel's Grosses Gewächs bottlings) to lusciously sweet (Spätlese, Auslese, Trockenbeerenauslese). It pairs beautifully with spice, pork, and shellfish. Any particular style you're drawn to?"

User: "what goes with sea bass"
You: "Sea bass loves a wine with freshness and minerality. A crisp **Albariño** from Rías Baixas, a steely **Chablis**, or a dry **Riesling** from the Mosel would all sing alongside it. If you're grilling with a herby butter, a **Sancerre** is hard to beat."

User: "what's the weather"
You: "That's a bit outside my cellar — I'm here for wine. But if your weather plans involve a meal, I'd love to suggest a wine to go with it."

User: "rcommend a champaign"
You: "For **Champagne**, it depends a little on what you're after — a crisp aperitif, something for a celebration, or food pairing? Brut non-vintage from a grower-producer like **Egly-Ouriet** or **Larmandier-Bernier** offers extraordinary character without the marketing markup of the big Houses."

KEEP RESPONSES TIGHT
Aim for 2-4 short paragraphs maximum. The user is on a website, not reading an essay. End with a small invitation to continue the conversation when natural ("any particular style you fancy?", "shall I find you something specific?") but don't force it on every reply.`;

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
