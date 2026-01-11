/**
 * Email Notifier Service
 * Sends email notifications for interesting WABS results (score >= 70)
 * Uses Resend API
 */

export interface EmailNotificationInput {
  userId: string;
  userEmail?: string;
  taskTitle: string;
  score: number;
  signals: {
    relevance: number;
    novelty: number;
    actionability: number;
    urgency: number;
  };
  result: any;
  explanation?: string;
}

/**
 * Send email notification for interesting result
 */
export async function sendInterestingResultEmail(
  input: EmailNotificationInput
): Promise<{ sent: boolean; messageId?: string; error?: string }> {
  const { userId, userEmail, taskTitle, score, signals, result, explanation } = input;

  // Check if Resend is configured
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM_EMAIL = process.env.FROM_EMAIL || 'notifications@wyshbone.app';

  if (!RESEND_API_KEY) {
    console.warn('[EMAIL] RESEND_API_KEY not configured - email notification skipped');
    return { sent: false, error: 'Resend API key not configured' };
  }

  if (!userEmail) {
    console.warn('[EMAIL] No user email address - notification skipped');
    return { sent: false, error: 'No user email address' };
  }

  try {
    // Prepare email content
    const subject = `🌟 Interesting Result: ${taskTitle}`;
    const htmlBody = generateEmailHTML({
      taskTitle,
      score,
      signals,
      result,
      explanation
    });

    // Send via Resend API
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [userEmail],
        subject,
        html: htmlBody
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[EMAIL] Resend API error:', errorText);
      return { sent: false, error: `Resend API error: ${response.status}` };
    }

    const data = await response.json();
    console.log(`[EMAIL] ✅ Sent notification to ${userEmail} (message ID: ${data.id})`);

    return { sent: true, messageId: data.id };

  } catch (error: any) {
    console.error('[EMAIL] Failed to send notification:', error.message);
    return { sent: false, error: error.message };
  }
}

/**
 * Generate HTML email content
 */
function generateEmailHTML(params: {
  taskTitle: string;
  score: number;
  signals: any;
  result: any;
  explanation?: string;
}): string {
  const { taskTitle, score, signals, result, explanation } = params;

  // Generate signal breakdown HTML
  const signalBars = Object.entries(signals)
    .map(([name, value]) => {
      const percentage = value as number;
      const color = percentage >= 70 ? '#22c55e' : percentage >= 50 ? '#eab308' : '#ef4444';
      return `
        <div style="margin-bottom: 12px;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span style="font-weight: 600; text-transform: capitalize;">${name}</span>
            <span style="color: #64748b;">${percentage}/100</span>
          </div>
          <div style="background: #e2e8f0; border-radius: 9999px; height: 8px; overflow: hidden;">
            <div style="background: ${color}; height: 100%; width: ${percentage}%;"></div>
          </div>
        </div>
      `;
    })
    .join('');

  // Generate result preview
  let resultPreview = '';
  if (result.name) {
    resultPreview += `<h3 style="margin: 0 0 8px 0; color: #0f172a;">${result.name}</h3>`;
  }
  if (result.description) {
    resultPreview += `<p style="margin: 0 0 12px 0; color: #475569;">${result.description}</p>`;
  }

  // Contact info
  const contactInfo: string[] = [];
  if (result.email) contactInfo.push(`📧 ${result.email}`);
  if (result.phone) contactInfo.push(`📞 ${result.phone}`);
  if (result.website) contactInfo.push(`🌐 <a href="${result.website}" style="color: #3b82f6;">${result.website}</a>`);

  if (contactInfo.length > 0) {
    resultPreview += `<div style="font-size: 14px; color: #64748b;">${contactInfo.join(' • ')}</div>`;
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #0f172a; margin: 0; padding: 0; background: #f8fafc;">
  <div style="max-width: 600px; margin: 40px auto; background: white; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); overflow: hidden;">

    <!-- Header -->
    <div style="background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); padding: 32px; text-align: center;">
      <div style="font-size: 48px; margin-bottom: 8px;">⭐</div>
      <h1 style="margin: 0; color: white; font-size: 24px; font-weight: 700;">Interesting Result Found!</h1>
    </div>

    <!-- WABS Score -->
    <div style="padding: 32px; border-bottom: 1px solid #e2e8f0;">
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="display: inline-block; background: linear-gradient(135deg, #22c55e 0%, #10b981 100%); color: white; font-size: 48px; font-weight: 800; padding: 16px 32px; border-radius: 12px;">
          ${score}/100
        </div>
        <p style="margin: 12px 0 0 0; color: #64748b; font-size: 14px;">WABS Score</p>
      </div>

      ${explanation ? `
        <div style="background: #f1f5f9; border-left: 4px solid #3b82f6; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
          <p style="margin: 0; color: #475569; font-size: 14px;">${explanation}</p>
        </div>
      ` : ''}

      <h2 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #0f172a;">Signal Breakdown</h2>
      ${signalBars}
    </div>

    <!-- Task Info -->
    <div style="padding: 32px; border-bottom: 1px solid #e2e8f0;">
      <h2 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #0f172a;">Task: ${taskTitle}</h2>
      ${resultPreview ? `
        <div style="background: #f8fafc; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0;">
          ${resultPreview}
        </div>
      ` : ''}
    </div>

    <!-- Footer -->
    <div style="padding: 24px 32px; background: #f8fafc; text-align: center;">
      <p style="margin: 0 0 12px 0; color: #64748b; font-size: 14px;">
        View in Wyshbone Dashboard
      </p>
      <a href="http://localhost:5173" style="display: inline-block; background: #3b82f6; color: white; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600;">
        Open Dashboard
      </a>
      <p style="margin: 16px 0 0 0; color: #94a3b8; font-size: 12px;">
        Generated by Wyshbone Autonomous Agent
      </p>
    </div>

  </div>
</body>
</html>
  `;
}

/**
 * Get user email address from database
 */
export async function getUserEmail(userId: string): Promise<string | null> {
  // For now, use demo email pattern
  // In production, this would query users table
  if (userId.startsWith('demo_')) {
    const emailPart = userId.replace('demo_', '');
    return `${emailPart}@wyshbone.demo`;
  }

  // Try to extract from userId if it looks like an email
  if (userId.includes('@')) {
    return userId;
  }

  return null;
}
