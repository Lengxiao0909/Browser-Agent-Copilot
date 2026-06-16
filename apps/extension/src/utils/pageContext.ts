import type { PageContext, PageHeading, PageLandmark, PageLink, SelectionReference } from '@bac/shared';

const MAX_VISIBLE_TEXT = 10000;
const MAX_FULL_TEXT = 50000;
const MAX_HEADINGS = 36;
const MAX_LINKS = 40;
const MAX_LANDMARKS = 24;
const SKIPPED_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION']);

export interface CapturedSelection {
  reference: SelectionReference;
  rect: DOMRect;
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function shouldSkipElement(element: Element) {
  if (element.closest('#browser-agent-copilot-root')) return true;
  if (SKIPPED_TEXT_TAGS.has(element.tagName)) return true;
  const role = element.getAttribute('role');
  if (role === 'navigation' || role === 'banner' || role === 'contentinfo') return true;
  return Boolean(element.closest('script,style,noscript,nav,header,footer,aside,#browser-agent-copilot-root'));
}

function getMetaDescription() {
  return (
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ||
    document.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.content ||
    undefined
  );
}

function isElementVisible(element: Element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== 'hidden' &&
    style.display !== 'none' &&
    rect.bottom >= 0 &&
    rect.top <= window.innerHeight
  );
}

function collectVisibleText(limit = MAX_VISIBLE_TEXT) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !isElementVisible(parent)) return NodeFilter.FILTER_REJECT;
      if (shouldSkipElement(parent)) {
        return NodeFilter.FILTER_REJECT;
      }
      return normalizeText(node.textContent || '').length
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });

  const chunks: string[] = [];
  let total = 0;
  while (walker.nextNode() && total < limit) {
    const text = normalizeText(walker.currentNode.textContent || '');
    chunks.push(text);
    total += text.length;
  }
  return chunks.join('\n').slice(0, limit);
}

function getReadableRoot() {
  const candidates = [
    ...document.querySelectorAll<HTMLElement>(
      'article,main,[role="main"],[data-testid*="article" i],[class*="article" i],[class*="content" i],[id*="article" i],[id*="content" i]'
    )
  ].filter((element) => !shouldSkipElement(element));

  if (!candidates.length) return document.body;

  return candidates
    .map((element) => ({
      element,
      textLength: collectTextFromElement(element, MAX_FULL_TEXT).length
    }))
    .sort((a, b) => b.textLength - a.textLength)[0]?.element || document.body;
}

function collectTextFromElement(root: Element | null | undefined, limit = MAX_FULL_TEXT) {
  if (!root) return '';

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || shouldSkipElement(parent)) return NodeFilter.FILTER_REJECT;
      return normalizeText(node.textContent || '').length
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });

  const chunks: string[] = [];
  let total = 0;
  while (walker.nextNode() && total < limit) {
    const text = normalizeText(walker.currentNode.textContent || '');
    chunks.push(text);
    total += text.length + 1;
  }
  return chunks.join('\n').slice(0, limit);
}

function collectHeadings(): PageHeading[] {
  return [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .map((element) => ({
      level: Number(element.tagName.slice(1)),
      text: normalizeText(element.textContent || '')
    }))
    .filter((heading) => heading.text)
    .slice(0, MAX_HEADINGS);
}

function collectLinks(): PageLink[] {
  const seen = new Set<string>();

  return [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
    .filter((element) => isElementVisible(element))
    .map((element) => {
      const text = normalizeText(element.textContent || element.getAttribute('aria-label') || '');
      return {
        text: text || element.href,
        href: element.href
      };
    })
    .filter((link) => {
      const key = `${link.text}\n${link.href}`;
      if (!link.href || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_LINKS);
}

function collectLandmarks(): PageLandmark[] {
  const selector = [
    'main',
    'nav',
    'header',
    'footer',
    'aside',
    'section[aria-label]',
    '[role="main"]',
    '[role="navigation"]',
    '[role="search"]',
    '[role="banner"]',
    '[role="contentinfo"]'
  ].join(',');

  return [...document.querySelectorAll<HTMLElement>(selector)]
    .filter((element) => isElementVisible(element))
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || undefined,
      label:
        element.getAttribute('aria-label') ||
        element.getAttribute('aria-labelledby') ||
        element.getAttribute('data-testid') ||
        undefined,
      text: normalizeText(element.textContent || '').slice(0, 240) || undefined
    }))
    .slice(0, MAX_LANDMARKS);
}

export function getCurrentSelection(): CapturedSelection | null {
  const activeSelection = window.getSelection();
  const text = normalizeText(activeSelection?.toString() || '');
  if (!activeSelection || text.length < 2 || activeSelection.rangeCount === 0) return null;

  const rect = activeSelection.getRangeAt(0).getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;

  return {
    rect,
    reference: {
      text: text.slice(0, 4000),
      pageUrl: location.href,
      pageTitle: document.title,
      capturedAt: new Date().toISOString()
    }
  };
}

export function collectPageContext(selection?: SelectionReference): PageContext {
  const readableText = collectTextFromElement(getReadableRoot(), MAX_FULL_TEXT);
  const bodyText = collectTextFromElement(document.body, MAX_FULL_TEXT);
  const fullText = readableText.length >= 500 ? readableText : bodyText;

  return {
    url: location.href,
    title: document.title,
    description: getMetaDescription(),
    visibleText: collectVisibleText(),
    fullText: fullText || undefined,
    headings: collectHeadings(),
    links: collectLinks(),
    landmarks: collectLandmarks(),
    selection
  };
}
