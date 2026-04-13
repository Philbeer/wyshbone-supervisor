/**
 * Dynamic context preamble for LLM prompts.
 * Provides current date and basic facts so models with older training cutoffs
 * can reason about time and avoid confidently stating outdated information.
 */

export function getCurrentDatePreamble(): string {
  const now = new Date();
  const readable = now.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const iso = now.toISOString().split('T')[0];
  const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];
  const currentYear = now.getFullYear();

  return `TODAY'S DATE: ${readable} (${iso}). Current year: ${currentYear}. "Last 12 months" = after ${oneYearAgo}.`;
}

export function getCurrentContextPreamble(): string {
  const datePreamble = getCurrentDatePreamble();
  const currentYear = new Date().getFullYear();

  return `${datePreamble}

IMPORTANT: Your training data may be outdated. If asked about current events, leaders, or recent developments, acknowledge that your information may not be current and suggest the user verify. Do not confidently state facts about events after early 2024.

Basic current context (${currentYear}):
- UK Prime Minister: Keir Starmer (Labour, since July 2024)
- US President: Donald Trump (since January 2025)
- UK currency: GBP. EU currency: EUR.
- This app (Wyshbone) is a B2B lead generation tool based in the UK.`;
}
