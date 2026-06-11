import type {
  BrowserActionRequest,
  BrowserActionResponse,
  BrowserTextMatch,
  BrowserTextQueryInput
} from '@bac/shared';
import { collectPageContext, getCurrentSelection } from './pageContext';

const HIGHLIGHT_ROOT_ID = 'browser-agent-copilot-highlight-root';

function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
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

async function executeBrowserAction(request: BrowserActionRequest): Promise<unknown> {
  const context = collectPageContext(getCurrentSelection()?.reference);

  if (request.action === 'browser.get_page_summary') {
    return {
      url: context.url,
      title: context.title,
      description: context.description,
      headingCount: context.headings?.length || 0,
      linkCount: context.links?.length || 0,
      selectedText: context.selection?.text
    };
  }

  if (request.action === 'browser.extract_links') {
    return { links: context.links || [] };
  }

  if (request.action === 'browser.describe_page_structure') {
    return {
      headings: context.headings || [],
      landmarks: context.landmarks || []
    };
  }

  if (request.action === 'browser.read_selected_text') {
    return {
      selection: context.selection || null
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
