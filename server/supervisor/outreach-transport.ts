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
  try {
    const { client } = getResendClient();

    console.log(`[OUTREACH_TRANSPORT] Sending email: messageId=${input.messageId} to=${input.recipientEmail} from=${input.fromAddress}`);

    const result = await client.emails.send({
      from: input.fromAddress,
      to: input.recipientEmail,
      reply_to: input.replyToAddress,
      subject: input.subject,
      html: input.bodyHtml,
      text: input.bodyText,
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
