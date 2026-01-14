// CRITICAL: Load environment variables FIRST (from repo root .env.local)
import './env.js';

import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { supervisor } from "./supervisor";
import { startSubconScheduler } from "./subcon";
import { startDailyAgentCron } from "./cron/daily-agent";
import crypto from "crypto";

const app = express();

// CORS configuration for cross-origin requests
const isDevelopment = process.env.NODE_ENV !== 'production';
const allowedOrigins = [
  // Development origins only - both localhost and 127.0.0.1
  ...(isDevelopment ? [
    'http://localhost:3000',    // Tower
    'http://127.0.0.1:3000',
    'http://localhost:3001',    // Additional service
    'http://127.0.0.1:3001',
    'http://localhost:5173',    // UI (Vite)
    'http://127.0.0.1:5173',
    'http://localhost:5000',    // Backend API (from main)
    'http://127.0.0.1:5000',    // Backend API (from main)
    'http://localhost:5001',    // Backend API alt
    'http://127.0.0.1:5001',
  ] : []),
  // Production origins
  process.env.FRONTEND_URL,
  process.env.UI_URL,
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman) in development only
    if (!origin) {
      if (isDevelopment) {
        console.log('[CORS][DEV] Allowing request with no origin (curl/Postman)');
      }
      return callback(null, isDevelopment);
    }

    // Check if origin is allowed
    const isAllowed = allowedOrigins.includes(origin) ||
                      origin.endsWith('.vercel.app') ||
                      origin.endsWith('.onrender.com') ||
                      origin.endsWith('.replit.dev') ||
                      origin.endsWith('.replit.app');

    if (isAllowed) {
      if (isDevelopment) {
        console.log(`[CORS][DEV] Allowing origin: ${origin}`);
      }
      return callback(null, true);
    }

    // Log rejected origins in development
    if (isDevelopment) {
      console.warn(`[CORS][DEV] REJECTED origin: ${origin}`);
      console.warn(`[CORS][DEV] Allowed origins:`, allowedOrigins);
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-EXPORT-KEY']
}));

// Health check endpoint for load balancers
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'wyshbone-supervisor',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

declare module 'http' {
  interface IncomingMessage {
    rawBody: unknown
  }
}
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Generate or use EXPORT_KEY for export API
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (!process.env.EXPORT_KEY) {
    if (isProduction) {
      console.error('⚠️  EXPORT_KEY must be set in production environment');
      console.error('⚠️  Export API will be disabled');
      (global as any).GENERATED_EXPORT_KEY = null;
    } else {
      const generatedKey = crypto.randomBytes(16).toString('hex');
      (global as any).GENERATED_EXPORT_KEY = generatedKey;
      console.log('\n' + '='.repeat(60));
      console.log('🔑 EXPORT_KEY for this app:', generatedKey);
      console.log('   (Development only - set EXPORT_KEY env var for production)');
      console.log('='.repeat(60) + '\n');
    }
  } else {
    if (!isProduction) {
      console.log('✅ Using EXPORT_KEY from environment');
    }
  }

  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  // Use 127.0.0.1 for Windows dev (0.0.0.0 causes ENOTSUP), 0.0.0.0 for production
  const host = process.env.HOST || (isDevelopment ? '127.0.0.1' : '0.0.0.0');
  server.listen({
    port,
    host,
  }, () => {
    log(`serving on http://${host}:${port}`);
    
    // Start the supervisor service
    supervisor.start().catch(error => {
      console.error('Failed to start supervisor:', error);
    });
    
    // Start the subconscious scheduler (SUP-11)
    // Disable with SUBCON_SCHEDULER_ENABLED=false
    startSubconScheduler();

    // Start the daily agent cron job (Phase 2 Task 5)
    // Runs at 9am daily - disable with DAILY_AGENT_ENABLED=false
    startDailyAgentCron();
  });
})();
