import { buildToolResult, buildToolError } from "@shared/tool-result-helpers";
import type { ToolResultEnvelope, EvidenceItem } from "@shared/tool-result";

const TOOL_NAME = "WEB_SEARCH";
const TOOL_VERSION = "1.0";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESULTS_CAP = 10;

export interface WebSearchInput {
  query: string;
  location_hint?: string | null;
  entity_name?: string | null;
  limit: number;
}

interface SearchResult {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  source: string;
  match_signals: string[];
}

interface WebSearchOutput {
  results: SearchResult[];
  best_guess_official_url: string | null;
  why_this_url: string | null;
}

type MatchSignal =
  | "name_match"
  | "town_match"
  | "address_fragment_match"
  | "phone_match"
  | "domain_match";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

async function fetchBraveResults(
  query: string,
  limit: number,
): Promise<{ results: RawSearchHit[]; error?: string }> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return {
      results: [],
      error: "BRAVE_SEARCH_API_KEY not configured",
    };
  }

  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(limit, 20)));
  url.searchParams.set("safesearch", "off");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        results: [],
        error: `Brave API returned ${response.status}: ${body.substring(0, 200)}`,
      };
    }

    const data = await response.json();
    const webResults = data?.web?.results ?? [];

    return {
      results: webResults.map((r: any) => ({
        title: String(r.title ?? ""),
        url: String(r.url ?? ""),
        description: String(r.description ?? ""),
      })),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { results: [], error: `Brave search failed: ${msg}` };
  }
}

interface RawSearchHit {
  title: string;
  url: string;
  description: string;
}

function computeMatchSignals(
  hit: RawSearchHit,
  entityName: string | null | undefined,
  locationHint: string | null | undefined,
): MatchSignal[] {
  const signals: MatchSignal[] = [];
  const titleLower = hit.title.toLowerCase();
  const snippetLower = hit.description.toLowerCase();
  const urlLower = hit.url.toLowerCase();
  const combined = `${titleLower} ${snippetLower} ${urlLower}`;

  if (entityName) {
    const nameLower = entityName.toLowerCase();
    const nameWords = nameLower.split(/\s+/).filter((w) => w.length > 2);
    const nameInTitle = nameWords.every((w) => titleLower.includes(w));
    const nameInUrl = nameWords.some((w) => urlLower.includes(w));
    if (nameInTitle || nameInUrl) {
      signals.push("name_match");
    }

    const domainWords = nameLower
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2);
    try {
      const hostname = new URL(hit.url).hostname.toLowerCase();
      if (domainWords.some((w) => hostname.includes(w))) {
        signals.push("domain_match");
      }
    } catch {}
  }

  if (locationHint) {
    const locLower = locationHint.toLowerCase();
    const locWords = locLower.split(/[,\s]+/).filter((w) => w.length > 2);
    if (locWords.some((w) => combined.includes(w))) {
      signals.push("town_match");
    }
  }

  const addressFragments = combined.match(
    /\d+\s+[a-z]+(?:\s+[a-z]+)?\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|way|place|pl|close|crescent|terrace|boulevard|blvd)/gi,
  );
  if (addressFragments && addressFragments.length > 0) {
    signals.push("address_fragment_match");
  }

  const phonePattern = /(?:\+?\d{1,4}[\s\-.]?)?\(?\d{2,5}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}/;
  if (phonePattern.test(hit.description)) {
    signals.push("phone_match");
  }

  return Array.from(new Set(signals));
}

function disambiguateOfficialUrl(
  results: SearchResult[],
  entityName: string | null | undefined,
): { best_guess_official_url: string | null; why_this_url: string | null } {
  if (!entityName || results.length === 0) {
    return {
      best_guess_official_url: null,
      why_this_url: entityName
        ? "No results to disambiguate"
        : "No entity_name provided for disambiguation",
    };
  }

  let bestUrl: string | null = null;
  let bestSignalCount = 0;
  let bestSignals: string[] = [];

  for (const r of results) {
    if (r.match_signals.length >= 2 && r.match_signals.length > bestSignalCount) {
      bestUrl = r.url;
      bestSignalCount = r.match_signals.length;
      bestSignals = [...r.match_signals];
    }
  }

  if (bestUrl) {
    return {
      best_guess_official_url: bestUrl,
      why_this_url: `Matched ${bestSignalCount} signals: ${bestSignals.join(", ")}`,
    };
  }

  const topSignals = results
    .filter((r) => r.match_signals.length > 0)
    .map((r) => `${r.url} (${r.match_signals.join(", ")})`)
    .slice(0, 3);

  return {
    best_guess_official_url: null,
    why_this_url:
      topSignals.length > 0
        ? `No result had 2+ match signals. Best candidates: ${topSignals.join("; ")}`
        : "No match signals found in any result",
  };
}

