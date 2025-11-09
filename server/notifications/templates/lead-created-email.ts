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
  const safeUserName = escapeHtml(userName);

  const formattedDate = new Date().toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  const formattedTime = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const subject = `🎯 New Lead Found: ${leadName} - ${formattedDate}`;

  // Use logo from app
  const baseUrl = dashboardUrl.split('?')[0];
  const logoUrl = `${baseUrl}/assets/logo.png`;

  const html = `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${subject}</title>
<style>
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; display: block; }
  body { margin: 0; padding: 0; background-color: #f4f4f4; }
  .container { width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  .logo-section { text-align: center; padding: 20px 20px 10px; }
  .brand-logo { width: 96px; height: 96px; margin: 0 auto; }
  .monitor-header { padding: 10px 20px 0; text-align: left; font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif; }
  .monitor-header h1 { margin: 0 0 8px; font-size: 22px; color: #153e52; font-weight: 700; line-height: 1.3; }
  .badge { display: inline-block; background-color: #2b7a78; color: #ffffff; padding: 4px 12px; border-radius: 12px; font-size: 12px; letter-spacing: 0.5px; }
  .content { padding: 18px 20px 28px; color: #333; line-height: 1.6; font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif; }
  .info-box { background-color: #f8f9fa; border-left: 4px solid #2b7a78; padding: 14px; margin: 18px 0; border-radius: 4px; color: #444; font-size: 14px; }
  .info-box h3 { margin: 0 0 8px; font-size: 13px; color: #2b7a78; text-transform: uppercase; letter-spacing: 0.5px; }
  .stats { display: flex; justify-content: center; gap: 28px; margin: 20px 0; padding: 18px 12px; background-color: #f8f9fa; border-radius: 8px; }
  .stat { text-align: center; }
  .stat-value { font-size: 28px; font-weight: 800; color: #2b7a78; line-height: 1.1; }
  .stat-label { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
  .summary { border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin: 18px 0; background-color: #ffffff; }
  .summary h3 { margin: 0 0 8px; color: #153e52; font-size: 16px; }
  .summary p { color: #555; font-size: 15px; line-height: 1.7; margin: 0; }
  .cta-wrap { text-align: center; margin-top: 26px; }
  .button { display: inline-block; background-color: #2b7a78; color: #ffffff !important; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px; }
  .footer { text-align: center; font-size: 12px; color: #777; background-color: #f8f9fa; padding: 16px; }
  .contact-item { margin-bottom: 12px; }
  .contact-label { color: #6b7280; font-size: 13px; font-weight: 500; }
  .contact-value { color: #1a1a1a; font-size: 14px; margin-left: 8px; }
  .email-button { display: inline-block; background-color: #667eea; color: #ffffff !important; padding: 6px 12px; border-radius: 4px; font-size: 13px; text-decoration: none; margin: 4px 4px 0 0; }
</style>
</head>
<body>
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
    <tr>
      <td align="center" style="padding: 16px;">
        <div class="container">
          <div class="logo-section">
            <img class="brand-logo" src="${logoUrl}" width="96" height="96" alt="Wyshbone AI Logo" />
          </div>

          <div class="monitor-header">
            <h1>${safeLeadName}</h1>
            <span class="badge">AI-GENERATED LEAD</span>
          </div>

          <div class="content">
            <p>Hi ${safeUserName}, your AI supervisor has found a new lead that matches your objectives.</p>

            <div class="info-box">
              <h3>Lead Details</h3>
              <p><strong>Business Name:</strong> ${safeLeadName}</p>
              <p><strong>Discovered:</strong> ${formattedDate} at ${formattedTime}</p>
              <p><strong>Match Score:</strong> ${score}%</p>
            </div>

            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px; padding: 16px; margin: 18px 0; color: white;">
              <h3 style="margin: 0 0 12px; color: white; font-size: 16px; display: flex; align-items: center; gap: 8px;">
                🤖 AI Analysis
              </h3>
              <div style="background-color: rgba(255,255,255,0.15); border-radius: 6px; padding: 12px; margin-bottom: 10px;">
                <div style="display: flex; gap: 12px; flex-wrap: wrap;">
                  <div>
                    <strong style="font-size: 11px; opacity: 0.9; text-transform: uppercase; letter-spacing: 0.5px;">Match Quality</strong>
                    <div style="font-size: 16px; font-weight: 700; margin-top: 2px;">
                      ${score >= 80 ? '🔴 HIGH' : score >= 60 ? '🟡 MEDIUM' : '🟢 NORMAL'}
                    </div>
                  </div>
                  <div style="border-left: 1px solid rgba(255,255,255,0.3); padding-left: 12px;">
                    <strong style="font-size: 11px; opacity: 0.9; text-transform: uppercase; letter-spacing: 0.5px;">Score</strong>
                    <div style="font-size: 16px; font-weight: 700; margin-top: 2px;">
                      ${score}%
                    </div>
                  </div>
                </div>
              </div>
              <p style="font-size: 14px; margin: 8px 0; line-height: 1.5; opacity: 0.95;">
                <strong>AI Reasoning:</strong> ${safeRationale}
              </p>
            </div>

            <div class="summary">
              <h3>📞 Contact Information</h3>
              ${address ? `
              <div class="contact-item">
                <span class="contact-label">📍 Address:</span>
                <span class="contact-value">${safeAddress}</span>
              </div>
              ` : ''}
              
              ${phone ? `
              <div class="contact-item">
                <span class="contact-label">📞 Phone:</span>
                <a href="tel:${safePhone}" style="color: #2b7a78; text-decoration: none; margin-left: 8px;">${safePhone}</a>
              </div>
              ` : ''}
              
              ${website ? `
              <div class="contact-item">
                <span class="contact-label">🌐 Website:</span>
                <a href="${safeWebsite}" target="_blank" style="color: #2b7a78; text-decoration: none; margin-left: 8px;">${safeWebsite}</a>
              </div>
              ` : ''}
              
              ${emailCandidates.length > 0 ? `
              <div class="contact-item" style="margin-bottom: 0;">
                <span class="contact-label">✉️ Email${emailCandidates.length > 1 ? 's' : ''}:</span>
                <div style="margin-top: 6px;">
                  ${emailCandidates.map(email => `
                    <a href="mailto:${encodeURIComponent(email)}" class="email-button">${escapeHtml(email)}</a>
                  `).join('')}
                </div>
              </div>
              ` : ''}
            </div>

            <div class="cta-wrap">
              <a href="${dashboardUrl}" class="button">📊 View Full Report</a>
              <p style="margin-top: 10px; font-size: 12px; color: #999;">Open your Wyshbone dashboard to see all details</p>
            </div>
          </div>

          <div class="footer">
            <p>This lead was automatically generated by Wyshbone Supervisor based on your user activity and objectives.</p>
          </div>
        </div>
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

AI REASONING:
${rationale}

CONTACT INFORMATION:
${address ? `📍 Address: ${address}` : ''}
${phone ? `📞 Phone: ${phone}` : ''}
${website ? `🌐 Website: ${website}` : ''}
${emailCandidates.length > 0 ? `✉️ Email${emailCandidates.length > 1 ? 's' : ''}: ${emailCandidates.join(', ')}` : ''}

View Full Report: ${dashboardUrl}

---
This lead was automatically generated by Wyshbone Supervisor
based on your user activity and objectives.
  `.trim();

  return { html, text };
}
