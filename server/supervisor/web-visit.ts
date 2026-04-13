import * as cheerio from "cheerio";
import { buildToolResult, buildToolError } from "@shared/tool-result-helpers";
import type { ToolResultEnvelope, EvidenceItem } from "@shared/tool-result";
import { callLLMText } from "./llm-failover";

const TOOL_NAME = "WEB_VISIT";
const TOOL_VERSION = "1.0";

const FETCH_TIMEOUT_MS = 15_000;
const PLAYWRIGHT_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const REALISTIC_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

const BOT_BLOCK_STATUSES = new Set([403, 429, 503]);

const CHALLENGE_SIGNALS = [
  "just a moment",
  "checking your browser",
  "verify you are human",
  "please wait while we verify",
  "access denied",
  "attention required",
  "enable javascript and cookies",
  "cloudflare",
  "ddos protection",
  "ray id",
  "cf-browser-verification",
  "challenge-platform",
  "managed-challenge",
  "hcaptcha",
  "recaptcha",
  "turnstile",
];

const PAGE_HINT_PATHS: Record<string, string[]> = {
  home: ["/"],
  contact: ["/contact", "/contact-us", "/get-in-touch"],
  about: ["/about", "/about-us", "/our-story"],
  events: ["/events", "/whats-on", "/calendar"],
  menu: ["/menu", "/food-menu", "/drinks", "/food-and-drink"],
};

const VALID_HINTS = Object.keys(PAGE_HINT_PATHS);

const _pageHintCache = new Map<string, string[]>();

async function getLLMPageHints(constraintValue: string, entityType: string): Promise<string[]> {
  const cacheKey = `${entityType}::${constraintValue}`.toLowerCase();
  if (_pageHintCache.has(cacheKey)) {
    return _pageHintCache.get(cacheKey)!;
  }
  try {
    const raw = await callLLMText(
      `A user is looking for businesses with a specific attribute. Suggest 5-8 URL path slugs where this information would most likely appear on a business's website. Return ONLY a JSON array of strings starting with "/". No explanation.

Example for "cask ale" on a "pub" website:
["/beers", "/ales", "/our-beers", "/real-ale", "/drinks", "/cellar", "/tap-list", "/whats-on-tap"]`,
      `Attribute: "${constraintValue}"\nBusiness type: "${entityType}"`,
      'page_hints',
      { maxTokens: 200, timeoutMs: 5000 },
    );
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.every(s => typeof s === 'string')) {
      _pageHintCache.set(cacheKey, parsed);
      console.log(`[WEB_VISIT] LLM page hints for "${constraintValue}" on "${entityType}": ${parsed.join(', ')}`);
      return parsed;
    }
  } catch (err: any) {
    console.warn(`[WEB_VISIT] LLM page hints failed for "${constraintValue}": ${err?.message || err}`);
  }
  return [];
}

type PageType = "home" | "contact" | "about" | "events" | "menu" | "other";

export interface WebVisitInput {
  url: string;
  max_pages: number;
  page_hints?: string[];
  same_domain_only?: boolean;
  constraint_value?: string;
  entity_type?: string;
}

interface CrawledPage {
  url: string;
  page_type: PageType;
  title: string;
  text_clean: string;
  extracted_links: string[];
}

interface CrawlStats {
  attempted_pages: number;
  fetched_pages: number;
  blocked: boolean;
  retryable: boolean;
  http_failures_count: number;
}

interface WebVisitOutput {
  pages: CrawledPage[];
  site_summary: string;
  site_language: string;
  crawl: CrawlStats;
}

interface FetchStageDetails {
  status?: number;
  reason: string;
  exception?: string;
  content_type?: string;
}

interface PlaywrightStageDetails {
  attempted: boolean;
  reason: string;
  exception?: string;
  challenge_detected?: boolean;
  challenge_signals?: string[];
}

interface FetchResult {
  ok: boolean;
  html?: string;
  status?: number;
  error?: string;
  redirectedUrl?: string;
  blocked?: boolean;
  retryable?: boolean;
  method?: "fetch" | "playwright";
  errorCode?: string;
  stageDetails?: {
    fetch_stage: FetchStageDetails;
    playwright_stage?: PlaywrightStageDetails;
  };
}