export async function executeWebSearch(
  input: WebSearchInput,
  runId: string,
  goalId?: string,
): Promise<ToolResultEnvelope> {
  const query = input.query?.trim();
  if (!query) {
    return buildToolResult({
      tool_name: TOOL_NAME,
      tool_version: TOOL_VERSION,
      run_id: runId,
      goal_id: goalId,
      inputs: { query: "", limit: input.limit },
      outputs: { results: [], best_guess_official_url: null, why_this_url: "Empty query" },
      errors: [buildToolError("EMPTY_QUERY", "Query string is required", false)],
    });
  }

  const limit = Math.max(1, Math.min(input.limit || 5, MAX_RESULTS_CAP));

  const fullQuery = input.location_hint
    ? `${query} ${input.location_hint}`
    : query;

  const { results: rawHits, error } = await fetchBraveResults(fullQuery, limit);

  if (error && rawHits.length === 0) {
    return buildToolResult({
      tool_name: TOOL_NAME,
      tool_version: TOOL_VERSION,
      run_id: runId,
      goal_id: goalId,
      inputs: {
        query,
        location_hint: input.location_hint ?? null,
        entity_name: input.entity_name ?? null,
        limit,
      },
      outputs: { results: [], best_guess_official_url: null, why_this_url: null },
      errors: [buildToolError("SEARCH_FAILED", error, true)],
    });
  }

  const evidence: EvidenceItem[] = [];

  const results: SearchResult[] = rawHits.slice(0, limit).map((hit, idx) => {
    const signals = computeMatchSignals(hit, input.entity_name, input.location_hint);
    const result: SearchResult = {
      rank: idx + 1,
      title: hit.title,
      url: hit.url,
      snippet: hit.description,
      source: "brave_search",
      match_signals: signals,
    };

    evidence.push({
      source_type: "search_result",
      source_url: hit.url,
      captured_at: new Date().toISOString(),
      quote: `[Rank ${idx + 1}] ${hit.title} — ${hit.description.substring(0, 150)}`,
      field_supported: "results",
    });

    for (const signal of signals) {
      evidence.push({
        source_type: "search_result",
        source_url: hit.url,
        captured_at: new Date().toISOString(),
        quote: `Signal "${signal}" detected for result "${hit.title}"`,
        field_supported: `results[${idx}].match_signals`,
      });
    }

    return result;
  });

  const disambiguation = disambiguateOfficialUrl(results, input.entity_name);

  if (disambiguation.best_guess_official_url) {
    evidence.push({
      source_type: "search_result",
      source_url: disambiguation.best_guess_official_url,
      captured_at: new Date().toISOString(),
      quote: `Best guess official URL: ${disambiguation.why_this_url}`,
      field_supported: "best_guess_official_url",
    });
  }

  const outputs: WebSearchOutput = {
    results,
    best_guess_official_url: disambiguation.best_guess_official_url,
    why_this_url: disambiguation.why_this_url,
  };

  const confidence = results.length > 0
    ? Math.min(1, 0.3 + results.length * 0.05 + (disambiguation.best_guess_official_url ? 0.3 : 0))
    : 0;

  const envelope = buildToolResult({
    tool_name: TOOL_NAME,
    tool_version: TOOL_VERSION,
    run_id: runId,
    goal_id: goalId,
    inputs: {
      query,
      location_hint: input.location_hint ?? null,
      entity_name: input.entity_name ?? null,
      limit,
    },
    outputs: outputs as unknown as Record<string, unknown>,
    evidence,
    confidence,
    errors: error ? [buildToolError("PARTIAL_ERROR", error, true)] : undefined,
  });

  return envelope;
}
