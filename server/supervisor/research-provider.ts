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
  error?: string;
}

export interface DeepResearchProvider {
  research(topic: string, prompt: string): Promise<ResearchResult>;
}

export class PerplexityResearchProvider implements DeepResearchProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'llama-3.1-sonar-large-128k-online') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async research(topic: string, prompt: string): Promise<ResearchResult> {
    const systemPrompt = [
      'You are a professional research analyst producing comprehensive reports.',
      'Write in Markdown. Use headings (##, ###), bullet points, and tables where appropriate.',
      'Include specific facts, figures, names, and dates wherever possible.',
      'Cite your sources inline using [Source Title](url) notation.',
      'Structure: start with a brief executive summary, then detailed sections, end with key takeaways.',
      'Be thorough — aim for 1500-3000 words of substantive content.',
    ].join(' ');

    const userPrompt = prompt && prompt !== topic
      ? `Research topic: ${topic}\n\nSpecific instructions: ${prompt}`
      : `Produce a comprehensive, well-structured research report on the following topic:\n\n${topic}`;

    const resp = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
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

    const firstParagraph = content.split('\n').find(l => l.trim().length > 30 && !l.startsWith('#')) || '';
    const summary = firstParagraph.substring(0, 300).trim();

    const titleMatch = content.match(/^#\s+(.+)/m);
    const title = titleMatch ? titleMatch[1].trim() : `Research Report: ${topic}`;

    return {
      title,
      summary,
      report_markdown: content,
      sources,
      status: 'completed',
    };
  }
}

export function createResearchProvider(): DeepResearchProvider | null {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return null;
  return new PerplexityResearchProvider(apiKey);
}
