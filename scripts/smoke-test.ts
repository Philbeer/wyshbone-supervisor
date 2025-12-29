/**
 * Wyshbone Supervisor Smoke Test
 * 
 * A simple, robust sanity check that proves the Supervisor isn't obviously broken.
 * Windows-safe: runs in-process, no child spawning, no file watchers, graceful shutdown.
 * 
 * Usage: npm run smoke
 */

import express from 'express';
import cors from 'cors';
import { createServer, type Server } from 'http';
import { registerRoutes } from '../server/routes';

// Configuration
const PORT = 5099; // Use a non-standard port to avoid conflicts
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;
const REQUEST_TIMEOUT = 5000; // 5s per request

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration?: number;
}

const results: TestResult[] = [];
let httpServer: Server | null = null;

// ============================================================
// UTILITIES
// ============================================================

function log(message: string) {
  console.log(`[smoke] ${message}`);
}

function logResult(result: TestResult) {
  const icon = result.passed ? '✅' : '❌';
  const timing = result.duration ? ` (${result.duration}ms)` : '';
  console.log(`${icon} ${result.name}${timing}`);
  if (!result.passed && result.error) {
    console.log(`   └─ Error: ${result.error}`);
  }
}

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================
// IN-PROCESS SERVER MANAGEMENT
// ============================================================

async function startServer(): Promise<void> {
  log(`Starting in-process server on port ${PORT}...`);
  
  const app = express();
  
  // CORS configuration
  app.use(cors({
    origin: true,
    credentials: true
  }));
  
  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'healthy',
      service: 'wyshbone-supervisor',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  });
  
  // JSON parsing
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  
  // Set env for export key
  process.env.EXPORT_KEY = 'smoke-test-key';
  (global as any).GENERATED_EXPORT_KEY = 'smoke-test-key';
  
  // Register routes (but don't start supervisor or subcon scheduler)
  httpServer = await registerRoutes(app);
  
  // Error handler
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
  });
  
  // Start listening
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Server failed to start within 10s'));
    }, 10000);
    
    httpServer!.listen(PORT, HOST, () => {
      clearTimeout(timeout);
      log(`Server started on http://${HOST}:${PORT}`);
      resolve();
    });
    
    httpServer!.on('error', (err: any) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function stopServer(): Promise<void> {
  if (!httpServer) return;
  
  log('Stopping server gracefully...');
  
  await new Promise<void>((resolve) => {
    httpServer!.close(() => {
      log('Server stopped');
      resolve();
    });
    
    // Force close after 3 seconds if connections are stuck
    setTimeout(() => {
      log('Force closing remaining connections...');
      resolve();
    }, 3000);
  });
  
  httpServer = null;
}

// ============================================================
// TEST CASES
// ============================================================

async function testHealthEndpoint(): Promise<TestResult> {
  const start = Date.now();
  const name = 'GET /health returns 200';
  
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/health`);
    const data = await response.json();
    
    if (response.status !== 200) {
      return { name, passed: false, error: `Status ${response.status}`, duration: Date.now() - start };
    }
    
    if (data.status !== 'healthy') {
      return { name, passed: false, error: `Unexpected status: ${data.status}`, duration: Date.now() - start };
    }
    
    return { name, passed: true, duration: Date.now() - start };
  } catch (err: any) {
    return { name, passed: false, error: err.message, duration: Date.now() - start };
  }
}

async function testPlanProgressEndpoint(): Promise<TestResult> {
  const start = Date.now();
  const name = 'GET /api/plan/progress returns idle (no active plan)';
  
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/api/plan/progress`);
    const data = await response.json();
    
    if (response.status !== 200) {
      return { name, passed: false, error: `Status ${response.status}`, duration: Date.now() - start };
    }
    
    if (data.status !== 'idle') {
      return { name, passed: false, error: `Unexpected status: ${data.status}`, duration: Date.now() - start };
    }
    
    return { name, passed: true, duration: Date.now() - start };
  } catch (err: any) {
    return { name, passed: false, error: err.message, duration: Date.now() - start };
  }
}

