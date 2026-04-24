/**
 * outreach-transport.ts
 * 
 * Transport layer for outreach emails via Resend.
 * Handles: sending emails, processing delivery webhooks, processing inbound replies.
 */

import { getResendClient } from '../notifications/resend-client';
import { supabase } from '../supabase';

// ── Types ──

export interface OutreachSendInput {
  messageId: string;
  fromAddress: string;
  replyToAddress: string;
  recipientEmail: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

export interface OutreachSendResult {
  success: boolean;
  resendMessageId: string | null;
  error: string | null;
}

export interface InboundReplyPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

// ── Send ──

export async function sendOutreachEmail(input: OutreachSendInput): Promise<OutreachSendResult> {
  const originalRecipient = input.recipientEmail;

  try {
    let effectiveRecipient = originalRecipient;
    let effectiveSubject = input.subject;
    let effectiveHtml = input.bodyHtml;
    let effectiveText = input.bodyText;
    let layer1Active = false;
    const allowedDomainsEnv = process.env.OUTREACH_ALLOWED_DOMAINS;

    // ── LAYER 1: Test-mode redirect ──
    // If OUTREACH_TEST_MODE=true (case-insensitive), redirect all outgoing
    // email to OUTREACH_TEST_REDIRECT_EMAIL and annotate subject/body so the
    // tester can clearly see where the real email would have gone.
    if ((process.env.OUTREACH_TEST_MODE || '').toLowerCase() === 'true') {
      const redirectAddress = process.env.OUTREACH_TEST_REDIRECT_EMAIL;
      if (!redirectAddress) {
        throw new Error('OUTREACH_TEST_MODE is enabled but OUTREACH_TEST_REDIRECT_EMAIL is not set');
      }
      effectiveRecipient = redirectAddress;
      layer1Active = true;
      effectiveSubject = `[TEST → ${originalRecipient}] ${input.subject}`;
      const testBannerText = `[TEST MODE] This email was redirected from ${originalRecipient} to ${redirectAddress}.\n\n`;
      const testBannerHtml =
        `<div style="background:#fff3cd;border:1px solid #ffc107;padding:8px 12px;margin-bottom:16px;font-family:monospace;font-size:12px;">` +
        `<strong>[TEST MODE]</strong> This email was redirected from <em>${originalRecipient}</em> to <em>${redirectAddress}</em>.` +
        `</div>`;
      effectiveText = testBannerText + input.bodyText;
      effectiveHtml = testBannerHtml + input.bodyHtml;
      console.log(`[OUTREACH_TRANSPORT] LAYER 1 (test-mode redirect): original=${originalRecipient} → redirected=${effectiveRecipient}`);
    }

    // ── LAYER 2: Domain allow-list ──
    // If OUTREACH_ALLOWED_DOMAINS is set (comma-separated list), the effective
    // recipient's domain must appear in that list or the send is blocked.
    // A blocked send marks the message as failed in the DB to keep status accurate.
    if (allowedDomainsEnv) {
      const allowedDomains = allowedDomainsEnv
        .split(',')
        .map(d => d.trim().toLowerCase())
        .filter(Boolean);
      const recipientDomain = effectiveRecipient.split('@')[1]?.toLowerCase() ?? '';
      if (!allowedDomains.includes(recipientDomain)) {
        const errMsg = `LAYER 2 (domain allow-list): domain "${recipientDomain}" is not in OUTREACH_ALLOWED_DOMAINS — send blocked`;
        console.warn(`[OUTREACH_TRANSPORT] ${errMsg}`);
        if (supabase) {
          await supabase
            .from('outreach_messages')
            .update({
              status: 'failed',
              failed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', input.messageId);
        }
        return { success: false, resendMessageId: null, error: errMsg };
      }
      console.log(`[OUTREACH_TRANSPORT] LAYER 2 (domain allow-list): domain="${recipientDomain}" is allowed`);
    }

    // ── LAYER 3: Decision log ──
    // Log a structured record of the routing decision before every send so
    // there is a complete auditable trail of where each message actually went.
    console.log(
      `[OUTREACH_TRANSPORT] LAYER 3 (decision log): messageId=${input.messageId}` +
      ` originalRecipient=${originalRecipient}` +
      ` effectiveRecipient=${effectiveRecipient}` +
      ` testModeActive=${layer1Active}` +
      ` domainCheckActive=${Boolean(allowedDomainsEnv)}` +
      ` from=${input.fromAddress}`
    );

    const { client } = getResendClient();

    const result = await client.emails.send({
      from: input.fromAddress,
      to: effectiveRecipient,
      replyTo: input.replyToAddress,
      subject: effectiveSubject,
      html: effectiveHtml,
      text: effectiveText,
      headers: {
        'X-Wyshbone-Message-Id': input.messageId,
      },
    });

    const resendId = (result as any)?.data?.id ?? (result as any)?.id ?? null;

    if (resendId) {
      console.log(`[OUTREACH_TRANSPORT] Email sent successfully: messageId=${input.messageId} resendId=${resendId}`);

      if (supabase) {
        await supabase
          .from('outreach_messages')
          .update({
            resend_message_id: resendId,
            resend_status: 'sent',
            status: 'sent',
            sent_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', input.messageId);
      }

      return { success: true, resendMessageId: resendId, error: null };
    }

    console.warn(`[OUTREACH_TRANSPORT] Resend returned no ID for messageId=${input.messageId}`);
    return { success: false, resendMessageId: null, error: 'No message ID returned from Resend' };
  } catch (err: any) {
    const errMsg = err.message || String(err);
    console.error(`[OUTREACH_TRANSPORT] Send failed: messageId=${input.messageId} error=${errMsg}`);

    if (supabase) {
      try {
        await supabase
          .from('outreach_messages')
          .update({
            status: 'failed',
            failed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', input.messageId);
      } catch (e) {
        console.error('[OUTREACH_TRANSPORT] Failed to update message status to failed:', e);
      }
    }

    return { success: false, resendMessageId: null, error: errMsg };
  }
}

// ── Delivery Webhook Handler ──

export async function handleDeliveryWebhook(payload: {
  type: string;
  data: {
    email_id: string;
    to: string[];
    created_at: string;
    [key: string]: unknown;
  };
}): Promise<void> {
  if (!supabase) {
    console.warn('[OUTREACH_TRANSPORT] Supabase not configured — cannot process delivery webhook');
    return;
  }

  const resendId = payload.data.email_id;
  const eventType = payload.type;

  console.log(`[OUTREACH_TRANSPORT] Delivery webhook: type=${eventType} resendId=${resendId}`);

  const statusMap: Record<string, string> = {
    'email.delivered': 'delivered',
    'email.bounced': 'bounced',
    'email.complained': 'bounced',
    'email.delivery_delayed': 'sent',
  };

  const newStatus = statusMap[eventType];
  if (!newStatus) {
    console.log(`[OUTREACH_TRANSPORT] Ignoring webhook event type: ${eventType}`);
    return;
  }

  const timestampField = newStatus === 'delivered' ? 'delivered_at' :
                          newStatus === 'bounced' ? 'bounced_at' : null;

  const updatePayload: Record<string, unknown> = {
    status: newStatus,
    resend_status: eventType,
    updated_at: new Date().toISOString(),
  };
  if (timestampField) {
    updatePayload[timestampField] = new Date().toISOString();
  }

  const { error } = await supabase
    .from('outreach_messages')
    .update(updatePayload)
    .eq('resend_message_id', resendId);

  if (error) {
    console.error(`[OUTREACH_TRANSPORT] Failed to update message status: resendId=${resendId} error=${error.message}`);
  } else {
    console.log(`[OUTREACH_TRANSPORT] Updated message status: resendId=${resendId} → ${newStatus}`);
  }
}

// ── Inbound Reply Handler ──

export async function handleInboundReply(payload: InboundReplyPayload): Promise<void> {
  if (!supabase) {
    console.warn('[OUTREACH_TRANSPORT] Supabase not configured — cannot process inbound reply');
    return;
  }

  const toAddress = payload.to;
  const idMatch = toAddress.match(/reply\+([a-zA-Z0-9\-]+)@/);
  if (!idMatch) {
    console.warn(`[OUTREACH_TRANSPORT] Could not extract message ID from reply-to: ${toAddress}`);
    return;
  }

  const messageId = idMatch[1];
  console.log(`[OUTREACH_TRANSPORT] Inbound reply received: messageId=${messageId} from=${payload.from}`);

  const { error } = await supabase
    .from('outreach_messages')
    .update({
      status: 'replied',
      reply_received_at: new Date().toISOString(),
      reply_from: payload.from,
      reply_subject: payload.subject,
      reply_body_text: payload.text?.substring(0, 50000) ?? null,
      reply_body_html: payload.html?.substring(0, 100000) ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', messageId);

  if (error) {
    console.error(`[OUTREACH_TRANSPORT] Failed to record reply: messageId=${messageId} error=${error.message}`);
    return;
  }

  console.log(`[OUTREACH_TRANSPORT] Reply recorded: messageId=${messageId} → status=replied`);

  // Forward the reply to the user's real email
  try {
    const { data: message } = await supabase
      .from('outreach_messages')
      .select('user_id')
      .eq('id', messageId)
      .single();

    if (message?.user_id) {
      const { data: config } = await supabase
        .from('outreach_config')
        .select('user_real_email, display_name')
        .eq('user_id', message.user_id)
        .single();

      if (config?.user_real_email) {
        const { client } = getResendClient();
        await client.emails.send({
          from: `Wyshbone Outreach <notifications@outreach.wyshbone.com>`,
          to: config.user_real_email,
          subject: `[Wyshbone Reply] ${payload.subject}`,
          text: `You received a reply from ${payload.from}:\n\n${payload.text}\n\n---\nThis reply was forwarded by Wyshbone.`,
          html: `<p><strong>You received a reply from ${payload.from}:</strong></p>${payload.html || `<p>${payload.text}</p>`}<hr><p><em>This reply was forwarded by Wyshbone.</em></p>`,
        });
        console.log(`[OUTREACH_TRANSPORT] Reply forwarded to user: ${config.user_real_email}`);
      }
    }
  } catch (fwdErr: any) {
    console.warn(`[OUTREACH_TRANSPORT] Reply forwarding failed (non-fatal): ${fwdErr.message}`);
  }
}

// ── Helpers ──

export function buildFromAddress(displayName: string, handle: string, domain: string): string {
  return `${displayName} <${handle}@${domain}>`;
}

export function buildReplyToAddress(messageId: string, replyDomain: string): string {
  return `reply+${messageId}@${replyDomain}`;
}
