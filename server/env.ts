/**
 * Environment Loader for Supervisor - MUST BE IMPORTED FIRST
 * 
 * Loads environment variables from the repo root's .env files.
 * Priority: .env.local > .env
 * 
 * The repo root is two levels up from this file (supervisor/server/ → supervisor/ → repo root)
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

// Get the directory of this file (supervisor/server/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Repo root is two levels up from supervisor/server/
const repoRoot = resolve(__dirname, '..', '..');

/**
 * Load environment variables from .env files at repo root
 */
function loadEnv(): { loaded: boolean; path: string; error?: string } {
  // Priority 1: .env.local at repo root
  const envLocalPath = resolve(repoRoot, '.env.local');
  if (existsSync(envLocalPath)) {
    const result = config({ path: envLocalPath, override: true });
    if (!result.error) {
      return { loaded: true, path: envLocalPath };
    }
  }

  // Priority 2: .env at repo root
  const envPath = resolve(repoRoot, '.env');
  if (existsSync(envPath)) {
    const result = config({ path: envPath, override: true });
    if (!result.error) {
      return { loaded: true, path: envPath };
    }
    return { loaded: false, path: envPath, error: 'Failed to parse' };
  }

  // No env file found
  return { 
    loaded: false, 
    path: `(looked in ${envLocalPath} and ${envPath})`,
    error: 'No .env or .env.local file found'
  };
}

// ============================================
// EXECUTE ENV LOADING ON IMPORT
// ============================================

const envResult = loadEnv();

console.log(`\n${'='.repeat(60)}`);
console.log(`🔧 [SUPERVISOR ENV] Environment Configuration`);
console.log(`${'='.repeat(60)}`);
console.log(`   Repo root: ${repoRoot}`);

if (envResult.loaded) {
  console.log(`   ✅ Loaded: ${envResult.path}`);
} else {
  console.log(`   ❌ NOT LOADED: ${envResult.path}`);
  if (envResult.error) {
    console.log(`   Error: ${envResult.error}`);
  }
}

// Check key env vars - prefer SUPABASE_DATABASE_URL over DATABASE_URL
const keyVars = ['SUPABASE_DATABASE_URL', 'DATABASE_URL', 'SUPABASE_URL'];
console.log(`\n   Key variables:`);
for (const key of keyVars) {
  const isSet = process.env[key] ? '✅' : '❌';
  const value = process.env[key];
  const masked = value ? value.substring(0, 20) + '...' : '(not set)';
  console.log(`   ${isSet} ${key}: ${masked}`);
}

console.log(`${'='.repeat(60)}\n`);

export { envResult, repoRoot };

