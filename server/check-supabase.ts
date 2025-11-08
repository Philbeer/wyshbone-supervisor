import { supabase } from './supabase';

async function checkSupabaseSignals() {
  console.log('Connecting to Supabase...');
  
  // Try to fetch from user_signals table
  const { data, error } = await supabase
    .from('user_signals')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);
  
  if (error) {
    console.error('Error fetching signals:', error);
    return;
  }
  
  console.log(`\nFound ${data?.length || 0} signals in Supabase:`);
  console.log(JSON.stringify(data, null, 2));
}

checkSupabaseSignals();
