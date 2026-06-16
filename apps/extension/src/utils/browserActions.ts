import type {
  BrowserActionRequest,
  BrowserPageContentResult,
  BrowserActionResponse,
  BrowserSearchResult,
  BrowserTextMatch,
  BrowserTextQueryInput,
  SelectionReference
} from '@bac/shared';
import { collectPageContext, getCurrentSelection } from './pageContext';

const HIGHLIGHT_ROOT_ID = 'browser-agent-copilot-highlight-root';

function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function isElementVisible(element: Element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden'
  );
}

function getVisibleTextNodes() {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('#browser-agent-copilot-root')) {
        return NodeFilter.FILTER_REJECT;
      }
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT'].includes(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }

      const rect = parent.getBoundingClientRect();
      const style = window.getComputedStyle(parent);
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        style.display === 'none' ||
        style.visibility === 'hidden'
      ) {
        return NodeFilter.FILTER_REJECT;
      }

      return normalizeText(node.textContent || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });

  while (walker.nextNode()) {
    nodes.push(walker.currentNode as Text);
  }

  return nodes;
}

function findTextRanges(query: string, maxMatches = 8) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const ranges: Range[] = [];
  for (const node of getVisibleTextNodes()) {
    const text = node.textContent || '';
    const lowerText = text.toLowerCase();
    let startIndex = lowerText.indexOf(needle);

    while (startIndex >= 0 && ranges.length < maxMatches) {
      const range = document.createRange();
      range.setStart(node, startIndex);
      range.setEnd(node, startIndex + query.length);
      ranges.push(range);
      startIndex = lowerText.indexOf(needle, startIndex + needle.length);
    }

    if (ranges.length >= maxMatches) break;
  }

  return ranges;
}

function getRangeSnippet(range: Range, index: number): BrowserTextMatch {
  const text = range.startContainer.textContent || '';
  const start = range.startOffset;
  const end = range.endOffset;
  return {
    index,
    text: range.toString(),
    before: normalizeText(text.slice(Math.max(0, start - 80), start)) || undefined,
    after: normalizeText(text.slice(end, end + 80)) || undefined
  };
}

function getHighlightRoot() {
  const existing = document.getElementById(HIGHLIGHT_ROOT_ID);
  if (existing) return existing;

  const root = document.createElement('div');
  root.id = HIGHLIGHT_ROOT_ID;
  root.style.pointerEvents = 'none';
  root.style.position = 'fixed';
  root.style.inset = '0';
  root.style.zIndex = '2147483646';
  document.documentElement.appendChild(root);
  return root;
}

function clearHighlights() {
  document.getElementById(HIGHLIGHT_ROOT_ID)?.remove();
}

function highlightRange(range: Range) {
  const root = getHighlightRoot();
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);

  for (const rect of rects) {
    const marker = document.createElement('div');
    marker.style.background = 'rgba(16, 163, 127, 0.24)';
    marker.style.border = '1px solid rgba(16, 163, 127, 0.42)';
    marker.style.borderRadius = '4px';
    marker.style.boxShadow = '0 0 0 2px rgba(16, 163, 127, 0.12)';
    marker.style.left = `${rect.left}px`;
    marker.style.top = `${rect.top}px`;
    marker.style.width = `${rect.width}px`;
    marker.style.height = `${rect.height}px`;
    marker.style.position = 'fixed';
    root.appendChild(marker);
  }
}

function scrollRangeIntoView(range: Range) {
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return false;

  window.scrollTo({
    top: window.scrollY + rect.top - Math.round(window.innerHeight * 0.28),
    behavior: 'smooth'
  });
  return true;
}

function parseTextInput(input: unknown): BrowserTextQueryInput {
  const value = input as Partial<BrowserTextQueryInput> | undefined;
  return {
    query: typeof value?.query === 'string' ? value.query : '',
    maxMatches: typeof value?.maxMatches === 'number' ? value.maxMatches : undefined
  };
}

function parseSelectionInput(input: unknown): SelectionReference | null {
  const value = input as { selection?: Partial<SelectionReference> } | undefined;
  const selection = value?.selection;
  if (
    typeof selection?.text === 'string' &&
    typeof selection.pageUrl === 'string' &&
    typeof selection.pageTitle === 'string' &&
    typeof selection.capturedAt === 'string'
  ) {
    return selection as SelectionReference;
  }
  return null;
}

