/**
 * Reference Knowledge — Pre-loaded content for demo conversations
 *
 * Contains curated information about organisations that Wyshbone may discuss
 * in demo or sales contexts. The chat handler injects relevant reference
 * knowledge into the LLM prompt when keywords are detected.
 *
 * To add a new reference: add an entry to REFERENCE_ENTRIES with keywords
 * and content. The chat handler will include it when any keyword matches
 * the conversation.
 */

interface ReferenceEntry {
  /** Unique label for logging */
  label: string;
  /** Keywords that trigger inclusion (lowercase). ANY match = include. */
  keywords: string[];
  /** The reference content injected into the prompt */
  content: string;
}

const REFERENCE_ENTRIES: ReferenceEntry[] = [
  {
    label: 'the_wine_society',
    keywords: ['wine society', 'thewinesociety', 'wine club'],
    content: `THE WINE SOCIETY — Reference Knowledge
Source: thewinesociety.com (pre-loaded for demo purposes)

OVERVIEW:
The Wine Society (full name: The International Exhibition Co-operative Wine Society Limited) is the world's oldest member-owned wine cooperative, founded on 4 August 1874 at the Royal Albert Hall in London. It operates as a not-for-profit mutual — all profits are reinvested into better prices and services for members. It is NOT a retailer in the traditional sense; it is a co-operative owned by its members.

HISTORY:
Founded after the 1874 International Exhibition at the Royal Albert Hall, where surplus Portuguese wines were left unsold. Major-General Henry Scott (co-architect of the Albert Hall) and R. Brudenell Carter (an ophthalmic surgeon) organised tasting lunches to help sell the surplus, which proved so popular they formed a cooperative wine-buying club. The motto from the start: supply wines at the lowest possible prices that working expenses would allow.

KEY FACTS:
- Over 180,000 active members worldwide
- One-time lifetime membership share: £40 (no ongoing fees, no obligation to purchase)
- Each member owns one share — true cooperative model
- Free UK delivery on every order
- Second-largest wine buyer in the UK (as of 2018)
- Headquartered in Stevenage, Hertfordshire (purpose-built warehouse)
- Europe's tallest wine warehouse (built 2008)
- Members' Reserves: wine storage for over 20,000 members (three-million-bottle capacity, built 1975)
- Trustpilot rating: 4.8/5 from over 3,900 reviews
- Online sales launched 1999
- Jancis Robinson MW regularly praises their value and quality

WHAT THEY SELL:
- Over 1,400 wines from diverse regions worldwide
- Red, white, rosé, sparkling, fortified, sweet, orange, and natural wines
- Own-label ranges: "Society Wines" and "Exhibition Wines" (curated by their buying team)
- Organic, biodynamic, vegan, and vegetarian wines
- Spirits, whisky, sake, beers & ciders, low/no alcohol
- Wine accessories, gifts, gift memberships
- Fine wines, museum releases, rare & small stock wines
- Wine tasting kits
- Half bottles, magnums, bag-in-box, cans

SERVICES:
- Food & Wine Matcher tool on website
- Wine Selector tool for personalised recommendations
- Wine Advice Service with specialist team
- Tastings and events programme
- Wine subscriptions
- In-bond wine offers (en primeur)
- Spring/Fine Wine Clearance sales
- Case savings offers
- Community forum at community.thewinesociety.com

UNIQUE SELLING POINTS:
- "Passion before Profit" — buying team sources on taste and quality alone, not margin
- Society's Promise: if a bottle is not to your taste, they make it right, no questions asked
- Generation-spanning relationships with growers worldwide
- Honest pricing every day (no fake "was/now" pricing games)
- Wine storage at the best value in the market
- They keep back age-worthy fine wines in their cellars and offer them when ready to drink

CURRENT FEATURES (as of site content):
- "Your Next Favourite Wine" recommendation feature
- Fine Wine Collection spotlight
- Regional features: North-East Italy, Macon & Beaujolais, Rhône
- "Pick Of The Range" curated selection
- "Hot Off The Press" new arrivals
- Spring Clearance and Fine Wine Clearance offers
- In-Bond first releases: Domaine Gauby 2024/23, Prophet's Rock 2025, Chryseia 2023
- Jancis Robinson's Value Picks selection

PRICE RANGES:
- Wines under £10
- Wines £10-£20
- Wines £20-£30
- Wines over £30
- Fine wines at various price points

AWARDS:
- Multiple wine trade industry awards
- Recognised by Which? for reliable quality and value
- Regularly featured in Financial Times wine coverage`,
  },
];

/**
 * Returns relevant reference knowledge for a conversation.
 * Checks the current message AND recent conversation history for keyword matches.
 */
export function getRelevantReferenceKnowledge(
  currentMessage: string,
  conversationHistory?: Array<{ role: string; content: string }>,
): string | null {
  const searchText = [
    currentMessage,
    ...(conversationHistory || []).slice(-5).map(m => m.content),
  ].join(' ').toLowerCase();

  const matched: string[] = [];

  for (const entry of REFERENCE_ENTRIES) {
    const isMatch = entry.keywords.some(kw => searchText.includes(kw));
    if (isMatch) {
      matched.push(entry.content);
      console.log(`[REFERENCE_KNOWLEDGE] Matched: ${entry.label} (keyword hit in conversation)`);
    }
  }

  if (matched.length === 0) return null;
  return matched.join('\n\n---\n\n');
}
