/**
 * Agent Findings Email Template
 *
 * Daily summary email of interesting autonomous agent activities
 */

export interface AgentFinding {
  taskTitle: string;
  taskDescription: string;
  priority: 'high' | 'medium' | 'low';
  result: string;
  interestingReason: string;
  timestamp: number;
}

export interface AgentFindingsEmailData {
  userName: string;
  findings: AgentFinding[];
  totalTasksExecuted: number;
  successRate: number;
  dashboardUrl: string;
  date: string;
  unsubscribeUrl: string;
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

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getPriorityBadge(priority: 'high' | 'medium' | 'low'): string {
  const badges = {
    high: '<span style="background-color: #EF4444; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">HIGH</span>',
    medium: '<span style="background-color: #F59E0B; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">MEDIUM</span>',
    low: '<span style="background-color: #10B981; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">LOW</span>'
  };
  return badges[priority];
}

export function generateAgentFindingsEmailTemplate(data: AgentFindingsEmailData): { html: string; text: string } {
  const {
    userName,
    findings,
    totalTasksExecuted,
    successRate,
    dashboardUrl,
    date,
    unsubscribeUrl
  } = data;

  const safeUserName = escapeHtml(userName);
  const findingsCount = findings.length;

  // HTML Email
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Daily Agent Report</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F3F4F6;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #F3F4F6; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #FFFFFF; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">

          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #667EEA 0%, #764BA2 100%); padding: 40px 30px; border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; color: #FFFFFF; font-size: 28px; font-weight: 700;">
                🤖 Your Autonomous Agent Report
              </h1>
              <p style="margin: 10px 0 0 0; color: #E5E7EB; font-size: 16px;">
                ${date}
              </p>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding: 30px 30px 20px 30px;">
              <p style="margin: 0; font-size: 16px; color: #374151; line-height: 1.6;">
                Hi ${safeUserName},
              </p>
              <p style="margin: 15px 0 0 0; font-size: 16px; color: #374151; line-height: 1.6;">
                Your autonomous agent worked overnight and discovered <strong>${findingsCount} interesting ${findingsCount === 1 ? 'finding' : 'findings'}</strong> worth reviewing.
              </p>
            </td>
          </tr>

          <!-- Stats Bar -->
          <tr>
            <td style="padding: 0 30px 30px 30px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #F9FAFB; border-radius: 6px; padding: 20px;">
                <tr>
                  <td width="50%" style="padding: 0 10px 0 0; text-align: center;">
                    <div style="font-size: 32px; font-weight: 700; color: #667EEA;">
                      ${totalTasksExecuted}
                    </div>
                    <div style="font-size: 13px; color: #6B7280; margin-top: 5px;">
                      Tasks Executed
                    </div>
                  </td>
                  <td width="50%" style="padding: 0 0 0 10px; text-align: center; border-left: 1px solid #E5E7EB;">
                    <div style="font-size: 32px; font-weight: 700; color: #10B981;">
                      ${successRate}%
                    </div>
                    <div style="font-size: 13px; color: #6B7280; margin-top: 5px;">
                      Success Rate
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Findings -->
          <tr>
            <td style="padding: 0 30px 30px 30px;">
              <h2 style="margin: 0 0 20px 0; font-size: 20px; color: #111827; font-weight: 600;">
                🌟 Interesting Findings
              </h2>

              ${findings.map((finding, index) => `
                <div style="background-color: #F9FAFB; border-left: 4px solid #667EEA; padding: 20px; margin-bottom: ${index < findings.length - 1 ? '15px' : '0'}; border-radius: 4px;">
                  <div style="margin-bottom: 10px;">
                    ${getPriorityBadge(finding.priority)}
                    <span style="color: #9CA3AF; font-size: 12px; margin-left: 10px;">
                      ${formatTime(finding.timestamp)}
                    </span>
                  </div>
                  <h3 style="margin: 0 0 8px 0; font-size: 16px; color: #111827; font-weight: 600;">
                    ${escapeHtml(finding.taskTitle)}
                  </h3>
                  <p style="margin: 0 0 10px 0; font-size: 14px; color: #6B7280; line-height: 1.5;">
                    ${escapeHtml(finding.taskDescription)}
                  </p>
                  <div style="background-color: #FFFFFF; padding: 12px; border-radius: 4px; margin-top: 10px;">
                    <div style="font-size: 12px; color: #9CA3AF; font-weight: 600; margin-bottom: 5px;">
                      WHY IT'S INTERESTING:
                    </div>
                    <div style="font-size: 14px; color: #374151;">
                      ${escapeHtml(finding.interestingReason)}
                    </div>
                  </div>
                  ${finding.result ? `
                    <div style="margin-top: 10px; font-size: 13px; color: #6B7280;">
                      <strong>Result:</strong> ${escapeHtml(finding.result)}
                    </div>
                  ` : ''}
                </div>
              `).join('')}
            </td>
          </tr>

          <!-- CTA Button -->
          <tr>
            <td style="padding: 0 30px 40px 30px;" align="center">
              <a href="${dashboardUrl}" style="display: inline-block; background: linear-gradient(135deg, #667EEA 0%, #764BA2 100%); color: #FFFFFF; text-decoration: none; padding: 14px 32px; border-radius: 6px; font-size: 16px; font-weight: 600; box-shadow: 0 4px 6px rgba(102, 126, 234, 0.25);">
                View Full Dashboard →
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 30px; background-color: #F9FAFB; border-radius: 0 0 8px 8px; border-top: 1px solid #E5E7EB;">
              <p style="margin: 0 0 10px 0; font-size: 13px; color: #6B7280; text-align: center;">
                This email was sent by your Wyshbone autonomous agent
              </p>
              <p style="margin: 0; font-size: 12px; color: #9CA3AF; text-align: center;">
                <a href="${unsubscribeUrl}" style="color: #9CA3AF; text-decoration: underline;">
                  Unsubscribe from daily reports
                </a>
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

  // Plain Text Email
  const text = `
🤖 YOUR AUTONOMOUS AGENT REPORT
${date}

Hi ${safeUserName},

Your autonomous agent worked overnight and discovered ${findingsCount} interesting ${findingsCount === 1 ? 'finding' : 'findings'} worth reviewing.

SUMMARY:
• ${totalTasksExecuted} tasks executed
• ${successRate}% success rate

🌟 INTERESTING FINDINGS:

${findings.map((finding, index) => `
${index + 1}. ${finding.taskTitle} [${finding.priority.toUpperCase()}]
   ${finding.taskDescription}

   Why it's interesting:
   ${finding.interestingReason}

   ${finding.result ? `Result: ${finding.result}` : ''}
   Time: ${formatTime(finding.timestamp)}
`).join('\n---\n')}

VIEW FULL DASHBOARD:
${dashboardUrl}

---
This email was sent by your Wyshbone autonomous agent.
Unsubscribe: ${unsubscribeUrl}
  `.trim();

  return { html, text };
}
