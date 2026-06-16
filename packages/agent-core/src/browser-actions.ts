import type { ToolDefinition } from '@bac/shared';
import type { PageContext } from '@bac/shared';

export interface BrowserActionContext {
  tabId?: number;
  url?: string;
  title?: string;
  pageContext?: PageContext;
}

export function createBuiltinBrowserActions(): ToolDefinition[] {
  return [
    {
      name: 'browser.get_page_summary',
      title: 'Get page summary',
      description: 'Returns the current page URL and title from the provided browser context.',
      layer: 'browser-action',
      risk: 'low',
      async execute(input: BrowserActionContext) {
        const page = input.pageContext;
        return {
          url: page?.url || input.url,
          title: page?.title || input.title,
          description: page?.description,
          headingCount: page?.headings?.length || 0,
          linkCount: page?.links?.length || 0,
          tabId: input.tabId
        };
      }
    },
    {
      name: 'browser.extract_links',
      title: 'Extract links',
      description: 'Returns visible links collected from the current page context.',
      layer: 'browser-action',
      risk: 'low',
      async execute(input: BrowserActionContext) {
        return {
          links: input.pageContext?.links || []
        };
      }
    },
    {
      name: 'browser.describe_page_structure',
      title: 'Describe page structure',
      description: 'Returns headings and landmark summaries collected from the current page.',
      layer: 'browser-action',
      risk: 'low',
      async execute(input: BrowserActionContext) {
        return {
          headings: input.pageContext?.headings || [],
          landmarks: input.pageContext?.landmarks || []
        };
      }
    },
    {
      name: 'browser.find_text',
      title: 'Find text',
      description: 'Finds visible text matches on the current page.',
      layer: 'browser-action',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          maxMatches: { type: 'number' }
        },
        required: ['query']
      },
      async execute() {
        return {
          status: 'extension-bridge-required',
          message: 'This action must be executed by the extension content script.'
        };
      }
    },
    {
      name: 'browser.highlight_text',
      title: 'Highlight text',
      description: 'Highlights visible text matches on the current page with a temporary overlay.',
      layer: 'browser-action',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          maxMatches: { type: 'number' }
        },
        required: ['query']
      },
      async execute() {
        return {
          status: 'extension-bridge-required',
          message: 'This action must be executed by the extension content script.'
        };
      }
    },
    {
      name: 'browser.scroll_to_text',
      title: 'Scroll to text',
      description: 'Scrolls the current page to the first visible text match.',
      layer: 'browser-action',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        },
        required: ['query']
      },
      async execute() {
        return {
          status: 'extension-bridge-required',
          message: 'This action must be executed by the extension content script.'
        };
      }
    },
    {
      name: 'browser.read_selected_text',
      title: 'Read selected text',
      description: 'Reads the current selected text from the active page.',
      layer: 'browser-action',
      risk: 'low',
      async execute(input: BrowserActionContext) {
        return {
          selection: input.pageContext?.selection || null
        };
      }
    },
    {
      name: 'browser.search_web',
      title: 'Search web',
      description: 'Opens a search results page in an agent-created tab and extracts visible result links.',
      layer: 'browser-action',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          engine: { type: 'string', enum: ['google', 'bing', 'scholar'] },
          readTopResults: { type: 'boolean' },
          maxPages: { type: 'number' },
          keepTabsOpen: { type: 'boolean' }
        },
        required: ['query']
      },
      async execute() {
        return {
          status: 'extension-background-required',
          message: 'This action must be executed by the extension background service worker.'
        };
      }
    },
    {
      name: 'browser.extract_search_results',
      title: 'Extract search results',
      description: 'Extracts ranked result titles, URLs, and snippets from a search results page.',
      layer: 'browser-action',
      risk: 'low',
      async execute() {
        return {
          status: 'extension-bridge-required',
          message: 'This action must be executed by the extension content script.'
        };
      }
    },
    {
      name: 'browser.read_page_content',
      title: 'Read page content',
      description: 'Reads the current page readable text, title, description, and headings.',
      layer: 'browser-action',
      risk: 'low',
      async execute() {
        return {
          status: 'extension-bridge-required',
          message: 'This action must be executed by the extension content script.'
        };
      }
    }
  ];
}
