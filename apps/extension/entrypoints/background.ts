import { browser } from 'wxt/browser';
import type {
  AgentToolCall,
  AgentToolResult,
  BrowserPageContentResult,
  BrowserSearchResult,
  BrowserSearchWebInput,
  ChatPlanResponse,
  ChatReplanResponse,
  ChatStreamEvent,
  ChatStreamRequest
} from '@bac/shared';
import type { BrowserActionRequest, BrowserActionResponse, ChatMessage, ContextScope } from '@bac/shared';
import { API_BASE_URL } from '../src/env';

type ChatPortRequest =
  | { type: 'start'; request: ChatStreamRequest }
  | { type: 'cancel' }
  | { type: 'confirm_tool'; toolCallId: string }
  | { type: 'reject_tool'; toolCallId: string };

type ChatPortResponse =
  | { type: 'event'; event: ChatStreamEvent }
  | { type: 'error'; message: string };

type RuntimePort = ReturnType<typeof browser.runtime.connect>;

interface PersistedTabConversation {
  conversationId?: string;
  contextScope: ContextScope;
  messages: ChatMessage[];
  updatedAt: string;
}

type TabConversationMessage =
  | { type: 'get-tab-conversation' }
  | { type: 'set-tab-conversation'; payload: PersistedTabConversation }
  | { type: 'execute-browser-action'; request: BrowserActionRequest }
  | { type: 'open-agent-tab'; url: string };

const debugLoggingKey = 'bac.debugLogging';
const legacyGlobalConversationKey = 'bac.globalConversation';
const tabConversationKeyPrefix = 'bac.tabConversation.';
let debugLoggingEnabled = false;

type ToolConfirmationRequest = (call: AgentToolCall) => Promise<boolean>;
type ToolProgressReporter = (event: {
  id: string;
  summary: string;
  toolName: BrowserActionRequest['action'];
  status: 'running' | 'success' | 'error';
  output?: unknown;
  error?: string;
}) => void;

async function hydrateDebugLogging() {
  try {
    const stored = await browser.storage.local.get(debugLoggingKey);
    debugLoggingEnabled = stored[debugLoggingKey] === true;
  } catch {
    debugLoggingEnabled = false;
  }
}

function debugLog(message: string, details?: unknown) {
  if (!debugLoggingEnabled) return;
  console.debug('[Browser Agent Copilot][background]', message, details ?? '');
}

function createHttpErrorMessage(status: number, statusText: string) {
  if (status === 404) {
    return `本地 API 未找到 /chat/stream 接口，请确认服务版本和扩展版本一致。`;
  }
  if (status === 401 || status === 403) {
    return `本地 API 拒绝了请求，请检查后端的模型 API Key 配置。`;
  }
  if (status >= 500) {
    return `本地 API 返回 ${status} ${statusText || ''}，请查看后端日志。`.trim();
  }
  return `本地 API 返回 ${status} ${statusText || ''}，请求未完成。`.trim();
}

function normalizeStreamError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return `无法连接本地 API（${API_BASE_URL}）。请确认后端服务已启动。`;
  }
  return message || '流式请求失败，请稍后重试。';
}

function getTabConversationKey(tabId: number) {
  return `${tabConversationKeyPrefix}${tabId}`;
}

function getSenderTabId(sender: { tab?: { id?: number } }) {
  return sender.tab?.id;
}

async function getStoredTabConversation(tabId: number) {
  const tabKey = getTabConversationKey(tabId);
  const stored = await browser.storage.local.get([tabKey, legacyGlobalConversationKey]);
  const state = stored[tabKey] || stored[legacyGlobalConversationKey];
  if (!stored[tabKey] && state) {
    await browser.storage.local.set({ [tabKey]: state });
  }
  return state as PersistedTabConversation | undefined;
}

async function inheritConversationToTab(parentTabId: number, childTabId: number) {
  const state = await getStoredTabConversation(parentTabId);
  if (!state) return false;

  await browser.storage.local.set({
    [getTabConversationKey(childTabId)]: {
      ...state,
      updatedAt: new Date().toISOString()
    }
  });
  return true;
}

function normalizeAgentTabUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error('Agent tab URL is required.');
  }

  const parsed = new URL(trimmed);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Agent tabs only support http and https URLs.');
  }
  return parsed.toString();
}

