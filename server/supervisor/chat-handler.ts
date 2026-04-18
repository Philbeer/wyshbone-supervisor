import { callLLMText } from './llm-failover';
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
- For short answers (1-3 sentences), write a single paragraph.
- For any longer answer — multiple points, options, recommendations, or wine/producer lists — use this exact structure with blank lines between EVERY section:

  **[Bold header naming the topic]**

  [1-2 sentences of confident context.]

  **[Optional bold lead-in line, e.g. "Two directions depending on your taste:"]**

  **[Label]** — *[name in italics]*. [One sentence explaining it.]

  **[Label]** — *[name in italics]*. [One sentence explaining it.]

  [One closing question offering a next step.]

- CRITICAL: every **section** must be separated by a completely blank line in the output. This means two newline characters (\n\n) between each section. A single newline is not enough — it will render as one paragraph. Never run sections together.
- Use **bold** for headers and labels. Use *italics* for wine names, producer names, grape varieties, and classifications.
- Use em dashes (—) between labels and names, not hyphens.
- Maximum 3 options per response unless the user explicitly asks for more.
- Never use markdown # headers, numbered lists, or bullet points.
- Never start with "I", "Certainly", or "Of course".

EXAMPLE (correct — note the blank lines):

**Mosel Valley — Riesling**

The Mosel is Germany's most celebrated white wine region, known for steep slate vineyards and wines with brilliant acidity.

**Two directions depending on your taste:**

**Dry** — *Grosses Gewächs* (GG), the top tier of dry Riesling from a classified single vineyard. Precise, mineral, age-worthy.

**Sweeter** — *Spätlese* or *Auslese*. Classic Mosel balance of sweetness and razor-sharp acidity.

Shall I find specific bottles available now, or look for merchants stocking Mosel wines?

EXAMPLE (wrong — all run together as one paragraph):

**Mosel Valley — Riesling** The Mosel is Germany's most celebrated... **Two directions: Dry** — *Grosses Gewächs*... **Sweeter** — *Spätlese*...

RESPONSE FORMAT — WINE RECOMMENDATIONS

Structure every wine response as follows:

1. Open with a bold header naming the region, grape, style, or topic.
   Examples:
     **Mosel Valley — Riesling**
     **Amarone della Valpolicella**
     **Burgundy — Pinot Noir**

2. Follow with one or two sentences of confident context. State what makes the region, grape, or style distinctive. Be specific, not generic.

3. If presenting options or producers, introduce them with a short bold lead-in line such as:
     **Two directions depending on your taste:**
     **A few producers worth knowing:**
     **Three to consider at different price points:**

4. List each option on its own line in this exact format:
     **[Label]** — *[wine name or style in italics]* ([classification if relevant]). One or two sentences explaining why it fits.

   Good labels: Dry, Sweeter, Entry-level, Special occasion, Classic, Modern, Lighter, Fuller-bodied, Value pick, Age-worthy.

   Example lines:
     **Dry** — *Grosses Gewächs* (GG), the top tier of dry Riesling from a classified single vineyard. Precise, mineral, age-worthy.
     **Sweeter** — *Spätlese* or *Auslese*. Classic Mosel balance of sweetness and razor-sharp acidity.
     **Special occasion** — *Eiswein*, made from grapes harvested frozen. Intense, rare, unforgettable.

   CORRECT output structure (note the blank lines):

   **Mosel Valley — Riesling**

   The Mosel is Germany's most celebrated white wine region, known for steep slate vineyards and wines with brilliant acidity.

   **Two directions depending on your taste:**

   **Dry** — *Grosses Gewächs* (GG), the top tier of dry Riesling from a classified single vineyard. Precise, mineral, age-worthy.

   **Sweeter** — *Spätlese* or *Auslese*. Classic Mosel balance of sweetness and razor-sharp acidity.

   Shall I find specific bottles available now, or look for merchants stocking Mosel wines?

   INCORRECT (all run together on one line):

   **Mosel Valley — Riesling** The Mosel is Germany's most celebrated... **Two directions depending on your taste:** **Dry** — ...

5. Close with ONE focused question offering a clear next step.
   Good: "Shall I find specific bottles available now, or look for merchants stocking Mosel wines?"
   Bad: Two or more questions. Generic "let me know if you need anything else."

TONE
- Knowledgeable, confident, never condescending.
- Write as a sommelier speaking to a curious customer, not a textbook.
- Use "you" not "one." Contractions are fine.
- No hedging phrases like "it depends" or "there are many options."
- No emoji. Wine Society voice is traditional and authoritative.

FORMATTING RULES (STRICT)
- Separate each section with a blank line (i.e. two newlines in the output). The header, context paragraph, lead-in line, each labelled option, and the closing question must each be on their own line separated by blank lines. Never run sections together as a single paragraph.
- Use markdown throughout: **bold** for headers and labels, *italics* for wine names, grape varieties, and classifications.
- Maximum 3 options per response unless explicitly asked for more.
- Do not use bullet points or numbered lists. Use the labelled line format above.
- Never start with "I", "Certainly", or "Of course".
- Do not include [IMAGE: ...] tags, describe images, or embed image URLs.
- Keep paragraphs to 2 sentences maximum.
- Use an em dash (—) between the label and the wine name, not a hyphen.

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

  // 2. Call LLM with circuit breaker
  let response: string;

  if (isCircuitBroken()) {
    console.warn('[CHAT_HANDLER] Circuit breaker OPEN — using fallback');
    response = "I'm a bit busy right now. I can find businesses for you — just tell me a business type and location, like 'find cafes in Brighton'.";
  } else {
    try {
      recordChatCall();
      response = await callLLMText(CHAT_SYSTEM_PROMPT, userPrompt, 'chat', {
        anthropicModel: process.env.CHAT_LLM_MODEL || 'claude-sonnet-4-6',
        maxTokens: 2048,
        temperature: 0.7,
        timeoutMs: 30_000,
      });
    } catch (err: any) {
      console.error(`[CHAT_HANDLER] LLM call failed: ${err.message}`);
      response = "I can find businesses and leads for you. Just tell me what you're looking for and where — for example, 'find web designers in Manchester'.";
    }
  }

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

  // 4. Save message to DB (single write, complete content)
  const messageId = await saveChatMessage(conversationId, response);

  console.log(`[CHAT_HANDLER] Responded — ${response.length} chars, conversation=${conversationId.slice(0, 8)}`);

  return { response, messageId };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function saveChatMessage(conversationId: string, content: string): Promise<string> {
  const { randomUUID } = await import('crypto');
  const messageId = randomUUID();

  try {
    const { supabase } = await import('../supabase');
    if (!supabase) return messageId;

    await supabase.from('messages').insert({
      id: messageId,
      conversation_id: conversationId,
      role: 'assistant',
      content,
      source: 'supervisor',
      metadata: {
        conversation_phase: 'chatting',
        handler: 'chat',
      },
      created_at: Date.now(),
    });
  } catch (err: any) {
    console.error(`[CHAT_HANDLER] Failed to save message (non-fatal): ${err.message}`);
  }

  return messageId;
}
