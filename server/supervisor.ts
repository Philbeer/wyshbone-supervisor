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
    // Get the timestamp of the latest processed signal
    const latestProcessedTimestamp = await storage.getLatestProcessedTimestamp('supabase');
    
    // Fetch signals newer than the latest processed one
    let query = supabase
      .from('user_signals')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(this.batchSize);
    
    // Only fetch signals created after the latest processed timestamp
    if (latestProcessedTimestamp) {
      query = query.gt('created_at', latestProcessedTimestamp.toISOString());
    }

    const { data: signals, error } = await query;

    if (error) {
      console.error('Error fetching signals from Supabase:', error);
      return;
    }

    if (!signals || signals.length === 0) {
      return;
    }

    // Process each signal in order - stop on first failure to preserve timestamp order
    for (const signal of signals) {
      const signalId = signal.id.toString();
      const signalCreatedAt = new Date(signal.created_at);
      
      console.log(`📊 Processing new signal ${signalId} (${signal.type})...`);
      
      try {
        await this.generateLeadsFromSignal(signal);
        // Only mark as processed AFTER successful lead generation
        await storage.markSignalProcessed(signalId, 'supabase', signalCreatedAt);
      } catch (error) {
        console.error(`Failed to process signal ${signalId}:`, error);
        // Break the loop - don't advance timestamp past this failed signal
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
