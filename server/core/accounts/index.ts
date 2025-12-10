/**
 * Accounts Module
 * 
 * SUP-17: Ensure accounts have vertical = 'brewery'
 * 
 * Provides domain types and helpers for working with accounts.
 * 
 * @module core/accounts
 */

export {
  // Types
  type Account,
  type RawAccountData,
  type AccountContext,
  // Constants
  DEFAULT_VERTICAL_ID,
  // Helpers
  createAccountFromRaw,
  ensureAccountVertical,
  getAccountVerticalId,
  createAccountContext,
  isBreweryAccount,
} from './types';