function normalizeSearchInput(input: unknown): BrowserSearchWebInput {
  const value = input as Partial<BrowserSearchWebInput> | undefined;
  const maxPages = typeof value?.maxPages === 'number' ? Math.min(Math.max(Math.round(value.maxPages), 1), 8) : 3;
  return {
    query: typeof value?.query === 'string' ? value.query.trim() : '',
    engine: value?.engine === 'bing' || value?.engine === 'scholar' ? value.engine : 'google',
    inheritConversation: value?.inheritConversation !== false,
    readTopResults: value?.readTopResults === true,
    maxPages,
    keepTabsOpen: value?.keepTabsOpen !== false
  };
}

function createSearchUrl(input: BrowserSearchWebInput) {
  if (!input.query) {
    throw new Error('搜索关键词不能为空。');
  }

  const encoded = encodeURIComponent(input.query);
  if (input.engine === 'bing') {
    return `https://www.bing.com/search?q=${encoded}`;
  }
  if (input.engine === 'scholar') {
    return `https://scholar.google.com/scholar?q=${encoded}`;
  }
  return `https://www.google.com/search?q=${encoded}`;
}

async function waitForTabComplete(tabId: number, timeoutMs = 12000) {
  const current = await browser.tabs.get(tabId).catch(() => undefined);
  if (current?.status === 'complete') return;

  await new Promise<void>((resolve) => {
    const timeout = globalThis.setTimeout(() => {
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      globalThis.clearTimeout(timeout);
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    browser.tabs.onUpdated.addListener(listener);
  });
}

function normalizeHttpUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http and https URLs can be opened by the agent.');
  }
  return url.toString();
}

function getSearchResultsFromOutput(output: unknown): BrowserSearchResult[] {
  const value = output as { results?: unknown } | undefined;
  if (!Array.isArray(value?.results)) return [];

  return value.results
    .map((item) => item as Partial<BrowserSearchResult>)
    .filter((item): item is BrowserSearchResult => {
      return (
        typeof item.rank === 'number' &&
        typeof item.title === 'string' &&
        typeof item.url === 'string' &&
        item.title.trim().length > 0 &&
        item.url.trim().length > 0
      );
    });
}

async function readPageContentFromTab(tabId: number): Promise<BrowserPageContentResult> {
  const response = (await browser.tabs.sendMessage(tabId, {
    type: 'bac-execute-browser-action',
    request: {
      action: 'browser.read_page_content'
    }
  })) as BrowserActionResponse<BrowserPageContentResult>;

  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.output;
}

async function readTopSearchResultPages(options: {
  parentTabId: number;
  openerTabId: number;
  searchResultsOutput: unknown;
  maxPages: number;
  inheritConversation: boolean;
  keepTabsOpen: boolean;
  progressPrefix?: string;
  onProgress?: ToolProgressReporter;
}) {
  const results = getSearchResultsFromOutput(options.searchResultsOutput).slice(0, options.maxPages);
  const pages: Array<{
    rank: number;
    title: string;
    url: string;
    source?: string;
    tabId?: number;
    content?: BrowserPageContentResult;
    error?: string;
  }> = [];

  for (const result of results) {
    const progressId = `${options.progressPrefix || 'search'}:read:${result.rank}`;
    options.onProgress?.({
      id: progressId,
      toolName: 'browser.read_page_content',
      summary: `阅读结果 ${result.rank}：${result.title}`,
      status: 'running'
    });

    let tabId: number | undefined;
    try {
      const url = normalizeHttpUrl(result.url);
      const tab = await browser.tabs.create({
        url,
        active: false,
        openerTabId: options.openerTabId
      });
      tabId = tab.id;

      if (typeof tabId !== 'number') {
        throw new Error('Agent result tab was not created.');
      }
      if (options.inheritConversation) {
        await inheritConversationToTab(options.parentTabId, tabId);
      }

      await waitForTabComplete(tabId, 15000);
      const content = await readPageContentFromTab(tabId);
      pages.push({
        rank: result.rank,
        title: result.title,
        url,
        source: result.source,
        tabId,
        content
      });
      options.onProgress?.({
        id: progressId,
        toolName: 'browser.read_page_content',
        summary: `阅读结果 ${result.rank}：${result.title}`,
        status: 'success'
      });

      if (!options.keepTabsOpen) {
        await browser.tabs.remove(tabId).catch(() => undefined);
      }
    } catch (error) {
      pages.push({
        rank: result.rank,
        title: result.title,
        url: result.url,
        source: result.source,
        tabId,
        error: error instanceof Error ? error.message : '页面正文读取失败。'
      });
      options.onProgress?.({
        id: progressId,
        toolName: 'browser.read_page_content',
        summary: `阅读结果 ${result.rank}：${result.title}`,
        status: 'error',
        error: error instanceof Error ? error.message : '页面正文读取失败。'
      });
      if (typeof tabId === 'number' && !options.keepTabsOpen) {
        await browser.tabs.remove(tabId).catch(() => undefined);
      }
    }
  }

  return pages;
}

