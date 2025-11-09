import { supabase } from './supabase';
import { storage } from './storage';
import { emailService } from './notifications/email-service';

interface UserContext {
  userId: string;
  profile?: {
    companyName?: string;
    companyDomain?: string;
    inferredIndustry?: string;
    primaryObjective?: string;
    secondaryObjectives?: string[];
    targetMarkets?: string[];
    productsOrServices?: string[];
    confidence?: number;
  };
  facts: Array<{
    fact: string;
    score: number;
    category: string;
    createdAt: string;
  }>;
  recentMessages: Array<{
    role: string;
    content: string;
    createdAt: string;
  }>;
  monitors: Array<{
    label: string;
    description: string;
    monitorType: string;
  }>;
  researchRuns: Array<{
    label: string;
    prompt: string;
  }>;
}

class SupervisorService {
  private pollInterval: number = 30000; // 30 seconds
  private isRunning: boolean = false;
  private timeoutId?: NodeJS.Timeout;
  private batchSize: number = 50; // Process up to 50 signals per poll

  async start() {
    if (this.isRunning) {
      console.log('Supervisor already running');
      return;
    }

    this.isRunning = true;
    console.log('🤖 Supervisor service started - monitoring for new signals...');
    await this.poll();
  }

  stop() {
    this.isRunning = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
    console.log('Supervisor service stopped');
  }

  private async poll() {
    if (!this.isRunning) return;

    try {
      await this.processNewSignals();
    } catch (error) {
      console.error('Error in supervisor poll:', error);
    }

    this.timeoutId = setTimeout(() => this.poll(), this.pollInterval);
  }

  private async processNewSignals() {
    // Get composite checkpoint {timestamp, id}
    const checkpoint = await storage.getSupervisorCheckpoint('supabase');
    
    // Fetch signals using timestamp-only server filter, then client-side composite cursor
    // This works around PostgREST .or() limitations while remaining efficient
    let query = supabase
      .from('user_signals')
      .select('*')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(this.batchSize + 50); // Fetch extra to handle same-timestamp filtering
    
    if (checkpoint.timestamp) {
      // Fetch signals at or after checkpoint timestamp (server-side)
      query = query.gte('created_at', checkpoint.timestamp.toISOString());
    }
    // else: no checkpoint, fetch from beginning

    const { data: rawSignals, error } = await query;

    if (error) {
      console.error('Error fetching signals from Supabase:', error);
      return;
    }

    if (!rawSignals || rawSignals.length === 0) {
      return;
    }

    // Client-side composite cursor filter: exclude signals at/before checkpoint
    const filteredSignals = rawSignals.filter(signal => {
      if (!checkpoint.timestamp || !checkpoint.id) {
        return true; // No checkpoint, process all
      }
      
      const signalTime = new Date(signal.created_at).getTime();
      const checkpointTime = checkpoint.timestamp.getTime();
      
      // Only include if AFTER checkpoint: (ts > checkpoint.ts) OR (ts == checkpoint.ts AND id > checkpoint.id)
      if (signalTime > checkpointTime) {
        return true;
      } else if (signalTime === checkpointTime) {
        // Numeric comparison for bigint IDs
        const signalId = BigInt(signal.id);
        const checkpointId = BigInt(checkpoint.id);
        return signalId > checkpointId;
      }
      return false;
    });

    // Take only batch size after filtering
    const signals = filteredSignals.slice(0, this.batchSize);

    if (signals.length === 0) {
      return;
    }

    // Process each signal in order - stop on first failure
    for (const signal of signals) {
      const signalId = signal.id.toString();
      const signalCreatedAt = new Date(signal.created_at);
      
      // Check if already processed (idempotency guard - redundant but safe)
      const alreadyProcessed = await storage.isSignalProcessed(signalId, 'supabase');
      if (alreadyProcessed) {
        console.log(`⏭️  Signal ${signalId} already processed, skipping...`);
        continue;
      }
      
      console.log(`📊 Processing new signal ${signalId} (${signal.type})...`);
      
      try {
        await this.generateLeadsFromSignal(signal);
        
        // Mark as processed in processed_signals table (idempotency)
        await storage.markSignalProcessed(signalId, 'supabase', signalCreatedAt);
        
        // Update checkpoint to this signal's position
        await storage.updateSupervisorCheckpoint('supabase', signalCreatedAt, signalId);
        
        console.log(`✅ Checkpoint updated: ${signalCreatedAt.toISOString()} / ${signalId}`);
      } catch (error) {
        console.error(`Failed to process signal ${signalId}:`, error);
        // Break the loop - don't advance checkpoint past this failed signal
        // Will retry this signal and remaining signals on next poll
        break;
      }
    }
  }

