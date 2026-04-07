/**
 * Result Discussion Handler
 *
 * Handles messages when the user is in the 'reviewing' phase — e.g.
 * "tell me about #3", "which ones have a website?", "why did you include X?".
 * Loads delivered leads, resolves any specific lead reference, optionally
 * fetches artefact evidence for that lead, then calls Haiku for a concise reply.
 */

import { getConversationContext, resolveLeadReference } from './conversation-context';
import { storage } from '../storage';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ResultDiscussionInput {
  conversationId: string;
  userId: string;
  rawMessage: string;
  jobId: string;
  taskId: string;
}

export interface ResultDiscussionOutput {
  response: string;
  referencedLead: { name: string; index: number } | null;
  messageId: string;
}

// ─── Circuit breaker — max 10 discussion calls per 5 minutes ─────────────────

const _discussionCallTimestamps: number[] = [];
const CIRCUIT_BREAKER_WINDOW_MS = 5 * 60 * 1000;
const CIRCUIT_BREAKER_MAX_CALLS = 10;

function isCircuitBroken(): boolean {
  const cutoff = Date.now() - CIRCUIT_BREAKER_WINDOW_MS;
  while (_discussionCallTimestamps.length > 0 && _discussionCallTimestamps[0] < cutoff) {
    _discussionCallTimestamps.shift();
  }
  return _discussionCallTimestamps.length >= CIRCUIT_BREAKER_MAX_CALLS;
}

function recordDiscussionCall(): void {
  _discussionCallTimestamps.push(Date.now());
}

// ─── Anthropic Haiku call ─────────────────────────────────────────────────────

async function callDiscussionLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — cannot call discussion LLM');
  }

  const model = process.env.DISCUSSION_LLM_MODEL || process.env.RESCUE_LLM_MODEL || 'claude-3-haiku-20240307';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${body.substring(0, 200)}`);
  }

  const data = await resp.json() as { content: Array<{ type: string; text?: string }> };
  const textBlock = data.content?.find((b) => b.type === 'text');
  return textBlock?.text || '';
}

// ─── System prompt ────────────────────────────────────────────────────────────

const DISCUSSION_SYSTEM_PROMPT = `You are Wyshbone's results assistant. The user has search results and is asking about them. Be helpful, concise, and factual.