async function executeSearchWebAction(
  parentTabId: number | undefined,
  input: unknown,
  progressPrefix?: string,
  onProgress?: ToolProgressReporter
) {
  if (typeof parentTabId !== 'number') {
    throw new Error('Unable to resolve the current tab for web search.');
  }

  const searchInput = normalizeSearchInput(input);
  const url = createSearchUrl(searchInput);
  const childTab = await browser.tabs.create({
    url,
    active: false,
    openerTabId: parentTabId
  });

  if (typeof childTab.id === 'number' && searchInput.inheritConversation) {
    await inheritConversationToTab(parentTabId, childTab.id);
  }

  const output: Record<string, unknown> = {
    query: searchInput.query,
    engine: searchInput.engine,
    url,
    tabId: childTab.id
  };

  if (typeof childTab.id === 'number') {
    await waitForTabComplete(childTab.id);
    try {
      const linksResponse = (await browser.tabs.sendMessage(childTab.id, {
        type: 'bac-execute-browser-action',
        request: {
          action: 'browser.extract_search_results'
        }
      })) as BrowserActionResponse;
      output.searchResults = linksResponse.ok ? linksResponse.output : undefined;
      output.linkExtractionError = linksResponse.ok ? undefined : linksResponse.error;

      if (linksResponse.ok && searchInput.readTopResults) {
        output.openedPages = await readTopSearchResultPages({
          parentTabId,
          openerTabId: childTab.id,
          searchResultsOutput: linksResponse.output,
          maxPages: searchInput.maxPages || 3,
          inheritConversation: searchInput.inheritConversation !== false,
          keepTabsOpen: searchInput.keepTabsOpen !== false,
          progressPrefix,
          onProgress
        });
      }
    } catch (error) {
      output.linkExtractionError = error instanceof Error ? error.message : '搜索结果链接读取失败。';
    }
  }

  return {
    ok: true,
    action: 'browser.search_web',
    output
  } satisfies BrowserActionResponse;
}

function emitSseFrames(buffer: string, emit: (event: ChatStreamEvent) => void) {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const frames = normalized.split('\n\n');
  const rest = frames.pop() ?? '';

  for (const frame of frames) {
    const dataLines = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.replace(/^data:\s?/, ''));

    if (!dataLines.length) continue;

    try {
      emit(JSON.parse(dataLines.join('\n')) as ChatStreamEvent);
    } catch (error) {
      debugLog('Unable to parse SSE frame.', { frame, error });
      emit({ type: 'error', message: '无法解析 API 流式响应，请查看调试日志。' });
    }
  }

  return rest;
}

function post(port: RuntimePort, message: ChatPortResponse) {
  try {
    port.postMessage(message);
  } catch {
    // The page may have navigated away while the model was streaming.
  }
}

function postAgentStep(
  port: RuntimePort,
  id: string,
  summary: string,
  status: 'running' | 'success' | 'error',
  detail?: string
) {
  post(port, {
    type: 'event',
    event: {
      type: 'tool_call',
      toolCall: {
        id,
        toolName: 'agent.replan',
        summary,
        risk: 'low',
        status,
        error: status === 'error' ? detail : undefined,
        output: status === 'success' && detail ? { detail } : undefined
      }
    }
  });
}

async function fetchToolPlan(request: ChatStreamRequest, signal: AbortSignal) {
  const response = await fetch(`${API_BASE_URL}/chat/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal
  });

  if (!response.ok) {
    throw new Error(createHttpErrorMessage(response.status, response.statusText));
  }

  const plan = (await response.json()) as ChatPlanResponse;
  return Array.isArray(plan.toolCalls) ? plan.toolCalls : [];
}

async function fetchToolReplan(
  request: ChatStreamRequest,
  toolResults: AgentToolResult[],
  iteration: number,
  signal: AbortSignal
) {
  const response = await fetch(`${API_BASE_URL}/chat/replan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...request,
      toolResults,
      iteration
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(createHttpErrorMessage(response.status, response.statusText));
  }

  const replan = (await response.json()) as ChatReplanResponse;
  return {
    rationale: replan.rationale,
    toolCalls: Array.isArray(replan.toolCalls) ? replan.toolCalls : []
  };
}

function shouldEvaluateReplan(toolResults: AgentToolResult[]) {
  return toolResults.some((result) => result.call.toolName === 'browser.search_web' && result.response.ok);
}

