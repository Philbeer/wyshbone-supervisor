import { registerExecutor } from './executor-registry';
import { gpCascadeAdapter } from './gp-cascade-adapter';
import { gpt4oAdapter } from './gpt4o-adapter';

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

export { runReloop } from './loop-skeleton';
export * from './types';
export { registerExecutor, getAvailableExecutors } from './executor-registry';
