import type {
  ToolResultEnvelope,
  EvidenceItem,
  ToolError,
  EvidencedValue,
  UnknownValue,
} from "./tool-result";

export interface BuildToolResultParams {
  tool_name: string;
  tool_version: string;
  run_id: string;
  goal_id?: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  evidence?: EvidenceItem[];
  confidence?: number;
  errors?: ToolError[];
}

export function buildToolResult(params: BuildToolResultParams): ToolResultEnvelope {
  return {
    tool_name: params.tool_name,
    tool_version: params.tool_version,
    run_id: params.run_id,
    goal_id: params.goal_id,
    timestamp: new Date().toISOString(),
    inputs: params.inputs,
    outputs: params.outputs,
    evidence: params.evidence ?? [],
    confidence: params.confidence,
    errors: params.errors && params.errors.length > 0 ? params.errors : undefined,
  };
}

export function addEvidence(
  result: ToolResultEnvelope,
  item: EvidenceItem,
): ToolResultEnvelope {
  return {
    ...result,
    evidence: [...result.evidence, item],
  };
}

export function evidencedValue<T>(
  value: T,
  item: EvidenceItem,
): EvidencedValue<T> {
  return { value, verified: true, evidence: [item] };
}

export function unknownValue(reason: string): UnknownValue {
  return { value: null, verified: false, reason };
}

export function buildToolError(
  code: string,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): ToolError {
  return { code, message, retryable, details };
}

// ---------------------------------------------------------------------------
// Usage example (for future tool authors):
//
//   import { buildToolResult, evidencedValue, unknownValue, buildToolError } from "@shared/tool-result-helpers";
//
//   const result = buildToolResult({
//     tool_name: "lead_search",
//     tool_version: "1.0.0",
//     run_id: currentRunId,
//     goal_id: activeGoalId,
//     inputs: { query: "SaaS companies in Austin" },
//     outputs: {
//       company_name: evidencedValue("Acme Corp", {
//         source_type: "website",
//         source_url: "https://acme.com/about",
//         captured_at: new Date().toISOString(),
//         quote: "Acme Corp is a SaaS company headquartered in Austin, TX.",
//         field_supported: "company_name",
//       }),
//       employee_count: unknownValue("Not listed on public pages"),
//     },
//     confidence: 0.85,
//   });
//
//   // Adding evidence after initial creation:
//   const updated = addEvidence(result, {
//     source_type: "search_result",
//     source_url: "https://google.com/search?q=...",
//     captured_at: new Date().toISOString(),
//     quote: "Acme Corp listed as Austin-based SaaS.",
//     field_supported: "company_name",
//   });
//
//   // Structured error (never throw raw exceptions):
//   const failedResult = buildToolResult({
//     tool_name: "lead_search",
//     tool_version: "1.0.0",
//     run_id: currentRunId,
//     inputs: { query: "invalid" },
//     outputs: {},
//     errors: [
//       buildToolError("RATE_LIMITED", "Google Places API quota exceeded", true, { retryAfterMs: 60000 }),
//     ],
//   });
// ---------------------------------------------------------------------------
