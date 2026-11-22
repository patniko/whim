import { defineTool } from '@microsoft/copilot-sdk';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

interface WebFetchArgs {
  url: string;
  maxLength?: number;
  raw?: boolean;
}

const DEFAULT_MAX_LENGTH = 20_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB

export const webFetchTool = defineTool<WebFetchArgs>('web_fetch', {
  description:
    'Fetch a URL and return its content as text. For HTML pages, extracts the main readable content. ' +
    'Use this to retrieve information from the web.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch.',
      },
      maxLength: {
        type: 'number',
        description: `Maximum characters to return (default: ${DEFAULT_MAX_LENGTH}).`,
      },
      raw: {
        type: 'boolean',
        description: 'If true, return raw HTML instead of extracted text. Default: false.',
      },
    },
    required: ['url'],
  },
  overridesBuiltInTool: true,
  skipPermission: true,
  handler: webFetchHandler,
});

export async function webFetchHandler(args: WebFetchArgs): Promise<string> {
  const { url, raw = false } = args;
  const maxLength = Math.min(args.maxLength ?? DEFAULT_MAX_LENGTH, 100_000);

  if (!url || typeof url !== 'string') {
    return 'Error: url is required.';
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Error: Invalid URL: ${url}`;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return `Error: Only http and https URLs are supported.`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; IntentBot/1.0)',
        Accept: 'text/html, application/xhtml+xml, text/plain, */*',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return `Error: HTTP ${response.status} ${response.statusText}`;
    }

    const contentType = response.headers.get('content-type') || '';
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_RESPONSE_BYTES) {
      return `Error: Response too large (${contentLength} bytes). Max ${MAX_RESPONSE_BYTES} bytes.`;
    }

    const body = await response.text();

    // Non-HTML: return as-is (truncated)
    const isHtml = contentType.includes('html');
    if (!isHtml || raw) {
      return truncate(body, maxLength);
    }

    // HTML: extract readable content
    return extractReadableContent(body, url, maxLength);
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return `Error: Request timed out after ${FETCH_TIMEOUT_MS / 1000}s.`;
    }
    return `Error: ${err.message || 'Failed to fetch URL'}`;
  }
}

function extractReadableContent(html: string, url: string, maxLength: number): string {
  try {
    const { document } = parseHTML(html);
    const reader = new Readability(document as any, { charThreshold: 0 });
    const article = reader.parse();

    if (article && article.textContent) {
      const title = article.title ? `# ${article.title}\n\n` : '';
      const content = article.textContent.replace(/\n{3,}/g, '\n\n').trim();
      return truncate(`${title}${content}`, maxLength);
    }
  } catch {
    // Fall through to basic extraction
  }

  // Fallback: strip tags
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return truncate(text, maxLength);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '\n\n[Content truncated]';
}