  private async generateLeadsFromSignal(signal: any) {
    const payload = signal.payload;
    const userProfile = payload?.userProfile;

    if (!userProfile) {
      console.log('Signal has no userProfile, skipping');
      return;
    }

    const { industry, location, prefs } = userProfile;
    
    if (!industry) {
      console.log('Signal has no industry in userProfile, skipping');
      return;
    }

    const city = location?.city || 'Local';
    const country = location?.country || 'UK';

    // Build comprehensive user context
    const userContext = await this.buildUserContext(signal.user_id);

    console.log(`🔍 Searching for ${industry} businesses in ${city}, ${country}...`);

    try {
      // Search for businesses using Google Places API
      const businesses = await this.searchGooglePlaces(industry, city, country);
      
      if (!businesses || businesses.length === 0) {
        console.log(`⚠️  No businesses found for ${industry} in ${city}`);
        return;
      }

      // Generate one lead from the first result
      const business = businesses[0];
      console.log(`📍 Found business: ${business.displayName?.text || 'Unknown'}`);

      // Try to find email using Hunter.io if we have a domain
      let emailCandidates: string[] = [];
      if (business.websiteUri) {
        try {
          const domain = new URL(business.websiteUri).hostname.replace('www.', '');
          console.log(`📧 Searching for emails at ${domain}...`);
          emailCandidates = await this.findEmails(domain);
          console.log(`✉️  Found ${emailCandidates.length} email candidates`);
        } catch (e) {
          console.log(`⚠️  Could not extract domain from ${business.websiteUri}`);
        }
      }

      // Generate intelligent rationale using full user context
      const rationale = this.generateRationale(signal, userContext, business, industry, city);

      // Calculate smarter score based on context matching
      const score = this.calculateLeadScore(userContext, business, industry);

      const lead = {
        userId: signal.user_id,
        rationale,
        source: 'supervisor_auto',
        score,
        lead: {
          name: business.displayName?.text || 'Unknown Business',
          address: business.formattedAddress || `${city}, ${country}`,
          place_id: business.id || '',
          domain: business.websiteUri || '',
          emailCandidates,
          tags: [industry, signal.type],
          phone: business.nationalPhoneNumber || business.internationalPhoneNumber || ''
        }
      };

      const createdLead = await storage.createSuggestedLead(lead);
      console.log(`✅ Generated lead: ${lead.lead.name} (score: ${(score * 100).toFixed(0)}%)`);

      // Send email notification to user
      await this.notifyLeadCreated(createdLead);
    } catch (error) {
      console.error(`Failed to generate lead from Google Places:`, error);
      throw error;
    }
  }

  private async notifyLeadCreated(lead: any): Promise<void> {
    try {
      // Get user email from Supabase
      const userInfo = await storage.getUserEmail(lead.userId);
      
      if (!userInfo || !userInfo.email) {
        console.log(`⚠️  No email found for user ${lead.userId}, skipping notification`);
        return;
      }

      // Generate dashboard URL from environment variable
      const dashboardUrl = process.env.DASHBOARD_URL || 
        (process.env.REPL_SLUG 
          ? `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`
          : 'http://localhost:5000');

      // Send email notification
      await emailService.sendLeadCreatedEmail({
        lead,
        userEmail: userInfo.email,
        userName: userInfo.name,
        dashboardUrl
      });
    } catch (error) {
      // Log error but don't block the supervisor loop
      console.error(`❌ Failed to send email notification for lead ${lead.id}:`, error);
    }
  }

  private generateRationale(signal: any, context: UserContext, business: any, industry: string, city: string): string {
    const parts: string[] = [];
    
    // Base rationale from signal
    parts.push(`${business.displayName?.text || 'Business'} in ${city}`);

    // Add context from user profile
    if (context.profile?.primaryObjective) {
      parts.push(`Matches objective: "${context.profile.primaryObjective}"`);
    }

    // Add relevant facts
    const relevantFacts = context.facts
      .filter(f => f.category === 'industry' || f.category === 'place' || f.score >= 85)
      .slice(0, 2);
    
    if (relevantFacts.length > 0) {
      parts.push(`User interests: ${relevantFacts.map(f => f.fact).join(', ')}`);
    }

    return parts.join(' • ');
  }

  private calculateLeadScore(context: UserContext, business: any, industry: string): number {
    let score = 0.75; // Base score

    // Boost if matches user's inferred industry
    if (context.profile?.inferredIndustry && context.profile.inferredIndustry.toLowerCase().includes(industry.toLowerCase())) {
      score += 0.10;
    }

    // Boost if matches target markets
    if (context.profile?.targetMarkets && context.profile.targetMarkets.length > 0) {
      score += 0.05;
    }

    // Boost if user has high-value facts in same category
    const relevantFacts = context.facts.filter(f => f.category === 'industry' && f.score >= 80);
    if (relevantFacts.length > 0) {
      score += 0.05;
    }

    // Boost if user has active monitors (shows engagement)
    if (context.monitors.length > 0) {
      score += 0.03;
    }

    // Cap at 0.98
    return Math.min(score, 0.98);
  }

