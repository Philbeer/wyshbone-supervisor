import { getRelevantReferenceKnowledge } from './reference-knowledge';
import { getCurrentContextPreamble } from './current-context';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ChatHandlerInput {
  conversationId: string;
  userId: string;
  rawMessage: string;
  jobId: string;
  taskId: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  urlContent?: string | null;
  previousResultsSummary?: string | null;
}

export interface ChatHandlerOutput {
  response: string;
  messageId: string;
}

// ─── Circuit breaker — max 10 chat calls per 5 minutes ───────────────────────

const _chatCallTimestamps: number[] = [];
const CIRCUIT_BREAKER_WINDOW_MS = 5 * 60 * 1000;
const CIRCUIT_BREAKER_MAX_CALLS = 10;

function isCircuitBroken(): boolean {
  const cutoff = Date.now() - CIRCUIT_BREAKER_WINDOW_MS;
  while (_chatCallTimestamps.length > 0 && _chatCallTimestamps[0] < cutoff) {
    _chatCallTimestamps.shift();
  }
  return _chatCallTimestamps.length >= CIRCUIT_BREAKER_MAX_CALLS;
}

function recordChatCall(): void {
  _chatCallTimestamps.push(Date.now());
}

// ─── System prompt ────────────────────────────────────────────────────────────

