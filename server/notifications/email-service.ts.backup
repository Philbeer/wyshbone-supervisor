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
}

export const emailService = new EmailNotificationService();
