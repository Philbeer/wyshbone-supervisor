/**
 * Save Lead In-Memory Store
 * 
 * Simple in-memory storage for saved leads.
 * Easy to swap to a real DB later.
 * SUP-7: Save Lead Endpoint
 * SUP-8: Lead Saved Events
 */

import type { IncomingLeadPayload, SavedLead, LeadSavedEvent } from './types';
import { createEventBus, type SupervisorEventBus } from '../../core/event-bus';

/**
 * Generate a unique ID for leads
 */
function generateId(): string {
  return `lead_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Generate a unique ID for events
 */
function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * In-memory store for saved leads
 */
const savedLeads: SavedLead[] = [];

/**
 * Shared event bus for lead events (SUP-8)
 */
let eventBus: SupervisorEventBus = createEventBus();

/**
 * Get the shared event bus for subscribing to lead events
 * Useful for testing and external subscriptions
 */
export function getLeadEventBus(): SupervisorEventBus {
  return eventBus;
}

/**
 * Set a custom event bus (useful for testing)
 */
export function setLeadEventBus(bus: SupervisorEventBus): void {
  eventBus = bus;
}

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
  
  // SUP-8: Emit LeadSaved event
  emitLeadSavedEvent(savedLead);
  
  return savedLead;
}

/**
 * Emit a LeadSaved event after a lead is successfully saved.
 * SUP-8: Lead Saved Events
 * 
 * @param savedLead - The lead that was saved
 */
function emitLeadSavedEvent(savedLead: SavedLead): void {
  const event: LeadSavedEvent = {
    id: generateEventId(),
    type: 'lead.saved',
    timestamp: new Date().toISOString(),
    source: 'lead-store',
    payload: {
      leadId: savedLead.id,
      ownerUserId: savedLead.ownerUserId,
      businessName: savedLead.businessName,
      address: savedLead.address,
      placeId: savedLead.placeId,
      website: savedLead.website,
      phone: savedLead.phone,
      lat: savedLead.lat,
      lng: savedLead.lng,
      source: savedLead.source,
      createdAt: savedLead.createdAt
    }
  };

  console.log("[SUP-8] Emitting LeadSaved event", {
    leadId: savedLead.id,
    ownerUserId: savedLead.ownerUserId,
    source: savedLead.source,
    businessName: savedLead.businessName,
  });

  // Fire-and-forget: don't await, don't block the save operation
  eventBus.publish(event).catch((error) => {
    console.error("[SUP-8] Failed to emit LeadSaved event:", error);
  });
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

