import { registerExecutor } from './executor-registry';
import { gpCascadeAdapter } from './gp-cascade-adapter';
import { gpt4oAdapter } from './gpt4o-adapter';
import { outreachAdapter } from './outreach-adapter';

registerExecutor('gp_cascade', gpCascadeAdapter, {
  description: 'Google Places discovery with website verification cascade. Finds businesses via structured Google Places data, visits their websites to verify constraints, falls back to GPT-4o web search for bot-blocked sites.',
  strengths: 'Excellent for location-based business discovery. Returns structured data (address, phone, website). Cheap and fast. Good coverage for common business types (shops, restaurants, services).',
  limitations: 'Limited to what Google Places indexes. Misses niche/specialist entities, non-commercial organisations, charities, government bodies, and anything without a Google Business listing. Max ~20 results per query.',
  typicalUse: 'First choice for standard business discovery queries. Best when the entity type maps well to Google Places categories.',
  costTier: 'cheap',
});

registerExecutor('gpt4o_search', gpt4oAdapter, {
  description: 'GPT-4o web search discovery. Uses OpenAI GPT-4o with web search to find entities across the open web, including directories, council websites, NHS listings, charity registers, and specialist databases.',
  strengths: 'Finds entities that Google Places misses — charities, CICs, housing associations, niche manufacturers, specialist service providers. Can reason about what to search for. Finds entities on council and government websites.',
  limitations: 'More expensive than GP cascade. Slower (multiple search rounds). No structured place data (no phone numbers, no verified addresses). Results depend on web search quality.',
  typicalUse: 'Second choice after GP cascade when coverage is thin. First choice for queries about non-commercial entities, organisations, or niche sectors that Google Places does not index well.',
  costTier: 'moderate',
});

registerExecutor('outreach', outreachAdapter, {
  description: 'Post-discovery outreach executor. Takes delivered leads, extracts contact information from their websites, drafts personalised emails using GPT-4o, and stores them for user approval before sending via Resend.',
  strengths: 'Personalised email drafting using lead evidence and intent narrative. Contact extraction from websites. Full send/track/reply pipeline via Resend. Reply detection and forwarding.',
  limitations: 'Requires leads to have websites for contact extraction. Email deliverability depends on recipient domain. Cannot outreach to leads without discoverable email addresses.',
  typicalUse: 'Post-discovery phase. User reviews delivered leads, triggers outreach, reviews drafted emails, approves and sends. System tracks delivery and replies.',
  costTier: 'moderate',
});

export { runReloop } from './loop-skeleton';
export { checkForResumableState } from './resume';
export * from './types';
export { registerExecutor, getAvailableExecutors } from './executor-registry';