async function testPlanStartEndpoint(): Promise<TestResult> {
  const start = Date.now();
  const name = 'POST /api/plan/start creates a plan (dry-run)';
  
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/api/plan/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'smoke-test-user',
        goal: {
          rawGoal: 'Find 3 dental clinics in Bristol for smoke test'
        }
      })
    });
    
    const data = await response.json();
    
    if (response.status !== 200) {
      return { name, passed: false, error: `Status ${response.status}: ${data.error || 'Unknown error'}`, duration: Date.now() - start };
    }
    
    if (!data.planId) {
      return { name, passed: false, error: 'No planId returned', duration: Date.now() - start };
    }
    
    if (data.status !== 'pending_approval') {
      return { name, passed: false, error: `Unexpected status: ${data.status}`, duration: Date.now() - start };
    }
    
    return { name, passed: true, duration: Date.now() - start };
  } catch (err: any) {
    return { name, passed: false, error: err.message, duration: Date.now() - start };
  }
}

async function testLeadsEndpoint(): Promise<TestResult> {
  const start = Date.now();
  const name = 'GET /api/leads returns array (may be empty)';
  
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/api/leads`);
    const data = await response.json();
    
    if (response.status !== 200) {
      return { name, passed: false, error: `Status ${response.status}`, duration: Date.now() - start };
    }
    
    if (!Array.isArray(data)) {
      return { name, passed: false, error: 'Response is not an array', duration: Date.now() - start };
    }
    
    return { name, passed: true, duration: Date.now() - start };
  } catch (err: any) {
    return { name, passed: false, error: err.message, duration: Date.now() - start };
  }
}

async function testSavedLeadsEndpoint(): Promise<TestResult> {
  const start = Date.now();
  const name = 'GET /api/leads/saved returns status ok';
  
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/api/leads/saved`);
    const data = await response.json();
    
    if (response.status !== 200) {
      return { name, passed: false, error: `Status ${response.status}`, duration: Date.now() - start };
    }
    
    if (data.status !== 'ok') {
      return { name, passed: false, error: `Unexpected status: ${data.status}`, duration: Date.now() - start };
    }
    
    return { name, passed: true, duration: Date.now() - start };
  } catch (err: any) {
    return { name, passed: false, error: err.message, duration: Date.now() - start };
  }
}

// ============================================================
// MAIN EXECUTION
// ============================================================

async function runTests(): Promise<number> {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Wyshbone Supervisor Smoke Test');
  console.log('═══════════════════════════════════════════════════════════\n');

  try {
    // Start the server in-process
    await startServer();
    console.log('');

    // Run all tests
    const tests = [
      testHealthEndpoint,
      testPlanProgressEndpoint,
      testPlanStartEndpoint,
      testLeadsEndpoint,
      testSavedLeadsEndpoint
    ];

    console.log('Running tests...\n');
    
    for (const test of tests) {
      const result = await test();
      results.push(result);
      logResult(result);
    }

  } catch (err: any) {
    console.error(`\n❌ FATAL: ${err.message}`);
    results.push({ name: 'Server startup', passed: false, error: err.message });
  } finally {
    // Always stop the server gracefully
    await stopServer();
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  console.log('\n═══════════════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ✅ ALL TESTS PASSED (${passed}/${total})`);
  } else {
    console.log(`  ❌ ${failed} TEST(S) FAILED (${passed}/${total} passed)`);
  }
  console.log('═══════════════════════════════════════════════════════════\n');

  // Return exit code (don't call process.exit - let natural exit occur)
  return failed > 0 ? 1 : 0;
}

// Run the tests and set exit code without calling process.exit()
runTests().then((exitCode) => {
  // Set the exit code but don't force exit - let Node exit naturally
  // This avoids the winasync.c assertion failure on Windows
  process.exitCode = exitCode;
}).catch((err) => {
  console.error('Unexpected error:', err);
  process.exitCode = 1;
});
