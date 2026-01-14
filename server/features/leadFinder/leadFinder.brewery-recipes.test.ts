/**
 * Lead Finder Brewery Recipes Tests
 * 
 * Tests for the vertical pack recipe integration in Lead Finder.
 * Run with: npx tsx server/features/leadFinder/leadFinder.brewery-recipes.test.ts
 * 
 * SUP-15: Lead Finder uses brewery search recipes
 */

import {
  runLeadFinder,
  buildSearchQueryFromRecipe,
  buildLegacySearchQuery,
  type LeadFinderParams,
} from './leadFinder';
import { getVerticalPack } from '../../core/verticals';
import type { VerticalLeadFinderQueryRecipe } from '../../core/verticals/types';

// ============================================
// TEST UTILITIES
// ============================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

function describe(name: string, fn: () => void | Promise<void>) {
  console.log(`\n${name}`);
  return fn();
}

// ============================================
// TESTS
// ============================================

async function runTests() {
  console.log('='.repeat(60));
  console.log('Lead Finder Brewery Recipes Tests (SUP-15)');
  console.log('='.repeat(60));

  // ----------------------------------------
  // buildSearchQueryFromRecipe Tests
  // ----------------------------------------

  describe('buildSearchQueryFromRecipe() replaces {REGION_OR_TOWN} placeholder', () => {
    const recipe: VerticalLeadFinderQueryRecipe = {
      id: 'test_recipe',
      label: 'Test Recipe',
      searchTemplate: 'micropub {REGION_OR_TOWN}',
    };

    const params: LeadFinderParams = {
      query: '',
      location: 'Brighton',
    };

    const query = buildSearchQueryFromRecipe(recipe, params);
    assert(query === 'micropub Brighton', `Expected "micropub Brighton", got "${query}"`);
  });

  describe('buildSearchQueryFromRecipe() replaces {CITY} placeholder', () => {
    const recipe: VerticalLeadFinderQueryRecipe = {
      id: 'test_recipe',
      label: 'Test Recipe',
      searchTemplate: 'craft beer bar {CITY}',
    };

    const params: LeadFinderParams = {
      query: '',
      location: 'Manchester',
    };

    const query = buildSearchQueryFromRecipe(recipe, params);
    assert(query === 'craft beer bar Manchester', `Expected "craft beer bar Manchester", got "${query}"`);
  });

  describe('buildSearchQueryFromRecipe() handles multiple placeholders', () => {
    const recipe: VerticalLeadFinderQueryRecipe = {
      id: 'test_recipe',
      label: 'Test Recipe',
      searchTemplate: '{REGION_OR_TOWN} pubs and bars {CITY}',
    };

    const params: LeadFinderParams = {
      query: '',
      location: 'Leeds',
    };

    const query = buildSearchQueryFromRecipe(recipe, params);
    assert(query === 'Leeds pubs and bars Leeds', `Expected "Leeds pubs and bars Leeds", got "${query}"`);
  });

  describe('buildSearchQueryFromRecipe() strips placeholders when no location', () => {
    const recipe: VerticalLeadFinderQueryRecipe = {
      id: 'test_recipe',
      label: 'Test Recipe',
      searchTemplate: 'micropub {REGION_OR_TOWN}',
    };

    const params: LeadFinderParams = {
      query: '',
      location: '',
    };

    const query = buildSearchQueryFromRecipe(recipe, params);
    assert(query === 'micropub', `Expected "micropub", got "${query}"`);
  });

  describe('buildSearchQueryFromRecipe() trims location whitespace', () => {
    const recipe: VerticalLeadFinderQueryRecipe = {
      id: 'test_recipe',
      label: 'Test Recipe',
      searchTemplate: 'micropub {REGION_OR_TOWN}',
    };

    const params: LeadFinderParams = {
      query: '',
      location: '  Bristol  ',
    };

    const query = buildSearchQueryFromRecipe(recipe, params);
    assert(query === 'micropub Bristol', `Expected "micropub Bristol", got "${query}"`);
  });

  // ----------------------------------------
  // buildLegacySearchQuery Tests
  // ----------------------------------------

  describe('buildLegacySearchQuery() combines query and location', () => {
    const params: LeadFinderParams = {
      query: 'dental clinics',
      location: 'UK',
    };

    const query = buildLegacySearchQuery(params);
    assert(query === 'dental clinics UK', `Expected "dental clinics UK", got "${query}"`);
  });

  describe('buildLegacySearchQuery() handles empty query', () => {
    const params: LeadFinderParams = {
      query: '',
      location: 'Bristol',
    };

    const query = buildLegacySearchQuery(params);
    assert(query === 'Bristol', `Expected "Bristol", got "${query}"`);
  });

  describe('buildLegacySearchQuery() handles empty location', () => {
    const params: LeadFinderParams = {
      query: 'breweries',
      location: '',
    };

    const query = buildLegacySearchQuery(params);
    assert(query === 'breweries', `Expected "breweries", got "${query}"`);
  });

  describe('buildLegacySearchQuery() handles both empty', () => {
    const params: LeadFinderParams = {
      query: '',
      location: '',
    };

    const query = buildLegacySearchQuery(params);
    assert(query === '', `Expected "", got "${query}"`);
  });

  describe('buildLegacySearchQuery() trims whitespace', () => {
    const params: LeadFinderParams = {
      query: '  pubs  ',
      location: '  London  ',
    };

    const query = buildLegacySearchQuery(params);
    assert(query === 'pubs London', `Expected "pubs London", got "${query}"`);
  });

  // ----------------------------------------
  // runLeadFinder with recipeId Tests
  // ----------------------------------------

  await describe('runLeadFinder() uses pack recipe when recipeId provided', async () => {
    const result = await runLeadFinder({
      query: '',
      location: 'Brighton',
      verticalId: 'brewery',
      recipeId: 'micropubs_uk',
    });

    // Should return leads (mock data)
    assert(result.leads.length > 0, 'Should return leads');
    assert(result.count === result.leads.length, 'Count should match leads length');
  });

  await describe('runLeadFinder() uses default vertical (brewery) when verticalId omitted', async () => {
    // This should NOT throw - it should default to 'brewery' and find the recipe
    let didThrow = false;
    try {
      const result = await runLeadFinder({
        query: '',
        location: 'Manchester',
        recipeId: 'micropubs_uk', // no verticalId provided
      });
      assert(result.leads.length > 0, 'Should return leads with default vertical');
    } catch (e) {
      didThrow = true;
    }
    assert(!didThrow, 'Should not throw when verticalId is omitted');
  });

  await describe('runLeadFinder() falls back gracefully when no recipeId provided', async () => {
    // Legacy behaviour - no recipeId
    const result = await runLeadFinder({
      query: 'dental clinics',
      location: 'UK',
    });

    assert(result.leads.length > 0, 'Should return leads with legacy params');
    assert(result.count === result.leads.length, 'Count should match leads length');
  });

  await describe('runLeadFinder() throws for nonexistent recipe', async () => {
    let thrownError: Error | null = null;
    
    try {
      await runLeadFinder({
        query: '',
        location: 'Bristol',
        verticalId: 'brewery',
        recipeId: 'nonexistent_recipe',
      });
    } catch (e) {
      thrownError = e as Error;
    }
    
    assert(thrownError !== null, 'Should throw an error for nonexistent recipe');
    assert(
      thrownError?.message.includes('nonexistent_recipe'),
      `Error should mention the recipe ID, got: "${thrownError?.message}"`
    );
    assert(
      thrownError?.message.includes('brewery'),
      `Error should mention the vertical ID, got: "${thrownError?.message}"`
    );
  });

  // ----------------------------------------
  // Brewery Pack Recipe Integration Tests
  // ----------------------------------------

  describe('Brewery pack has the micropubs_uk recipe', () => {
    const pack = getVerticalPack('brewery');
    assert(pack !== undefined, 'Brewery pack should exist');
    
    const recipe = pack!.leadFinderRecipes.find(r => r.id === 'micropubs_uk');
    assert(recipe !== undefined, 'micropubs_uk recipe should exist');
    assert(
      recipe!.searchTemplate.includes('{REGION_OR_TOWN}'),
      'Recipe should have {REGION_OR_TOWN} placeholder'
    );
  });

  await describe('buildSearchQueryFromRecipe() works with actual brewery pack recipe', async () => {
    const pack = getVerticalPack('brewery');
    const recipe = pack!.leadFinderRecipes.find(r => r.id === 'micropubs_uk')!;
    
    const params: LeadFinderParams = {
      query: '',
      location: 'Brighton',
    };

    const query = buildSearchQueryFromRecipe(recipe, params);
    
    // micropubs_uk template is 'micropub {REGION_OR_TOWN}'
    assert(query.includes('micropub'), `Query should contain "micropub", got "${query}"`);
    assert(query.includes('Brighton'), `Query should contain "Brighton", got "${query}"`);
  });

  await describe('runLeadFinder() with craft_beer_bars recipe', async () => {
    const result = await runLeadFinder({
      query: '',
      location: 'Manchester',
      verticalId: 'brewery',
      recipeId: 'craft_beer_bars',
    });

    assert(result.leads.length > 0, 'Should return leads for craft_beer_bars recipe');
  });

  await describe('runLeadFinder() with freehouses recipe', async () => {
    const result = await runLeadFinder({
      query: '',
      location: 'Leeds',
      verticalId: 'brewery',
      recipeId: 'freehouses',
    });

    assert(result.leads.length > 0, 'Should return leads for freehouses recipe');
  });

  // ----------------------------------------
  // Backwards Compatibility Tests
  // ----------------------------------------

  await describe('Old API calls still work without recipeId', async () => {
    // Simulating the old API usage pattern
    const result = await runLeadFinder({
      query: 'dental clinics',
      location: 'UK',
    });

    assert(typeof result === 'object', 'Result should be an object');
    assert(Array.isArray(result.leads), 'Result should have leads array');
    assert(typeof result.count === 'number', 'Result should have count');
  });

  await describe('Empty params still work (legacy fallback)', async () => {
    const result = await runLeadFinder({
      query: '',
      location: '',
    });

    assert(result.leads.length > 0, 'Should return leads even with empty legacy params');
  });

  // ----------------------------------------
  // Summary
  // ----------------------------------------
  
  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

// Run tests
runTests().catch((error) => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
