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
  return `You are a task interpreter. Convert the following natural language task into a structured tool call.

AVAILABLE TOOLS:
1. SEARCH_PLACES - Search for businesses using Google Places API
   Required: query (string)
   Optional: location (string), maxResults (number), country (string, default: "GB")

2. DEEP_RESEARCH - Start background research job with AI analysis
   Required: prompt (string)
   Optional: label (string), mode (string, default: "report"), counties (string), windowMonths (number)

3. BATCH_CONTACT_FINDER - Find and enrich contacts for businesses
   Required: query (string), location (string)
   Optional: country (string, default: "GB"), targetRole (string, default: "General Manager"), limit (number, default: 30)

4. DRAFT_EMAIL - Generate draft email content for outreach
   Optional: to_role (string, default: "General Manager"), purpose (string, default: "intro"), product (string, default: "your product")

5. GET_NUDGES - Get AI-generated suggestions and nudges
   Optional: limit (number, default: 10)

TASK TO INTERPRET:
Title: ${task.title}
Description: ${task.description}
Priority: ${task.priority}
${task.reasoning ? `Reasoning: ${task.reasoning}` : ''}

INSTRUCTIONS:
1. Analyze the task description and determine which tool best fits the intent
2. Extract relevant parameters from the description
3. Respond with ONLY valid JSON in this exact format (no markdown, no explanation):
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

    // Validate response structure
    if (!parsed.tool || !parsed.params) {
      throw new Error('Invalid response format from Claude API');
    }

    console.log(`[TASK_INTERPRETER] ✅ Mapped "${task.description}" → ${parsed.tool}`);
    console.log(`[TASK_INTERPRETER]    Params: ${JSON.stringify(parsed.params)}`);

    return parsed as ToolCall;

  } catch (error: any) {
    console.warn(`[TASK_INTERPRETER] ⚠️  Claude API failed (${error.message}), using fallback`);
    return fallbackInterpretation(task);
  }
}

/**
 * Fallback: keyword-based tool selection
 * Used when Claude API fails or returns invalid response
 */
export function fallbackInterpretation(task: GeneratedTask): ToolCall {
  const desc = task.description.toLowerCase();
  const title = task.title.toLowerCase();
  const combined = `${title} ${desc}`;

  console.log(`[TASK_INTERPRETER] 🔍 Fallback interpretation for: "${task.description}"`);

  // Search/Find patterns
  if (combined.match(/\b(search|find|look|locate|discover)\b.*\b(business|restaurant|pub|brewery|shop|store|company)\b/i)) {
    // Extract location if present
    const locationMatch = combined.match(/in\s+([A-Z][a-zA-Z\s,]+?)(?:\s|$|,)/);
    const location = locationMatch ? locationMatch[1].trim() : 'UK';

    console.log(`[TASK_INTERPRETER] ✅ Fallback → SEARCH_PLACES (location: ${location})`);

    return {
      tool: 'SEARCH_PLACES',
      params: {
        query: task.description,
        location: location,
        maxResults: 30,
        country: 'GB'
      }
    };
  }

  // Research patterns
  if (combined.match(/\b(research|analyze|investigate|study|explore)\b/i)) {
    console.log(`[TASK_INTERPRETER] ✅ Fallback → DEEP_RESEARCH`);

    return {
      tool: 'DEEP_RESEARCH',
      params: {
        prompt: task.description,
        label: task.title,
        mode: 'report'
      }
    };
  }

  // Email drafting patterns (check before contact finder)
  if (combined.match(/\b(draft|write|compose).*\b(email|message|letter)\b/i) ||
      combined.match(/\b(email|message).*\b(draft|write|compose)\b/i)) {
    console.log(`[TASK_INTERPRETER] ✅ Fallback → DRAFT_EMAIL`);

    return {
      tool: 'DRAFT_EMAIL',
      params: {
        to_role: 'General Manager',
        purpose: 'intro',
        product: task.description
      }
    };
  }

  // Contact/Lead generation patterns
  if (combined.match(/\b(contact|lead|outreach|find.*manager|find.*owner)\b/i)) {
    const locationMatch = combined.match(/in\s+([A-Z][a-zA-Z\s,]+?)(?:\s|$|,)/);
    const location = locationMatch ? locationMatch[1].trim() : 'UK';

    console.log(`[TASK_INTERPRETER] ✅ Fallback → BATCH_CONTACT_FINDER`);

    return {
      tool: 'BATCH_CONTACT_FINDER',
      params: {
        query: task.description,
        location: location,
        country: 'GB',
        targetRole: 'General Manager',
        limit: 30
      }
    };
  }

  // Nudge/Suggestion patterns
  if (combined.match(/\b(nudge|suggest|recommend|idea|follow.*up)\b/i)) {
    console.log(`[TASK_INTERPRETER] ✅ Fallback → GET_NUDGES`);

    return {
      tool: 'GET_NUDGES',
      params: {
        limit: 10
      }
    };
  }

  // Default: try SEARCH_PLACES as most general tool
  console.log(`[TASK_INTERPRETER] ⚠️  No keyword match, defaulting to SEARCH_PLACES`);

  return {
    tool: 'SEARCH_PLACES',
    params: {
      query: task.description,
      location: 'UK',
      maxResults: 30,
      country: 'GB'
    }
  };
}