function normalizeUrl(raw: string): string {
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const parsed = new URL(u);
    return parsed.href;
  } catch {
    return u;
  }
}

function getDomain(urlStr: string): string {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return "";
  }
}

function isSameDomain(base: string, candidate: string): boolean {
  const d1 = getDomain(base).replace(/^www\./, "");
  const d2 = getDomain(candidate).replace(/^www\./, "");
  return d1 === d2;
}

function resolveUrl(base: string, relative: string): string | null {
  try {
    return new URL(relative, base).href;
  } catch {
    return null;
  }
}

function classifyPage(urlStr: string, hintType?: string): PageType {
  if (hintType && VALID_HINTS.includes(hintType)) return hintType as PageType;
  try {
    const path = new URL(urlStr).pathname.toLowerCase();
    if (path === "/" || path === "") return "home";
    for (const [type, paths] of Object.entries(PAGE_HINT_PATHS)) {
      if (paths.some((p) => path.startsWith(p))) return type as PageType;
    }
  } catch {
    return "other";
  }
  return "other";
}

const STRIP_SELECTORS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "nav",
  "footer",
  "header[role='banner']",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  ".cookie-banner",
  ".cookie-consent",
  ".cookie-notice",
  "#cookie-banner",
  "#cookie-consent",
  "#cookie-notice",
  ".gdpr",
  "#gdpr",
  ".cc-banner",
  ".cc-window",
  ".popup-overlay",
  ".modal-overlay",
  ".newsletter-popup",
  ".skip-link",
  "[aria-hidden='true']",
];

function cleanHtml(html: string, pageUrl: string): { text: string; title: string; links: string[]; lang: string } {
  const $ = cheerio.load(html);

  const lang = ($("html").attr("lang") || "").split("-")[0].toLowerCase() || "en";
  const title = $("title").first().text().trim() || $("h1").first().text().trim() || "";

  for (const sel of STRIP_SELECTORS) {
    $(sel).remove();
  }

  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    if (href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:") || href.startsWith("#")) return;
    const resolved = resolveUrl(pageUrl, href);
    if (resolved && !links.includes(resolved)) links.push(resolved);
  });

  const body = $("body");
  const rawText = body.text();
  const text = rawText
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");

  return { text, title, links, lang };
}

function isNonHtmlContentType(ct: string): boolean {
  return !ct.includes("text/html") && !ct.includes("application/xhtml");
}

function detectChallengeSignals(html: string): string[] {
  const lower = html.toLowerCase();
  return CHALLENGE_SIGNALS.filter((sig) => lower.includes(sig));
}

function isChallengePage(html: string): { detected: boolean; signals: string[] } {
  const signals = detectChallengeSignals(html);
  if (signals.length >= 2) return { detected: true, signals };
  if (html.length < 5_000 && signals.length >= 1) return { detected: true, signals };
  return { detected: false, signals };
}

function exceptionMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function fetchPage(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let needsPlaywrightFallback = false;
  let fetchStage: FetchStageDetails = { reason: "pending" };
  let fetchStatus: number | undefined;

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: REALISTIC_HEADERS,
      redirect: "follow",
    });

    clearTimeout(timer);

    const contentType = res.headers.get("content-type") || "";
    fetchStatus = res.status;

    if (BOT_BLOCK_STATUSES.has(res.status)) {
      needsPlaywrightFallback = true;
      fetchStage = {
        status: res.status,
        reason: `bot_block_status_${res.status}`,
      };
    } else if (!res.ok) {
      fetchStage = { status: res.status, reason: `http_error_${res.status}` };
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}`,
        blocked: false,
        retryable: res.status >= 500,
        stageDetails: { fetch_stage: fetchStage },
      };
    } else if (isNonHtmlContentType(contentType)) {
      needsPlaywrightFallback = true;
      fetchStage = {
        status: res.status,
        reason: "non_html_content_type",
        content_type: contentType,
      };
    } else {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BODY_BYTES) {
        fetchStage = { status: res.status, reason: "response_too_large" };
        return {
          ok: false,
          error: `Response too large (${buf.byteLength} bytes)`,
          blocked: false,
          retryable: false,
          stageDetails: { fetch_stage: fetchStage },
        };
      }

      const html = new TextDecoder("utf-8").decode(buf);

      const challenge = isChallengePage(html);
      if (challenge.detected) {
        needsPlaywrightFallback = true;
        fetchStage = {
          status: res.status,
          reason: "challenge_page_detected",
        };
      } else {
        const redirectedUrl = res.url !== url ? res.url : undefined;
        return { ok: true, html, status: res.status, redirectedUrl, method: "fetch" };
      }
    }
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = exceptionMessage(err);
    const isTimeout = msg.includes("abort");
    needsPlaywrightFallback = true;
    fetchStage = {
      reason: isTimeout ? "timeout" : "network_error",
      exception: isTimeout ? `Timeout after ${FETCH_TIMEOUT_MS}ms` : msg,
    };
  }

  if (!needsPlaywrightFallback) {
    return {
      ok: false,
      error: fetchStage.reason,
      blocked: false,
      retryable: true,
      status: fetchStatus,
      stageDetails: { fetch_stage: fetchStage },
    };
  }

  const isBotBlock = BOT_BLOCK_STATUSES.has(fetchStatus ?? 0) || fetchStage.reason === "challenge_page_detected";

  console.log(`[WEB_VISIT] Fetch failed for ${url} (${fetchStage.reason}), attempting Playwright fallback…`);

  let pw: any = null;
  try {
    pw = await import("playwright");
  } catch (importErr: unknown) {
    const importMsg = exceptionMessage(importErr);
    const missingDep = importMsg.includes("Cannot find module")
      ? "playwright package not installed"
      : importMsg.includes("browserType.launch")
        ? "Chromium browser binary not found — run `npx playwright install chromium`"
        : importMsg;

    const pwStage: PlaywrightStageDetails = {
      attempted: false,
      reason: "import_failed",
      exception: missingDep,
    };

    return {
      ok: false,
      status: fetchStatus,
      error: `Fetch: ${fetchStage.exception ?? fetchStage.reason}; Playwright unavailable: ${missingDep}`,
      errorCode: "PLAYWRIGHT_UNAVAILABLE",
      blocked: isBotBlock,
      retryable: true,
      stageDetails: { fetch_stage: fetchStage, playwright_stage: pwStage },
    };
  }

  const pwResult = await runPlaywright(pw, url, fetchStage, fetchStatus, isBotBlock);
  return pwResult;
}

async function runPlaywright(
  pw: any,
  url: string,
  fetchStage: FetchStageDetails,
  fetchStatus: number | undefined,
  fetchWasBotBlock: boolean,
): Promise<FetchResult> {
  let browser: any = null;
  try {
    browser = await pw.chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });

    const context = await browser.newContext({
      userAgent: REALISTIC_HEADERS["User-Agent"],
      locale: "en-US",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PLAYWRIGHT_TIMEOUT_MS,
    });

    await page.waitForTimeout(2000);

    const html: string = await page.content();
    const finalUrl: string = page.url();

    await context.close();
    await browser.close();
    browser = null;

    if (!html || html.length < 100) {
      const pwStage: PlaywrightStageDetails = {
        attempted: true,
        reason: "empty_or_minimal_content",
      };
      return {
        ok: false,
        status: fetchStatus,
        error: `Fetch: ${fetchStage.exception ?? fetchStage.reason}; Playwright: empty or minimal content`,
        blocked: fetchWasBotBlock,
        retryable: true,
        stageDetails: { fetch_stage: fetchStage, playwright_stage: pwStage },
      };
    }

    const challenge = isChallengePage(html);
    if (challenge.detected) {
      const pwStage: PlaywrightStageDetails = {
        attempted: true,
        reason: "challenge_page_persisted",
        challenge_detected: true,
        challenge_signals: challenge.signals,
      };
      return {
        ok: false,
        status: fetchStatus,
        error: `Fetch: ${fetchStage.exception ?? fetchStage.reason}; Playwright: challenge page persisted (${challenge.signals.join(", ")})`,
        blocked: true,
        retryable: true,
        stageDetails: { fetch_stage: fetchStage, playwright_stage: pwStage },
      };
    }

    return {
      ok: true,
      html,
      status: 200,
      redirectedUrl: finalUrl !== url ? finalUrl : undefined,
      method: "playwright",
    };
  } catch (err: unknown) {
    if (browser) {
      try { await browser.close(); } catch { /* ignore cleanup */ }
    }
    const msg = exceptionMessage(err);

    const isBrowserMissing = msg.includes("Executable doesn't exist") || msg.includes("browserType.launch");

    const pwStage: PlaywrightStageDetails = {
      attempted: true,
      reason: isBrowserMissing ? "chromium_not_installed" : "runtime_error",
      exception: msg,
    };

    if (isBrowserMissing) {
      return {
        ok: false,
        status: fetchStatus,
        error: `Fetch: ${fetchStage.exception ?? fetchStage.reason}; Playwright: Chromium not installed — run \`npx playwright install chromium\``,
        errorCode: "PLAYWRIGHT_UNAVAILABLE",
        blocked: fetchWasBotBlock,
        retryable: true,
        stageDetails: { fetch_stage: fetchStage, playwright_stage: pwStage },
      };
    }

    return {
      ok: false,
      status: fetchStatus,
      error: `Fetch: ${fetchStage.exception ?? fetchStage.reason}; Playwright: ${msg}`,
      blocked: fetchWasBotBlock,
      retryable: true,
      stageDetails: { fetch_stage: fetchStage, playwright_stage: pwStage },
    };
  }
}