async function executePlannedToolCalls(
  port: RuntimePort,
  tabId: number | undefined,
  toolCalls: AgentToolCall[],
  request: ChatStreamRequest,
  signal: AbortSignal,
  requestConfirmation: ToolConfirmationRequest
) {
  const toolResults: AgentToolResult[] = [];
  const shouldShowWorkflow =
    toolCalls.length > 1 || toolCalls.some((call) => call.toolName === 'browser.search_web');

  for (const call of toolCalls) {
    if (shouldShowWorkflow) {
      post(port, {
        type: 'event',
        event: {
          type: 'tool_call',
          toolCall: {
            ...call,
            status: 'running'
          }
        }
      });
    }

    let response: BrowserActionResponse;
    try {
      if (call.risk !== 'low') {
        if (shouldShowWorkflow) {
          post(port, {
            type: 'event',
            event: {
              type: 'tool_call',
              toolCall: {
                ...call,
                status: 'waiting'
              }
            }
          });
        }

        const confirmed = await requestConfirmation(call);
        if (!confirmed) {
          response = {
            ok: false,
            action: call.toolName,
            error: '用户取消了需要确认的浏览器动作。'
          };
          toolResults.push({
            call,
            response,
            completedAt: new Date().toISOString()
          });
          if (shouldShowWorkflow) {
            post(port, {
              type: 'event',
              event: {
                type: 'tool_call',
                toolCall: {
                  ...call,
                  status: 'cancelled',
                  error: response.error
                }
              }
            });
          }
          break;
        }
      }

      if (typeof tabId !== 'number') {
        throw new Error('Unable to resolve the current tab for tool execution.');
      }
      if (signal.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }

      if (call.toolName === 'browser.search_web') {
        response = await executeSearchWebAction(tabId, call.input, call.id, (event) => {
          if (!shouldShowWorkflow) return;
          post(port, {
            type: 'event',
            event: {
              type: 'tool_call',
              toolCall: {
                id: event.id,
                toolName: event.toolName,
                summary: event.summary,
                risk: 'low',
                status: event.status,
                output: event.output,
                error: event.error
              }
            }
          });
        });
      } else {
        response = (await browser.tabs.sendMessage(tabId, {
          type: 'bac-execute-browser-action',
          request: {
            action: call.toolName,
            input:
              call.toolName === 'browser.read_selected_text' && request.context.selection
                ? { selection: request.context.selection }
                : call.input
          }
        })) as BrowserActionResponse;
      }
    } catch (error) {
      response = {
        ok: false,
        action: call.toolName,
        error: error instanceof Error ? error.message : 'Browser action bridge failed.'
      };
    }

    toolResults.push({
      call,
      response,
      completedAt: new Date().toISOString()
    });

    if (shouldShowWorkflow) {
      post(port, {
        type: 'event',
        event: {
          type: 'tool_call',
          toolCall: {
            ...call,
            status: response.ok ? 'success' : 'error',
            output: response.ok ? response.output : undefined,
            error: response.ok ? undefined : response.error
          }
        }
      });
    }
  }

  return toolResults;
}

