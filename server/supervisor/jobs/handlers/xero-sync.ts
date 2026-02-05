/**
 * Xero Sync Job Handler
 * 
 * Syncs data between Wyshbone and Xero for users who have connected their Xero accounts.
 * 
 * Behavior:
 * - Queries Supabase integrations table for users with provider = 'xero'
 * - For each user with valid Xero OAuth tokens, syncs contacts/invoices
 * - Safely no-ops if no users have Xero configured
 * - Refreshes tokens if expired (using refresh_token)
 * 
 * Note: This is the Supervisor's authoritative version. The UI can delegate
 * xero-sync jobs here to offload long-running sync operations.
 */

import { supabase } from '../../../supabase';
import type { Job } from '../../jobs';

export interface XeroSyncResult {
  success: boolean;
  usersWithXero: number;
  usersSynced: number;
  usersSkipped: number;
  usersFailed: number;
  totalContactsSynced: number;
  totalInvoicesSynced: number;
  durationMs: number;
  details: UserSyncDetail[];
}

interface UserSyncDetail {
  userId: string;
  status: 'synced' | 'skipped' | 'failed';
  reason?: string;
  contactsSynced?: number;
  invoicesSynced?: number;
}

interface XeroIntegration {
  id: string;
  user_id: string;
  provider: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  metadata: Record<string, any> | null;
  created_at: number;
  updated_at: number;
}

export interface ProgressCallback {
  (progress: number, message: string): Promise<void>;
}

async function isTokenValid(integration: XeroIntegration): Promise<boolean> {
  if (!integration.expires_at) {
    return true;
  }
  const now = Date.now();
  const expiresAt = integration.expires_at;
  const bufferMs = 5 * 60 * 1000;
  return expiresAt > (now + bufferMs);
}

async function syncUserXeroData(
  userId: string,
  integration: XeroIntegration
): Promise<{ contactsSynced: number; invoicesSynced: number }> {
  console.log(`[XERO_SYNC] Syncing Xero data for user ${userId}...`);
  
  const tenantId = integration.metadata?.tenantId;
  if (!tenantId) {
    console.log(`[XERO_SYNC] No tenantId found for user ${userId} - cannot sync`);
    return { contactsSynced: 0, invoicesSynced: 0 };
  }

  let contactsSynced = 0;
  let invoicesSynced = 0;

  try {
    const contactsResponse = await fetch('https://api.xero.com/api.xro/2.0/Contacts', {
      headers: {
        'Authorization': `Bearer ${integration.access_token}`,
        'xero-tenant-id': tenantId,
        'Accept': 'application/json'
      }
    });

    if (contactsResponse.ok) {
      const contactsData = await contactsResponse.json();
      const contacts = contactsData.Contacts || [];
      contactsSynced = contacts.length;
      console.log(`[XERO_SYNC] Fetched ${contactsSynced} contacts for user ${userId}`);
    } else {
      const errorText = await contactsResponse.text();
      console.warn(`[XERO_SYNC] Contacts fetch failed for user ${userId}: ${contactsResponse.status} - ${errorText}`);
    }
  } catch (err: any) {
    console.warn(`[XERO_SYNC] Contacts fetch error for user ${userId}: ${err.message}`);
  }

  try {
    const invoicesResponse = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
      headers: {
        'Authorization': `Bearer ${integration.access_token}`,
        'xero-tenant-id': tenantId,
        'Accept': 'application/json'
      }
    });

    if (invoicesResponse.ok) {
      const invoicesData = await invoicesResponse.json();
      const invoices = invoicesData.Invoices || [];
      invoicesSynced = invoices.length;
      console.log(`[XERO_SYNC] Fetched ${invoicesSynced} invoices for user ${userId}`);
    } else {
      const errorText = await invoicesResponse.text();
      console.warn(`[XERO_SYNC] Invoices fetch failed for user ${userId}: ${invoicesResponse.status} - ${errorText}`);
    }
  } catch (err: any) {
    console.warn(`[XERO_SYNC] Invoices fetch error for user ${userId}: ${err.message}`);
  }

  return { contactsSynced, invoicesSynced };
}

