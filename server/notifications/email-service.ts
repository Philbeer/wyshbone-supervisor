import { getUncachableResendClient } from './resend-client';
import { SuggestedLead } from '@shared/schema';
import { generateLeadEmailTemplate } from './templates/lead-created-email';

export interface LeadNotificationPayload {
  lead: SuggestedLead;
  userEmail: string;
  userName?: string;
  dashboardUrl: string;
}

export class EmailNotificationService {
  async sendLeadCreatedEmail(payload: LeadNotificationPayload): Promise<void> {
    const { lead, userEmail, userName, dashboardUrl } = payload;

    try {
      const { client, fromEmail } = await getUncachableResendClient();
      
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

      await client.emails.send({
        from: fromEmail,
        to: userEmail,
        subject: `🎯 New Lead Found: ${leadData.name}`,
        html,
        text
      });

      console.log(`✉️  Email notification sent to ${userEmail} for lead: ${leadData.name}`);
    } catch (error) {
      console.error(`❌ Failed to send email notification to ${userEmail}:`, error);
      throw error;
    }
  }
}

export const emailService = new EmailNotificationService();