async function streamChat(
  port: RuntimePort,
  request: ChatStreamRequest,
  signal: AbortSignal,
  tabId: number | undefined,
  requestConfirmation: ToolConfirmationRequest
) {
  debugLog('Starting chat stream.', {
    conversationId: request.conversationId,
    scope: request.scope,
    pageUrl: request.context.url,
    visibleTextLength: request.context.visibleText?.length ?? 0,
    fullTextLength: request.context.fullText?.length ?? 0
  });

  let toolResults: AgentToolResult[] = [];
  try {
    const toolCalls = await fetchToolPlan(request, signal);
    toolResults = await executePlannedToolCalls(port, tabId, toolCalls, request, signal, requestConfirmation);

    if (toolResults.length && shouldEvaluateReplan(toolResults) && !signal.aborted) {
      postAgentStep(port, 'agent:replan:1', '评估已读结果', 'running');
      const replan = await fetchToolReplan(request, toolResults, 0, signal);
      postAgentStep(
        port,
        'agent:replan:1',
        '评估已读结果',
        'success',
        replan.rationale || (replan.toolCalls.length ? '需要继续补充资料' : '已有资料足够回答')
      );

      if (replan.toolCalls.length && !signal.aborted) {
        const extraResults = await executePlannedToolCalls(
          port,
          tabId,
          replan.toolCalls,
          { ...request, toolResults },
          signal,
          requestConfirmation
        );
        toolResults = [...toolResults, ...extraResults];
      }
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw error;
    }
    debugLog('Tool planning failed; continuing with direct chat stream.', error);
  }

  const response = await fetch(`${API_BASE_URL}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toolResults.length ? { ...request, toolResults } : request),
    signal
  });

  if (!response.ok || !response.body) {
    throw new Error(createHttpErrorMessage(response.status, response.statusText));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;

  while (!done) {
    const result = await reader.read();
    done = result.done;
    buffer += decoder.decode(result.value, { stream: !done });
    buffer = emitSseFrames(buffer, (event) => post(port, { type: 'event', event }));
  }

  if (buffer.trim()) {
    emitSseFrames(`${buffer}\n\n`, (event) => post(port, { type: 'event', event }));
  }
}

export default defineBackground(() => {
  void hydrateDebugLogging();

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[debugLoggingKey]) return;
    debugLoggingEnabled = changes[debugLoggingKey].newValue === true;
    debugLog('Debug logging changed.', { enabled: debugLoggingEnabled });
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'bac-chat-stream') return;

    let abortController: AbortController | undefined;
    const pendingConfirmations = new Map<string, (confirmed: boolean) => void>();

    const resolvePendingConfirmation = (toolCallId: string, confirmed: boolean) => {
      const resolve = pendingConfirmations.get(toolCallId);
      if (!resolve) return;
      pendingConfirmations.delete(toolCallId);
      resolve(confirmed);
    };

    const requestConfirmation: ToolConfirmationRequest = (call) => {
      post(port, {
        type: 'event',
        event: {
          type: 'tool_confirmation',
          toolCall: {
            ...call,
            status: 'waiting'
          }
        }
      });

      return new Promise<boolean>((resolve) => {
        pendingConfirmations.set(call.id, resolve);
        abortController?.signal.addEventListener(
          'abort',
          () => {
            resolvePendingConfirmation(call.id, false);
          },
          { once: true }
        );
      });
    };

    port.onMessage.addListener((rawMessage) => {
      const message = rawMessage as ChatPortRequest;
      if (message.type === 'cancel') {
        debugLog('Cancelling chat stream.');
        for (const toolCallId of pendingConfirmations.keys()) {
          resolvePendingConfirmation(toolCallId, false);
        }
        abortController?.abort();
        return;
      }

      if (message.type === 'confirm_tool') {
        resolvePendingConfirmation(message.toolCallId, true);
        return;
      }

      if (message.type === 'reject_tool') {
        resolvePendingConfirmation(message.toolCallId, false);
        return;
      }

      if (message.type !== 'start') return;

      for (const toolCallId of pendingConfirmations.keys()) {
        resolvePendingConfirmation(toolCallId, false);
      }
      abortController?.abort();
      abortController = new AbortController();

      const tabId = getSenderTabId(port.sender ?? {});
      void streamChat(port, message.request, abortController.signal, tabId, requestConfirmation).catch((error) => {
        if ((error as Error).name === 'AbortError') return;
        debugLog('Chat stream failed.', error);
        post(port, {
          type: 'error',
          message: normalizeStreamError(error)
        });
      });
    });

    port.onDisconnect.addListener(() => {
      for (const toolCallId of pendingConfirmations.keys()) {
        resolvePendingConfirmation(toolCallId, false);
      }
      abortController?.abort();
      abortController = undefined;
    });
  });

  browser.runtime.onMessage.addListener(async (rawMessage: unknown, sender: { tab?: { id?: number } }) => {
    const message = rawMessage as TabConversationMessage;
    if (
      message.type !== 'get-tab-conversation' &&
      message.type !== 'set-tab-conversation' &&
      message.type !== 'execute-browser-action' &&
      message.type !== 'open-agent-tab'
    ) {
      return undefined;
    }

    const tabId = getSenderTabId(sender);
    if (typeof tabId !== 'number') {
      return { ok: false, error: 'Unable to resolve the current tab.' };
    }

    const tabKey = getTabConversationKey(tabId);

    try {
      if (message.type === 'execute-browser-action') {
        return browser.tabs.sendMessage(tabId, {
          type: 'bac-execute-browser-action',
          request: message.request
        }) as Promise<BrowserActionResponse>;
      }

      if (message.type === 'open-agent-tab') {
        const url = normalizeAgentTabUrl(message.url);
        const childTab = await browser.tabs.create({
          url,
          active: true,
          openerTabId: tabId
        });
        if (typeof childTab.id === 'number') {
          const inherited = await inheritConversationToTab(tabId, childTab.id);
          return { ok: true, tabId: childTab.id, inherited };
        }
        return { ok: true, inherited: false };
      }

      if (message.type === 'get-tab-conversation') {
        const state = await getStoredTabConversation(tabId);
        return { ok: true, state };
      }

      await browser.storage.local.set({ [tabKey]: message.payload });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Tab conversation storage failed.'
      };
    }
  });
});