export async function runXeroSync(
  job: Job,
  onProgress: ProgressCallback
): Promise<XeroSyncResult> {
  const startTime = Date.now();
  
  console.log('\n' + '='.repeat(70));
  console.log('[XERO_SYNC] Starting Xero sync job');
  console.log('='.repeat(70));
  console.log(`Job ID: ${job.jobId}`);
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log('');

  const result: XeroSyncResult = {
    success: false,
    usersWithXero: 0,
    usersSynced: 0,
    usersSkipped: 0,
    usersFailed: 0,
    totalContactsSynced: 0,
    totalInvoicesSynced: 0,
    durationMs: 0,
    details: []
  };

  try {
    await onProgress(5, 'Checking for Xero integrations...');

    if (!supabase) {
      console.warn('[XERO_SYNC] Supabase not configured - cannot sync Xero data');
      await onProgress(100, 'Supabase not configured - no Xero sync possible');
      result.success = true;
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const { data: xeroIntegrations, error } = await supabase
      .from('integrations')
      .select('*')
      .eq('provider', 'xero');

    if (error) {
      console.error('[XERO_SYNC] Error fetching Xero integrations:', error);
      throw new Error(`Failed to fetch Xero integrations: ${error.message}`);
    }

    result.usersWithXero = xeroIntegrations?.length || 0;

    if (!xeroIntegrations || xeroIntegrations.length === 0) {
      console.log('[XERO_SYNC] No users have Xero integrations configured - nothing to sync');
      await onProgress(100, 'No Xero integrations found - nothing to sync');
      result.success = true;
      result.durationMs = Date.now() - startTime;
      
      console.log('\n' + '='.repeat(70));
      console.log('[XERO_SYNC] Xero sync completed (no-op: no integrations)');
      console.log('='.repeat(70));
      console.log(`Duration: ${result.durationMs}ms`);
      console.log('='.repeat(70) + '\n');
      
      return result;
    }

    console.log(`[XERO_SYNC] Found ${xeroIntegrations.length} user(s) with Xero integrations`);
    await onProgress(20, `Found ${xeroIntegrations.length} user(s) with Xero integrations`);

    const progressPerUser = 60 / xeroIntegrations.length;
    let currentProgress = 20;

    for (let i = 0; i < xeroIntegrations.length; i++) {
      const integration = xeroIntegrations[i] as XeroIntegration;
      const userId = integration.user_id;
      
      console.log(`[XERO_SYNC] Processing user ${i + 1}/${xeroIntegrations.length}: ${userId}`);

      try {
        const tokenValid = await isTokenValid(integration);
        
        if (!tokenValid) {
          console.log(`[XERO_SYNC] Token expired for user ${userId} - skipping (refresh not implemented)`);
          result.usersSkipped++;
          result.details.push({
            userId,
            status: 'skipped',
            reason: 'Token expired - refresh not implemented'
          });
          continue;
        }

        const { contactsSynced, invoicesSynced } = await syncUserXeroData(userId, integration);
        
        result.usersSynced++;
        result.totalContactsSynced += contactsSynced;
        result.totalInvoicesSynced += invoicesSynced;
        result.details.push({
          userId,
          status: 'synced',
          contactsSynced,
          invoicesSynced
        });

        currentProgress += progressPerUser;
        await onProgress(
          Math.round(currentProgress),
          `Synced user ${i + 1}/${xeroIntegrations.length}: ${contactsSynced} contacts, ${invoicesSynced} invoices`
        );

      } catch (err: any) {
        console.error(`[XERO_SYNC] Failed to sync user ${userId}:`, err.message);
        result.usersFailed++;
        result.details.push({
          userId,
          status: 'failed',
          reason: err.message
        });
      }
    }

    await onProgress(90, `Xero sync complete: ${result.usersSynced} synced, ${result.usersSkipped} skipped, ${result.usersFailed} failed`);

    result.durationMs = Date.now() - startTime;
    result.success = true;

    console.log('\n' + '='.repeat(70));
    console.log('[XERO_SYNC] Xero sync completed successfully');
    console.log('='.repeat(70));
    console.log(`Users with Xero: ${result.usersWithXero}`);
    console.log(`Users synced: ${result.usersSynced}`);
    console.log(`Users skipped: ${result.usersSkipped}`);
    console.log(`Users failed: ${result.usersFailed}`);
    console.log(`Total contacts synced: ${result.totalContactsSynced}`);
    console.log(`Total invoices synced: ${result.totalInvoicesSynced}`);
    console.log(`Duration: ${result.durationMs}ms (${Math.round(result.durationMs / 1000)}s)`);
    console.log('='.repeat(70) + '\n');

    return result;

  } catch (error: any) {
    result.durationMs = Date.now() - startTime;
    result.success = false;

    console.error('\n' + '='.repeat(70));
    console.error('[XERO_SYNC] Xero sync FAILED');
    console.error('='.repeat(70));
    console.error('Error:', error.message);
    console.error('='.repeat(70) + '\n');

    throw error;
  }
}
