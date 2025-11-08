import { supabase } from './supabase';
import { storage } from './storage';

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

    // Generate a lead based on the signal
    // For now, this is a simple mock implementation
    // Later we'll integrate with Google Places API and email finders
    
    const leadName = this.generateLeadName(industry, location);
    const leadAddress = this.generateLeadAddress(location);
    
    const lead = {
      userId: signal.user_id,
      rationale: `Generated from ${signal.type} signal - ${industry} business in ${location?.city || 'target area'}${prefs?.packaging ? ` interested in ${prefs.packaging}` : ''}`,
      source: 'supervisor_auto',
      score: 0.80 + Math.random() * 0.15, // Score between 0.80-0.95
      lead: {
        name: leadName,
        address: leadAddress,
        place_id: `generated_${Date.now()}`,
        domain: this.generateDomain(leadName),
        emailCandidates: [this.generateEmail(leadName)],
        tags: [industry, signal.type]
      }
    };

    // Create the lead - let errors bubble up to caller
    await storage.createSuggestedLead(lead);
    console.log(`✅ Generated lead: ${leadName}`);
  }

  private generateLeadName(industry: string, location: any): string {
    const prefixes = ['The', 'Local', 'Premier', 'Quality'];
    const suffixes = industry === 'brewery' 
      ? ['Bottle Shop', 'Beer House', 'Craft Market', 'Brew Depot']
      : ['Market', 'Shop', 'Store', 'Outlet'];
    
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
    const city = location?.city || 'Local';
    
    return `${prefix} ${city} ${suffix}`;
  }

  private generateLeadAddress(location: any): string {
    const streetNum = Math.floor(Math.random() * 500) + 1;
    const streets = ['High Street', 'Main Road', 'Market Street', 'Station Road'];
    const street = streets[Math.floor(Math.random() * streets.length)];
    const city = location?.city || 'Unknown';
    const country = location?.country || 'UK';
    
    return `${streetNum} ${street}, ${city}, ${country}`;
  }

  private generateDomain(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '')
      .substring(0, 20) + '.co.uk';
  }

  private generateEmail(name: string): string {
    const domain = this.generateDomain(name);
    return `info@${domain}`;
  }
}

export const supervisor = new SupervisorService();
