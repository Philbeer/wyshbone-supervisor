/**
 * outreach-adapter.ts
 * 
 * Outreach executor for the reloop architecture.
 * Takes delivered leads → extracts contacts → drafts personalised emails → stores as drafts.
 */

import type { ExecutorInput, ExecutorOutput, ExecutorEntity } from './types';
import { executeContactExtract, type ContactExtractInput } from '../contact-extract';
import { executeWebVisit } from '../web-visit';
import { draftOutreachEmail, type DraftInput } from '../outreach-drafter';
import { buildFromAddress, buildReplyToAddress } from '../outreach-transport';
import { supabase } from '../../supabase';
import { randomUUID } from 'crypto';

const CONTACT_CONCURRENCY = 2;

interface LeadWithContact {
  name: string;
  address: string;
  phone: string | null;
  website: string | null;
  placeId: string;
  contactEmail: string | null;
  contactName: string | null;
  contactRole: string | null;
  contactSource: string;
}

export async function outreachAdapter(input: ExecutorInput): Promise<ExecutorOutput> {
  const startTime = Date.now();
  const runId = input.missionContext.runId as string;
  const userId = input.missionContext.userId as string;

  console.log(`[OUTREACH_EXECUTOR] Starting outreach for ${input.knownEntities.length} known entities`);

  // Step 1: Get outreach config for this user
  let outreachConfig: {
    display_name: string;
    handle: string;
    sending_domain: string;
    reply_to_domain: string;
    signature_text: string | null;
    user_real_email: string | null;
  } | null = null;

  if (supabase) {
    const { data } = await supabase
      .from('outreach_config')
      .select('display_name, handle, sending_domain, reply_to_domain, signature_text, user_real_email')
      .eq('user_id', userId)
      .eq('enabled', true)
      .single();
    outreachConfig = data;
  }

  if (!outreachConfig) {
    console.warn(`[OUTREACH_EXECUTOR] No outreach config found for user ${userId}. Cannot draft emails.`);
    return buildEmptyOutput(startTime, 'No outreach configuration found. Set up your outreach identity first.');
  }

  // Step 2: Get the delivered leads from the previous discovery run
  const previousLeads = (input.missionContext.deliveredLeads as any[]) || [];
  
  if (previousLeads.length === 0) {
    console.warn(`[OUTREACH_EXECUTOR] No delivered leads in mission context. Nothing to outreach.`);
    return buildEmptyOutput(startTime, 'No leads available for outreach.');
  }

  console.log(`[OUTREACH_EXECUTOR] Processing ${previousLeads.length} leads for contact extraction`);

  // Step 3: Extract contacts from lead websites
  const leadsWithContacts: LeadWithContact[] = [];
  let apiCallsMade = 0;
  const errors: string[] = [];

  for (let i = 0; i < previousLeads.length; i += CONTACT_CONCURRENCY) {
    const batch = previousLeads.slice(i, i + CONTACT_CONCURRENCY);

    await Promise.allSettled(batch.map(async (lead: any) => {
      const lwc: LeadWithContact = {
        name: lead.name,
        address: lead.address,
        phone: lead.phone || null,
        website: lead.website || null,
        placeId: lead.placeId || `outreach_${randomUUID().substring(0, 8)}`,
        contactEmail: null,
        contactName: null,
        contactRole: null,
        contactSource: 'none',
      };

      if (!lead.website) {
        console.log(`[OUTREACH_EXECUTOR] "${lead.name}": no website, skipping contact extraction`);
        leadsWithContacts.push(lwc);
        return;
      }

      try {
        apiCallsMade++;
        const webVisitResult = await executeWebVisit(
          { url: lead.website, max_pages: 3, page_hints: ['/contact', '/about', '/team'], same_domain_only: true },
          runId,
        );

        const pages = (webVisitResult as any)?.envelope?.outputs?.pages || [];

        if (pages.length === 0) {
          console.log(`[OUTREACH_EXECUTOR] "${lead.name}": website visit returned no pages`);
          leadsWithContacts.push(lwc);
          return;
        }

        const contactInput: ContactExtractInput = {
          pages: pages.map((p: any) => ({ url: p.url || lead.website, text_clean: p.text_clean || p.text || '' })),
          entity_name: lead.name,
        };

        const contactResult = executeContactExtract(contactInput, runId);
        const contactOutputs = (contactResult as any)?.envelope?.outputs;

        if (contactOutputs?.contacts?.emails?.length > 0) {
          lwc.contactEmail = contactOutputs.contacts.emails[0];
          lwc.contactSource = 'website_extraction';
        }

        if (contactOutputs?.people?.length > 0) {
          const person = contactOutputs.people[0];
          lwc.contactName = person.name;
          lwc.contactRole = person.role;
        }

        console.log(`[OUTREACH_EXECUTOR] "${lead.name}": email=${lwc.contactEmail || 'none'} contact=${lwc.contactName || 'none'} (${lwc.contactRole || 'no role'})`);
      } catch (err: any) {
        console.warn(`[OUTREACH_EXECUTOR] Contact extraction failed for "${lead.name}": ${err.message}`);
        errors.push(`${lead.name}: ${err.message}`);
      }

      leadsWithContacts.push(lwc);
    }));
  }

  // Step 3b: GPT-4o email finder fallback for leads with no email
  const leadsNeedingEmail = leadsWithContacts.filter(l => !l.contactEmail && l.name);
  
  if (leadsNeedingEmail.length > 0) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      console.log(`[OUTREACH_EXECUTOR] Running GPT-4o email finder for ${leadsNeedingEmail.length} leads without emails`);
      
      for (const lead of leadsNeedingEmail) {
        try {
          apiCallsMade++;
          const emailFinderPrompt = `Find the contact email address for this business:
Business name: "${lead.name}"
Address: ${lead.address}
${lead.website ? `Website: ${lead.website}` : ''}

Search for their contact email address. Look at their website contact page, Google Business listing, social media profiles, business directories, and any other public source.

Respond with JSON only, no markdown fences:
{
  "email_found": true or false,
  "email": "the email address or null",
  "contact_name": "name of the contact person if found, or null",
  "contact_role": "role/title of the contact person if found, or null",
  "source": "where you found the email (e.g. 'website contact page', 'Google Business listing', 'Facebook page', 'business directory')",
  "confidence": "high" or "medium" or "low"
}

IMPORTANT:
- Only return real email addresses you actually found, never guess or fabricate
- Generic addresses like info@, contact@, hello@ are fine
- If you cannot find any email, set email_found to false`;

          const resp = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${openaiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: process.env.OUTREACH_EMAIL_FINDER_MODEL || 'gpt-4o-mini',
              input: emailFinderPrompt,
              tools: [{ type: 'web_search' }],
              store: false,
            }),
          });

          if (!resp.ok) {
            console.warn(`[OUTREACH_EXECUTOR] Email finder API error for "${lead.name}": HTTP ${resp.status}`);
            continue;
          }

          const data = await resp.json();
          let content = '';
          if (Array.isArray(data.output)) {
            for (const item of data.output) {
              if (item.type === 'message' && Array.isArray(item.content)) {
                for (const block of item.content) {
                  if (block.type === 'output_text') content += block.text;
                }
              }
            }
          }
          if (!content && data.output_text) content = data.output_text;

          try {
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.email_found && parsed.email && parsed.email.includes('@')) {
                lead.contactEmail = parsed.email;
                lead.contactSource = `gpt4o_web_search: ${parsed.source || 'web'}`;
                if (parsed.contact_name && !lead.contactName) lead.contactName = parsed.contact_name;
                if (parsed.contact_role && !lead.contactRole) lead.contactRole = parsed.contact_role;
                console.log(`[OUTREACH_EXECUTOR] GPT-4o found email for "${lead.name}": ${parsed.email} (source: ${parsed.source}, confidence: ${parsed.confidence})`);
              } else {
                console.log(`[OUTREACH_EXECUTOR] GPT-4o could not find email for "${lead.name}"`);
              }
            }
          } catch (parseErr: any) {
            console.warn(`[OUTREACH_EXECUTOR] Failed to parse email finder response for "${lead.name}": ${parseErr.message}`);
          }
        } catch (finderErr: any) {
          console.warn(`[OUTREACH_EXECUTOR] Email finder failed for "${lead.name}": ${finderErr.message}`);
        }
      }

      const foundByFallback = leadsNeedingEmail.filter(l => l.contactEmail).length;
      console.log(`[OUTREACH_EXECUTOR] GPT-4o email finder: found ${foundByFallback}/${leadsNeedingEmail.length} additional emails`);
    } else {
      console.warn(`[OUTREACH_EXECUTOR] OPENAI_API_KEY not set — skipping GPT-4o email finder fallback`);
    }
  }

  // Step 4: Filter to leads with contact emails
  const reachableLeads = leadsWithContacts.filter(l => l.contactEmail);
  const unreachableLeads = leadsWithContacts.filter(l => !l.contactEmail);

  console.log(`[OUTREACH_EXECUTOR] Contact extraction complete: ${reachableLeads.length} reachable, ${unreachableLeads.length} unreachable`);

  if (reachableLeads.length === 0) {
    console.warn(`[OUTREACH_EXECUTOR] No leads have contact emails. Cannot draft outreach.`);
    return buildEmptyOutput(startTime, `Found ${previousLeads.length} leads but no contact emails could be extracted.`, apiCallsMade, errors);
  }

  // Step 5: Draft personalised emails
  const intentNarrative = input.missionContext.intentNarrative as any;
  const entities: ExecutorEntity[] = [];

  for (const lead of reachableLeads) {
    try {
      const draftInput: DraftInput = {
        leadName: lead.name,
        leadAddress: lead.address,
        leadWebsite: lead.website,
        leadPhone: lead.phone,
        contactEmail: lead.contactEmail,
        contactName: lead.contactName,
        contactRole: lead.contactRole,
        senderName: outreachConfig.display_name,
        senderCompany: null,
        senderRole: null,
        originalQuery: input.mission.rawUserInput,
        intentNarrative: intentNarrative ? {
          entityDescription: intentNarrative.entity_description || intentNarrative.entityDescription || '',
          keyDiscriminator: intentNarrative.key_discriminator || intentNarrative.keyDiscriminator || '',
        } : null,
        matchSummary: null,
        evidenceSnippets: [],
        toneGuidance: null,
        callToAction: null,
      };

      apiCallsMade++;
      const draft = await draftOutreachEmail(draftInput);

      const messageId = randomUUID();
      const fromAddress = buildFromAddress(outreachConfig.display_name, outreachConfig.handle, outreachConfig.sending_domain);
      const replyToAddress = buildReplyToAddress(messageId, outreachConfig.reply_to_domain);

      if (supabase) {
        await supabase.from('outreach_messages').insert({
          id: messageId,
          run_id: runId,
          user_id: userId,
          lead_name: lead.name,
          lead_place_id: lead.placeId,
          recipient_email: lead.contactEmail,
          recipient_name: lead.contactName,
          recipient_role: lead.contactRole,
          from_address: fromAddress,
          reply_to_address: replyToAddress,
          subject: draft.subject,
          body_html: draft.bodyHtml,
          body_text: draft.bodyText,
          status: 'draft',
          draft_model: draft.model,
          draft_context: {
            original_query: input.mission.rawUserInput,
            intent_narrative: intentNarrative ? { entity_description: intentNarrative.entity_description, key_discriminator: intentNarrative.key_discriminator } : null,
            personalisation_notes: draft.personalisationNotes,
            contact_source: lead.contactSource,
          },
          drafted_at: new Date().toISOString(),
        });
      }

      console.log(`[OUTREACH_EXECUTOR] Draft created: "${lead.name}" → ${lead.contactEmail} subject="${draft.subject}" messageId=${messageId}`);

      entities.push({
        name: lead.name,
        address: lead.address,
        phone: lead.phone,
        website: lead.website,
        placeId: lead.placeId,
        source: 'outreach_draft',
        verified: true,
        verificationStatus: 'draft_ready',
        evidence: [{
          type: 'outreach_draft',
          messageId,
          recipientEmail: lead.contactEmail,
          subject: draft.subject,
          contactName: lead.contactName,
          contactRole: lead.contactRole,
          personalisationNotes: draft.personalisationNotes,
        }],
      });
    } catch (draftErr: any) {
      console.warn(`[OUTREACH_EXECUTOR] Draft failed for "${lead.name}": ${draftErr.message}`);
      errors.push(`Draft for ${lead.name}: ${draftErr.message}`);
    }
  }

  const timeMs = Date.now() - startTime;

  console.log(`[OUTREACH_EXECUTOR] Complete: ${entities.length} drafts created from ${previousLeads.length} leads in ${timeMs}ms`);

  return {
    executorType: 'outreach',
    entities,
    entitiesAttempted: reachableLeads.length,
    executionMetadata: {
      toolsUsed: ['contact_extract', 'web_visit', 'gpt4o_draft'],
      apiCallsMade,
      timeMs,
      errorsEncountered: errors,
      rateLimitsHit: false,
    },
    coverageSignals: {
      maxResultsHit: false,
      searchQueriesExhausted: false,
      estimatedUniverseSize: previousLeads.length,
    },
    rawResult: {
      totalLeads: previousLeads.length,
      reachableLeads: reachableLeads.length,
      unreachableLeads: unreachableLeads.length,
      draftsCreated: entities.length,
      unreachableNames: unreachableLeads.map(l => l.name),
    },
  };
}

function buildEmptyOutput(startTime: number, reason: string, apiCallsMade = 0, errors: string[] = []): ExecutorOutput {
  return {
    executorType: 'outreach',
    entities: [],
    entitiesAttempted: 0,
    executionMetadata: {
      toolsUsed: [],
      apiCallsMade,
      timeMs: Date.now() - startTime,
      errorsEncountered: [...errors, reason],
      rateLimitsHit: false,
    },
    coverageSignals: {
      maxResultsHit: false,
      searchQueriesExhausted: false,
      estimatedUniverseSize: null,
    },
    rawResult: { reason },
  };
}