  async getUserContext(userId: string): Promise<UserContext> {
    return this.buildUserContext(userId);
  }

  private async buildUserContext(userId: string): Promise<UserContext> {
    console.log(`🔍 Building comprehensive context for user: ${userId}`);
    
    const context: UserContext = {
      userId,
      facts: [],
      recentMessages: [],
      monitors: [],
      researchRuns: []
    };

    try {
      // Get user profile
      const { data: userProfile } = await supabase
        .from('users')
        .select('company_name, company_domain, inferred_industry, primary_objective, secondary_objectives, target_markets, products_or_services, confidence')
        .eq('id', userId)
        .single();

      if (userProfile) {
        context.profile = {
          companyName: userProfile.company_name,
          companyDomain: userProfile.company_domain,
          inferredIndustry: userProfile.inferred_industry,
          primaryObjective: userProfile.primary_objective,
          secondaryObjectives: userProfile.secondary_objectives,
          targetMarkets: userProfile.target_markets,
          productsOrServices: userProfile.products_or_services,
          confidence: userProfile.confidence
        };
        console.log(`  📋 Profile: ${userProfile.company_name || 'Unknown'} (${userProfile.inferred_industry || 'Unknown industry'})`);
      }

      // Get top ranked facts (score >= 70)
      const { data: facts } = await supabase
        .from('facts')
        .select('fact, score, category, created_at')
        .eq('user_id', userId)
        .gte('score', 70)
        .order('score', { ascending: false })
        .limit(10);

      if (facts) {
        context.facts = facts.map(f => ({
          fact: f.fact,
          score: f.score,
          category: f.category,
          createdAt: new Date(f.created_at).toISOString()
        }));
        console.log(`  ✨ Found ${facts.length} high-value facts (score >= 70)`);
      }

      // Get recent conversations and messages (last 50 messages)
      const { data: conversations } = await supabase
        .from('conversations')
        .select('id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(5);

      if (conversations && conversations.length > 0) {
        const conversationIds = conversations.map(c => c.id);
        const { data: messages } = await supabase
          .from('messages')
          .select('role, content, created_at')
          .in('conversation_id', conversationIds)
          .order('created_at', { ascending: false })
          .limit(50);

        if (messages) {
          context.recentMessages = messages.map(m => ({
            role: m.role,
            content: m.content,
            createdAt: new Date(m.created_at).toISOString()
          }));
          console.log(`  💬 Found ${messages.length} recent messages`);
        }
      }

      // Get active monitors
      const { data: monitors } = await supabase
        .from('scheduled_monitors')
        .select('label, description, monitor_type')
        .eq('user_id', userId)
        .eq('is_active', 1)
        .limit(10);

      if (monitors) {
        context.monitors = monitors.map(m => ({
          label: m.label,
          description: m.description,
          monitorType: m.monitor_type
        }));
        console.log(`  📊 Found ${monitors.length} active monitors`);
      }

      // Get recent research runs
      const { data: researchRuns } = await supabase
        .from('deep_research_runs')
        .select('label, prompt')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(5);

      if (researchRuns) {
        context.researchRuns = researchRuns.map(r => ({
          label: r.label,
          prompt: r.prompt
        }));
        console.log(`  🔬 Found ${researchRuns.length} research runs`);
      }

    } catch (error) {
      console.error('Error building user context:', error);
    }

    return context;
  }

  private async searchGooglePlaces(industry: string, city: string, country: string): Promise<any[]> {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_PLACES_API_KEY not configured');
    }

    // Map industry to search query
    const queryMap: Record<string, string> = {
      'brewery': 'brewery',
      'distillery': 'distillery',
      'winery': 'winery',
      'restaurant': 'restaurant',
      'bar': 'bar'
    };
    const query = queryMap[industry.toLowerCase()] || industry;

    const url = 'https://places.googleapis.com/v1/places:searchText';
    const requestBody = {
      textQuery: `${query} in ${city} ${country}`,
      maxResultCount: 3
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.internationalPhoneNumber'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google Places API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return data.places || [];
  }

  private async findEmails(domain: string): Promise<string[]> {
    const apiKey = process.env.HUNTER_IO_API_KEY;
    if (!apiKey) {
      console.log('⚠️  HUNTER_IO_API_KEY not configured, skipping email search');
      return [];
    }

    try {
      const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${apiKey}&limit=3`;
      
      const response = await fetch(url);
      if (!response.ok) {
        console.log(`⚠️  Hunter.io API error: ${response.status}`);
        return [];
      }

      const data = await response.json();
      
      if (data.data?.emails && data.data.emails.length > 0) {
        return data.data.emails
          .filter((e: any) => e.value)
          .map((e: any) => e.value)
          .slice(0, 3);
      }

      return [];
    } catch (error) {
      console.log(`⚠️  Hunter.io search failed:`, error);
      return [];
    }
  }

}

export const supervisor = new SupervisorService();
