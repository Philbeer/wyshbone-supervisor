import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { createServer as createViteServer, createLogger } from "vite";
import { type Server } from "http";
import viteConfig from "../vite.config";
import { nanoid } from "nanoid";

const viteLogger = createLogger();

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        // Only exit for truly fatal Vite errors (e.g. can't start server),
        // not for TypeScript/transform errors which should be non-fatal.
        if (msg.includes("The server is unable to start") || msg.includes("EADDRINUSE")) {
          process.exit(1);
        }
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  // Replit's proxy closes idle WebSockets after ~17 s.
  // Send a custom keepalive frame every 10 s so the connection stays open.
  const hmrKeepalive = setInterval(() => {
    try {
      vite.ws.send({ type: "custom", event: "keepalive", data: {} });
    } catch (_) {
      // No clients connected — harmless
    }
  }, 10_000);
  server.on("close", () => clearInterval(hmrKeepalive));

  app.use(vite.middlewares);
  app.get("*", async (req, res, next) => {
    const url = req.originalUrl;

    if (url.startsWith("/api") || url.startsWith("/dev")) {
      return next();
    }

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({
        "Content-Type": "text/html",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
      }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(import.meta.dirname, "public");

  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/dev")) {
      return next();
    }
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
