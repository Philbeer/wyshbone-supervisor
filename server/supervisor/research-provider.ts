export interface ResearchSource {
  title: string;
  url: string;
}

export interface ResearchResult {
  title: string;
  summary: string;
  report_markdown: string;
  sources: ResearchSource[];
  status: 'completed' | 'failed';
  provider: string;
  error?: string;
}

export interface DeepResearchProvider {
  readonly name: string;
  research(topic: string, prompt: string): Promise<ResearchResult>;
}

const RESEARCH_SYSTEM_PROMPT = [
  'You are a professional research analyst producing comprehensive reports.',
  'Write in Markdown. Use headings (##, ###), bullet points, and tables where appropriate.',
  'Include specific facts, figures, names, and dates wherever possible.',
  'Cite your sources inline using [Source Title](url) notation when available.',
  'Structure: start with a brief executive summary, then detailed sections, end with key takeaways.',
  'Be thorough — aim for 1500-3000 words of substantive content.',
].join(' ');

function buildUserPrompt(topic: string, prompt: string): string {
  return prompt && prompt !== topic
    ? `Research topic: ${topic}\n\nSpecific instructions: ${prompt}`
    : `Produce a comprehensive, well-structured research report on the following topic:\n\n${topic}`;
}

function extractTitleAndSummary(content: string, topic: string): { title: string; summary: string } {
  const titleMatch = content.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : `Research Report: ${topic}`;
  const firstParagraph = content.split('\n').find(l => l.trim().length > 30 && !l.startsWith('#')) || '';
  const summary = firstParagraph.substring(0, 300).trim();
  return { title, summary };
}

export class OpenAIResponsesProvider implements DeepResearchProvider {
  readonly name = 'openai';
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'gpt-4.1') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async research(topic: string, prompt: string): Promise<ResearchResult> {
    const userPrompt = buildUserPrompt(topic, prompt);

    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        instructions: RESEARCH_SYSTEM_PROMPT,
        input: userPrompt,
        tools: [{ type: 'web_search' }],
        store: false,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`OpenAI Responses API returned HTTP ${resp.status}: ${errText.substring(0, 300)}`);
    }

    const data = await resp.json();

    let content = '';
    const sources: ResearchSource[] = [];
    const seenUrls = new Set<string>();

    if (Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const block of item.content) {
            if (block.type === 'output_text') {
              content += (content ? '\n\n' : '') + block.text;
              if (Array.isArray(block.annotations)) {
                for (const ann of block.annotations) {
                  if (ann.type === 'url_citation' && ann.url && !seenUrls.has(ann.url)) {
                    seenUrls.add(ann.url);
                    sources.push({
                      title: ann.title || ann.url,
                      url: ann.url,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }

    if (!content && data.output_text) {
      content = data.output_text;
    }

    if (!content) {
      throw new Error('OpenAI Responses API returned empty content');
    }

    const { title, summary } = extractTitleAndSummary(content, topic);

    return {
      title,
      summary,
      report_markdown: content,
      sources,
      status: 'completed',
      provider: this.name,
    };
  }
}

export class PerplexityResearchProvider implements DeepResearchProvider {
  readonly name = 'perplexity';
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'llama-3.1-sonar-large-128k-online') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async research(topic: string, prompt: string): Promise<ResearchResult> {
    const userPrompt = buildUserPrompt(topic, prompt);

    const resp = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: RESEARCH_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        top_p: 0.9,
        return_images: false,
        return_related_questions: false,
        stream: false,
        frequency_penalty: 1,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Perplexity API returned HTTP ${resp.status}: ${errText.substring(0, 300)}`);
    }

    const data = await resp.json();
    const content: string = data.choices?.[0]?.message?.content || '';
    const citations: string[] = data.citations || [];

    if (!content) {
      throw new Error('Perplexity returned empty content');
    }

    const sources: ResearchSource[] = citations.map((url: string, i: number) => {
      let domain = url;
      try { domain = new URL(url).hostname.replace('www.', ''); } catch {}
      return { title: `Source ${i + 1} (${domain})`, url };
    });

    const { title, summary } = extractTitleAndSummary(content, topic);

    return {
      title,
      summary,
      report_markdown: content,
      sources,
      status: 'completed',
      provider: this.name,
    };
  }
}

export class AnthropicResearchProvider implements DeepResearchProvider {
  readonly name = 'anthropic';
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'claude-sonnet-4-20250514') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async research(topic: string, prompt: string): Promise<ResearchResult> {
    const userPrompt = buildUserPrompt(topic, prompt);
    const disclaimer = '\n\n---\n*Note: This report was generated without live web search. Information is based on training data and may not reflect the very latest developments.*\n';

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system: RESEARCH_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Anthropic API returned HTTP ${resp.status}: ${errText.substring(0, 300)}`);
    }

    const data = await resp.json();
    let content = '';
    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text') {
          content += (content ? '\n\n' : '') + block.text;
        }
      }
    }

    if (!content) {
      throw new Error('Anthropic returned empty content');
    }

    content += disclaimer;

    const { title, summary } = extractTitleAndSummary(content, topic);

    return {
      title,
      summary,
      report_markdown: content,
      sources: [],
      status: 'completed',
      provider: this.name,
    };
  }
}

export class FallbackResearchProvider implements DeepResearchProvider {
  readonly name = 'fallback';

  async research(topic: string, _prompt: string): Promise<ResearchResult> {
    const content = `# Research Report: ${topic}

## Executive Summary

This report provides a general overview of **${topic}**. No external web search or AI research API was available at the time of generation, so this report contains a structured outline based on general knowledge.

## Overview

${topic} is a subject that warrants detailed investigation. Key areas to explore include:

- **Market landscape** — current state and major players
- **Trends** — emerging patterns and growth areas
- **Opportunities** — potential avenues for engagement or investment
- **Challenges** — known risks and barriers

## Recommended Next Steps

1. Conduct targeted web research on "${topic}" using search engines
2. Identify key industry reports and publications
3. Review competitor analysis and market positioning
4. Gather primary data through surveys or interviews where applicable

## Key Takeaways

- A comprehensive analysis requires access to current data sources
- This outline can serve as a starting framework for deeper research
- Consider re-running this research when an API key (OpenAI, Perplexity, or Anthropic) is configured

---
*Note: No web search API was available. This is a basic framework report. Configure OPENAI_API_KEY, PERPLEXITY_API_KEY, or ANTHROPIC_API_KEY to enable full research capabilities.*
`;

    return {
      title: `Research Report: ${topic}`,
      summary: `Basic framework report on "${topic}" — no research API available. Configure an API key for full research.`,
      report_markdown: content,
      sources: [],
      status: 'completed',
      provider: this.name,
    };
  }
}

export function createResearchProvider(): DeepResearchProvider {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return new OpenAIResponsesProvider(openaiKey);
  }

  const perplexityKey = process.env.PERPLEXITY_API_KEY;
  if (perplexityKey) {
    return new PerplexityResearchProvider(perplexityKey);
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return new AnthropicResearchProvider(anthropicKey);
  }

  return new FallbackResearchProvider();
}
