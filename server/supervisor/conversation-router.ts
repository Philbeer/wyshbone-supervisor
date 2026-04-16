/**
 * Conversation Router — Single LLM call to route every user message
 * 
 * Replaces the multi-step decision chain (message classifier → conversation state →
 * state routing → intent extractor → constraint gate → smart clarify → rescue LLM)
 * with ONE fast LLM call that reads the full conversation and decides what to do.
 * 
 * Performance target: 2-5 seconds for the routing decision.
 */

import { callLLMText } from './llm-failover';
import { getCurrentDatePreamble } from './current-context';
import type { TurnAnalysis } from './conversation-turn-classifier';

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
  turnAnalysis: TurnAnalysis;   // NEW — required
}

// ─── System Prompt ──────────────────────────────────────────────────────────

const ROUTER_SYSTEM_PROMPT = `${getCurrentDatePreamble()}

You are the conversation router for Wyshbone, a B2B lead generation app that finds businesses for users.

A context analyser has already determined what kind of conversational turn this is. You will receive a TURN ANALYSIS block in the input. Treat it as authoritative — it tells you what the user's message is doing relative to the conversation. Your job is to pick the right action given that context.

Return ONLY a JSON object. No markdown, no backticks, no commentary.

## HOW TURN ANALYSIS MAPS TO ROUTES

The TURN ANALYSIS \`user_message_relation\` field constrains which routes are plausible:

- ANSWERING_QUESTION → Route = CHAT. The user is answering a conversational question the assistant asked. Any nouns in their reply (including food items, business types, colours) are answers, not search entities. Continue the conversation.

- CONTINUING_CHAT → Route = CHAT. The user is following up on the topic the assistant was discussing. Keep the conversation going.

- PROVIDING_CLARIFICATION → Route = SEARCH or CLARIFY. Read the conversation history to find what was missing (entity, location) and combine with the user's current message. If you now have BOTH entity and location → SEARCH. If still missing one → CLARIFY.

- DISCUSSING_RESULTS → Route = DISCUSS. User is talking about leads already delivered. (Exception: short affirmatives like "yes", "go ahead" may be ITERATE — see rule 12.)

- REFINING_SEARCH → Route = ITERATE. User wants to modify the existing search (different location, different entity, extra filter). Include full new params.

- NEW_SEARCH_REQUEST → Route = SEARCH if entity + location both present; otherwise CLARIFY.

- GREETING_OR_OFFTOPIC → Route = CHAT.

IMPORTANT: If the turn analysis says ANSWERING_QUESTION or CONTINUING_CHAT, do NOT route as SEARCH even if the user's message contains words that look like business types. The context analyser has already determined the user is in conversational mode. Trust it.

The ONLY case where you may override turn analysis is if the user's current message contains an explicit search verb (find, search, show me, look for) PLUS a new entity AND location — in which case it's a clear NEW_SEARCH_REQUEST regardless of prior context.

## THE FIVE ROUTES

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
- Previous assistant: "I can widen the search to include nearby towns." User: "yes please" → ITERATE, entity=same as last search, location=wider area around last search location, iteration_change="user accepted suggestion to widen search"

### CHAT
General conversation, greetings, off-topic questions, knowledge questions, or anything that is NOT a request to find/search for businesses in a specific location.

Key signal: the message does NOT contain both a business type AND a location. If the user is asking ABOUT a topic (wine, AI, marketing, weather) rather than asking you to FIND businesses, it's CHAT.

Set route="CHAT" and chat_response=a friendly response. For knowledge questions, give a brief helpful answer then mention what Wyshbone can do.

CHAT patterns:
- Greetings: "hi", "hello", "hey there"
- Knowledge questions: "tell me about X", "what is X", "how does X work", "explain X"
- Capability questions: "what can you do", "how do you work"
- Off-topic: weather, philosophy, personal questions
- Gibberish: more than half the words aren't real English
- Single words or fragments without search intent
- Gratitude: "thanks", "cheers", "that's helpful"
- The word "find" or "search" WITHOUT both a business type AND location

CRITICAL: "tell me about [topic]" is ALWAYS CHAT, even if the topic relates to businesses (wine, restaurants, marketing). The user is asking for information, not requesting a search. Only route as SEARCH when the user explicitly asks to FIND or SEARCH for a business type in a specific place.

chat_response guidelines:
- For knowledge questions: give a brief helpful 1-2 sentence answer, then redirect to what Wyshbone does
- For greetings: welcome them and explain what you can do
- For gibberish: ask them to clarify
- Keep to 1-3 sentences

CHAT CONTINUITY: If the conversation history shows the last exchange was a CHAT (the assistant gave a conversational/informational answer, NOT search results), short follow-up questions are almost certainly CHAT continuations. Only route away from CHAT if the user gives a clear, explicit search instruction with both a business type AND a location.

What NOT to route as CHAT:
- "yes please" (when previous assistant offered to search more) → NOT CHAT and NOT DISCUSS — this is an affirmative to a search offer → ITERATE or SEARCH

## CRITICAL RULES

1. SEARCH requires BOTH entity AND location. If either is missing → CLARIFY, never SEARCH.
2. "companies" or "businesses" alone is NOT specific enough for entity → CLARIFY for what type.
3. If the user is answering a previous clarification question, read the conversation history, combine their answer with earlier context. If you now have entity + location → SEARCH.
4. If PREVIOUS RESULTS exist and user is talking about those results → DISCUSS. This includes subjective questions like "which look old fashioned?" — these are discussions, not new searches. EXCEPTION: short affirmatives like "yes", "yes please", "ok", "sure", "go ahead" are NOT discussions — see rule 12.
5. If PREVIOUS RESULTS exist and user wants to change search params → ITERATE.
6. If a URL is all they sent with no search intent → CLARIFY asking what they'd like to do with it.
7. Gibberish (more than half the words aren't real English) → CHAT.
8. Typos in real words are fine — interpret intent. "find restraunts in manchster" = SEARCH.
9. DISCUSS and ITERATE only valid when previous results exist. Otherwise → SEARCH or CLARIFY.
10. For ITERATE, include the COMPLETE new search params, not just the delta.
11. Keep all responses concise. clarify_question: 1-2 sentences. chat_response: 1-3 sentences.
12. AFFIRMATIVE RESPONSES (overrides rule 4): If the user's ENTIRE message is a short affirmative (under 5 words) like "yes", "yes please", "ok", "sure", "go ahead", "do it", "yeah", "please do", "go for it" — this is NOT a discussion. Read the PREVIOUS ASSISTANT MESSAGE. If it offered to search, refine, expand, or filter, route as ITERATE or SEARCH with the entity and location from the LAST SEARCH context. Example: last search was "pubs in Arundel", assistant said "I can search nearby towns too — want me to?", user says "yes please" → ITERATE with expanded location. Rule 12 takes priority over rule 4 whenever the entire user message is a short affirmative.

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
  "reasoning": "one sentence — reference the turn analysis and explain the route choice"
}`;


