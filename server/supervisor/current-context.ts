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

export function getTemporalVerificationRules(cutoffDate: string): string {
  return `TEMPORAL VERIFICATION RULES (apply when constraint involves time, recency, or "opened recently"):
1. Find the OPENING or ESTABLISHMENT date of the business. This is the ONLY date that matters.
2. Check: is that opening date AFTER ${cutoffDate}? If yes → constraint met. If no → constraint NOT met.
3. These are NOT valid evidence of recent opening:
   - A recent website UPDATE or redesign (businesses update sites regardless of age)
   - A recent MOVE or relocation (moving to new premises ≠ opening a new business)
   - "Operating for over 12 months" (this means the business is OLD, not new)
   - Recent Google reviews (old businesses get new reviews too)
   - A recent Companies House filing update (routine annual filings)
   - The current year appearing anywhere on the website (copyright notices, blog posts)
4. These ARE valid evidence of recent opening:
   - "Opened in [date after ${cutoffDate}]" or "Established [date after ${cutoffDate}]"
   - "Grand opening" or "Now open" with a date after ${cutoffDate}
   - "New micropub" or "newly opened" with supporting date evidence
   - First Google reviews appearing only after ${cutoffDate}
5. If the opening date is BEFORE ${cutoffDate}, the constraint is NOT met regardless of any other recent activity.
6. If no opening date can be found, the constraint is NOT met (cannot verify without evidence).`;
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
