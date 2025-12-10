/**
 * Database Seed Script (Development)
 * 
 * Adds sample data to the SQLite dev database for testing.
 * Run with: npm run db:seed
 */

import { config } from 'dotenv';
config();

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { randomUUID } from 'crypto';
import * as schema from '@shared/schema-sqlite';

const dbPath = process.env.DATABASE_URL?.replace('file:', '') || './dev.db';

console.log('='.repeat(60));
console.log('[Seed] SQLite Dev Database Seeding');
console.log('='.repeat(60));
console.log(`[Seed] Database path: ${dbPath}`);
console.log('');

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');

const db = drizzle(sqlite, { schema });

// Sample data
const now = new Date().toISOString();

// Demo user
const demoUserId = '8f9079b3ddf739fb0217373c92292e91'; // Same as in routes.ts
const demoAccountId = 'demo_account_brewery';

console.log('[Seed] Creating sample data...');

try {
  // Create demo user
  db.insert(schema.users).values({
    id: demoUserId,
    username: 'demo@brewery.com',
    password: 'demo123', // Not used for auth in dev
  }).onConflictDoNothing().run();
  console.log('  ✓ Demo user created');

  // Create sample leads
  const sampleLeads = [
    {
      id: randomUUID(),
      userId: demoUserId,
      accountId: demoAccountId,
      rationale: 'Craft beer pub in Manchester - high engagement potential',
      source: 'google_places',
      score: 0.92,
      lead: JSON.stringify({
        businessName: 'The Craft Beer Co',
        address: '45 Deansgate, Manchester M3 2AY',
        phone: '+44 161 555 0123',
        website: 'https://craftbeerco.example.com',
        placeId: 'ChIJ_demo_1',
        tags: ['pub', 'craft_beer', 'manchester']
      }),
      createdAt: now,
      updatedAt: now,
      pipelineStage: 'new',
    },
    {
      id: randomUUID(),
      userId: demoUserId,
      accountId: demoAccountId,
      rationale: 'Micropub specializing in local ales - perfect fit',
      source: 'google_places',
      score: 0.87,
      lead: JSON.stringify({
        businessName: 'The Hoppy Frog',
        address: '12 High Street, Leeds LS1 1AA',
        phone: '+44 113 555 0456',
        website: 'https://hoppyfrog.example.com',
        placeId: 'ChIJ_demo_2',
        tags: ['micropub', 'local_ales', 'leeds']
      }),
      createdAt: now,
      updatedAt: now,
      pipelineStage: 'contacted',
      lastContactedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
    },
    {
      id: randomUUID(),
      userId: demoUserId,
      accountId: demoAccountId,
      rationale: 'Wine bar expanding into craft beers',
      source: 'manual',
      score: 0.75,
      lead: JSON.stringify({
        businessName: 'Vino & Hops',
        address: '88 Church Lane, Bristol BS1 5TT',
        phone: '+44 117 555 0789',
        website: 'https://vinohops.example.com',
        placeId: 'ChIJ_demo_3',
        tags: ['wine_bar', 'expanding', 'bristol']
      }),
      createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(), // 14 days ago (stale)
      updatedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
      pipelineStage: 'new',
    },
  ];

  for (const lead of sampleLeads) {
    db.insert(schema.suggestedLeads).values(lead).onConflictDoNothing().run();
  }
  console.log(`  ✓ ${sampleLeads.length} sample leads created`);

  // Create a sample plan
  const planId = `plan_${Date.now()}`;
  db.insert(schema.plans).values({
    id: planId,
    userId: demoUserId,
    accountId: demoAccountId,
    status: 'completed',
    planData: JSON.stringify({
      id: planId,
      title: 'Find pubs in Manchester',
      steps: [
        { id: 'step_1', tool: 'GOOGLE_PLACES_SEARCH', status: 'completed' },
        { id: 'step_2', tool: 'HUNTER_ENRICH', status: 'completed' },
      ]
    }),
    goalText: 'Find pubs in Manchester for craft beer distribution',
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().run();
  console.log('  ✓ Sample plan created');

  // Create a sample nudge
  db.insert(schema.subconsciousNudges).values({
    id: `nudge_${Date.now()}`,
    accountId: demoAccountId,
    userId: demoUserId,
    nudgeType: 'stale_lead',
    title: 'Stale Lead Alert',
    message: 'Vino & Hops: Created 14 days ago and never contacted',
    importance: 75,
    leadId: sampleLeads[2].id,
    context: JSON.stringify({ staleReasons: ['never_contacted'] }),
    createdAt: now,
  }).onConflictDoNothing().run();
  console.log('  ✓ Sample nudge created');

  sqlite.close();

  console.log('');
  console.log('[Seed] ✅ Seeding complete!');
  console.log('');
  console.log('Sample data created:');
  console.log('  - 1 demo user (demo@brewery.com)');
  console.log('  - 3 sample leads');
  console.log('  - 1 sample plan');
  console.log('  - 1 sample nudge');
  console.log('');
  console.log('Next steps:');
  console.log('  npm run dev       # Start the dev server');
  console.log('='.repeat(60));

} catch (error) {
  console.error('[Seed] ✗ Seeding failed:', error);
  sqlite.close();
  process.exit(1);
}
