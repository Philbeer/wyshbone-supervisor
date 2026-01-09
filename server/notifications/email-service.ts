import { getUncachableResendClient } from './resend-client';
import { SuggestedLead } from '@shared/schema';
import { generateLeadEmailTemplate } from './templates/lead-created-email';
import {
  generateAgentFindingsEmailTemplate,
  type AgentFinding,
  type AgentFindingsEmailData
} from './templates/agent-findings-email';

export interface LeadNotificationPayload {
  lead: SuggestedLead;
  userEmail: string;
  userName?: string;
  dashboardUrl: string;
}

export interface AgentFindingsPayload {
  userEmail: string;
  userName: string;
  findings: AgentFinding[];
  totalTasksExecuted: number;
  successRate: number;
  dashboardUrl: string;
  unsubscribeUrl?: string;
}

export class EmailNotificationService {
  /**
   * Send lead created notification email
   */
  async sendLeadCreatedEmail(payload: LeadNotificationPayload): Promise<void> {
    const { lead, userEmail, userName, dashboardUrl } = payload;

    try {
      console.log(`📧 Attempting to send email to ${userEmail}...`);

      const { client, fromEmail } = await getUncachableResendClient();
      console.log(`📧 Resend client initialized, from: ${fromEmail}`);

      const leadData = lead.lead as any;
      const { html, text } = generateLeadEmailTemplate({
        leadName: leadData.name || 'Unknown Business',
        address: leadData.address || '',
        phone: leadData.phone || '',
        website: leadData.domain || '',
        emailCandidates: leadData.emailCandidates || [],
        score: Math.round(lead.score * 100),
        rationale: lead.rationale,
        dashboardUrl,
        userName: userName || 'there'
      });

      const result = await client.emails.send({
        from: fromEmail,
        to: userEmail,
        subject: `🎯 New Lead Found: ${leadData.name}`,
        html,
        text
      });

      console.log(`✅ Email sent successfully! Resend response:`, JSON.stringify(result));
      console.log(`✉️  Email notification sent to ${userEmail} for lead: ${leadData.name}`);
    } catch (error) {
      console.error(`❌ DETAILED ERROR sending email to ${userEmail}:`, error);
      console.error(`Error type: ${error?.constructor?.name}`);
      console.error(`Error message:`, error instanceof Error ? error.message : String(error));
      if (error && typeof error === 'object' && 'response' in error) {
        console.error(`API Response:`, JSON.stringify((error as any).response));
      }
      throw error;
    }
  }

  /**
   * Send daily agent findings email
   * Only sends if there are interesting findings to report
   */
  async sendAgentFindingsEmail(payload: AgentFindingsPayload): Promise<void> {
    const {
      userEmail,
      userName,
      findings,
      totalTasksExecuted,
      successRate,
      dashboardUrl,
      unsubscribeUrl
    } = payload;

    try {
      // Don't send email if no interesting findings
      if (findings.length === 0) {
        console.log(`📧 No interesting findings for ${userEmail} - skipping email`);
        return;
      }

      console.log(`📧 Sending agent findings email to ${userEmail} (${findings.length} findings)...`);

      const { client, fromEmail } = await getUncachableResendClient();
      console.log(`📧 Resend client initialized, from: ${fromEmail}`);

      const date = new Date().toLocaleDateString('en-GB', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      const emailData: AgentFindingsEmailData = {
        userName,
        findings,
        totalTasksExecuted,
        successRate,
        dashboardUrl,
        date,
        unsubscribeUrl: unsubscribeUrl || `${dashboardUrl}/settings/notifications`
      };

      const { html, text } = generateAgentFindingsEmailTemplate(emailData);

      const subject = findings.length === 1
        ? `🤖 Your Agent Found 1 Interesting Result`
        : `🤖 Your Agent Found ${findings.length} Interesting Results`;

      const result = await client.emails.send({
        from: fromEmail,
        to: userEmail,
        subject,
        html,
        text
      });

      console.log(`✅ Agent findings email sent successfully!`, JSON.stringify(result));
      console.log(`✉️  Sent ${findings.length} findings to ${userEmail}`);

    } catch (error) {
      console.error(`❌ ERROR sending agent findings email to ${userEmail}:`, error);
      console.error(`Error type: ${error?.constructor?.name}`);
      console.error(`Error message:`, error instanceof Error ? error.message : String(error));
      if (error && typeof error === 'object' && 'response' in error) {
        console.error(`API Response:`, JSON.stringify((error as any).response));
      }
      // Don't throw - we don't want email failures to stop the agent
      console.warn(`⚠️  Failed to send email, but continuing agent execution`);
    }
  }
}

export const emailService = new EmailNotificationService();
