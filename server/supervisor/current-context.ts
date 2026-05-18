/**
 * Dynamic context preamble for LLM prompts.
 * Provides current date and basic facts so models with older training cutoffs
 * can reason about time and avoid confidently stating outdated information.
 */

function toIso(d: Date): string {
  return d.toISOString().split('T')[0];
}

function addDays(d: Date, n: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() + n);
  return result;
}

export function getTemporalAnchors(): {
  today_iso: string;
  today_weekday: string;
  this_weekend: { start: string; end: string };
  next_weekend: { start: string; end: string };
  this_week_end: string;
  next_week: { start: string; end: string };
  this_month_end: string;
  next_month: { start: string; end: string };
  this_year_end: string;
  next_year: { start: string; end: string };
} {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayOfWeek = today.getDay();

  let thisWeekendStart: Date;
  let thisWeekendEnd: Date;
  if (dayOfWeek === 5) {
    thisWeekendStart = today;
    thisWeekendEnd = addDays(today, 2);
  } else if (dayOfWeek === 6) {
    thisWeekendStart = today;
    thisWeekendEnd = addDays(today, 1);
  } else if (dayOfWeek === 0) {
    thisWeekendStart = today;
    thisWeekendEnd = today;
  } else {
    const daysToSat = 6 - dayOfWeek;
    thisWeekendStart = addDays(today, daysToSat);
    thisWeekendEnd = addDays(today, daysToSat + 1);
  }

  const nextWeekendStart = addDays(thisWeekendEnd, 6);
  const nextWeekendEnd = addDays(nextWeekendStart, 1);

  const thisWeekEnd = dayOfWeek === 0 ? today : addDays(today, 7 - dayOfWeek);

  const nextWeekStart = addDays(thisWeekEnd, 1);
  const nextWeekEnd = addDays(nextWeekStart, 6);

  const thisMonthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const nextMonthEnd = new Date(today.getFullYear(), today.getMonth() + 2, 0);

  const thisYearEnd = new Date(today.getFullYear(), 11, 31);
  const nextYearStart = new Date(today.getFullYear() + 1, 0, 1);
  const nextYearEnd = new Date(today.getFullYear() + 1, 11, 31);

  return {
    today_iso: toIso(today),
    today_weekday: today.toLocaleDateString('en-GB', { weekday: 'long' }),
    this_weekend: { start: toIso(thisWeekendStart), end: toIso(thisWeekendEnd) },
    next_weekend: { start: toIso(nextWeekendStart), end: toIso(nextWeekendEnd) },
    this_week_end: toIso(thisWeekEnd),
    next_week: { start: toIso(nextWeekStart), end: toIso(nextWeekEnd) },
    this_month_end: toIso(thisMonthEnd),
    next_month: { start: toIso(nextMonthStart), end: toIso(nextMonthEnd) },
    this_year_end: toIso(thisYearEnd),
    next_year: { start: toIso(nextYearStart), end: toIso(nextYearEnd) },
  };
}

export function formatTemporalAnchorsForPrompt(): string {
  const a = getTemporalAnchors();
  const readableDate = new Date(`${a.today_iso}T12:00:00`).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  return [
    `TODAY: ${a.today_weekday}, ${readableDate} (${a.today_iso})`,
    `THIS WEEKEND: ${a.this_weekend.start} to ${a.this_weekend.end}`,
    `NEXT WEEKEND: ${a.next_weekend.start} to ${a.next_weekend.end}`,
    `THIS WEEK (rest of): ${a.today_iso} to ${a.this_week_end}`,
    `NEXT WEEK: ${a.next_week.start} to ${a.next_week.end}`,
    `THIS MONTH (rest of): ${a.today_iso} to ${a.this_month_end}`,
    `NEXT MONTH: ${a.next_month.start} to ${a.next_month.end}`,
    `THIS YEAR (rest of): ${a.today_iso} to ${a.this_year_end}`,
    `NEXT YEAR: ${a.next_year.start} to ${a.next_year.end}`,
  ].join('\n');
}

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
6. If no opening date can be found, the constraint is NOT met (cannot verify without evidence).

FUTURE / UPCOMING EVENTS (apply when constraint involves future-tense words like "upcoming", "next", "future", "soon", "this weekend", "this month", "this year" referring to events that have not happened yet):
A. These queries are NOT date-cutoff checks. The user is asking about events scheduled for a date AFTER today.
B. DO NOT emit today's date (${cutoffDate} or any literal date string) as the constraint value. Today's date is the REFERENCE point, not the value to match against.
C. The correct treatment is to flag the constraint as inherently uncertain. Either:
   - emit the time_constraint with verifiability="proxy" and a chosen_proxy of "event_listing_sites" (Eventbrite, festival aggregators, news mentions of upcoming dates), OR
   - emit it with verifiability="unverifiable" if no proxy can confirm the event will happen as scheduled.
D. Valid evidence of an upcoming event:
   - An explicit future date on the page (e.g. "23-25 May 2026", "this June", "Summer 2026") that parses to a date AFTER today (${cutoffDate})
   - A "tickets on sale" / "book now" / "register" call-to-action paired with a future date
   - Recent news mentions of the event with a future date
E. NOT valid evidence:
   - The word "annual" or "yearly" alone (an event being annual does not mean it is upcoming THIS year)
   - A historical page about past editions of the event with no current date
   - Today's date appearing anywhere on the page (this is just the current date, not evidence of a scheduled event)
F. If the page only describes that the event exists, with no future date, mark the lead's time_constraint as "no_evidence" — do NOT use today's date as a fallback match.`;
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