RULES:
- Only use information from the lead data and evidence provided. Do NOT make up details.
- If asked about a specific lead, give what you know from the data.
- If asked a general question ("which have websites?"), scan the lead list and answer.
- Keep responses to 2-4 sentences. Be direct.
- If you don't have enough information to answer, say so honestly.
- You can suggest next actions: "Would you like me to search for more like this?" or "I can refine these results if you tell me what to filter by."`;

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleResultDiscussion(
  input: ResultDiscussionInput,
): Promise<ResultDiscussionOutput> {
  const { conversationId, userId, rawMessage } = input;

  // 1. Load conversation context
  const ctx = await getConversationContext(conversationId);

  if (ctx.leads.length === 0) {
    const fallbackResponse = "I don't have any previous results to discuss. What would you like me to search for?";
    const messageId = await saveAssistantMessage(conversationId, fallbackResponse, null);
    return { response: fallbackResponse, referencedLead: null, messageId };
  }

  // 2. Try to resolve a specific lead reference
  const resolvedLead = resolveLeadReference(ctx, rawMessage);

  // 3. Optionally load artefact evidence for a specific lead
  let evidenceContext = '';
  if (resolvedLead && ctx.lastDeliveryRunId) {
    try {
      const artefacts = await storage.getArtefactsByRunId(ctx.lastDeliveryRunId);
      const evidenceArtefacts = artefacts.filter((a) =>
        ['verification_evidence', 'step_result', 'leads_list'].includes(a.type),
      );

      for (const artefact of evidenceArtefacts) {
        const payload = artefact.payloadJson as any;
        if (!payload) continue;

        const payloadStr = JSON.stringify(payload);
        const nameMatch = payloadStr.toLowerCase().includes(resolvedLead.name.toLowerCase());
        const placeMatch = resolvedLead.placeId && payloadStr.includes(resolvedLead.placeId);

        if (nameMatch || placeMatch) {
          evidenceContext = payloadStr.substring(0, 2000);
          break;
        }
      }
    } catch (err: any) {
      console.warn(`[RESULT_DISCUSSION] Failed to load artefacts (non-fatal): ${err.message}`);
    }
  }

  // 4. Build lead summary
  const leadSummary = ctx.leads
    .map((l) => {
      const parts = [`${l.index}. ${l.name}`, l.address];
      if (l.website) parts.push(`Website: ${l.website}`);
      if (l.phone) parts.push(`Phone: ${l.phone}`);
      return parts.join(' | ');
    })
    .join('\n');

  // 5. Build user prompt
  let userPrompt = `LEADS (${ctx.leads.length} total):\n${leadSummary}\n\n`;

  if (resolvedLead) {
    userPrompt += `REFERENCED LEAD:\n${resolvedLead.index}. ${resolvedLead.name} — ${resolvedLead.address}`;
    if (resolvedLead.website) userPrompt += ` | Website: ${resolvedLead.website}`;
    if (resolvedLead.phone) userPrompt += ` | Phone: ${resolvedLead.phone}`;
    userPrompt += '\n\n';
  }

  if (evidenceContext) {
    userPrompt += `EVIDENCE CONTEXT:\n${evidenceContext}\n\n`;
  }

  userPrompt += `USER MESSAGE: ${rawMessage}`;

  // 6. Call LLM (with circuit breaker)
  let response: string;

  if (isCircuitBroken()) {
    console.warn(`[RESULT_DISCUSSION] Circuit breaker OPEN — using fallback response`);
    response = buildFallbackResponse(resolvedLead, ctx.leads.length);
  } else {
    try {
      recordDiscussionCall();
      response = await callDiscussionLLM(DISCUSSION_SYSTEM_PROMPT, userPrompt);
    } catch (err: any) {
      console.error(`[RESULT_DISCUSSION] LLM call failed: ${err.message}`);
      response = buildFallbackResponse(resolvedLead, ctx.leads.length);
    }
  }

  // 7. Save message to DB
  const referencedLeadForMeta = resolvedLead
    ? { name: resolvedLead.name, index: resolvedLead.index }
    : null;

  const messageId = await saveAssistantMessage(conversationId, response, referencedLeadForMeta);

  // 8. Log
  if (resolvedLead) {
    console.log(
      `[RESULT_DISCUSSION] Responded about lead #${resolvedLead.index} "${resolvedLead.name}" — ${response.length} chars`,
    );
  } else {
    console.log(`[RESULT_DISCUSSION] Responded to general query — ${response.length} chars`);
  }

  return { response, referencedLead: referencedLeadForMeta, messageId };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildFallbackResponse(
  lead: { name: string; index: number; address: string; website: string | null; phone: string | null } | null,
  totalLeads: number,
): string {
  if (lead) {
    const parts = [`Here's what I have for ${lead.name}: ${lead.address}`];
    if (lead.website) parts.push(`Website: ${lead.website}`);
    if (lead.phone) parts.push(`Phone: ${lead.phone}`);
    return parts.join('. ');
  }
  return `I have ${totalLeads} result${totalLeads === 1 ? '' : 's'}. Ask about a specific one by number (e.g. "tell me about #2") or ask a general question about the list.`;
}

async function saveAssistantMessage(
  conversationId: string,
  content: string,
  referencedLead: { name: string; index: number } | null,
): Promise<string> {
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
        conversation_phase: 'reviewing',
        ...(referencedLead ? { referenced_lead: referencedLead } : {}),
      },
      created_at: Date.now(),
    });
  } catch (err: any) {
    console.error(`[RESULT_DISCUSSION] Failed to save message (non-fatal): ${err.message}`);
  }

  return messageId;
}
