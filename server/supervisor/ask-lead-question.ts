import { buildToolResult, buildToolError } from "@shared/tool-result-helpers";
import type { ToolResultEnvelope, EvidenceItem } from "@shared/tool-result";
import { executeWebVisit } from "./web-visit";
import type { WebVisitInput } from "./web-visit";

const TOOL_NAME = "ASK_LEAD_QUESTION";
const TOOL_VERSION = "1.0";

export interface AskLeadQuestionInput {
  lead: {
    business_name: string;
    town?: string;
    address?: string;
    website?: string;
    phone?: string;
  };
  intent_question: string;
  evidence_query: string;
  search_budget: number;
  visit_budget: number;
}

interface KeyFact {
  fact: string;
  verified: boolean;
  evidence_url: string;
}

interface AnswerOutput {
  text: string;
  verdict: "answered" | "unknown" | "needs_manual_check";
  confidence?: number;
  key_facts: KeyFact[];
}

interface BudgetUsed {
  searches_used: number;
  visits_used: number;
}

interface AskLeadQuestionOutput {
  answer: AnswerOutput;
  budget_used: BudgetUsed;
}

interface CollectedPage {
  url: string;
  text_clean: string;
  source: "direct_visit" | "search_visit";
}

function extractRelevantFacts(
  pages: CollectedPage[],
  intentQuestion: string,
  evidenceQuery: string,
): KeyFact[] {
  const facts: KeyFact[] = [];
  const seenFacts = new Set<string>();

  const queryWords = evidenceQuery
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const questionWords = intentQuestion
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const allKeywords = Array.from(new Set([...queryWords, ...questionWords]));

  for (const page of pages) {
    const lines = page.text_clean.split("\n").filter((l) => l.trim().length > 10);

    for (const line of lines) {
      const lineLower = line.toLowerCase();
      const matchCount = allKeywords.filter((kw) => lineLower.includes(kw)).length;

      if (matchCount < 2) continue;

      const factText = line.trim().substring(0, 300);
      const factKey = factText.toLowerCase().substring(0, 80);
      if (seenFacts.has(factKey)) continue;
      seenFacts.add(factKey);

      facts.push({
        fact: factText,
        verified: true,
        evidence_url: page.url,
      });

      if (facts.length >= 10) break;
    }

    if (facts.length >= 10) break;
  }

  return facts;
}

function normaliseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function determineVerdict(
  facts: KeyFact[],
  pages: CollectedPage[],
  leadWebsite?: string,
): { verdict: "answered" | "unknown" | "needs_manual_check"; confidence: number } {
  if (facts.length === 0 && pages.length === 0) {
    return { verdict: "unknown", confidence: 0 };
  }

  if (facts.length === 0 && pages.length > 0) {
    return { verdict: "needs_manual_check", confidence: 0.2 };
  }

  const DEFAULT_CAP = 0.85;
  const ELEVATED_CAP = 0.95;

  const base = facts.length === 1 ? 0.5 : 0.5 + facts.length * 0.1;

  const officialDomain = leadWebsite ? normaliseUrl(leadWebsite) : null;

  let hasIndependentCorroboration = false;
  if (officialDomain !== null && facts.length >= 2) {
    const hasOfficialFact = facts.some(
      (f) => normaliseUrl(f.evidence_url) === officialDomain,
    );
    const hasNonOfficialFact = facts.some(
      (f) => normaliseUrl(f.evidence_url) !== officialDomain,
    );
    hasIndependentCorroboration = hasOfficialFact && hasNonOfficialFact;
  }

  const cap = hasIndependentCorroboration ? ELEVATED_CAP : DEFAULT_CAP;
  const confidence = Math.min(cap, base);

  return { verdict: "answered", confidence };
}

function buildAnswerText(
  facts: KeyFact[],
  intentQuestion: string,
  leadName: string,
): string {
  if (facts.length === 0) {
    return `No evidence found to answer "${intentQuestion}" for ${leadName}.`;
  }

  const factSummaries = facts
    .slice(0, 5)
    .map((f, i) => `${i + 1}. ${f.fact}`)
    .join("\n");

  return `Evidence for "${intentQuestion}" (${leadName}):\n${factSummaries}`;
}

export async function executeAskLeadQuestion(
  input: AskLeadQuestionInput,
  runId: string,
  goalId?: string,
): Promise<ToolResultEnvelope> {
  const lead = input.lead;
  const intentQuestion = input.intent_question?.trim();
  const evidenceQuery = input.evidence_query?.trim();

  if (!intentQuestion || !evidenceQuery) {
    return buildToolResult({
      tool_name: TOOL_NAME,
      tool_version: TOOL_VERSION,
      run_id: runId,
      goal_id: goalId,
      inputs: { lead, intent_question: intentQuestion, evidence_query: evidenceQuery },
      outputs: {
        answer: { text: "Missing required fields", verdict: "unknown", key_facts: [] },
        budget_used: { searches_used: 0, visits_used: 0 },
      },
      errors: [buildToolError("MISSING_INPUT", "intent_question and evidence_query are required", false)],
    });
  }

  const visitBudget = Math.max(0, Math.min(input.visit_budget ?? 3, 5));

  const evidence: EvidenceItem[] = [];
  const collectedPages: CollectedPage[] = [];
  let visitsUsed = 0;

  if (lead.website && visitBudget > 0) {
    try {
      const visitInput: WebVisitInput = {
        url: lead.website,
        max_pages: Math.min(3, visitBudget),
        page_hints: ["home", "about", "events"],
        same_domain_only: true,
      };

      const visitEnvelope = await executeWebVisit(visitInput, runId, goalId);
      visitsUsed++;

      const visitPages = (visitEnvelope.outputs as any)?.pages ?? [];
      for (const page of visitPages) {
        if (page.text_clean) {
          collectedPages.push({
            url: page.url,
            text_clean: page.text_clean,
            source: "direct_visit",
          });
        }
      }

      evidence.push({
        source_type: "website",
        source_url: lead.website,
        captured_at: new Date().toISOString(),
        quote: `Direct visit: ${visitPages.length} page(s) crawled from ${lead.website}`,
        field_supported: "answer.sources",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      evidence.push({
        source_type: "website",
        source_url: lead.website,
        captured_at: new Date().toISOString(),
        quote: `Direct visit failed: ${msg}`,
        field_supported: "answer.errors",
      });
    }
  }

  const allFacts = extractRelevantFacts(collectedPages, intentQuestion, evidenceQuery);
  const { verdict, confidence } = determineVerdict(allFacts, collectedPages, lead.website);

  for (const fact of allFacts) {
    evidence.push({
      source_type: "website",
      source_url: fact.evidence_url,
      captured_at: new Date().toISOString(),
      quote: fact.fact.substring(0, 200),
      field_supported: "answer.key_facts",
    });
  }

  const answerText = buildAnswerText(allFacts, intentQuestion, lead.business_name);

  const outputs: AskLeadQuestionOutput = {
    answer: {
      text: answerText,
      verdict,
      confidence,
      key_facts: allFacts,
    },
    budget_used: {
      searches_used: 0,
      visits_used: visitsUsed,
    },
  };

  return buildToolResult({
    tool_name: TOOL_NAME,
    tool_version: TOOL_VERSION,
    run_id: runId,
    goal_id: goalId,
    inputs: {
      business_name: lead.business_name,
      intent_question: intentQuestion,
      evidence_query: evidenceQuery,
      search_budget: 0,
      visit_budget: visitBudget,
    },
    outputs: outputs as unknown as Record<string, unknown>,
    evidence,
    confidence,
  });
}
