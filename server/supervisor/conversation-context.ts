export interface ConversationLeadReference {
  index: number;
  name: string;
  address: string;
  website: string | null;
  phone: string | null;
  placeId: string;
  runId: string;
}

export interface ConversationContext {
  lastDeliveryRunId: string | null;
  leads: ConversationLeadReference[];
  totalLeadsDelivered: number;
}

export async function getConversationContext(conversationId: string): Promise<ConversationContext> {
  const { supabase } = await import('../supabase');
  if (!supabase) return { lastDeliveryRunId: null, leads: [], totalLeadsDelivered: 0 };

  const { data: messages } = await supabase
    .from('messages')
    .select('metadata')
    .eq('conversation_id', conversationId)
    .eq('role', 'assistant')
    .eq('source', 'supervisor')
    .not('metadata->leads', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1);

  const msg = messages?.[0];
  if (!msg?.metadata?.leads || !Array.isArray(msg.metadata.leads)) {
    return { lastDeliveryRunId: null, leads: [], totalLeadsDelivered: 0 };
  }

  const leads: ConversationLeadReference[] = msg.metadata.leads.map((l: any, i: number) => ({
    index: i + 1,
    name: l.name,
    address: l.address || '',
    website: l.website || null,
    phone: l.phone || null,
    placeId: l.placeId || '',
    runId: msg.metadata.run_id || '',
  }));

  return {
    lastDeliveryRunId: msg.metadata.run_id || null,
    leads,
    totalLeadsDelivered: leads.length,
  };
}

export function resolveLeadReference(context: ConversationContext, reference: string): ConversationLeadReference | null {
  const numMatch = reference.match(/(?:number|#|item)\s*(\d+)|(\d+)(?:st|nd|rd|th)|(?:the\s+)?(first|second|third|fourth|fifth)/i);

  if (numMatch) {
    const ordinals: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
    const num = numMatch[1] ? parseInt(numMatch[1]) : numMatch[2] ? parseInt(numMatch[2]) : ordinals[numMatch[3]?.toLowerCase()] || 0;

    if (num > 0 && num <= context.leads.length) {
      return context.leads[num - 1];
    }
  }

  const refLower = reference.toLowerCase().trim();
  return context.leads.find(l => l.name.toLowerCase().includes(refLower)) || null;
}