function getResultSource(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function normalizeResultUrl(rawUrl: string) {
  const parsed = new URL(rawUrl, location.href);
  if (parsed.hostname.includes('google.') && parsed.pathname === '/url') {
    const target = parsed.searchParams.get('q') || parsed.searchParams.get('url');
    if (target) return new URL(target, location.href);
  }
  return parsed;
}

function findResultContainer(anchor: HTMLAnchorElement) {
  return (
    anchor.closest('article,li,[data-sokoban-container],.g,.MjjYud,.b_algo,.gs_r,.result') ||
    anchor.parentElement
  );
}

function extractSearchResults(limit = 12): BrowserSearchResult[] {
  const seen = new Set<string>();
  const results: BrowserSearchResult[] = [];

  for (const anchor of [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]) {
    if (!anchor.href || !isElementVisible(anchor)) continue;
    let url: URL;
    try {
      url = normalizeResultUrl(anchor.href);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    if (url.hostname.includes('google.') && url.pathname.startsWith('/search')) continue;
    if (seen.has(url.toString())) continue;

    const title = normalizeText(anchor.textContent || anchor.getAttribute('aria-label') || '');
    if (title.length < 4 || title.length > 220) continue;

    const container = findResultContainer(anchor);
    const snippet = normalizeText(container?.textContent || '')
      .replace(title, '')
      .slice(0, 420)
      .trim();

    seen.add(url.toString());
    results.push({
      rank: results.length + 1,
      title,
      url: url.toString(),
      snippet: snippet || undefined,
      source: getResultSource(url.toString())
    });

    if (results.length >= limit) break;
  }

  return results;
}

function readPageContent(maxChars = 18000): BrowserPageContentResult {
  const context = collectPageContext(getCurrentSelection()?.reference);
  const text = normalizeText(context.fullText || context.visibleText || '');
  return {
    url: context.url,
    title: context.title || document.title || location.href,
    description: context.description,
    headings: (context.headings || []).slice(0, 12).map((heading) => heading.text),
    textLength: text.length,
    textExcerpt: text.slice(0, maxChars)
  };
}

async function executeBrowserAction(request: BrowserActionRequest): Promise<unknown> {
  const context = collectPageContext(getCurrentSelection()?.reference);

  if (request.action === 'browser.get_page_summary') {
    return {
      url: context.url,
      title: context.title,
      description: context.description,
      headingCount: context.headings?.length || 0,
      linkCount: context.links?.length || 0,
      visibleTextLength: context.visibleText?.length || 0,
      fullTextLength: context.fullText?.length || 0,
      contentExcerpt: (context.fullText || context.visibleText || '').slice(0, 5000),
      selectedText: context.selection?.text
    };
  }

  if (request.action === 'browser.extract_links') {
    return { links: context.links || [] };
  }

  if (request.action === 'browser.extract_search_results') {
    return {
      url: location.href,
      title: document.title,
      results: extractSearchResults()
    };
  }

  if (request.action === 'browser.read_page_content') {
    return readPageContent();
  }

  if (request.action === 'browser.describe_page_structure') {
    return {
      headings: context.headings || [],
      landmarks: context.landmarks || []
    };
  }

  if (request.action === 'browser.read_selected_text') {
    return {
      selection: context.selection || parseSelectionInput(request.input)
    };
  }

  if (
    request.action === 'browser.find_text' ||
    request.action === 'browser.highlight_text' ||
    request.action === 'browser.scroll_to_text'
  ) {
    const input = parseTextInput(request.input);
    const ranges = findTextRanges(input.query, input.maxMatches || 8);
    const matches = ranges.map((range, index) => getRangeSnippet(range, index));

    if (request.action === 'browser.find_text') {
      return { query: input.query, matches };
    }

    if (request.action === 'browser.scroll_to_text') {
      const scrolled = ranges[0] ? scrollRangeIntoView(ranges[0]) : false;
      return { query: input.query, scrolled, match: matches[0] };
    }

    clearHighlights();
    for (const range of ranges) {
      highlightRange(range);
    }
    window.setTimeout(clearHighlights, 4500);
    return { query: input.query, highlighted: ranges.length, matches };
  }

  throw new Error(`Unsupported browser action: ${String(request.action)}`);
}

export async function handleBrowserActionRequest(
  request: BrowserActionRequest
): Promise<BrowserActionResponse> {
  try {
    if (request.risk && request.risk !== 'low' && !request.confirmed) {
      throw new Error('此浏览器动作需要用户确认后才能执行。');
    }

    const output = await executeBrowserAction(request);
    return { ok: true, action: request.action, output };
  } catch (error) {
    return {
      ok: false,
      action: request.action,
      error: error instanceof Error ? error.message : 'Browser action failed.'
    };
  }
}
