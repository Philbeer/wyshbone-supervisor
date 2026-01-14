/**
 * Brewery Vertical Pack Tests
 * 
 * Unit tests for the Brewery Vertical Pack.
 * Run with: npx tsx server/verticals/brewery/BreweryVerticalPack.test.ts
 * 
 * SUP-14: BreweryVerticalPack (pipeline, scripts, queries)
 */

import { BreweryVerticalPack, getBreweryVerticalPack } from './BreweryVerticalPack';
import {
  getVerticalPack,
  listVerticalPacks,
  hasVerticalPack,
  listVerticalIds,
} from '../../core/verticals';
import type { VerticalPack } from '../../core/verticals/types';

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
  console.log('Brewery Vertical Pack Tests (SUP-14)');
  console.log('='.repeat(60));

  // ----------------------------------------
  // Basic existence and structure
  // ----------------------------------------
  
  describe('BreweryVerticalPack exists and has correct structure', () => {
    assert(BreweryVerticalPack !== undefined, 'BreweryVerticalPack should be defined');
    assert(BreweryVerticalPack.verticalId === 'brewery', 'verticalId should be "brewery"');
    assert(BreweryVerticalPack.name === 'Brewery', 'name should be "Brewery"');
    assert(typeof BreweryVerticalPack.description === 'string', 'description should be a string');
    assert(Array.isArray(BreweryVerticalPack.leadPipeline), 'leadPipeline should be an array');
    assert(Array.isArray(BreweryVerticalPack.leadFinderRecipes), 'leadFinderRecipes should be an array');
    assert(Array.isArray(BreweryVerticalPack.scriptTemplates), 'scriptTemplates should be an array');
  });

  describe('getBreweryVerticalPack() returns the pack', () => {
    const pack = getBreweryVerticalPack();
    assert(pack === BreweryVerticalPack, 'getBreweryVerticalPack() should return BreweryVerticalPack');
  });

  // ----------------------------------------
  // Lead Pipeline Tests
  // ----------------------------------------

  describe('Lead pipeline has required stages', () => {
    const pipeline = BreweryVerticalPack.leadPipeline;
    
    assert(pipeline.length >= 5, 'Pipeline should have at least 5 stages');
    
    // Check for 'new' stage
    const newStage = pipeline.find(s => s.id === 'new');
    assert(newStage !== undefined, 'Pipeline should include "new" stage');
    
    // Check for at least one terminal stage
    const terminalStages = pipeline.filter(s => s.isTerminal === true);
    assert(terminalStages.length >= 1, 'Pipeline should have at least one terminal stage');
    
    // Check for specific terminal stages
    const customerStage = pipeline.find(s => s.id === 'customer');
    const lostStage = pipeline.find(s => s.id === 'lost');
    assert(customerStage?.isTerminal === true, '"customer" stage should be terminal');
    assert(lostStage?.isTerminal === true, '"lost" stage should be terminal');
  });

  describe('Lead pipeline order is strictly increasing', () => {
    const pipeline = BreweryVerticalPack.leadPipeline;
    const orders = pipeline.map(s => s.order);
    
    let isStrictlyIncreasing = true;
    for (let i = 1; i < orders.length; i++) {
      if (orders[i] <= orders[i - 1]) {
        isStrictlyIncreasing = false;
        break;
      }
    }
    
    assert(isStrictlyIncreasing, 'Pipeline stage orders should be strictly increasing');
  });

  describe('Lead pipeline stages have required fields', () => {
    const pipeline = BreweryVerticalPack.leadPipeline;
    
    for (const stage of pipeline) {
      assert(typeof stage.id === 'string' && stage.id.length > 0, `Stage "${stage.id}" should have a non-empty id`);
      assert(typeof stage.label === 'string' && stage.label.length > 0, `Stage "${stage.id}" should have a non-empty label`);
      assert(typeof stage.order === 'number', `Stage "${stage.id}" should have a numeric order`);
    }
    
    assert(true, 'All pipeline stages have required fields');
  });

  // ----------------------------------------
  // Lead Finder Recipe Tests
  // ----------------------------------------

  describe('Lead Finder recipes are non-empty and brewery/pub focused', () => {
    const recipes = BreweryVerticalPack.leadFinderRecipes;
    
    assert(recipes.length >= 4, 'Should have at least 4 Lead Finder recipes');
    
    // Check for brewery/pub related keywords in recipes
    const breweryPubKeywords = ['pub', 'bar', 'beer', 'taproom', 'freehouse', 'micropub', 'ale'];
    
    let hasBreweryFocus = false;
    for (const recipe of recipes) {
      const combined = (recipe.searchTemplate + ' ' + recipe.label + ' ' + (recipe.tags?.join(' ') || '')).toLowerCase();
      if (breweryPubKeywords.some(kw => combined.includes(kw))) {
        hasBreweryFocus = true;
        break;
      }
    }
    
    assert(hasBreweryFocus, 'Recipes should include brewery/pub-focused search terms');
  });

  describe('Lead Finder recipes have required fields', () => {
    const recipes = BreweryVerticalPack.leadFinderRecipes;
    
    for (const recipe of recipes) {
      assert(typeof recipe.id === 'string' && recipe.id.length > 0, `Recipe "${recipe.id}" should have a non-empty id`);
      assert(typeof recipe.label === 'string' && recipe.label.length > 0, `Recipe "${recipe.id}" should have a non-empty label`);
      assert(typeof recipe.searchTemplate === 'string' && recipe.searchTemplate.length > 0, `Recipe "${recipe.id}" should have a non-empty searchTemplate`);
    }
    
    assert(true, 'All recipes have required fields');
  });

  describe('Lead Finder recipes have placeholders', () => {
    const recipes = BreweryVerticalPack.leadFinderRecipes;
    
    const recipesWithPlaceholder = recipes.filter(r => r.searchTemplate.includes('{'));
    assert(recipesWithPlaceholder.length > 0, 'At least one recipe should have a {PLACEHOLDER}');
    
    // Check for common location placeholder
    const hasLocationPlaceholder = recipes.some(r => 
      r.searchTemplate.includes('{REGION_OR_TOWN}') || 
      r.searchTemplate.includes('{LOCATION}')
    );
    assert(hasLocationPlaceholder, 'Recipes should include location placeholder');
  });

  // ----------------------------------------
  // Script Template Tests
  // ----------------------------------------

  describe('Script templates are non-empty', () => {
    const scripts = BreweryVerticalPack.scriptTemplates;
    
    assert(scripts.length >= 3, 'Should have at least 3 script templates');
  });

  describe('Script templates have required fields', () => {
    const scripts = BreweryVerticalPack.scriptTemplates;
    
    for (const script of scripts) {
      assert(typeof script.id === 'string' && script.id.length > 0, `Script "${script.id}" should have a non-empty id`);
      assert(typeof script.label === 'string' && script.label.length > 0, `Script "${script.id}" should have a non-empty label`);
      assert(typeof script.bodyTemplate === 'string' && script.bodyTemplate.length > 0, `Script "${script.id}" should have a non-empty bodyTemplate`);
    }
    
    assert(true, 'All scripts have required fields');
  });

  describe('Script templates contain {{...}} placeholders', () => {
    const scripts = BreweryVerticalPack.scriptTemplates;
    
    const placeholderRegex = /\{\{[^}]+\}\}/;
    
    let allHavePlaceholders = true;
    for (const script of scripts) {
      if (!placeholderRegex.test(script.bodyTemplate)) {
        console.log(`    Script "${script.id}" is missing {{placeholders}}`);
        allHavePlaceholders = false;
      }
    }
    
    assert(allHavePlaceholders, 'All script templates should contain at least one {{placeholder}}');
  });

  describe('Script templates have expected placeholders', () => {
    const scripts = BreweryVerticalPack.scriptTemplates;
    
    // Check for common placeholders across all scripts
    const expectedPlaceholders = ['{{pub_name}}', '{{brewery_name}}', '{{sender_name}}'];
    
    const allTexts = scripts.map(s => s.bodyTemplate).join(' ');
    
    for (const placeholder of expectedPlaceholders) {
      const found = allTexts.includes(placeholder);
      assert(found, `Scripts should use ${placeholder} placeholder`);
    }
  });

  describe('Script templates have no leading/trailing blank lines in body', () => {
    const scripts = BreweryVerticalPack.scriptTemplates;
    
    let allClean = true;
    for (const script of scripts) {
      const body = script.bodyTemplate;
      if (body.startsWith('\n') || body.startsWith('\r\n')) {
        console.log(`    Script "${script.id}" has leading blank line`);
        allClean = false;
      }
      if (body.endsWith('\n\n') || body.endsWith('\r\n\r\n')) {
        console.log(`    Script "${script.id}" has trailing blank lines`);
        allClean = false;
      }
    }
    
    assert(allClean, 'Script templates should not have leading/trailing blank lines');
  });

  // ----------------------------------------
  // Registry Tests
  // ----------------------------------------

  describe('Registry: getVerticalPack("brewery") returns the pack', () => {
    const pack = getVerticalPack('brewery');
    
    assert(pack !== undefined, 'getVerticalPack("brewery") should return a pack');
    assert(pack === BreweryVerticalPack, 'Returned pack should be BreweryVerticalPack');
    assert(pack?.verticalId === 'brewery', 'Returned pack verticalId should be "brewery"');
  });

  describe('Registry: hasVerticalPack() works correctly', () => {
    assert(hasVerticalPack('brewery') === true, 'hasVerticalPack("brewery") should return true');
  });

  describe('Registry: listVerticalPacks() includes brewery pack', () => {
    const packs = listVerticalPacks();
    
    assert(Array.isArray(packs), 'listVerticalPacks() should return an array');
    assert(packs.length >= 1, 'listVerticalPacks() should return at least one pack');
    
    const breweryPack = packs.find((p: VerticalPack) => p.verticalId === 'brewery');
    assert(breweryPack !== undefined, 'listVerticalPacks() should include brewery pack');
  });

  describe('Registry: listVerticalIds() includes "brewery"', () => {
    const ids = listVerticalIds();
    
    assert(Array.isArray(ids), 'listVerticalIds() should return an array');
    assert(ids.includes('brewery'), 'listVerticalIds() should include "brewery"');
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
