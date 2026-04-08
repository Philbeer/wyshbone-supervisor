/**
 * Conversation Router — Single LLM call to route every user message
 * 
 * Replaces the multi-step decision chain (message classifier → conversation state →
 * state routing → intent extractor → constraint gate → smart clarify → rescue LLM)
 * with ONE fast LLM call that reads the full conversation and decides what to do.
 * 
 * Performance target: 2-5 seconds for the routing decision.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type Route = 'SEARCH' | 'CLARIFY' | 'DISCUSS' | 'ITERATE' | 'CHAT';

export interface RouterDecision {
  route: Route;
  entity: string | null;
  location: string | null;
  constraints: string[];
  clarify_question: string | null;
  chat_response: string | null;
  iteration_change: string | null;
  referenced_result: string | null;
  confidence: number;
  reasoning: string;
}

export interface RouterInput {
  currentMessage: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  previousResults: {
    exists: boolean;
    count: number;
    entityType: string | null;
    location: string | null;
    lastSearchRunId: string | null;
  };
  urlContent: string | null;
  userSearchHistory: Array<{ query: string; delivered: number }> | null;
}

// ─── System Prompt ──────────────────────────────────────────────────────────

const ROUTER_SYSTEM_PROMPT = `You are the conversation router for Wyshbone, a B2B lead generation app that finds businesses for users. You read the full conversation and decide what should happen next.

Return ONLY a JSON object. No markdown, no backticks, no commentary.

## YOUR FIVE ROUTES

### SEARCH
The user has given enough information to run a search. Minimum requirement: a type of business AND a location.
Set route="SEARCH", entity=the business type, location=the place, constraints=any filters mentioned.
Examples:
- "find pubs in arundel" → SEARCH, entity="pubs", location="Arundel"
- "find independent coffee shops in Manchester" → SEARCH, entity="coffee shops", location="Manchester", constraints=["independent"]
- "find web developers in Birmingham that also do app development" → SEARCH, entity="web developers", location="Birmingham", constraints=["also do app development"]

### CLARIFY
The user wants to search but hasn't provided enough info. Missing business type, location, or both.
Set route="CLARIFY" and clarify_question=a short, friendly question asking for what's missing.
Keep clarify_question to 1-2 sentences. Be specific.
Examples:
- "find companies in kent" → CLARIFY ("What type of companies? For example, accountants, builders, restaurants...")
- "find businesses that would be good for my app" → CLARIFY ("What kind of businesses are you looking for, and where should I search?")
- "find me leads" → CLARIFY ("What type of businesses would you like me to find, and in which area?")
- "find things in London" → CLARIFY ("What type of businesses in London? For example, restaurants, agencies, shops...")

### DISCUSS
The user is asking about results already delivered in this conversation. Only valid when PREVIOUS RESULTS exist.
Set route="DISCUSS" and referenced_result=description of what they're asking about.
Examples (when results exist):
- "tell me about the first one" → DISCUSS
- "which of those have good reviews?" → DISCUSS
- "which look old fashioned?" → DISCUSS
- "which might want help with social media?" → DISCUSS
- "only show ones with more than one location" → DISCUSS

### ITERATE
The user wants to modify their previous search — changing location, entity, or filters. Only valid when previous search exists.
Set route="ITERATE" with the FULL new search params (entity + location + constraints), plus iteration_change describing what changed.
Examples (when previous search exists):
- Previous: "pubs in Arundel". User: "now try Brighton" → ITERATE, entity="pubs", location="Brighton", iteration_change="location: Arundel → Brighton"
- Previous: "gyms in Birmingham". User: "actually make that personal trainers" → ITERATE, entity="personal trainers", location="Birmingham", iteration_change="entity: gyms → personal trainers"
- Previous: "restaurants in Cambridge". User: "no, go back to restaurants but make it Italian" → ITERATE, entity="Italian restaurants", location="Cambridge"
- User: "not bristol actually bath" → ITERATE, keep same entity, location="Bath", iteration_change="location: Bristol → Bath"

### CHAT
Greetings, gibberish, off-topic, or anything that is not a search intent.
Set route="CHAT" and chat_response=a friendly response.
Examples:
- "hi" → CHAT ("Hey! I can find businesses and leads for you. What are you looking for and where?")
- "sdfghjkl plumbers banana car" → CHAT ("I didn't quite catch that. Could you tell me what type of businesses you're looking for and where?")
- "what's the weather like" → CHAT ("I'm a business finder, so I can't help with weather! But tell me what businesses you're looking for and where.")
- "what can you do" → CHAT ("I find businesses and leads! Tell me a type of business and a location — like 'find cafes in Brighton'.")
- "any" → CHAT ("Could you tell me what you're looking for? I need a type of business and a location.")
- "find" → CHAT ("What would you like me to find? Give me a business type and location, like 'find restaurants in Manchester'.")

## CRITICAL RULES

1. SEARCH requires BOTH entity AND location. If either is missing → CLARIFY, never SEARCH.
2. "companies" or "businesses" alone is NOT specific enough for entity → CLARIFY for what type.
3. If the user is answering a previous clarification question, read the conversation history, combine their answer with earlier context. If you now have entity + location → SEARCH.
4. If PREVIOUS RESULTS exist and user is talking about those results → DISCUSS. This includes subjective questions like "which look old fashioned?" — these are discussions, not new searches.
5. If PREVIOUS RESULTS exist and user wants to change search params → ITERATE.
6. If a URL is all they sent with no search intent → CLARIFY asking what they'd like to do with it.
7. Gibberish (more than half the words aren't real English) → CHAT.
8. Typos in real words are fine — interpret intent. "find restraunts in manchster" = SEARCH.
9. DISCUSS and ITERATE only valid when previous results exist. Otherwise → SEARCH or CLARIFY.
10. For ITERATE, include the COMPLETE new search params, not just the delta.
11. Keep all responses concise. clarify_question: 1-2 sentences. chat_response: 1-3 sentences.

## OUTPUT FORMAT

{
  "route": "SEARCH" | "CLARIFY" | "DISCUSS" | "ITERATE" | "CHAT",
  "entity": "business type" | null,
  "location": "place name" | null,
  "constraints": ["filter1", "filter2"] | [],
  "clarify_question": "question text" | null,
  "chat_response": "response text" | null,
  "iteration_change": "what changed" | null,
  "referenced_result": "what they're asking about" | null,
  "confidence": 0.0-1.0,
  "reasoning": "one sentence explaining the decision"
}`;


// ─── User Message Builder ───────────────────────────────────────────────────

function buildRouterUserMessage(input: RouterInput): string {
  const parts: string[] = [];

  if (input.conversationHistory.length > 0) {
    parts.push('CONVERSATION HISTORY:');
    const historyLength = input.conversationHistory.length;
    for (let i = 0; i < historyLength; i++) {
      const msg = input.conversationHistory[i];
      const role = msg.role === 'user' ? 'user' : 'assistant';
      // Last 3 messages get more context — the user is most likely responding to these
      const limit = (historyLength - i) <= 3 ? 800 : 300;
      const content = msg.content.length > limit ? msg.content.substring(0, limit) + '...' : msg.content;
      parts.push(`[${role}] ${content}`);
    }
    parts.push('');
  }

  if (input.previousResults.exists) {
    parts.push(`PREVIOUS RESULTS: ${input.previousResults.count} leads delivered`);
    if (input.previousResults.entityType) {
      parts.push(`LAST SEARCH: entity="${input.previousResults.entityType}", location="${input.previousResults.location || 'unknown'}"`);
    }
    parts.push('');
  } else {
    parts.push('PREVIOUS RESULTS: None');
    parts.push('');
  }

  if (input.urlContent) {
    parts.push('URL CONTENT (fetched from a link the user provided):');
    parts.push(input.urlContent.substring(0, 2000));
    parts.push('');
  }

  if (input.userSearchHistory && input.userSearchHistory.length > 0) {
    parts.push('USER SEARCH HISTORY (previous sessions):');
    for (const s of input.userSearchHistory.slice(0, 5)) {
      parts.push(`  - "${s.query}" → ${s.delivered} results`);
    }
    parts.push('');
  }

  parts.push(`CURRENT MESSAGE: ${input.currentMessage}`);
  return parts.join('\n');
}


// ─── LLM Call ───────────────────────────────────────────────────────────────

async function callRouterLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    const model = process.env.ROUTER_LLM_MODEL || 'claude-3-5-haiku-20241022';
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 500,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Router LLM ${resp.status}: ${body.substring(0, 200)}`);
    }
    const data = await resp.json() as { content: Array<{ type: string; text?: string }> };
    const textBlock = data.content?.find((b: any) => b.type === 'text');
    return textBlock?.text || '';
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: openaiKey });
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    return response.choices[0]?.message?.content || '';
  }

  throw new Error('No LLM API key for router');
}


// ─── Response Parser ────────────────────────────────────────────────────────

function parseRouterResponse(raw: string): RouterDecision {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  const parsed = JSON.parse(cleaned);

  const validRoutes: Route[] = ['SEARCH', 'CLARIFY', 'DISCUSS', 'ITERATE', 'CHAT'];
  if (!validRoutes.includes(parsed.route)) {
    throw new Error(`Invalid route: ${parsed.route}`);
  }

  // Safety: SEARCH without entity or location → downgrade to CLARIFY
  if (parsed.route === 'SEARCH') {
    if (!parsed.entity || !parsed.location) {
      console.warn('[ROUTER] SEARCH missing entity/location — downgrading to CLARIFY');
      return {
        route: 'CLARIFY',
        entity: parsed.entity || null,
        location: parsed.location || null,
        constraints: parsed.constraints || [],
        clarify_question: !parsed.entity && !parsed.location
          ? "What type of businesses are you looking for, and where?"
          : !parsed.entity
            ? `What type of businesses in ${parsed.location}?`
            : `Where should I search for ${parsed.entity}?`,
        chat_response: null,
        iteration_change: null,
        referenced_result: null,
        confidence: 0.7,
        reasoning: 'SEARCH downgraded to CLARIFY — missing entity or location',
      };
    }
  }

  if (parsed.route === 'CLARIFY' && !parsed.clarify_question) {
    parsed.clarify_question = "What type of businesses are you looking for, and where?";
  }
  if (parsed.route === 'CHAT' && !parsed.chat_response) {
    parsed.chat_response = "Hey! I can find businesses for you. What are you looking for and where?";
  }

  return {
    route: parsed.route,
    entity: parsed.entity || null,
    location: parsed.location || null,
    constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
    clarify_question: parsed.clarify_question || null,
    chat_response: parsed.chat_response || null,
    iteration_change: parsed.iteration_change || null,
    referenced_result: parsed.referenced_result || null,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  };
}


// ─── Fast Paths (skip LLM for obvious cases) ───────────────────────────────

const INSTANT_CHAT = [
  /^(hi|hello|hey|howdy|morning|afternoon|evening|yo|sup)[\s!.?]*$/i,
  /^(thanks|thank you|cheers|ta|bye|goodbye|later)[\s!.?]*$/i,
];

function tryFastPath(message: string): RouterDecision | null {
  const trimmed = message.trim();

  if (trimmed.length < 3) {
    return {
      route: 'CHAT', entity: null, location: null, constraints: [],
      clarify_question: null,
      chat_response: "Could you tell me what you're looking for? I need a type of business and a location — for example, 'find plumbers in Bristol'.",
      iteration_change: null, referenced_result: null,
      confidence: 0.99, reasoning: 'very short input',
    };
  }

  for (const p of INSTANT_CHAT) {
    if (p.test(trimmed)) {
      return {
        route: 'CHAT', entity: null, location: null, constraints: [],
        clarify_question: null,
        chat_response: "Hey! I can find businesses and leads for you. What are you looking for and where? For example, 'find cafes in Brighton'.",
        iteration_change: null, referenced_result: null,
        confidence: 0.98, reasoning: 'greeting — fast path',
      };
    }
  }

  return null;
}


// ─── Main Export ─────────────────────────────────────────────────────────────

export async function routeConversation(input: RouterInput): Promise<RouterDecision> {
  const startTime = Date.now();

  // Fast path — no LLM needed
  const fast = tryFastPath(input.currentMessage);
  if (fast) {
    console.log(`[ROUTER] Fast path: route=${fast.route} (${Date.now() - startTime}ms)`);
    return fast;
  }

  // Build context and call LLM
  const userMessage = buildRouterUserMessage(input);

  let rawResponse: string;
  try {
    rawResponse = await callRouterLLM(ROUTER_SYSTEM_PROMPT, userMessage);
  } catch (err: any) {
    console.error(`[ROUTER] LLM failed (${Date.now() - startTime}ms): ${err.message}`);
    // Fallback: let existing pipeline handle it
    return {
      route: 'SEARCH', entity: null, location: null, constraints: [],
      clarify_question: null, chat_response: null,
      iteration_change: null, referenced_result: null,
      confidence: 0.1, reasoning: `Router LLM failed — fallback to pipeline`,
    };
  }

  let decision: RouterDecision;
  try {
    decision = parseRouterResponse(rawResponse);
  } catch (parseErr: any) {
    console.error(`[ROUTER] Parse failed (${Date.now() - startTime}ms): ${parseErr.message}`);
    return {
      route: 'SEARCH', entity: null, location: null, constraints: [],
      clarify_question: null, chat_response: null,
      iteration_change: null, referenced_result: null,
      confidence: 0.1, reasoning: `Router parse failed — fallback to pipeline`,
    };
  }

  console.log(`[ROUTER] route=${decision.route} entity="${decision.entity}" location="${decision.location}" confidence=${decision.confidence} (${Date.now() - startTime}ms)`);
  return decision;
}
