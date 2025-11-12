import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE || '';

if (!supabaseUrl || !supabaseKey) {
  console.warn('⚠️  SUPABASE_URL or SUPABASE_SERVICE_ROLE not configured');
  console.warn('⚠️  Supervisor chat integration will not work until credentials are added');
  console.warn('⚠️  Please add SUPABASE_URL and SUPABASE_SERVICE_ROLE to your secrets');
}

export const supabase = supabaseUrl && supabaseKey 
  ? createClient(supabaseUrl, supabaseKey)
  : null;
