import { z } from "zod";

export const evidenceSourceTypes = [
  "website",
  "search_result",
  "places",
  "directory",
  "social",
] as const;

export type EvidenceSourceType = (typeof evidenceSourceTypes)[number];

export const evidenceItemSchema = z.object({
  source_type: z.enum(evidenceSourceTypes),
  source_url: z.string(),
  captured_at: z.string(),
  quote: z.string(),
  field_supported: z.string(),
});

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const toolErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.unknown()).optional(),
});

export type ToolError = z.infer<typeof toolErrorSchema>;

export const toolResultEnvelopeSchema = z.object({
  tool_name: z.string(),
  tool_version: z.string(),
  run_id: z.string(),
  goal_id: z.string().optional(),
  timestamp: z.string(),
  inputs: z.record(z.unknown()),
  outputs: z.record(z.unknown()),
  evidence: z.array(evidenceItemSchema),
  confidence: z.number().min(0).max(1).optional(),
  errors: z.array(toolErrorSchema).optional(),
});

export type ToolResultEnvelope = z.infer<typeof toolResultEnvelopeSchema>;

export interface EvidencedValue<T = unknown> {
  value: T;
  verified: true;
  evidence: EvidenceItem[];
}

export interface UnknownValue {
  value: null;
  verified: false;
  reason: string;
}
