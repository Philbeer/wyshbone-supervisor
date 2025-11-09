import { Resend } from 'resend';

let connectionSettings: any;

async function getCredentials() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? 'depl ' + process.env.WEB_REPL_RENEWAL
    : null;

  if (!xReplitToken) {
    console.error('❌ X_REPLIT_TOKEN not found. REPL_IDENTITY:', process.env.REPL_IDENTITY, 'WEB_REPL_RENEWAL:', process.env.WEB_REPL_RENEWAL);
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  console.log(`🔑 Fetching Resend credentials from: https://${hostname}/api/v2/connection?include_secrets=true&connector_names=resend`);

  const response = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=resend',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  );

  if (!response.ok) {
    console.error(`❌ Failed to fetch connection: ${response.status} ${response.statusText}`);
    const text = await response.text();
    console.error('Response body:', text);
    throw new Error(`Failed to fetch Resend connection: ${response.status}`);
  }

  const data = await response.json();
  console.log('📦 Connection API response:', JSON.stringify(data, null, 2));
  
  connectionSettings = data.items?.[0];

  if (!connectionSettings || !connectionSettings.settings?.api_key) {
    console.error('❌ No valid Resend connection found. Response:', JSON.stringify(data));
    throw new Error('Resend not connected or API key missing');
  }
  
  console.log(`✅ Resend connection found. From email: ${connectionSettings.settings.from_email}`);
  
  // TEMPORARY: Use updated API key until connection is updated
  const apiKey = 're_NFc1V1Po_J6qtoSkLbtsuVryHSJfwjmUp';
  console.log(`🔑 Using updated API key (temporary override)`);
  
  return { 
    apiKey: apiKey, 
    fromEmail: connectionSettings.settings.from_email 
  };
}

export async function getUncachableResendClient() {
  const { apiKey, fromEmail } = await getCredentials();
  return {
    client: new Resend(apiKey),
    fromEmail: fromEmail || 'onboarding@resend.dev'
  };
}
