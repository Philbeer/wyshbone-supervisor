/**
 * Task Interpreter Service
 *
 * Bridges natural language tasks → structured tool calls
 * Uses Claude API with fallback to keyword matching
 *
 * Phase 3: WABS Integration - Task Intelligence Layer
 */

import 'dotenv/config';
import type { GeneratedTask } from '../autonomous-agent';
import Anthropic from '@anthropic-ai/sdk';
import { buildToolPromptSection, isToolEnabled } from '../supervisor/tool-registry';

interface ToolCall {
  tool: string;
  params: Record<string, any>;
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Build prompt for Claude API
 * Includes available tools and task context
 */
function buildPrompt(task: GeneratedTask): string {
  const toolSection = buildToolPromptSection();

  return `You are a task interpreter. Convert the following natural language task into a structured tool call.

${toolSection}
TASK TO INTERPRET:
Title: ${task.title}
Description: ${task.description}
Priority: ${task.priority}
${task.reasoning ? `Reasoning: ${task.reasoning}` : ''}

INSTRUCTIONS:
1. Analyze the task description and determine which ENABLED tool best fits the intent
2. NEVER select a DISABLED tool — if you do, the system will reject the call
3. Extract relevant parameters from the description
4. Respond with ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "tool": "tool_name",
  "params": {
    "param1": "value1",
    "param2": "value2"
  }
}

RESPONSE (JSON only):`;
}

/**
 * Clean API response - remove markdown code blocks if present
 */
function cleanResponse(response: string): string {
  // Remove markdown code blocks
  let cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '');
  // Trim whitespace
  cleaned = cleaned.trim();
  return cleaned;
}

/**
 * Call Claude API to interpret task
 */
async function callClaudeAPI(prompt: string): Promise<string> {
  const message = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    temperature: 0,
    messages: [{
      role: 'user',
      content: prompt
    }]
  });

  const content = message.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude API');
  }

  return content.text;
}

/**
 * Interpret natural language task → structured tool call
 * Uses Claude API to intelligently map tasks to tools
 */
export async function interpretTask(task: GeneratedTask): Promise<ToolCall> {
  try {
    console.log(`[TASK_INTERPRETER] Interpreting task: "${task.description}"`);

    const prompt = buildPrompt(task);
    const response = await callClaudeAPI(prompt);
    const cleaned = cleanResponse(response);
    const parsed = JSON.parse(cleaned);

    if (!parsed.tool || !parsed.params) {
      throw new Error('Invalid response format from Claude API');
    }

    if (!isToolEnabled(parsed.tool)) {
      console.warn(`[TASK_INTERPRETER] Claude selected disabled tool ${parsed.tool} — falling back`);
      return fallbackInterpretation(task);
    }

    console.log(`[TASK_INTERPRETER] Mapped "${task.description}" → ${parsed.tool}`);
    console.log(`[TASK_INTERPRETER]    Params: ${JSON.stringify(parsed.params)}`);

    return parsed as ToolCall;

  } catch (error: any) {
    console.warn(`[TASK_INTERPRETER] ⚠️  Claude API failed (${error.message}), using fallback`);
    return fallbackInterpretation(task);
  }
}

function extractLocation(text: string): string {
  const locationMatch = text.match(/in\s+([A-Z][a-zA-Z\s,]+?)(?:\s|$|,)/);
  return locationMatch ? locationMatch[1].trim() : 'UK';
}

function guardToolCall(candidate: ToolCall): ToolCall {
  if (isToolEnabled(candidate.tool)) return candidate;

  console.warn(`[TASK_INTERPRETER] Fallback picked disabled tool ${candidate.tool} — defaulting to SEARCH_PLACES`);
  return {
    tool: 'SEARCH_PLACES',
    params: {
      query: candidate.params.query || candidate.params.prompt || 'businesses',
      location: candidate.params.location || 'UK',
      maxResults: 30,
      country: 'GB',
    },
  };
}

/**
 * Fallback: keyword-based tool selection
 * Used when Claude API fails or returns invalid response.
 * Every candidate is validated against the tool registry before returning.
 */
export function fallbackInterpretation(task: GeneratedTask): ToolCall {
  const desc = task.description.toLowerCase();
  const title = task.title.toLowerCase();
  const combined = `${title} ${desc}`;

  console.log(`[TASK_INTERPRETER] Fallback interpretation for: "${task.description}"`);

  if (combined.match(/\b(search|find|look|locate|discover)\b.*\b(business|restaurant|pub|brewery|shop|store|company)\b/i)) {
    const location = extractLocation(combined);
    return guardToolCall({
      tool: 'SEARCH_PLACES',
      params: { query: task.description, location, maxResults: 30, country: 'GB' },
    });
  }

  if (combined.match(/\b(research|analyze|investigate|study|explore)\b/i)) {
    return guardToolCall({
      tool: 'SEARCH_PLACES',
      params: { query: task.description, location: 'UK', maxResults: 20, country: 'GB' },
    });
  }

  if (combined.match(/\b(contact|lead|outreach|find.*manager|find.*owner)\b/i)) {
    const location = extractLocation(combined);
    return guardToolCall({
      tool: 'ENRICH_LEADS',
      params: { query: task.description, location, country: 'GB', enrichType: 'detail' },
    });
  }

  if (combined.match(/\b(score|rank|evaluate|quality)\b/i)) {
    const location = extractLocation(combined);
    return guardToolCall({
      tool: 'SCORE_LEADS',
      params: { query: task.description, location, country: 'GB', scoreModel: 'basic' },
    });
  }

  console.log(`[TASK_INTERPRETER] No keyword match, defaulting to SEARCH_PLACES`);
  return guardToolCall({
    tool: 'SEARCH_PLACES',
    params: { query: task.description, location: 'UK', maxResults: 30, country: 'GB' },
  });
}
