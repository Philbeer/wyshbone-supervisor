/**
 * Database Reset Script (Development)
 * 
 * Drops and recreates the SQLite dev database.
 * Run with: npm run db:reset
 * 
 * WARNING: This will delete all data in the dev database!
 */

import { config } from 'dotenv';
config();

import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';

const dbPath = process.env.DATABASE_URL?.replace('file:', '') || './dev.db';
const fullPath = resolve(dbPath);

console.log('='.repeat(60));
console.log('[Reset] SQLite Dev Database Reset');
console.log('='.repeat(60));
console.log(`[Reset] Database path: ${fullPath}`);
console.log('');

// Delete the database file if it exists
const filesToDelete = [
  fullPath,
  `${fullPath}-wal`,  // WAL file
  `${fullPath}-shm`,  // Shared memory file
];

for (const file of filesToDelete) {
  if (existsSync(file)) {
    try {
      unlinkSync(file);
      console.log(`  ✓ Deleted: ${file}`);
    } catch (error) {
      console.error(`  ✗ Failed to delete ${file}:`, error);
    }
  }
}

console.log('');
console.log('[Reset] Database files removed. Running migration...');
console.log('');

// Run migration to recreate tables
const { spawn } = await import('child_process');

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

const child = spawn(npmCmd, ['run', 'db:migrate'], {
  stdio: 'inherit',
  shell: true
});

child.on('close', (code) => {
  if (code === 0) {
    console.log('');
    console.log('[Reset] ✅ Database reset complete!');
    console.log('');
    console.log('Next steps:');
    console.log('  npm run db:seed   # (optional) Add sample data');
    console.log('  npm run dev       # Start the dev server');
    console.log('='.repeat(60));
  } else {
    console.error('[Reset] ✗ Migration failed');
    process.exit(1);
  }
});
