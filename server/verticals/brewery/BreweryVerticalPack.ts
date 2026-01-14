/**
 * Brewery Vertical Pack
 * 
 * SUP-14: BreweryVerticalPack (pipeline, scripts, queries)
 * 
 * Defines brewery-specific:
 * - Lead pipeline stages (new → customer/lost)
 * - Lead Finder query recipes (pub/bar search templates)
 * - Script templates (cold outreach, follow-ups)
 */

import type {
  VerticalPack,
  VerticalLeadPipelineStage,
  VerticalLeadFinderQueryRecipe,
  VerticalScriptTemplate,
} from '../../core/verticals/types';

// ============================================
// LEAD PIPELINE STAGES
// ============================================

/**
 * Brewery-specific lead pipeline stages.
 * Tracks a lead from discovery through to conversion or loss.
 */
const breweryLeadPipeline: VerticalLeadPipelineStage[] = [
  {
    id: 'new',
    label: 'New',
    description: 'New brewery lead found, not yet contacted',
    order: 10,
  },
  {
    id: 'qualified',
    label: 'Qualified',
    description: 'Lead has been researched and deemed a good prospect',
    order: 20,
  },
  {
    id: 'first_contact',
    label: 'First Contact',
    description: 'First outreach attempt made (email, call, or visit)',
    order: 30,
  },
  {
    id: 'engaged',
    label: 'Engaged',
    description: 'In active discussions about range, pricing, or terms',
    order: 40,
  },
  {
    id: 'trial',
    label: 'Trial',
    description: 'Trial order placed or sample box shipped',
    order: 50,
  },
  {
    id: 'repeat_buyer',
    label: 'Repeat Buyer',
    description: 'Has placed more than one order',
    order: 60,
  },
  {
    id: 'customer',
    label: 'Customer',
    description: 'Active, regular customer',
    order: 70,
    isTerminal: true,
  },
  {
    id: 'lost',
    label: 'Lost',
    description: 'Lost opportunity or not interested',
    order: 80,
    isTerminal: true,
  },
];

// ============================================
// LEAD FINDER QUERY RECIPES
// ============================================

/**
 * Brewery-specific Lead Finder search templates.
 * Use {REGION_OR_TOWN} placeholder for location-based searches.
 */
const breweryLeadFinderRecipes: VerticalLeadFinderQueryRecipe[] = [
  {
    id: 'micropubs_uk',
    label: 'Micropubs in the UK',
    description: 'Find small, independent micropubs in a specific area',
    searchTemplate: 'micropub {REGION_OR_TOWN}',
    tags: ['pubs', 'micropub', 'uk', 'independent'],
    defaultCountryCode: 'GB',
  },
  {
    id: 'craft_beer_bars',
    label: 'Craft Beer Bars',
    description: 'Find bars specializing in craft beer',
    searchTemplate: 'craft beer bar {REGION_OR_TOWN}',
    tags: ['bars', 'craft beer', 'specialist'],
    defaultCountryCode: 'GB',
  },
  {
    id: 'freehouses',
    label: 'Freehouse Pubs',
    description: 'Find independent freehouses not tied to a brewery',
    searchTemplate: 'freehouse pub {REGION_OR_TOWN}',
    tags: ['pubs', 'freehouse', 'independent'],
    defaultCountryCode: 'GB',
  },
  {
    id: 'taprooms',
    label: 'Brewery Taprooms',
    description: 'Find brewery taprooms that might stock guest beers',
    searchTemplate: 'brewery taproom {REGION_OR_TOWN}',
    tags: ['taproom', 'brewery', 'venue'],
    defaultCountryCode: 'GB',
  },
  {
    id: 'real_ale_pubs',
    label: 'Real Ale Pubs',
    description: 'Find pubs known for serving real ale and cask beer',
    searchTemplate: 'real ale pub {REGION_OR_TOWN}',
    tags: ['pubs', 'real ale', 'cask', 'camra'],
    defaultCountryCode: 'GB',
  },
  {
    id: 'gastropubs',
    label: 'Gastropubs',
    description: 'Find food-focused pubs that often stock premium drinks',
    searchTemplate: 'gastropub {REGION_OR_TOWN}',
    tags: ['pubs', 'gastropub', 'food', 'premium'],
    defaultCountryCode: 'GB',
  },
  {
    id: 'hotel_bars',
    label: 'Hotel Bars',
    description: 'Find hotel bars that might stock local beers',
    searchTemplate: 'hotel bar {REGION_OR_TOWN}',
    tags: ['hotels', 'bars', 'hospitality'],
    defaultCountryCode: 'GB',
  },
  {
    id: 'beer_shops',
    label: 'Specialist Beer Shops',
    description: 'Find bottle shops and specialist beer retailers',
    searchTemplate: 'craft beer shop {REGION_OR_TOWN}',
    tags: ['retail', 'bottle shop', 'off-trade'],
    defaultCountryCode: 'GB',
  },
];

