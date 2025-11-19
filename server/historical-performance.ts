/**
 * SUP-012: Historical Performance Module
 * 
 * Analyzes past plan executions and lead outcomes to guide future planning decisions.
 * Uses simple heuristics to score strategies by niche, location, dataSource, and outreachChannel.
 */

import { storage } from "./storage";
import { db } from "./db";
import { planExecutions, suggestedLeads } from "@shared/schema";
import { desc, sql } from "drizzle-orm";
import type { LeadGenStepResult, LeadDataSourceId } from "./types/lead-gen-plan";

// ========================================
// TYPES
// ========================================

/**
 * Key dimensions that define a strategy
 */
export interface StrategyKey {
  niche?: string;          // e.g. "breweries", "coffee roasters", "pubs"
  country?: string;        // e.g. "GB", "US"
  region?: string;         // e.g. "North West", "California"
  city?: string;           // e.g. "Manchester", "London"
  dataSource?: LeadDataSourceId; // e.g. "google_places", "internal_pubs"
  outreachChannel?: string; // e.g. "email", "phone", "linkedin"
}

/**
 * Computed score for a particular strategy
 */
export interface StrategyScore {
  key: StrategyKey;
  score: number;           // higher = better (weighted by success rate and sample size)
  samples: number;         // number of data points
  successRate?: number;    // 0.0 - 1.0
  lastUsedAt?: string;     // ISO timestamp
  avgLeadsFound?: number;  // average leads found per execution
}

/**
 * Historical context for guiding plan generation
 */
export interface HistoricalContext {
  topStrategies: StrategyScore[];
  lowPerformers: StrategyScore[];
}

// ========================================
// SCORING LOGIC
// ========================================

/**
 * Compute a composite score for a strategy.
 * Formula: successRate * log(1 + samples) * recencyBoost
 * 
 * This balances:
 * - Success rate (quality)
 * - Sample size (confidence)
 * - Recency (freshness)
 */
