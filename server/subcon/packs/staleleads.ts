/**
 * Stale Leads Subconscious Pack
 * 
 * SUP-12: Stale Leads subconscious pack
 * 
 * This pack analyzes leads to detect staleness and generates nudges
 * to prompt users to follow up on neglected leads.
 * 
 * Staleness criteria:
 * - createdAt older than 7 days AND never contacted
 * - lastContactedAt older than 14 days
 * - pipeline stage unchanged for >10 days
 * - updatedAt older than 14 days
 * 
 * Scoring:
 * - 40-60: mild stale
 * - 60-80: medium stale  
 * - 80-100: very stale
 * - +15 bonus if never contacted
 * - +10 bonus if stuck in same stage >10 days
 */

import type { SubconsciousPack, SubconContext, SubconOutput, SubconNudge } from '../types';
import type { SuggestedLead } from '@shared/schema';

// ============================================
// STORAGE DEPENDENCY
// ============================================

/**
 * Interface for the storage methods needed by this pack.
 * Allows for dependency injection and testing without a database.
 */
export interface StaleLeadsStorage {
  getSuggestedLeadsByAccount(accountId: string): Promise<SuggestedLead[]>;
}

// Lazy-load the actual storage to avoid circular dependencies and allow testing
let _storage: StaleLeadsStorage | null = null;

async function getStorage(): Promise<StaleLeadsStorage> {
  if (_storage) return _storage;
  const { storage } = await import('../../storage');
  return storage;
}

/**
 * Set a custom storage implementation (for testing).
 * @internal
 */
export function _setStorage(storage: StaleLeadsStorage | null): void {
  _storage = storage;
}

// ============================================
// CONSTANTS
// ============================================

/** Days before a new lead with no contact is considered stale */
const NEVER_CONTACTED_STALE_DAYS = 7;

/** Days since last contact before a lead is considered stale */
const LAST_CONTACT_STALE_DAYS = 14;

/** Days in same pipeline stage before considered stuck */
const PIPELINE_STUCK_DAYS = 10;

/** Days since last update before a lead is considered stale */
const NO_UPDATE_STALE_DAYS = 14;

/** Score bonus for leads that have never been contacted */
const NEVER_CONTACTED_BONUS = 15;

/** Score bonus for leads stuck in the same pipeline stage */
const STUCK_PIPELINE_BONUS = 10;

// ============================================
// TYPES
// ============================================

/**
 * Detailed staleness analysis for a single lead
 */
export interface LeadStalenessInfo {
  leadId: string;
  businessName: string;
  isStale: boolean;
  staleReasons: string[];
  baseScore: number;
  bonuses: number;
  finalScore: number;
  priority: 'low' | 'medium' | 'high';
  neverContacted: boolean;
  stuckInPipeline: boolean;
  daysSinceCreated: number;
  daysSinceLastContact: number | null;
  daysSinceStageChange: number | null;
  daysSinceUpdate: number | null;
}

/**
 * Result of analyzing all leads for staleness
 */
