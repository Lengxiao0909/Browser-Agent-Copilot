import { browser } from 'wxt/browser';
import type { AgentToolCall, AgentToolResult, ChatPlanResponse, ChatStreamEvent, ChatStreamRequest } from '@bac/shared';
import type { BrowserActionRequest, BrowserActionResponse, ChatMessage, ContextScope } from '@bac/shared';
import { API_BASE_URL } from '../src/env';

type ChatPortRequest =
  | { type: 'start'; request: ChatStreamRequest }
  | { type: 'cancel' };

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
  | { type: 'execute-browser-action'; request: BrowserActionRequest };

const debugLoggingKey = 'bac.debugLogging';
const legacyGlobalConversationKey = 'bac.globalConversation';
const tabConversationKeyPrefix = 'bac.tabConversation.';
let debugLoggingEnabled = false;

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

async function executePlannedToolCalls(
  port: RuntimePort,
  tabId: number | undefined,
  toolCalls: AgentToolCall[]
) {
  const toolResults: AgentToolResult[] = [];

  for (const call of toolCalls) {
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

    let response: BrowserActionResponse;
    try {
      if (call.risk !== 'low') {
        throw new Error('此浏览器动作需要用户确认后才能执行。');
      }

      if (typeof tabId !== 'number') {
        throw new Error('Unable to resolve the current tab for tool execution.');
      }

      response = (await browser.tabs.sendMessage(tabId, {
        type: 'bac-execute-browser-action',
        request: {
          action: call.toolName,
          input: call.input
        }
      })) as BrowserActionResponse;
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

  return toolResults;
}

async function streamChat(
  port: RuntimePort,
  request: ChatStreamRequest,
  signal: AbortSignal,
  tabId?: number
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
    toolResults = await executePlannedToolCalls(port, tabId, toolCalls);
  } catch (error) {
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

    port.onMessage.addListener((rawMessage) => {
      const message = rawMessage as ChatPortRequest;
      if (message.type === 'cancel') {
        debugLog('Cancelling chat stream.');
        abortController?.abort();
        return;
      }

      if (message.type !== 'start') return;

      abortController?.abort();
      abortController = new AbortController();

      const tabId = getSenderTabId(port.sender ?? {});
      void streamChat(port, message.request, abortController.signal, tabId).catch((error) => {
        if ((error as Error).name === 'AbortError') return;
        debugLog('Chat stream failed.', error);
        post(port, {
          type: 'error',
          message: normalizeStreamError(error)
        });
      });
    });

    port.onDisconnect.addListener(() => {
      abortController?.abort();
      abortController = undefined;
    });
  });

  browser.runtime.onMessage.addListener(async (rawMessage: unknown, sender: { tab?: { id?: number } }) => {
    const message = rawMessage as TabConversationMessage;
    if (
      message.type !== 'get-tab-conversation' &&
      message.type !== 'set-tab-conversation' &&
      message.type !== 'execute-browser-action'
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

      if (message.type === 'get-tab-conversation') {
        const stored = await browser.storage.local.get([tabKey, legacyGlobalConversationKey]);
        const state = stored[tabKey] || stored[legacyGlobalConversationKey];
        if (!stored[tabKey] && state) {
          await browser.storage.local.set({ [tabKey]: state });
        }
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
