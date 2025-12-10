/**
 * Action Executors
 * 
 * Reusable executor functions that can be called by both UI and Supervisor.
 * Each executor performs a specific type of work and returns a standardized result.
 */

import { ActionInput, ActionResult } from './registry';
import { searchLeadsWithFallback } from '../lead-search-with-fallback';
import { storage } from '../storage';
import { supabase } from '../supabase';

/**
 * DEEP_RESEARCH - Run deep research on a topic
 * 
 * Input: { topic: string, prompt?: string }
 * Output: { success, summary, data: { runId, findings } }
 */
export async function runDeepResearch(input: ActionInput): Promise<ActionResult> {
  const { topic, prompt } = input;

  if (!topic) {
    return {
      success: false,
      summary: 'Missing required field: topic',
      error: 'topic is required'
    };
  }

  // TODO: This will integrate with Wyshbone UI's deep research system
  // For now, we'll create a placeholder that can be connected later
  
  if (!supabase) {
    return {
      success: false,
      summary: 'Deep research requires Supabase configuration',
      error: 'SUPABASE_URL not configured'
    };
  }

  try {
    // Placeholder: Create a research run record
    const runId = `research_${Date.now()}`;
    
    // In production, this would trigger the actual deep research pipeline
    // For now, return a success with placeholder data
    
    return {
      success: true,
      summary: `Started deep research on: ${topic}`,
      data: {
        runId,
        topic,
        prompt: prompt || topic,
        status: 'pending',
        note: 'Deep research integration pending - this is a placeholder'
      }
    };
  } catch (error) {
    return {
      success: false,
      summary: `Failed to start deep research: ${error instanceof Error ? error.message : String(error)}`,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * GLOBAL_DB - Search the Wyshbone global database (Google Places)
 * 
 * Input: { query: string, region: string, country?: string, maxResults?: number }
 * Output: { success, summary, data: { leads: [...] } }
 */
export async function runGlobalDatabaseSearch(input: ActionInput): Promise<ActionResult> {
  const { query, region, country = 'UK', maxResults = 10 } = input;

  if (!query || !region) {
    return {
      success: false,
      summary: 'Missing required fields: query and region',
      error: 'query and region are required'
    };
  }

  try {
    const result = await searchLeadsWithFallback(
      {
        primary: 'google_places',
        fallbacks: ['internal_pubs', 'dataledger', 'fallback_mock']
      },
      {
        query,
        region,
        country,
        maxResults
      }
    );

    const leadCount = result.leads?.length || 0;
    const sourceUsed = result.sourceUsed || 'unknown';

    return {
      success: leadCount > 0,
      summary: `Found ${leadCount} leads via ${sourceUsed} for "${query}" in ${region}`,
      data: {
        leads: result.leads || [],
        sourceUsed,
        query,
        region,
        country
      }
    };
  } catch (error) {
    return {
      success: false,
      summary: `Database search failed: ${error instanceof Error ? error.message : String(error)}`,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * SCHEDULED_MONITOR - Create a scheduled monitor
 * 
 * Input: { label: string, description: string, monitorType: string, userId: string }
 * Output: { success, summary, data: { monitorId } }
 */
export async function createScheduledMonitor(input: ActionInput): Promise<ActionResult> {
  const { label, description, monitorType, userId } = input;

  if (!label || !userId) {
    return {
      success: false,
      summary: 'Missing required fields: label and userId',
      error: 'label and userId are required'
    };
  }

  if (!supabase) {
    return {
      success: false,
      summary: 'Monitor creation requires Supabase configuration',
      error: 'SUPABASE_URL not configured'
    };
  }

  try {
    // Create monitor in Supabase
    const { data: monitor, error } = await supabase
      .from('scheduled_monitors')
      .insert({
        user_id: userId,
        label,
        description: description || `Monitor for ${label}`,
        monitor_type: monitorType || 'lead_generation',
        is_active: 1
      })
      .select()
      .single();

    if (error) throw error;

    return {
      success: true,
      summary: `Created monitor: ${label}`,
      data: {
        monitorId: monitor.id,
        label,
        description,
        monitorType: monitorType || 'lead_generation'
      }
    };
  } catch (error) {
    return {
      success: false,
      summary: `Failed to create monitor: ${error instanceof Error ? error.message : String(error)}`,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * EMAIL_FINDER - Find and enrich emails for leads
 * 
 * Input: { leads: Array<{ name, domain, address }>, userId: string }
 * Output: { success, summary, data: { enrichedLeads: [...] } }
 */
export async function runEmailFinderBatch(input: ActionInput): Promise<ActionResult> {
  const { leads, userId } = input;

  if (!leads || !Array.isArray(leads) || leads.length === 0) {
    return {
      success: false,
      summary: 'No leads provided',
      error: 'leads array is required and must not be empty'
    };
  }

  if (!userId) {
    return {
      success: false,
      summary: 'Missing required field: userId',
      error: 'userId is required'
    };
  }

  // Support both HUNTER_API_KEY (standard) and HUNTER_IO_API_KEY (legacy)
  const hunterApiKey = process.env.HUNTER_API_KEY || process.env.HUNTER_IO_API_KEY;
  if (!hunterApiKey) {
    return {
      success: false,
      summary: 'Email finder requires Hunter.io API key',
      error: 'HUNTER_API_KEY not configured'
    };
  }

  try {
    const enrichedLeads = [];

    for (const lead of leads) {
      const { domain, name, address } = lead;
      
      if (!domain) {
        enrichedLeads.push({
          ...lead,
          emails: [],
          enrichmentStatus: 'no_domain'
        });
        continue;
      }

      try {
        // Call Hunter.io to find emails
        const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${hunterApiKey}&limit=3`;
        const response = await fetch(url);

        if (!response.ok) {
          enrichedLeads.push({
            ...lead,
            emails: [],
            enrichmentStatus: 'api_error'
          });
          continue;
        }

        const data = await response.json();
        const emails = data.data?.emails
          ?.filter((e: any) => e.value)
          ?.map((e: any) => e.value)
          ?.slice(0, 3) || [];

        enrichedLeads.push({
          ...lead,
          emails,
          enrichmentStatus: emails.length > 0 ? 'enriched' : 'no_emails_found'
        });

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (error) {
        enrichedLeads.push({
          ...lead,
          emails: [],
          enrichmentStatus: 'error',
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const enrichedCount = enrichedLeads.filter(l => l.emails && l.emails.length > 0).length;

    return {
      success: true,
      summary: `Enriched ${enrichedCount}/${leads.length} leads with emails`,
      data: {
        enrichedLeads,
        totalLeads: leads.length,
        successfulEnrichments: enrichedCount
      }
    };
  } catch (error) {
    return {
      success: false,
      summary: `Email finder batch failed: ${error instanceof Error ? error.message : String(error)}`,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Export all executors
 */
export const executors = {
  runDeepResearch,
  runGlobalDatabaseSearch,
  createScheduledMonitor,
  runEmailFinderBatch
};
