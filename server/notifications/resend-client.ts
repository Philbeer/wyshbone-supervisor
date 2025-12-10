import { Resend } from 'resend';

/**
 * Resend email client for Supervisor notifications
 * 
 * Required environment variables:
 * - RESEND_API_KEY: Your Resend API key
 * - RESEND_FROM_EMAIL: The "from" email address (default: onboarding@resend.dev for testing)
 */

let cachedClient: { client: Resend; fromEmail: string } | null = null;

function getResendCredentials() {
  const apiKey = process.env.RESEND_API_KEY;
  
  if (!apiKey) {
    throw new Error(
      'RESEND_API_KEY environment variable is required. ' +
      'Get your API key from https://resend.com/api-keys'
    );
  }
  
  // Use RESEND_FROM_EMAIL if set, otherwise use Resend's default testing email
  // Note: For production, you'll need a verified domain in Resend
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  
  console.log(`📧 Resend configured with from email: ${fromEmail}`);
  
  return { apiKey, fromEmail };
}

export async function getUncachableResendClient() {
  const { apiKey, fromEmail } = getResendCredentials();
  return {
    client: new Resend(apiKey),
    fromEmail
  };
}

export function getResendClient() {
  if (!cachedClient) {
    const { apiKey, fromEmail } = getResendCredentials();
    cachedClient = {
      client: new Resend(apiKey),
      fromEmail
    };
  }
  return cachedClient;
}