export async function executeWebVisit(
  input: WebVisitInput,
  runId: string,
  goalId?: string,
): Promise<ToolResultEnvelope> {
  const baseUrl = normalizeUrl(input.url);
  const maxPages = Math.max(1, Math.min(input.max_pages, 10));
  const sameDomainOnly = input.same_domain_only !== false;
  const hints = (input.page_hints || []).filter((h) => VALID_HINTS.includes(h));
  const baseDomain = getDomain(baseUrl);

  const visited = new Set<string>();
  const pages: CrawledPage[] = [];
  const evidence: EvidenceItem[] = [];
  const errors: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> }[] = [];
  let attemptedPages = 0;
  let httpFailures = 0;
  let wasBlocked = false;
  let isRetryable = false;
  let siteLang = "en";

  const urlQueue: { url: string; hintType?: string }[] = [];

  for (const hint of hints) {
    const hintPaths = PAGE_HINT_PATHS[hint] || [];
    for (const path of hintPaths) {
      const resolved = resolveUrl(baseUrl, path);
      if (resolved) urlQueue.push({ url: resolved, hintType: hint });
    }
  }

  if (input.constraint_value && input.entity_type) {
    const llmPaths = await getLLMPageHints(input.constraint_value, input.entity_type);
    const existingUrls = new Set(urlQueue.map(q => q.url));
    for (const path of llmPaths) {
      const resolved = resolveUrl(baseUrl, path);
      if (resolved && !existingUrls.has(resolved)) {
        urlQueue.push({ url: resolved, hintType: "other" });
        existingUrls.add(resolved);
      }
    }
  }

  const hasHomeHint = hints.includes("home");
  if (!hasHomeHint) {
    urlQueue.unshift({ url: baseUrl, hintType: "home" });
  }

  const discoveredLinks: string[] = [];

  async function crawlOne(targetUrl: string, hintType?: string): Promise<void> {
    const normalized = targetUrl.split("#")[0].split("?")[0];
    if (visited.has(normalized)) return;
    if (pages.length >= maxPages) return;

    visited.add(normalized);
    attemptedPages++;

    console.log(`[WEB_VISIT] Fetching ${normalized} (page ${pages.length + 1}/${maxPages})`);

    const result = await fetchPage(targetUrl);

    if (!result.ok) {
      httpFailures++;
      if (result.blocked) wasBlocked = true;
      if (result.retryable) isRetryable = true;

      const errorCode = result.errorCode ?? (result.blocked ? "BLOCKED" : "FETCH_FAILED");
      const errorDetails: Record<string, unknown> = { url: targetUrl, status: result.status };
      if (result.stageDetails) {
        errorDetails.fetch_stage = result.stageDetails.fetch_stage;
        if (result.stageDetails.playwright_stage) {
          errorDetails.playwright_stage = result.stageDetails.playwright_stage;
        }
      }

      errors.push(
        buildToolError(
          errorCode,
          `${targetUrl}: ${result.error}`,
          result.retryable ?? false,
          errorDetails,
        ),
      );
      return;
    }

    const actualUrl = result.redirectedUrl || targetUrl;
    const fetchMethod = result.method || "fetch";
    const crossDomain = !isSameDomain(baseUrl, actualUrl);

    if (crossDomain && sameDomainOnly) {
      const cleaned = cleanHtml(result.html!, actualUrl);
      if (pages.length === 0) siteLang = cleaned.lang;
      const pageType = classifyPage(actualUrl, hintType);
      pages.push({
        url: actualUrl + " [CROSS-DOMAIN]",
        page_type: pageType,
        title: cleaned.title,
        text_clean: cleaned.text.substring(0, 50_000),
        extracted_links: [],
      });
      evidence.push({
        source_type: "website",
        source_url: actualUrl,
        captured_at: new Date().toISOString(),
        quote: `Cross-domain redirect from ${targetUrl} to ${actualUrl}`,
        field_supported: `pages[${pages.length - 1}]`,
      });
      return;
    }

    const cleaned = cleanHtml(result.html!, actualUrl);
    if (pages.length === 0) siteLang = cleaned.lang;

    const pageType = classifyPage(actualUrl, hintType);
    const pageEntry: CrawledPage = {
      url: actualUrl + (crossDomain ? " [CROSS-DOMAIN]" : ""),
      page_type: pageType,
      title: cleaned.title,
      text_clean: cleaned.text.substring(0, 50_000),
      extracted_links: cleaned.links.slice(0, 100),
    };

    pages.push(pageEntry);

    const quoteSnippet = cleaned.title
      ? `Page title: "${cleaned.title}"`
      : cleaned.text.substring(0, 120).trim() || `Crawled page at ${actualUrl}`;

    evidence.push({
      source_type: "website",
      source_url: actualUrl,
      captured_at: new Date().toISOString(),
      quote: fetchMethod === "playwright"
        ? `[via Playwright] ${quoteSnippet}`
        : quoteSnippet,
      field_supported: `pages[${pages.length - 1}]`,
    });

    for (const link of cleaned.links) {
      if (!visited.has(link.split("#")[0].split("?")[0])) {
        if (!sameDomainOnly || isSameDomain(baseUrl, link)) {
          discoveredLinks.push(link);
        }
      }
    }
  }

  for (const item of urlQueue) {
    if (pages.length >= maxPages) break;
    await crawlOne(item.url, item.hintType);
  }

  for (const link of discoveredLinks) {
    if (pages.length >= maxPages) break;
    await crawlOne(link);
  }

  const siteSummary = pages.length > 0
    ? `Crawled ${pages.length} page(s) from ${baseDomain}. Page types: ${Array.from(new Set(pages.map((p) => p.page_type))).join(", ")}.`
    : `Failed to crawl any pages from ${baseDomain}.`;

  const outputs: WebVisitOutput = {
    pages,
    site_summary: siteSummary,
    site_language: siteLang,
    crawl: {
      attempted_pages: attemptedPages,
      fetched_pages: pages.length,
      blocked: wasBlocked,
      retryable: isRetryable,
      http_failures_count: httpFailures,
    },
  };

  return buildToolResult({
    tool_name: TOOL_NAME,
    tool_version: TOOL_VERSION,
    run_id: runId,
    goal_id: goalId,
    inputs: {
      url: input.url,
      max_pages: input.max_pages,
      page_hints: input.page_hints,
      same_domain_only: sameDomainOnly,
    },
    outputs: outputs as unknown as Record<string, unknown>,
    evidence,
    confidence: pages.length > 0 ? Math.min(1, pages.length / maxPages) : 0,
    errors: errors.length > 0 ? errors : undefined,
  });
}
