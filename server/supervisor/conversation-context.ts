export interface ConversationLeadReference {
  index: number;
  name: string;
  address: string;
  website: string | null;
  phone: string | null;
  placeId: string;
  runId: string;
}

export interface PastDelivery {
  runId: string;
  entityCategory: string | null;
  location: string | null;
  leadCount: number;
  timestamp: number;
  /** Top 3 lead names — enough for the router/refine to disambiguate */
  topLeadNames: string[];
}

export interface ConversationContext {
  /** Most recent delivery — full lead list available for refine/discuss */
  lastDeliveryRunId: string | null;
  leads: ConversationLeadReference[];
  totalLeadsDelivered: number;
  /** Convenience fields exposing entity + location of the most recent delivery */
  entityType: string | null;
  location: string | null;
  /** All prior deliveries in this conversation, most recent first (incl. the latest) */
  pastDeliveries: PastDelivery[];
}

export async function getConversationContext(conversationId: string): Promise<ConversationContext> {
  const { supabase } = await import('../supabase');
  if (!supabase) {
    return {
      lastDeliveryRunId: null, leads: [], totalLeadsDelivered: 0,
      entityType: null, location: null, pastDeliveries: [],
    };
  }

  // Pull last 10 assistant messages with leads attached in this conversation
  const { data: messages } = await supabase
    .from('messages')
    .select('metadata, created_at')
    .eq('conversation_id', conversationId)
    .eq('role', 'assistant')
    .eq('source', 'supervisor')
    .not('metadata->leads', 'is', null)
    .order('created_at', { ascending: false })
    .limit(10);

  if (!messages || messages.length === 0) {
    return {
      lastDeliveryRunId: null, leads: [], totalLeadsDelivered: 0,
      entityType: null, location: null, pastDeliveries: [],
    };
  }

  const pastDeliveries: PastDelivery[] = messages
    .filter((m: any) => Array.isArray(m.metadata?.leads) && m.metadata.leads.length > 0)
    .map((m: any) => {
      const md = m.metadata || {};
      const leads = Array.isArray(md.leads) ? md.leads : [];
      return {
        runId: md.run_id || '',
        entityCategory:
          md.entity_category ||
          md.mission?.entity_category ||
          md.business_type ||
          null,
        location:
          md.location ||
          md.mission?.location_text ||
          null,
        leadCount: leads.length,
        timestamp: typeof m.created_at === 'number' ? m.created_at : new Date(m.created_at).getTime(),
        topLeadNames: leads.slice(0, 3).map((l: any) => l?.name).filter(Boolean),
      };
    });

  const latest = messages[0];
  const latestLeadsRaw = Array.isArray(latest.metadata?.leads) ? latest.metadata.leads : [];
  const latestRunId = latest.metadata?.run_id || null;

  const leads: ConversationLeadReference[] = latestLeadsRaw.map((l: any, i: number) => ({
    index: i + 1,
    name: l.name,
    address: l.address || '',
    website: l.website || null,
    phone: l.phone || null,
    placeId: l.placeId || '',
    runId: latestRunId || '',
  }));

  const latestEntity =
    latest.metadata?.entity_category ||
    latest.metadata?.mission?.entity_category ||
    latest.metadata?.business_type ||
    null;
  const latestLocation =
    latest.metadata?.location ||
    latest.metadata?.mission?.location_text ||
    null;

  return {
    lastDeliveryRunId: latestRunId,
    leads,
    totalLeadsDelivered: leads.length,
    entityType: latestEntity,
    location: latestLocation,
    pastDeliveries,
  };
}

export function resolveLeadReference(context: ConversationContext, reference: string): ConversationLeadReference | null {
  const numMatch = reference.match(/(?:number|#|item)\s*(\d+)|(\d+)(?:st|nd|rd|th)|(?:the\s+)?(first|second|third|fourth|fifth)/i);
  if (numMatch) {
    const ordinals: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
    const num = numMatch[1] ? parseInt(numMatch[1]) : numMatch[2] ? parseInt(numMatch[2]) : ordinals[numMatch[3]?.toLowerCase()] || 0;
    if (num > 0 && num <= context.leads.length) return context.leads[num - 1];
  }
  const refLower = reference.toLowerCase().trim();
  return context.leads.find(l => l.name.toLowerCase().includes(refLower)) || null;
}

/**
 * Resolve "the previous search" / "those results" / "the X one we did" to a specific past delivery.
 * Returns null if the reference is too ambiguous.
 */
export function resolvePreviousSearchReference(
  context: ConversationContext,
  reference: string,
): PastDelivery | null {
  if (context.pastDeliveries.length === 0) return null;
  const ref = reference.toLowerCase();
  // "previous", "last", "earlier" → second most recent (skipping the current one)
  if (/\b(previous|last|prior|earlier)\b/.test(ref) && context.pastDeliveries.length >= 2) {
    return context.pastDeliveries[1];
  }
  // "those results", "the results", "they", "them" → most recent
  if (/\b(those|the)\s+(results?|leads|ones?)\b|\b(they|them)\b/.test(ref)) {
    return context.pastDeliveries[0];
  }
  // Fuzzy match against entity_category or location of past deliveries
  for (const pd of context.pastDeliveries) {
    if (pd.entityCategory && ref.includes(pd.entityCategory.toLowerCase())) return pd;
    if (pd.location && ref.includes(pd.location.toLowerCase())) return pd;
  }
  return null;
}
