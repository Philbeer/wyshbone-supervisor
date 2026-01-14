/**
 * Account Types
 * 
 * SUP-17: Ensure accounts have vertical = 'brewery'
 * 
 * Domain types for accounts in the Supervisor system.
 * Accounts are managed externally (in Supabase), but this module defines
 * the domain types and helpers for working with account data.
 */

import type { VerticalId } from '../verticals/types';

// ============================================
// ACCOUNT DOMAIN TYPES
// ============================================

/**
 * Domain representation of an account in the Supervisor system.
 * 
 * Accounts are multi-tenant containers that group users and their data.
 * Each account belongs to a vertical (e.g., 'brewery') which determines
 * what features, recipes, and subcon packs are available.
 * 
 * @example
 * ```ts
 * const account: Account = {
 *   id: 'acc_123',
 *   verticalId: 'brewery',
 *   name: 'Listers Brewery',
 * };
 * ```
 */
export interface Account {
  /** Unique identifier for the account */
  id: string;
  /** The vertical this account belongs to (determines available features) */
  verticalId: VerticalId;
  /** Optional display name for the account */
  name?: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Raw account data as it might come from external sources (e.g., Supabase).
 * The vertical_id may be missing or null for legacy accounts.
 */
export interface RawAccountData {
  id: string;
  vertical_id?: string | null;
  name?: string;
  [key: string]: unknown;
}

/**
 * Context containing account information for feature execution.
 * Used by various parts of the system that need to know about the current account.
 */
export interface AccountContext {
  /** Account ID */
  accountId: string;
  /** Vertical ID (always present after SUP-17) */
  verticalId: VerticalId;
  /** Optional user ID within the account */
  userId?: string;
}

// ============================================
// CONSTANTS
// ============================================

/**
 * Default vertical ID for accounts that don't have one set.
 * After SUP-17, all accounts should have verticalId = 'brewery'.
 */
export const DEFAULT_VERTICAL_ID: VerticalId = 'brewery';

// ============================================
// ACCOUNT HELPERS
// ============================================

/**
 * Create an Account domain object from raw account data.
 * Ensures verticalId is always set (defaults to 'brewery').
 * 
 * @param raw - Raw account data (e.g., from Supabase)
 * @returns Account with guaranteed verticalId
 * 
 * @example
 * ```ts
 * // Raw data from Supabase (might be missing vertical_id)
 * const raw = { id: 'acc_123', vertical_id: null };
 * const account = createAccountFromRaw(raw);
 * // account.verticalId === 'brewery'
 * ```
 */
export function createAccountFromRaw(raw: RawAccountData): Account {
  return {
    id: raw.id,
    verticalId: (raw.vertical_id as VerticalId) || DEFAULT_VERTICAL_ID,
    name: raw.name,
    metadata: Object.fromEntries(
      Object.entries(raw).filter(([key]) => 
        !['id', 'vertical_id', 'name'].includes(key)
      )
    ),
  };
}

/**
 * Ensure an account has a verticalId set.
 * If verticalId is missing or undefined, defaults to 'brewery'.
 * 
 * @param account - Account that might have missing verticalId
 * @returns Account with guaranteed verticalId
 */
export function ensureAccountVertical(account: Partial<Account> & { id: string }): Account {
  return {
    ...account,
    id: account.id,
    verticalId: account.verticalId || DEFAULT_VERTICAL_ID,
  };
}

/**
 * Get the vertical ID for an account, with fallback to default.
 * Safe to call with undefined/null values.
 * 
 * @param verticalId - Optional vertical ID (may be undefined/null)
 * @returns A valid VerticalId (defaults to 'brewery')
 * 
 * @example
 * ```ts
 * getAccountVerticalId(undefined); // 'brewery'
 * getAccountVerticalId('brewery'); // 'brewery'
 * getAccountVerticalId(null as any); // 'brewery'
 * ```
 */
export function getAccountVerticalId(verticalId: VerticalId | undefined | null): VerticalId {
  return verticalId || DEFAULT_VERTICAL_ID;
}

/**
 * Create an AccountContext from account data.
 * Ensures verticalId is always set.
 * 
 * @param accountId - The account ID
 * @param verticalId - Optional vertical ID (defaults to 'brewery')
 * @param userId - Optional user ID
 * @returns AccountContext with guaranteed verticalId
 */
export function createAccountContext(
  accountId: string,
  verticalId?: VerticalId | null,
  userId?: string
): AccountContext {
  return {
    accountId,
    verticalId: getAccountVerticalId(verticalId),
    userId,
  };
}

/**
 * Check if an account is in the brewery vertical.
 * 
 * @param account - Account or partial account data
 * @returns true if the account is in the brewery vertical
 */
export function isBreweryAccount(account: { verticalId?: VerticalId | null }): boolean {
  return getAccountVerticalId(account.verticalId) === 'brewery';
}
