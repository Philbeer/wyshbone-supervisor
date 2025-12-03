/**
 * Save Lead Types
 * 
 * Type definitions for the saveLead feature.
 * SUP-7: Save Lead Endpoint
 */

/**
 * Source of the lead data
 */
export type LeadSource = "google" | "database" | "manual";

/**
 * Incoming lead payload from the UI/API
 */
export interface IncomingLeadPayload {
  lead: {
    businessName: string;
    address: string;
    placeId?: string;
    website?: string;
    phone?: string;
    lat?: number;
    lng?: number;
    source: LeadSource;
  };
  ownerUserId: string;
}

/**
 * A saved lead with metadata
 */
export interface SavedLead {
  id: string;
  ownerUserId: string;
  createdAt: string;
  businessName: string;
  address: string;
  placeId?: string;
  website?: string;
  phone?: string;
  lat?: number;
  lng?: number;
  source: LeadSource;
}

/**
 * Response from the saveLead endpoint
 */
export interface SaveLeadResponse {
  status: "ok";
  leadId: string;
  savedLead: SavedLead;
}

/**
 * Response from the listLeads endpoint
 */
export interface ListLeadsResponse {
  status: "ok";
  leads: SavedLead[];
}

