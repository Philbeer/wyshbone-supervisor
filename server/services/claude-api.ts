/**
 * Claude API Service
 *
 * Server-side integration with Anthropic's Claude API for autonomous agent intelligence.
 * Used for goal generation, task planning, and autonomous decision-making.
 */

import Anthropic from '@anthropic-ai/sdk';

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ClaudeResponse {
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  model: string;
}

interface RateLimitState {
  lastCallTime: number;
  callCount: number;
}

class ClaudeAPIService {
  private client: Anthropic | null = null;
  private readonly model = 'claude-3-5-sonnet-20241022';
  private readonly maxTokens = 2048;

  // Rate limiting: max 5 calls per minute
  private readonly maxCallsPerMinute = 5;
  private readonly minuteMs = 60000;
  private rateLimitState: RateLimitState = {
    lastCallTime: 0,
    callCount: 0
  };

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      console.warn('[CLAUDE_API] ANTHROPIC_API_KEY not set - Claude API disabled');
      return;
    }

    try {
      this.client = new Anthropic({
        apiKey: apiKey
      });
      console.log('[CLAUDE_API] Initialized successfully');
    } catch (error) {
      console.error('[CLAUDE_API] Failed to initialize:', error);
    }
  }

  /**
   * Check if Claude API is available
   */
  isAvailable(): boolean {
    return this.client !== null;
  }

  /**
   * Check rate limit before making API call
   */
  private async checkRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastCall = now - this.rateLimitState.lastCallTime;

    // Reset counter if more than a minute has passed
    if (timeSinceLastCall > this.minuteMs) {
      this.rateLimitState.callCount = 0;
      this.rateLimitState.lastCallTime = now;
      return;
    }

    // Check if we've exceeded rate limit
    if (this.rateLimitState.callCount >= this.maxCallsPerMinute) {
      const waitTime = this.minuteMs - timeSinceLastCall;
      console.log(`[CLAUDE_API] Rate limit reached, waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.rateLimitState.callCount = 0;
      this.rateLimitState.lastCallTime = Date.now();
    }
  }

  /**
   * Call Claude API with a single prompt
   */
  async chat(
    prompt: string,
    systemPrompt?: string,
    options?: {
      maxTokens?: number;
      temperature?: number;
    }
  ): Promise<ClaudeResponse> {
    if (!this.client) {
      throw new Error('Claude API not initialized - check ANTHROPIC_API_KEY');
    }

    // Check rate limit
    await this.checkRateLimit();

    try {
      console.log('[CLAUDE_API] Sending request...');
      console.log('[CLAUDE_API] Prompt length:', prompt.length);

      const maxTokens = options?.maxTokens || this.maxTokens;
      const temperature = options?.temperature || 1.0;

      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        temperature: temperature,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      // Update rate limit state
      this.rateLimitState.callCount++;
      this.rateLimitState.lastCallTime = Date.now();

      // Extract text content
      const textContent = message.content
        .filter(block => block.type === 'text')
        .map(block => ('text' in block) ? block.text : '')
        .join('');

      console.log('[CLAUDE_API] Response received');
      console.log('[CLAUDE_API] Input tokens:', message.usage.input_tokens);
      console.log('[CLAUDE_API] Output tokens:', message.usage.output_tokens);

      return {
        content: textContent,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens
        },
        model: this.model
      };

    } catch (error: any) {
      console.error('[CLAUDE_API] Error:', error.message);

      // Check for rate limit error
      if (error.status === 429) {
        console.error('[CLAUDE_API] Rate limit exceeded - waiting before retry');
        await new Promise(resolve => setTimeout(resolve, this.minuteMs));
        return this.chat(prompt, systemPrompt, options); // Retry once
      }

      throw new Error(`Claude API call failed: ${error.message}`);
    }
  }

  /**
   * Call Claude API with conversation history
   */
  async chatWithHistory(
    messages: ClaudeMessage[],
    systemPrompt?: string,
    options?: {
      maxTokens?: number;
      temperature?: number;
    }
  ): Promise<ClaudeResponse> {
    if (!this.client) {
      throw new Error('Claude API not initialized - check ANTHROPIC_API_KEY');
    }

    // Check rate limit
    await this.checkRateLimit();

    try {
      console.log('[CLAUDE_API] Sending conversation request...');
      console.log('[CLAUDE_API] Message count:', messages.length);

      const maxTokens = options?.maxTokens || this.maxTokens;
      const temperature = options?.temperature || 1.0;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        temperature: temperature,
        system: systemPrompt,
        messages: messages.map(msg => ({
          role: msg.role,
          content: msg.content
        }))
      });

      // Update rate limit state
      this.rateLimitState.callCount++;
      this.rateLimitState.lastCallTime = Date.now();

      // Extract text content
      const textContent = response.content
        .filter(block => block.type === 'text')
        .map(block => ('text' in block) ? block.text : '')
        .join('');

      console.log('[CLAUDE_API] Response received');
      console.log('[CLAUDE_API] Input tokens:', response.usage.input_tokens);
      console.log('[CLAUDE_API] Output tokens:', response.usage.output_tokens);

      return {
        content: textContent,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens
        },
        model: this.model
      };

    } catch (error: any) {
      console.error('[CLAUDE_API] Error:', error.message);

      // Check for rate limit error
      if (error.status === 429) {
        console.error('[CLAUDE_API] Rate limit exceeded - waiting before retry');
        await new Promise(resolve => setTimeout(resolve, this.minuteMs));
        return this.chatWithHistory(messages, systemPrompt, options); // Retry once
      }

      throw new Error(`Claude API call failed: ${error.message}`);
    }
  }

  /**
   * Get current rate limit status
   */
  getRateLimitStatus(): { remaining: number; resetIn: number } {
    const now = Date.now();
    const timeSinceLastCall = now - this.rateLimitState.lastCallTime;

    if (timeSinceLastCall > this.minuteMs) {
      return {
        remaining: this.maxCallsPerMinute,
        resetIn: 0
      };
    }

    return {
      remaining: this.maxCallsPerMinute - this.rateLimitState.callCount,
      resetIn: this.minuteMs - timeSinceLastCall
    };
  }
}

// Export singleton instance
export const claudeAPI = new ClaudeAPIService();
