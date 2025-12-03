/**
 * Save Lead Types
 * 
 * Type definitions for the saveLead feature.
 * SUP-7: Save Lead Endpoint
 * SUP-8: Lead Saved Events
 */

import type { BaseSupervisorEvent } from '../../core/types';

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

/**
 * LeadSaved event payload
 * SUP-8: Emitted when a lead is successfully saved
 */
export interface LeadSavedPayload {
  /** Unique ID of the saved lead */
  leadId: string;
  /** User ID who owns this lead */
  ownerUserId: string;
  /** Business name */
  businessName: string;
  /** Business address */
  address: string;
  /** Google Place ID (optional) */
  placeId?: string;
  /** Business website (optional) */
  website?: string;
  /** Business phone (optional) */
  phone?: string;
  /** Latitude coordinate (optional) */
  lat?: number;
  /** Longitude coordinate (optional) */
  lng?: number;
  /** Source of the lead data */
  source: LeadSource;
  /** ISO timestamp when the lead was created */
  createdAt: string;
}

/**
 * LeadSaved event type
 * SUP-8: Published when a lead is successfully saved to the in-memory store
 */
export interface LeadSavedEvent extends BaseSupervisorEvent {
  type: 'lead.saved';
  payload: LeadSavedPayload;
}