export interface StalenessAnalysisResult {
  totalLeads: number;
  staleLeads: number;
  freshLeads: number;
  analyses: LeadStalenessInfo[];
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Calculate days between two dates
 */
export function daysBetween(date1: Date, date2: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor((date2.getTime() - date1.getTime()) / msPerDay);
}

/**
 * Get the lead's business name from the lead jsonb or fallback
 */
function getBusinessName(lead: SuggestedLead): string {
  const leadData = lead.lead as Record<string, unknown>;
  return (leadData?.businessName as string) || (leadData?.name as string) || `Lead ${lead.id}`;
}

/**
 * Determine staleness severity and base score
 * - 40-60: mild stale
 * - 60-80: medium stale  
 * - 80-100: very stale
 */
function getStaleSeverityScore(maxDaysStale: number): { severity: 'mild' | 'medium' | 'very'; baseScore: number } {
  if (maxDaysStale >= 30) {
    // Very stale: 30+ days
    return { severity: 'very', baseScore: Math.min(100, 80 + Math.floor(maxDaysStale / 10)) };
  } else if (maxDaysStale >= 20) {
    // Medium stale: 20-29 days
    return { severity: 'medium', baseScore: 60 + Math.floor((maxDaysStale - 20) * 2) };
  } else {
    // Mild stale: less than 20 days
    return { severity: 'mild', baseScore: 40 + Math.floor(maxDaysStale) };
  }
}

/**
 * Convert score to priority level
 */
function scoreToPriority(score: number): 'low' | 'medium' | 'high' {
  if (score >= 80) return 'high';
  if (score >= 60) return 'medium';
  return 'low';
}

/**
 * Analyze a single lead for staleness
 */
export function analyzeLeadStaleness(lead: SuggestedLead, now: Date): LeadStalenessInfo {
  const businessName = getBusinessName(lead);
  const staleReasons: string[] = [];
  let maxDaysStale = 0;
  
  const createdAt = new Date(lead.createdAt);
  const daysSinceCreated = daysBetween(createdAt, now);
  
  // Calculate days since last contact (null if never contacted)
  const daysSinceLastContact = lead.lastContactedAt 
    ? daysBetween(new Date(lead.lastContactedAt), now) 
    : null;
  
  // Calculate days since pipeline stage change
  const daysSinceStageChange = lead.pipelineStageChangedAt 
    ? daysBetween(new Date(lead.pipelineStageChangedAt), now) 
    : null;
  
  // Calculate days since last update
  const daysSinceUpdate = lead.updatedAt 
    ? daysBetween(new Date(lead.updatedAt), now) 
    : null;

  // Check: createdAt older than 7 days AND never contacted
  const neverContacted = daysSinceLastContact === null;
  if (neverContacted && daysSinceCreated >= NEVER_CONTACTED_STALE_DAYS) {
    staleReasons.push(`Created ${daysSinceCreated} days ago and never contacted`);
    maxDaysStale = Math.max(maxDaysStale, daysSinceCreated);
  }

  // Check: lastContactedAt older than 14 days
  if (daysSinceLastContact !== null && daysSinceLastContact >= LAST_CONTACT_STALE_DAYS) {
    staleReasons.push(`Last contacted ${daysSinceLastContact} days ago`);
    maxDaysStale = Math.max(maxDaysStale, daysSinceLastContact);
  }

  // Check: pipeline stage unchanged for >10 days
  const stuckInPipeline = daysSinceStageChange !== null && daysSinceStageChange > PIPELINE_STUCK_DAYS;
  if (stuckInPipeline) {
    const stage = lead.pipelineStage || 'unknown';
    staleReasons.push(`Stuck in '${stage}' stage for ${daysSinceStageChange} days`);
    maxDaysStale = Math.max(maxDaysStale, daysSinceStageChange);
  }

  // Check: updatedAt older than 14 days
  if (daysSinceUpdate !== null && daysSinceUpdate >= NO_UPDATE_STALE_DAYS) {
    staleReasons.push(`No updates for ${daysSinceUpdate} days`);
    maxDaysStale = Math.max(maxDaysStale, daysSinceUpdate);
  }

  const isStale = staleReasons.length > 0;
  
  // Calculate score
  let baseScore = 0;
  let bonuses = 0;
  
  if (isStale) {
    const { baseScore: severity } = getStaleSeverityScore(maxDaysStale);
    baseScore = severity;
    
    // Add bonuses
    if (neverContacted && daysSinceCreated >= NEVER_CONTACTED_STALE_DAYS) {
      bonuses += NEVER_CONTACTED_BONUS;
    }
    if (stuckInPipeline) {
      bonuses += STUCK_PIPELINE_BONUS;
    }
  }
  
  const finalScore = Math.min(100, baseScore + bonuses);
  const priority = isStale ? scoreToPriority(finalScore) : 'low';

  return {
    leadId: lead.id,
    businessName,
    isStale,
    staleReasons,
    baseScore,
    bonuses,
    finalScore,
    priority,
    neverContacted: neverContacted && daysSinceCreated >= NEVER_CONTACTED_STALE_DAYS,
    stuckInPipeline,
    daysSinceCreated,
    daysSinceLastContact,
    daysSinceStageChange,
    daysSinceUpdate,
  };
}

/**
 * Analyze all leads for staleness
 */
export function analyzeAllLeads(leads: SuggestedLead[], now: Date): StalenessAnalysisResult {
  const analyses = leads.map(lead => analyzeLeadStaleness(lead, now));
  const staleAnalyses = analyses.filter(a => a.isStale);
  
  return {
    totalLeads: leads.length,
    staleLeads: staleAnalyses.length,
    freshLeads: analyses.length - staleAnalyses.length,
    analyses,
  };
}

/**
 * Convert staleness analysis to a nudge
 */
function analysisToNudge(analysis: LeadStalenessInfo): SubconNudge {
  // Build a descriptive message
  const primaryReason = analysis.staleReasons[0] || 'Lead needs attention';
  
  let message = `${analysis.businessName}: ${primaryReason}`;
  if (analysis.staleReasons.length > 1) {
    message += ` (+${analysis.staleReasons.length - 1} more issue${analysis.staleReasons.length > 2 ? 's' : ''})`;
  }

  return {
    type: 'stale_lead',
    message,
    priority: analysis.priority,
    entityId: analysis.leadId,
    metadata: {
      businessName: analysis.businessName,
      score: analysis.finalScore,
      staleReasons: analysis.staleReasons,
      neverContacted: analysis.neverContacted,
      stuckInPipeline: analysis.stuckInPipeline,
      daysSinceCreated: analysis.daysSinceCreated,
      daysSinceLastContact: analysis.daysSinceLastContact,
      daysSinceStageChange: analysis.daysSinceStageChange,
      daysSinceUpdate: analysis.daysSinceUpdate,
    },
  };
}

// ============================================
// PACK IMPLEMENTATION
// ============================================

/**
 * Stale Leads subconscious pack.
 * 
 * Analyzes leads for staleness and generates nudges to
 * prompt users to follow up on neglected leads.
 */
export const staleLeadsPack: SubconsciousPack = {
  id: 'stale_leads',
  
  async run(context: SubconContext): Promise<SubconOutput> {
    console.log(`[StaleLeadsPack] Running for user: ${context.userId}, account: ${context.accountId}`);
    
    const now = context.timestamp ? new Date(context.timestamp) : new Date();
    
    // Fetch all leads for this account
    const storage = await getStorage();
    const leads = await storage.getSuggestedLeadsByAccount(context.accountId);
    
    console.log(`[StaleLeadsPack] Found ${leads.length} leads for account ${context.accountId}`);
    
    if (leads.length === 0) {
      return {
        nudges: [],
        summary: 'No leads found for this account',
        completedAt: now.toISOString(),
      };
    }
    
    // Analyze all leads for staleness
    const analysis = analyzeAllLeads(leads, now);
    
    console.log(`[StaleLeadsPack] Analysis complete: ${analysis.staleLeads} stale out of ${analysis.totalLeads} total`);
    
    // Convert stale leads to nudges, sorted by score (highest first)
    const staleAnalyses = analysis.analyses
      .filter(a => a.isStale)
      .sort((a, b) => b.finalScore - a.finalScore);
    
    const nudges = staleAnalyses.map(analysisToNudge);
    
    return {
      nudges,
      summary: `Found ${analysis.staleLeads} stale lead${analysis.staleLeads !== 1 ? 's' : ''} out of ${analysis.totalLeads} total`,
      completedAt: now.toISOString(),
    };
  },
};

