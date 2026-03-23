/**
 * routes-outreach.ts
 * 
 * API routes for outreach:
 * - GET/POST /api/outreach/config
 * - GET /api/outreach/drafts
 * - POST /api/outreach/approve
 * - POST /api/outreach/send
 * - POST /api/outreach/send-all
 * - POST /api/outreach/webhook/delivery
 * - POST /api/outreach/webhook/inbound
 */

import { Router } from 'express';
import { supabase } from '../supabase';
import {
  sendOutreachEmail,
  handleDeliveryWebhook,
  handleInboundReply,
  buildFromAddress,
} from '../supervisor/outreach-transport';

export const outreachRouter = Router();

function getUserId(req: any): string {
  return req.body?.userId || req.query?.user_id || '8f9079b3ddf739fb0217373c92292e91';
}

// GET /config
outreachRouter.get('/config', async (req, res) => {
  const userId = getUserId(req);
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  try {
    const { data, error } = await supabase
      .from('outreach_config')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    res.json({ config: data ?? null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /config
outreachRouter.post('/config', async (req, res) => {
  const userId = getUserId(req);
  const { display_name, handle, signature_text, user_real_email } = req.body;

  if (!display_name || !handle) {
    return res.status(400).json({ error: 'display_name and handle are required' });
  }
  if (!/^[a-zA-Z0-9.\-]+$/.test(handle)) {
    return res.status(400).json({ error: 'Handle must contain only letters, numbers, dots, and hyphens' });
  }
  if (handle.length < 3 || handle.length > 60) {
    return res.status(400).json({ error: 'Handle must be between 3 and 60 characters' });
  }
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  try {
    const { data: existing } = await supabase
      .from('outreach_config')
      .select('user_id')
      .eq('handle', handle)
      .neq('user_id', userId)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'This handle is already taken. Please choose another.' });
    }

    const { data, error } = await supabase
      .from('outreach_config')
      .upsert({
        user_id: userId,
        display_name,
        handle,
        signature_text: signature_text || null,
        user_real_email: user_real_email || null,
        sending_domain: 'wyshbonesales.com',
        reply_to_domain: 'wyshbonesales.com',
        enabled: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) throw error;

    const fromPreview = buildFromAddress(display_name, handle, 'wyshbonesales.com');
    res.json({
      config: data,
      preview: { from_address: fromPreview, example_reply_to: `reply+example-id@wyshbonesales.com` },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /trigger — trigger outreach drafting for a completed discovery run
outreachRouter.post('/trigger', async (req, res) => {
  const userId = getUserId(req);
  const { run_id } = req.body;
  if (!run_id) return res.status(400).json({ error: 'run_id is required' });
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  try {
    // Get user's outreach config
    const { data: config } = await supabase
      .from('outreach_config')
      .select('*')
      .eq('user_id', userId)
      .eq('enabled', true)
      .single();

    if (!config) {
      return res.status(400).json({ error: 'No outreach config found. Set up your outreach identity first via POST /api/outreach/config' });
    }

    // Fetch the run's artefacts to find delivered leads
    const { storage } = await import('../storage');
    const artefacts = await storage.getArtefactsByRunId(run_id);
    
    // Look for final_delivery, combined_delivery, or leads_list artefact
    const deliveryArtefact = artefacts
      .filter((a: any) => ['final_delivery', 'combined_delivery', 'leads_list'].includes(a.type))
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

    if (!deliveryArtefact) {
      return res.status(404).json({ error: 'No delivery artefact found for this run. Run a discovery query first.' });
    }

    const payload = deliveryArtefact.payloadJson as any;
    const leads = payload?.leads || [];

    if (leads.length === 0) {
      return res.status(404).json({ error: 'No leads found in the delivery artefact.' });
    }

    console.log(`[OUTREACH_TRIGGER] Triggering outreach for run ${run_id} — ${leads.length} leads found`);

    // Import the outreach adapter and run it
    const { outreachAdapter } = await import('../supervisor/reloop/outreach-adapter');
    const { randomUUID } = await import('crypto');

    const outreachRunId = randomUUID();
    
    const result = await outreachAdapter({
      executorType: 'outreach',
      mission: {
        queryText: payload?.normalized_goal || payload?.original_user_goal || 'outreach',
        rawUserInput: payload?.original_user_goal || 'outreach',
        businessType: '',
        location: '',
        country: 'GB',
        requestedCount: null,
      },
      constraints: { hardConstraints: [], softConstraints: [], structuredConstraints: [] },
      knownEntities: leads.map((l: any) => l.name),
      budget: { maxApiCalls: 50, maxTimeMs: 300000 },
      missionContext: {
        runId: outreachRunId,
        userId,
        deliveredLeads: leads,
        intentNarrative: payload?.intent_narrative || null,
      },
    });

    console.log(`[OUTREACH_TRIGGER] Outreach complete: ${result.entities.length} drafts created`);

    res.json({
      ok: true,
      outreach_run_id: outreachRunId,
      discovery_run_id: run_id,
      leads_found: leads.length,
      drafts_created: result.entities.length,
      unreachable: (result.rawResult as any)?.unreachableNames || [],
      errors: result.executionMetadata.errorsEncountered,
    });
  } catch (err: any) {
    console.error(`[OUTREACH_TRIGGER] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /drafts
outreachRouter.get('/drafts', async (req, res) => {
  const userId = getUserId(req);
  const runId = req.query.run_id as string;
  if (!runId) return res.status(400).json({ error: 'run_id is required' });
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  try {
    const { data, error } = await supabase
      .from('outreach_messages')
      .select('*')
      .eq('run_id', runId)
      .eq('user_id', userId)
      .order('drafted_at', { ascending: true });
    if (error) throw error;

    const summary = { total: data?.length || 0, by_status: {} as Record<string, number> };
    for (const msg of data || []) {
      summary.by_status[msg.status] = (summary.by_status[msg.status] || 0) + 1;
    }
    res.json({ drafts: data || [], summary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /approve
outreachRouter.post('/approve', async (req, res) => {
  const userId = getUserId(req);
  const { message_id, subject, body_html, body_text, approval_notes } = req.body;
  if (!message_id) return res.status(400).json({ error: 'message_id is required' });
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  try {
    const { data: existing } = await supabase
      .from('outreach_messages')
      .select('status, user_id')
      .eq('id', message_id)
      .single();
    if (!existing) return res.status(404).json({ error: 'Message not found' });
    if (existing.user_id !== userId) return res.status(403).json({ error: 'Not authorized' });
    if (existing.status !== 'draft') return res.status(400).json({ error: `Cannot approve message with status "${existing.status}"` });

    const updatePayload: Record<string, unknown> = {
      status: 'approved',
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (subject) updatePayload.subject = subject;
    if (body_html) updatePayload.body_html = body_html;
    if (body_text) updatePayload.body_text = body_text;
    if (approval_notes) updatePayload.approval_notes = approval_notes;

    const { data, error } = await supabase
      .from('outreach_messages')
      .update(updatePayload)
      .eq('id', message_id)
      .select()
      .single();
    if (error) throw error;
    res.json({ message: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /send
outreachRouter.post('/send', async (req, res) => {
  const userId = getUserId(req);
  const { message_id } = req.body;
  if (!message_id) return res.status(400).json({ error: 'message_id is required' });
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  try {
    const { data: msg } = await supabase
      .from('outreach_messages')
      .select('*')
      .eq('id', message_id)
      .single();
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.user_id !== userId) return res.status(403).json({ error: 'Not authorized' });
    if (msg.status !== 'approved') return res.status(400).json({ error: `Can only send approved messages. Current status: "${msg.status}"` });
    if (!msg.recipient_email) return res.status(400).json({ error: 'No recipient email on this message' });

    const result = await sendOutreachEmail({
      messageId: msg.id,
      fromAddress: msg.from_address,
      replyToAddress: msg.reply_to_address,
      recipientEmail: msg.recipient_email,
      subject: msg.subject,
      bodyHtml: msg.body_html,
      bodyText: msg.body_text,
    });
    res.json({ sent: result.success, resend_message_id: result.resendMessageId, error: result.error });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /send-all
outreachRouter.post('/send-all', async (req, res) => {
  const userId = getUserId(req);
  const { run_id } = req.body;
  if (!run_id) return res.status(400).json({ error: 'run_id is required' });
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  try {
    const { data: drafts } = await supabase
      .from('outreach_messages')
      .select('*')
      .eq('run_id', run_id)
      .eq('user_id', userId)
      .eq('status', 'draft');

    if (!drafts || drafts.length === 0) {
      return res.json({ sent: 0, errors: [], message: 'No drafts to send' });
    }

    const results: { messageId: string; leadName: string; success: boolean; error: string | null }[] = [];

    for (const msg of drafts) {
      if (!msg.recipient_email) {
        results.push({ messageId: msg.id, leadName: msg.lead_name, success: false, error: 'No recipient email' });
        continue;
      }

      await supabase
        .from('outreach_messages')
        .update({ status: 'approved', approved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', msg.id);

      const sendResult = await sendOutreachEmail({
        messageId: msg.id,
        fromAddress: msg.from_address,
        replyToAddress: msg.reply_to_address,
        recipientEmail: msg.recipient_email,
        subject: msg.subject,
        bodyHtml: msg.body_html,
        bodyText: msg.body_text,
      });

      results.push({ messageId: msg.id, leadName: msg.lead_name, success: sendResult.success, error: sendResult.error });
    }

    const sent = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success);
    res.json({ sent, failed: failed.length, total: drafts.length, results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /webhook/delivery
outreachRouter.post('/webhook/delivery', async (req, res) => {
  try {
    await handleDeliveryWebhook(req.body);
    res.json({ ok: true });
  } catch (err: any) {
    console.error(`[OUTREACH_WEBHOOK] Delivery webhook error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /webhook/inbound
outreachRouter.post('/webhook/inbound', async (req, res) => {
  try {
    await handleInboundReply(req.body);
    res.json({ ok: true });
  } catch (err: any) {
    console.error(`[OUTREACH_WEBHOOK] Inbound webhook error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /messages/:messageId
outreachRouter.get('/messages/:messageId', async (req, res) => {
  const userId = getUserId(req);
  const { messageId } = req.params;
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  try {
    const { data, error } = await supabase
      .from('outreach_messages')
      .select('*')
      .eq('id', messageId)
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Message not found' });
    if (data.user_id !== userId) return res.status(403).json({ error: 'Not authorized' });
    res.json({ message: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /stats
outreachRouter.get('/stats', async (req, res) => {
  const userId = getUserId(req);
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  try {
    const { data, error } = await supabase
      .from('outreach_messages')
      .select('status')
      .eq('user_id', userId);
    if (error) throw error;

    const stats: Record<string, number> = { total: 0, draft: 0, approved: 0, sent: 0, delivered: 0, bounced: 0, replied: 0, failed: 0 };
    for (const msg of data || []) {
      if (msg.status in stats) stats[msg.status]++;
    }
    stats.total = data?.length || 0;
    res.json({ stats });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
