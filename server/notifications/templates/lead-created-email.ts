export interface LeadEmailData {
  leadName: string;
  address: string;
  phone: string;
  website: string;
  emailCandidates: string[];
  score: number;
  rationale: string;
  dashboardUrl: string;
  userName: string;
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

export function generateLeadEmailTemplate(data: LeadEmailData): { html: string; text: string } {
  const {
    leadName,
    address,
    phone,
    website,
    emailCandidates,
    score,
    rationale,
    dashboardUrl,
    userName
  } = data;

  const safeLeadName = escapeHtml(leadName);
  const safeAddress = escapeHtml(address);
  const safePhone = escapeHtml(phone);
  const safeWebsite = escapeHtml(website);
  const safeRationale = escapeHtml(rationale);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Lead Found</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 32px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">🎯 New Lead Found!</h1>
              <p style="margin: 8px 0 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">Wyshbone Supervisor has identified a new prospect</p>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding: 32px 32px 24px 32px;">
              <p style="margin: 0; color: #1a1a1a; font-size: 16px; line-height: 1.5;">Hi ${escapeHtml(userName)},</p>
              <p style="margin: 16px 0 0 0; color: #4a4a4a; font-size: 14px; line-height: 1.6;">Your AI supervisor has found a new lead that matches your objectives.</p>
            </td>
          </tr>

          <!-- Lead Card -->
          <tr>
            <td style="padding: 0 32px 24px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f8f9fa; border-radius: 6px; border: 1px solid #e0e0e0;">
                
                <!-- Lead Name & Score -->
                <tr>
                  <td style="padding: 20px 20px 16px 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td>
                          <h2 style="margin: 0; color: #1a1a1a; font-size: 20px; font-weight: 600;">${safeLeadName}</h2>
                        </td>
                        <td align="right">
                          <span style="display: inline-block; background-color: ${score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#6b7280'}; color: #ffffff; padding: 4px 12px; border-radius: 12px; font-size: 13px; font-weight: 600;">${score}% Match</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Rationale -->
                <tr>
                  <td style="padding: 0 20px 16px 20px;">
                    <p style="margin: 0; color: #4a4a4a; font-size: 14px; line-height: 1.5; font-style: italic;">💡 ${safeRationale}</p>
                  </td>
                </tr>

                <!-- Contact Info -->
                <tr>
                  <td style="padding: 0 20px 20px 20px;">
                    ${address ? `
                    <div style="margin-bottom: 12px;">
                      <span style="color: #6b7280; font-size: 13px; font-weight: 500;">📍 Address:</span>
                      <span style="color: #1a1a1a; font-size: 14px; margin-left: 8px;">${safeAddress}</span>
                    </div>
                    ` : ''}
                    
                    ${phone ? `
                    <div style="margin-bottom: 12px;">
                      <span style="color: #6b7280; font-size: 13px; font-weight: 500;">📞 Phone:</span>
                      <a href="tel:${safePhone}" style="color: #667eea; font-size: 14px; margin-left: 8px; text-decoration: none;">${safePhone}</a>
                    </div>
                    ` : ''}
                    
                    ${website ? `
                    <div style="margin-bottom: 12px;">
                      <span style="color: #6b7280; font-size: 13px; font-weight: 500;">🌐 Website:</span>
                      <a href="${safeWebsite}" target="_blank" style="color: #667eea; font-size: 14px; margin-left: 8px; text-decoration: none;">${safeWebsite}</a>
                    </div>
                    ` : ''}
                    
                    ${emailCandidates.length > 0 ? `
                    <div style="margin-bottom: 0;">
                      <span style="color: #6b7280; font-size: 13px; font-weight: 500;">✉️ Email${emailCandidates.length > 1 ? 's' : ''}:</span>
                      <div style="margin-top: 6px;">
                        ${emailCandidates.map(email => `
                          <a href="mailto:${escapeHtml(email)}" style="display: inline-block; background-color: #667eea; color: #ffffff; padding: 6px 12px; border-radius: 4px; font-size: 13px; text-decoration: none; margin: 4px 4px 0 0;">${escapeHtml(email)}</a>
                        `).join('')}
                      </div>
                    </div>
                    ` : ''}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA Button -->
          <tr>
            <td style="padding: 0 32px 32px 32px;" align="center">
              <a href="${dashboardUrl}" style="display: inline-block; background-color: #667eea; color: #ffffff; padding: 14px 32px; border-radius: 6px; font-size: 15px; font-weight: 600; text-decoration: none; box-shadow: 0 2px 4px rgba(102, 126, 234, 0.3);">View in Dashboard →</a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; background-color: #f8f9fa; border-top: 1px solid #e0e0e0;">
              <p style="margin: 0; color: #6b7280; font-size: 13px; text-align: center; line-height: 1.5;">
                This lead was automatically generated by Wyshbone Supervisor<br>
                based on your user activity and objectives.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const text = `
🎯 NEW LEAD FOUND

Hi ${userName},

Your AI supervisor has found a new lead that matches your objectives.

${leadName}
${score}% Match

${rationale}

CONTACT INFORMATION:
${address ? `📍 Address: ${address}` : ''}
${phone ? `📞 Phone: ${phone}` : ''}
${website ? `🌐 Website: ${website}` : ''}
${emailCandidates.length > 0 ? `✉️ Email${emailCandidates.length > 1 ? 's' : ''}: ${emailCandidates.join(', ')}` : ''}

View in Dashboard: ${dashboardUrl}

---
This lead was automatically generated by Wyshbone Supervisor
based on your user activity and objectives.
  `.trim();

  return { html, text };
}
