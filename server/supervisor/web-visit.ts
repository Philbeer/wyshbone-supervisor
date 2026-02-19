import * as cheerio from "cheerio";
import { buildToolResult, buildToolError } from "@shared/tool-result-helpers";
import type { ToolResultEnvelope, EvidenceItem } from "@shared/tool-result";

const TOOL_NAME = "WEB_VISIT";
const TOOL_VERSION = "1.0";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const PAGE_HINT_PATHS: Record<string, string[]> = {
  home: ["/"],
  contact: ["/contact", "/contact-us", "/get-in-touch"],
  about: ["/about", "/about-us", "/our-story"],
  events: ["/events", "/whats-on", "/calendar"],
  menu: ["/menu", "/food-menu", "/drinks", "/food-and-drink"],
};

const VALID_HINTS = Object.keys(PAGE_HINT_PATHS);

type PageType = "home" | "contact" | "about" | "events" | "menu" | "other";

export interface WebVisitInput {
  url: string;
  max_pages: number;
  page_hints?: string[];
  same_domain_only?: boolean;
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

async function fetchPage(url: string): Promise<{ ok: boolean; html?: string; status?: number; error?: string; redirectedUrl?: string; blocked?: boolean; retryable?: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; WyshboneCrawler/1.0; +https://wyshbone.com/bot)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    clearTimeout(timer);

    if (res.status === 403 || res.status === 401) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}`, blocked: true, retryable: false };
    }
    if (res.status === 429) {
      return { ok: false, status: res.status, error: "Rate limited (429)", blocked: true, retryable: true };
    }
    if (res.status >= 500) {
      return { ok: false, status: res.status, error: `Server error (${res.status})`, blocked: false, retryable: true };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}`, blocked: false, retryable: false };
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return { ok: false, error: `Non-HTML content type: ${contentType}`, blocked: false, retryable: false };
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) {
      return { ok: false, error: `Response too large (${buf.byteLength} bytes)`, blocked: false, retryable: false };
    }

    const html = new TextDecoder("utf-8").decode(buf);
    const redirectedUrl = res.url !== url ? res.url : undefined;

    return { ok: true, html, status: res.status, redirectedUrl };
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    const isAbort = msg.includes("abort");
    return {
      ok: false,
      error: isAbort ? `Timeout after ${FETCH_TIMEOUT_MS}ms` : msg,
      blocked: false,
      retryable: isAbort,
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
      errors.push(
        buildToolError(
          result.blocked ? "BLOCKED" : "FETCH_FAILED",
          `${targetUrl}: ${result.error}`,
          result.retryable ?? false,
          { url: targetUrl, status: result.status },
        ),
      );
      return;
    }

    const actualUrl = result.redirectedUrl || targetUrl;
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

    evidence.push({
      source_type: "website",
      source_url: actualUrl,
      captured_at: new Date().toISOString(),
      quote: cleaned.title
        ? `Page title: "${cleaned.title}"`
        : `Crawled page at ${actualUrl}`,
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
