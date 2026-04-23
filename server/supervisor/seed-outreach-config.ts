/**
 * seed-outreach-config.ts
 *
 * Idempotent seed for the demo user's outreach_config row.
 * Called once on server startup — safe to run on every restart.
 */

import { supabase } from '../supabase';

const DEMO_USER_ID = '8f9079b3ddf739fb0217373c92292e91';

export async function seedDemoOutreachConfig(): Promise<void> {
  if (!supabase) {
    console.warn('[SEED_OUTREACH] Supabase not configured — skipping seed');
    return;
  }

  const { error } = await supabase
    .from('outreach_config')
    .upsert(
      {
        user_id: DEMO_USER_ID,
        display_name: 'Phil',
        handle: 'phil',
        sending_domain: 'wyshbonesales.com',
        reply_to_domain: 'wyshbonesales.com',
        user_real_email: 'phil@wyshbonesales.com',
        signature_text: null,
        enabled: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );

  if (error) {
    throw new Error(`outreach_config upsert failed: ${error.message}`);
  }

  console.log('[SEED_OUTREACH] Demo outreach config seed complete');
}