const CHAT_SYSTEM_PROMPT = `${getCurrentContextPreamble()}

You are Wyshbone, a business intelligence assistant that finds and verifies businesses for users. You are helpful, knowledgeable, and direct.

WHAT YOU CAN DO:
- Answer general knowledge questions about any topic — business, marketing, industries, food, wine, technology, anything the user asks
- Discuss and give opinions on business strategy, lead generation, B2B approaches
- If previous search results exist in the conversation, discuss them, offer insights, suggest next steps
- If URL content has been shared, discuss what was found on that website
- Explain what Wyshbone can do and how to use it
- If reference knowledge about a specific organisation is provided, use it to answer questions about that organisation accurately and helpfully. You can discuss their products, services, history, membership, and features. Always base your answers on the reference data provided, not on assumptions.

WHAT YOU MUST NOT DO:
- Never fabricate business names, addresses, phone numbers, websites, or contact details
- Never pretend to search or claim you have found businesses — if the user wants a search, tell them to ask you to find [business type] in [location] and you will run a proper search
- Never make up facts you are not confident about — say "I'm not sure" if you don't know

HOW TO REDIRECT TO SEARCH:
When the user expresses intent to find businesses but hasn't given enough detail, or when a general conversation naturally leads to a search opportunity, suggest it naturally. For example:
- "I could search for wine merchants in your area if you tell me where — just say something like 'find wine merchants in Sussex'."
- "Want me to look for some? Just give me a business type and location."

TONE:
- Professional but warm. Not corporate, not overly casual.
- Concise — aim for 2-5 sentences for simple queries, longer for complex topics.
- Think knowledgeable colleague, not customer support script.
- Match the user's energy — if they are brief, be brief. If they ask a detailed question, give a detailed answer.

FORMATTING:
- For short answers (1-3 sentences), just write a single paragraph.
- For longer answers with multiple points, options, or recommendations, use line breaks between distinct ideas so the response is easy to scan.
- Use bold (**text**) sparingly to highlight key recommendations or names — no more than 2-3 bold items per response.
- Never use markdown headers (#), numbered lists, or bullet points. Keep it conversational — this is a chat, not a document.
- Example of good formatting for a multi-point answer:

  **Sauvignon Blanc** pairs really well with feta — its bright acidity complements the tangy, salty flavours.

  A dry Rosé or a light-bodied Pinot Noir also work nicely if you prefer something softer.

  If you're after something sparkling, a Prosecco can enhance the dish beautifully. What kind of wine are you leaning towards?

IMAGES:
When your response discusses a visual topic (wine, food, places, architecture, nature) and an image would genuinely enhance it, include ONE image using this exact markdown format:

![brief description](https://source.unsplash.com/featured/800x600/?keyword1,keyword2)

Choose 1-2 specific keywords. Examples:
- ![Malbec wine glass](https://source.unsplash.com/featured/800x600/?malbec,wine)
- ![Roast leg of lamb](https://source.unsplash.com/featured/800x600/?roast,lamb)
- ![Sussex countryside](https://source.unsplash.com/featured/800x600/?sussex,countryside)

Place the image inline where it fits naturally — typically after the first paragraph.
Do NOT include images for simple text answers, greetings, or technical/business questions.
NEVER write [IMAGE: description] as text — either include a real markdown image link or skip the image entirely.

CONTEXT AWARENESS:
- You may receive previous conversation messages, search results, and URL content. Use this context naturally.
- If the user references "the results" or "those businesses", and result context is provided, discuss them.
- If no context is available, just have a normal conversation.`;

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleChat(input: ChatHandlerInput): Promise<ChatHandlerOutput> {
  const { conversationId, rawMessage, conversationHistory, urlContent, previousResultsSummary } = input;

  // Check for pre-loaded reference knowledge
  const referenceKnowledge = getRelevantReferenceKnowledge(
    rawMessage,
    conversationHistory,
  );

  // 1. Build user prompt with context
  const parts: string[] = [];

  if (conversationHistory.length > 0) {
    parts.push('CONVERSATION HISTORY:');
    const recentHistory = conversationHistory.slice(-8);
    for (const msg of recentHistory) {
      const role = msg.role === 'user' ? 'User' : 'Wyshbone';
      const content = msg.content.length > 500 ? msg.content.substring(0, 500) + '...' : msg.content;
      parts.push(`${role}: ${content}`);
    }
    parts.push('');
  }

  if (previousResultsSummary) {
    parts.push('PREVIOUS SEARCH RESULTS IN THIS CONVERSATION:');
    parts.push(previousResultsSummary);
    parts.push('');
  }

  if (urlContent) {
    parts.push('URL CONTENT (from a link the user shared):');
    parts.push(urlContent.substring(0, 3000));
    parts.push('');
  }

  if (referenceKnowledge) {
    parts.push('REFERENCE KNOWLEDGE (pre-loaded — use this to answer questions about this organisation):');
    parts.push(referenceKnowledge);
    parts.push('');
    console.log(`[CHAT_HANDLER] Injected ${referenceKnowledge.length} chars of reference knowledge`);
  }

  parts.push(`User: ${rawMessage}`);

  const userPrompt = parts.join('\n');

  // 2. Stream LLM response with progressive Supabase writes
  const { randomUUID } = await import('crypto');
  const messageId = randomUUID();

  // Create message row immediately with empty content + streaming flag
  try {
    const { supabase } = await import('../supabase');
    if (supabase) {
      await supabase.from('messages').insert({
        id: messageId,
        conversation_id: conversationId,
        role: 'assistant',
        content: '',
        source: 'supervisor',
        metadata: {
          conversation_phase: 'chatting',
          handler: 'chat',
          streaming: true,
        },
        created_at: Date.now(),
      });
    }
  } catch (err: any) {
    console.warn(`[CHAT_HANDLER] Failed to create streaming message row: ${err.message}`);
  }

  let response: string;
  let lastFlushMs = Date.now();
  const FLUSH_INTERVAL_MS = 300;

  if (isCircuitBroken()) {
    console.warn('[CHAT_HANDLER] Circuit breaker OPEN — using fallback');
    response = "I'm a bit busy right now. I can find businesses for you — just tell me a business type and location, like 'find cafes in Brighton'.";
  } else {
    try {
      recordChatCall();
      const { callLLMStream } = await import('./llm-failover');

      response = await callLLMStream(
        CHAT_SYSTEM_PROMPT,
        userPrompt,
        'chat',
        async (accumulated: string, _delta: string) => {
          const now = Date.now();
          if (now - lastFlushMs >= FLUSH_INTERVAL_MS) {
            lastFlushMs = now;
            try {
              const { supabase } = await import('../supabase');
              if (supabase) {
                await supabase.from('messages')
                  .update({ content: accumulated })
                  .eq('id', messageId);
              }
            } catch {
              // Non-fatal — next flush will include these tokens
            }
          }
        },
        {
          anthropicModel: process.env.CHAT_LLM_MODEL || 'claude-sonnet-4-6',
          maxTokens: 2048,
          temperature: 0.7,
          timeoutMs: 30_000,
        },
      );
    } catch (err: any) {
      console.error(`[CHAT_HANDLER] LLM call failed: ${err.message}`);
      response = "I can find businesses and leads for you. Just tell me what you're looking for and where — for example, 'find web designers in Manchester'.";
    }
  }

  // 3. Safety net: convert any [IMAGE: description] text the LLM still emits into real Unsplash URLs
  response = response.replace(
    /\[IMAGE:\s*([^\]]+)\]/gi,
    (_match, description) => {
      const keywords = description
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter((w: string) => w.length > 2)
        .slice(0, 2)
        .join(',');
      return keywords
        ? `![${description.trim()}](https://source.unsplash.com/featured/800x600/?${keywords})`
        : '';
    }
  );

  // 3b. Resolve any remaining [IMAGE: ...] placeholders via Unsplash API (if key is set)
  try {
    const { resolveImagePlaceholders } = await import('./image-search');
    const resolved = await resolveImagePlaceholders(response);
    if (resolved.imageCount > 0) {
      response = resolved.text;
      console.log(`[CHAT_HANDLER] Inlined ${resolved.imageCount} image(s) via Unsplash`);
    }
  } catch (err: any) {
    console.warn(`[CHAT_HANDLER] Image resolution failed (non-fatal): ${err.message}`);
  }

  // 4. Final write — complete content + clear streaming flag
  try {
    const { supabase } = await import('../supabase');
    if (supabase) {
      await supabase.from('messages')
        .update({
          content: response,
          metadata: {
            conversation_phase: 'chatting',
            handler: 'chat',
            streaming: false,
          },
        })
        .eq('id', messageId);
    }
  } catch (err: any) {
    console.error(`[CHAT_HANDLER] Failed to finalise message: ${err.message}`);
  }

  console.log(`[CHAT_HANDLER] Responded — ${response.length} chars, conversation=${conversationId.slice(0, 8)}`);

  return { response, messageId };
}