// ============================================
// SCRIPT TEMPLATES
// ============================================

/**
 * Brewery-specific script templates for outreach.
 * Use {{placeholders}} for dynamic content.
 */
const breweryScriptTemplates: VerticalScriptTemplate[] = [
  {
    id: 'cold_outreach_pub',
    label: 'Cold Outreach to Pub',
    description: 'Initial cold email introducing the brewery to a pub',
    channel: 'email',
    tags: ['cold', 'introduction', 'pub'],
    bodyTemplate: `Hi {{contact_name}},

I noticed {{pub_name}} has a great reputation for quality drinks, and I wanted to reach out from {{brewery_name}}.

We're a local brewery producing {{selling_point}}, and I think your customers would really enjoy what we do.

Would you be open to a quick chat about stocking our range, or perhaps I could drop off some samples for you to try?

No pressure at all—just keen to connect with venues that share our passion for great beer.

Best,
{{sender_name}}
{{brewery_name}}`,
  },
  {
    id: 'follow_up_after_sample',
    label: 'Follow-up After Samples',
    description: 'Follow-up email after sending sample beers',
    channel: 'email',
    tags: ['follow-up', 'samples', 'pub'],
    bodyTemplate: `Hi {{contact_name}},

I hope the samples from {{brewery_name}} arrived safely! I wanted to check in and see what you thought.

If you and the team have had a chance to try them, I'd love to hear your feedback. Our {{selling_point}} has been particularly popular with other venues.

Happy to pop by to chat through our range and pricing, or answer any questions you might have.

Looking forward to hearing from you.

Cheers,
{{sender_name}}
{{brewery_name}}`,
  },
  {
    id: 'reactivate_stale_pub',
    label: 'Reactivate Quiet Account',
    description: 'Re-engagement email for a pub that has gone quiet',
    channel: 'email',
    tags: ['reactivation', 'stale', 'win-back'],
    bodyTemplate: `Hi {{contact_name}},

It's been a little while since we last connected, and I wanted to reach out from {{brewery_name}}.

We've been busy and have some exciting new additions to our range—including {{selling_point}}—that I think would go down well at {{pub_name}}.

If things have changed or you've got different needs now, I'd love to hear about it. Either way, we're always here if you need anything.

Would be great to catch up when you have a moment.

All the best,
{{sender_name}}
{{brewery_name}}`,
  },
  {
    id: 'call_script_introduction',
    label: 'Cold Call Introduction',
    description: 'Script for an introductory phone call to a pub',
    channel: 'call',
    tags: ['cold', 'call', 'introduction'],
    bodyTemplate: `Hi, could I speak to the person who handles your beer ordering, please?

[If available]

Great, thanks! My name's {{sender_name}} from {{brewery_name}}. We're a local brewery and I'm reaching out to pubs in the area who might be interested in stocking some fresh, local beer.

I noticed {{pub_name}} has a good reputation—do you currently work with any local breweries?

[Listen and respond]

We specialise in {{selling_point}}. Would you be open to me dropping off some samples for you to try? No obligation, just keen to introduce ourselves.

[If yes] Brilliant, what day works best for you?
[If no] No problem at all. I'll send over some info by email in case anything changes in the future.

Thanks for your time, {{contact_name}}. Have a great day!`,
  },
  {
    id: 'thank_you_first_order',
    label: 'Thank You for First Order',
    description: 'Thank you note after receiving a first order',
    channel: 'email',
    tags: ['thank-you', 'first-order', 'onboarding'],
    bodyTemplate: `Hi {{contact_name}},

Just a quick note to say a huge thank you for placing your first order with {{brewery_name}}!

We're really excited to be working with {{pub_name}}, and we hope your customers enjoy the beers as much as we enjoy making them.

If there's anything you need—point of sale materials, tap badges, or just advice on serving—don't hesitate to get in touch.

Here's to a great partnership!

Cheers,
{{sender_name}}
{{brewery_name}}`,
  },
];

// ============================================
// BREWERY VERTICAL PACK
// ============================================

/**
 * Complete Brewery Vertical Pack.
 * Contains all configurations for the brewery → pub sales vertical.
 */
export const BreweryVerticalPack: VerticalPack = {
  verticalId: 'brewery',
  name: 'Brewery',
  description: 'Tools, pipelines, and recipes for breweries selling to pubs and venues.',
  leadPipeline: breweryLeadPipeline,
  leadFinderRecipes: breweryLeadFinderRecipes,
  scriptTemplates: breweryScriptTemplates,
};

/**
 * Get the Brewery Vertical Pack.
 * Convenience function for programmatic access.
 */
export function getBreweryVerticalPack(): VerticalPack {
  return BreweryVerticalPack;
}