function computeScore(
  successRate: number,
  samples: number,
  lastUsedAt?: string
): number {
  // Base score: success rate weighted by log of sample size
  let score = successRate * Math.log(1 + samples);
  
  // Recency boost: strategies used in last 30 days get a 1.2x multiplier
  if (lastUsedAt) {
    const daysSinceUse = (Date.now() - new Date(lastUsedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceUse < 30) {
      score *= 1.2;
    }
  }
  
  return score;
}

/**
 * Extract niche/tags from a lead's tags array
 */
function extractNicheFromLead(leadData: any): string | undefined {
  if (!leadData?.tags || !Array.isArray(leadData.tags)) return undefined;
  
  // Filter out generic tags like 'chat_request', 'manual', etc.
  const genericTags = ['chat_request', 'manual', 'auto', 'test'];
  const nicheTags = leadData.tags.filter((tag: string) => 
    !genericTags.includes(tag.toLowerCase())
  );
  
  return nicheTags[0]; // Return first meaningful tag as niche
}

/**
 * Extract location info from lead address
 */
function extractLocationFromLead(leadData: any): { city?: string; region?: string; country?: string } {
  if (!leadData?.address) return {};
  
  const address = leadData.address as string;
  const parts = address.split(',').map(p => p.trim());
  
  // Simple heuristic: last part is usually country, second-to-last is region/state
  return {
    country: parts.length > 0 ? parts[parts.length - 1] : undefined,
    region: parts.length > 1 ? parts[parts.length - 2] : undefined,
    city: parts.length > 2 ? parts[0] : undefined
  };
}

// ========================================
// HISTORICAL DATA EXTRACTION
// ========================================

/**
 * Analyze plan executions and leads to build strategy scores.
 * 
 * @param goal - The goal we're planning for (used to filter relevant historical data)
 * @param userId - The user whose historical data to analyze
 * @param accountId - Optional account ID for further scoping
 * @returns Historical context with top and low performers
 */
export async function getHistoricalContextForGoal(
  goal: {
    description?: string;
    targetMarket?: string;
    country?: string;
    region?: string;
    city?: string;
  },
  userId: string,
  accountId?: string
): Promise<HistoricalContext> {
  
  // CRITICAL: Scope to user AND account to prevent cross-user and cross-account data leakage
  let executionsQuery = db
    .select()
    .from(planExecutions)
    .where(sql`${planExecutions.userId} = ${userId}`);
  
  // Add account filter if provided (prevents cross-account leakage for multi-account users)
  if (accountId) {
    executionsQuery = executionsQuery.where(sql`${planExecutions.accountId} = ${accountId}`);
  }
  
  const executions = await executionsQuery
    .orderBy(desc(planExecutions.createdAt))
    .limit(100);
  
  // Fetch recent suggested leads (last 500 for this user/account)
  let leadsQuery = db
    .select()
    .from(suggestedLeads)
    .where(sql`${suggestedLeads.userId} = ${userId}`);
  
  // Add account filter if provided
  if (accountId) {
    leadsQuery = leadsQuery.where(sql`${suggestedLeads.accountId} = ${accountId}`);
  }
  
  const leads = await leadsQuery
    .orderBy(desc(suggestedLeads.createdAt))
    .limit(500);
  
  // Build strategy aggregations
  const strategyMap = new Map<string, {
    key: StrategyKey;
    successCount: number;
    totalCount: number;
    totalLeadsFound: number;
    lastUsedAt?: string;
  }>();
  
  // 1. Extract strategies from plan executions
  for (const exec of executions) {
    const stepResults = exec.stepResults as LeadGenStepResult[];
    const wasSuccessful = exec.overallStatus === 'succeeded';
    const execDate = exec.createdAt?.toISOString();
    const metadata = exec.metadata as any;
    
    // Extract niche/region from metadata (SUP-003) or goal text
    let niche = metadata?.niche || extractNicheFromText(exec.goalText || '');
    let region = metadata?.region || extractRegionFromText(exec.goalText || '');
    const totalLeadsFromMeta = metadata?.totalLeadsFound || 0;
    
    // Process each step result for data source strategies
    if (stepResults && stepResults.length > 0) {
      for (const stepResult of stepResults) {
        // Extract data source from SUP-011 metadata
        const sourceMeta = (stepResult.data as any)?.sourceMeta;
        const dataSource = sourceMeta?.source as LeadDataSourceId | undefined;
        const leadsFound = (stepResult.data as any)?.leadsFound ?? 0;
        
        // Build strategy key using execution's own data (not current goal)
        const strategyKey: StrategyKey = {
          niche: niche || undefined,
          region: region || undefined,
          country: metadata?.country || undefined, // Use execution's country
          dataSource: dataSource || undefined
        };
        
        // Skip empty strategies
        if (!strategyKey.niche && !strategyKey.region && !strategyKey.dataSource) {
          continue;
        }
        
        const keyStr = JSON.stringify(strategyKey);
        const existing = strategyMap.get(keyStr) || {
          key: strategyKey,
          successCount: 0,
          totalCount: 0,
          totalLeadsFound: 0,
          lastUsedAt: execDate
        };
        
        existing.totalCount++;
        existing.totalLeadsFound += leadsFound;
        if (wasSuccessful && stepResult.status === 'succeeded') {
          existing.successCount++;
        }
        
        // Update last used date
        if (execDate && (!existing.lastUsedAt || execDate > existing.lastUsedAt)) {
          existing.lastUsedAt = execDate;
        }
        
        strategyMap.set(keyStr, existing);
      }
    } else {
      // No stepResults - create a single strategy from metadata
      const strategyKey: StrategyKey = {
        niche: niche || undefined,
        region: region || undefined,
        country: metadata?.country || undefined // Use execution's country
      };
      
      if (strategyKey.niche || strategyKey.region) {
        const keyStr = JSON.stringify(strategyKey);
        const existing = strategyMap.get(keyStr) || {
          key: strategyKey,
          successCount: 0,
          totalCount: 0,
          totalLeadsFound: 0,
          lastUsedAt: execDate
        };
        
        existing.totalCount++;
        existing.totalLeadsFound += totalLeadsFromMeta;
        if (wasSuccessful) {
          existing.successCount++;
        }
        
        if (execDate && (!existing.lastUsedAt || execDate > existing.lastUsedAt)) {
          existing.lastUsedAt = execDate;
        }
        
        strategyMap.set(keyStr, existing);
      }
    }
  }
  
  // 2. Extract strategies from suggested leads
  for (const lead of leads) {
    const leadData = lead.lead as any;
    const niche = extractNicheFromLead(leadData);
    const location = extractLocationFromLead(leadData);
    const wasGoodLead = lead.score >= 0.7; // Threshold for "success"
    
    const strategyKey: StrategyKey = {
      niche: niche || undefined,
      ...location
    };
    
    // Skip empty strategies
    if (!strategyKey.niche && !strategyKey.region && !strategyKey.country) {
      continue;
    }
    
    const keyStr = JSON.stringify(strategyKey);
    const existing = strategyMap.get(keyStr) || {
      key: strategyKey,
      successCount: 0,
      totalCount: 0,
      totalLeadsFound: 1,
      lastUsedAt: lead.createdAt?.toISOString()
    };
    
    existing.totalCount++;
    if (wasGoodLead) {
      existing.successCount++;
    }
    
    strategyMap.set(keyStr, existing);
  }
  
  // 3. Convert to StrategyScore objects
  const allScores: StrategyScore[] = [];
  
  for (const [_, data] of Array.from(strategyMap.entries())) {
    const successRate = data.totalCount > 0 ? data.successCount / data.totalCount : 0;
    const score = computeScore(successRate, data.totalCount, data.lastUsedAt);
    const avgLeadsFound = data.totalCount > 0 ? data.totalLeadsFound / data.totalCount : 0;
    
    allScores.push({
      key: data.key,
      score,
      samples: data.totalCount,
      successRate,
      lastUsedAt: data.lastUsedAt,
      avgLeadsFound
    });
  }
  
  // 4. Filter strategies relevant to the goal
  const relevantScores = filterRelevantStrategies(allScores, goal);
  
  // 5. Sort and partition into top/low performers
  relevantScores.sort((a, b) => b.score - a.score);
  
  const topStrategies = relevantScores.slice(0, 10);
  const lowPerformers = relevantScores.slice(-5).reverse(); // Worst 5
  
  return {
    topStrategies,
    lowPerformers
  };
}

/**
 * Filter strategies that are relevant to the given goal.
 * Relevance = matching on niche, region, country, or city.
 */
function filterRelevantStrategies(
  strategies: StrategyScore[],
  goal: {
    description?: string;
    targetMarket?: string;
    country?: string;
    region?: string;
    city?: string;
  }
): StrategyScore[] {
  // If no filtering criteria, return all
  if (!goal.targetMarket && !goal.country && !goal.region && !goal.city) {
    return strategies;
  }
  
  return strategies.filter(s => {
    const key = s.key;
    
    // Match on niche/target market
    if (goal.targetMarket && key.niche) {
      if (key.niche.toLowerCase().includes(goal.targetMarket.toLowerCase()) ||
          goal.targetMarket.toLowerCase().includes(key.niche.toLowerCase())) {
        return true;
      }
    }
    
    // Match on country
    if (goal.country && key.country === goal.country) {
      return true;
    }
    
    // Match on region
    if (goal.region && key.region === goal.region) {
      return true;
    }
    
    // Match on city
    if (goal.city && key.city === goal.city) {
      return true;
    }
    
    return false;
  });
}

/**
 * Extract niche/sector from goal text using simple keyword matching
 */
function extractNicheFromText(text: string): string | null {
  const niches = [
    'pub', 'pubs', 'brewery', 'breweries', 'coffee', 'cafe', 'restaurant',
    'hotel', 'gym', 'spa', 'salon', 'barber', 'dentist', 'clinic',
    'shop', 'store', 'boutique', 'bakery', 'florist'
  ];
  
  const lower = text.toLowerCase();
  for (const niche of niches) {
    if (lower.includes(niche)) {
      return niche;
    }
  }
  
  return null;
}

/**
 * Extract region from goal text using simple keyword matching
 */
function extractRegionFromText(text: string): string | null {
  const regions = [
    'North West', 'North East', 'South West', 'South East',
    'London', 'Manchester', 'Birmingham', 'Leeds', 'Liverpool',
    'Scotland', 'Wales', 'Midlands', 'Yorkshire'
  ];
  
  for (const region of regions) {
    if (text.toLowerCase().includes(region.toLowerCase())) {
      return region;
    }
  }
  
  return null;
}

// ========================================
// TOWER INTEGRATION
// ========================================

/**
 * Get strategy summary for a specific goal/session (for Tower UI)
 */
export async function getStrategySummaryForGoal(goalIdOrSessionId: string): Promise<HistoricalContext> {
  // For now, just return global context
  // In future, could filter by goalId from plan_executions
  return getHistoricalContextForGoal({});
}
