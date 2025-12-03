/**
 * Save Lead In-Memory Store
 * 
 * Simple in-memory storage for saved leads.
 * Easy to swap to a real DB later.
 * SUP-7: Save Lead Endpoint
 */

import type { IncomingLeadPayload, SavedLead } from './types';

/**
 * Generate a unique ID
 */
function generateId(): string {
  return `lead_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * In-memory store for saved leads
 */
const savedLeads: SavedLead[] = [];

/**
 * Save a lead to the in-memory store.
 * 
 * @param input - The incoming lead payload
 * @returns The saved lead with id, ownerUserId, and createdAt
 */
export function saveLead(input: IncomingLeadPayload): SavedLead {
  const { lead, ownerUserId } = input;
  
  console.log("[SUP-7] saveLead called", { 
    ownerUserId, 
    source: lead.source, 
    businessName: lead.businessName 
  });
  
  const savedLead: SavedLead = {
    id: generateId(),
    ownerUserId,
    createdAt: new Date().toISOString(),
    businessName: lead.businessName,
    address: lead.address,
    placeId: lead.placeId,
    website: lead.website,
    phone: lead.phone,
    lat: lead.lat,
    lng: lead.lng,
    source: lead.source
  };
  
  savedLeads.push(savedLead);
  
  console.log(`[SUP-7] Lead saved with id: ${savedLead.id}`);
  
  return savedLead;
}

/**
 * List saved leads, optionally filtered by owner.
 * 
 * @param ownerUserId - Optional user ID to filter by
 * @returns Array of saved leads
 */
export function listSavedLeads(ownerUserId?: string): SavedLead[] {
  if (ownerUserId) {
    return savedLeads.filter(lead => lead.ownerUserId === ownerUserId);
  }
  return [...savedLeads];
}

/**
 * Get the current count of saved leads (useful for testing)
 */
export function getSavedLeadsCount(): number {
  return savedLeads.length;
}

/**
 * Clear all saved leads (useful for testing)
 */
export function clearSavedLeads(): void {
  savedLeads.length = 0;
}

/**
 * Get a saved lead by ID
 */
export function getSavedLeadById(id: string): SavedLead | undefined {
  return savedLeads.find(lead => lead.id === id);
}