// ─── User Message Builder ───────────────────────────────────────────────────

function buildRouterUserMessage(input: RouterInput): string {
  const parts: string[] = [];

  parts.push('TURN ANALYSIS (from context analyser — treat as authoritative):');
  parts.push(`  last_assistant_turn_type: ${input.turnAnalysis.last_assistant_turn_type}`);
  parts.push(`  last_assistant_summary: ${input.turnAnalysis.last_assistant_summary}`);
  parts.push(`  user_message_relation: ${input.turnAnalysis.user_message_relation}`);
  parts.push(`  reasoning: ${input.turnAnalysis.reasoning}`);
  parts.push('');

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


// ─── Response Parser ────────────────────────────────────────────────────────

function parseRouterResponse(raw: string): RouterDecision {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  // Try to extract JSON from anywhere in the response (handles preamble/postamble)
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }

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


// ─── Main Export ─────────────────────────────────────────────────────────────

export async function routeConversation(input: RouterInput): Promise<RouterDecision> {
  const startTime = Date.now();

  // ALL messages go through the LLM router — no fast paths, no regex
  // Build context and call LLM
  const userMessage = buildRouterUserMessage(input);

  let rawResponse: string;
  try {
    rawResponse = await callLLMText(ROUTER_SYSTEM_PROMPT, userMessage, 'router', {
      anthropicModel: process.env.ROUTER_LLM_MODEL || 'claude-haiku-4-5-20251001',
      openaiModel: 'gpt-4o-mini',
      timeoutMs: parseInt(process.env.ROUTER_TIMEOUT_MS || '15000', 10),
    });
  } catch (err: any) {
    console.error(`[ROUTER] LLM failed (${Date.now() - startTime}ms): ${err.message}`);
    return {
      route: 'CHAT', entity: null, location: null, constraints: [],
      clarify_question: null,
      chat_response: "I didn't quite catch that. Could you tell me what you're looking for? I can find businesses for you — just give me a type and location.",
      iteration_change: null, referenced_result: null,
      confidence: 0.1, reasoning: `Router LLM failed — fallback to CHAT`,
    };
  }

  let decision: RouterDecision;
  try {
    decision = parseRouterResponse(rawResponse);
  } catch (parseErr: any) {
    console.error(`[ROUTER] Parse failed (${Date.now() - startTime}ms): ${parseErr.message}`);
    return {
      route: 'CHAT', entity: null, location: null, constraints: [],
      clarify_question: null,
      chat_response: "I didn't quite catch that. Could you tell me what you're looking for? I can find businesses for you — just give me a type and location.",
      iteration_change: null, referenced_result: null,
      confidence: 0.1, reasoning: `Router parse failed — fallback to CHAT`,
    };
  }

  // Safety: if route is SEARCH but the original message has no location-like content,
  // and the entity/location came from search history not the message, override to CHAT or CLARIFY
  if (decision.route === 'SEARCH') {
    const msgLower = input.currentMessage.toLowerCase().trim();

    const hasLocationWords = decision.location && msgLower.includes(decision.location.toLowerCase().substring(0, 4));
    const hasEntityWords = decision.entity && msgLower.includes(decision.entity.toLowerCase().substring(0, 4));

    if (!hasLocationWords && !hasEntityWords) {
      const chatPatterns = [
        /^(tell|teach|explain|describe|what is|what are|how does|how do|can you tell|do you know)/i,
        /^(hi|hello|hey|thanks|cheers|ok|sure|yes)/i,
        /\?$/,
      ];
      const looksLikeChat = chatPatterns.some(p => p.test(msgLower));

      if (looksLikeChat) {
        console.warn(`[ROUTER_SAFETY] Overriding SEARCH→CHAT: message="${input.currentMessage.substring(0, 60)}" has no entity/location words. Router hallucinated from history.`);
        decision = {
          ...decision,
          route: 'CHAT',
          entity: null,
          location: null,
          chat_response: decision.chat_response || "I'm not sure I understood that as a search. Could you tell me what type of businesses you're looking for and where?",
          confidence: 0.6,
          reasoning: `Safety override: SEARCH→CHAT — message contains no entity/location words`,
        };
      }
    }
  }

  console.log(`[ROUTER] route=${decision.route} entity="${decision.entity}" location="${decision.location}" confidence=${decision.confidence} (${Date.now() - startTime}ms)`);
  return decision;
}
