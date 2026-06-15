import { browser } from 'wxt/browser';
import { defineStore } from 'pinia';
import type {
  BrowserActionName,
  BrowserActionResponse,
  ChatMessage,
  ChatStreamEvent,
  ChatStreamRequest,
  ConversationDetail,
  ConversationSummary,
  ContextScope,
  LlmConfigTestResponse,
  LlmRuntimeConfig,
  PageContext,
  SelectionReference,
  ToolCallPreview,
  ToolRiskLevel
} from '@bac/shared';
import { API_BASE_URL } from '../env';

interface CapturedSelection {
  reference: SelectionReference;
  rect: DOMRect;
}

interface PersistedConversation {
  conversationId?: string;
  contextScope: ContextScope;
  messages: ChatMessage[];
  updatedAt: string;
}

interface LocalConversationRecord extends PersistedConversation {
  id: string;
  title: string;
  createdAt: string;
  pageUrl?: string;
  pageTitle?: string;
}

interface PendingToolConfirmation {
  action: BrowserActionName;
  input?: unknown;
  risk: Exclude<ToolRiskLevel, 'low'>;
  summary: string;
}

export interface UserLlmModel extends LlmRuntimeConfig {
  id: string;
  displayName: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

interface CopilotState {
  isOpen: boolean;
  isHydrated: boolean;
  debugLogging: boolean;
  clientId?: string;
  isConversationListOpen: boolean;
  isToolsOpen: boolean;
  isExecutingTool: boolean;
  toolError: string | null;
  toolCopyStatus: 'idle' | 'copied' | 'failed';
  lastToolResult: BrowserActionResponse | null;
  pendingToolConfirmation: PendingToolConfirmation | null;
  llmModels: UserLlmModel[];
  selectedLlmModelId?: string;
  isTestingLlmModel: boolean;
  llmConfigStatus: string | null;
  isLoadingConversations: boolean;
  conversationError: string | null;
  conversations: ConversationSummary[];
  messages: ChatMessage[];
  draft: string;
  selection: CapturedSelection | null;
  contextScope: ContextScope;
  isStreaming: boolean;
  streamError: string | null;
  conversationId?: string;
}

type ChatPortResponse =
  | { type: 'event'; event: ChatStreamEvent }
  | { type: 'error'; message: string };

type TabConversationResponse =
  | { ok: true; state?: PersistedConversation }
  | { ok: false; error?: string };

type OpenAgentTabResponse =
  | { ok: true; tabId?: number; inherited: boolean }
  | { ok: false; error?: string };

const debugLoggingKey = 'bac.debugLogging';
const clientIdKey = 'bac.clientId';
const llmModelsKey = 'bac.llmModels';
const selectedLlmModelIdKey = 'bac.selectedLlmModelId';
const localConversationHistoryKey = 'bac.localConversationHistory';
const maxPersistedMessages = 40;
const maxPersistedContentLength = 20000;
const maxPersistedContextTextLength = 12000;
const maxLocalConversationHistory = 50;
let storageListenerInstalled = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let activePort: ReturnType<typeof browser.runtime.connect> | undefined;

function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function compactMessages(messages: ChatMessage[]) {
  return messages.slice(-maxPersistedMessages).map((message) => ({
    ...message,
    context: message.context ? compactPageContext(message.context) : undefined,
    content:
      message.content.length > maxPersistedContentLength
        ? `${message.content.slice(0, maxPersistedContentLength)}\n\n[Content truncated locally]`
        : message.content
  }));
}

function compactText(text?: string, limit = maxPersistedContextTextLength) {
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[Context truncated locally]`;
}

function compactPageContext(context: PageContext): PageContext {
  return {
    ...context,
    visibleText: compactText(context.visibleText),
    fullText: compactText(context.fullText),
    selection: context.selection
      ? {
          ...context.selection,
          text: compactText(context.selection.text, 4000) || ''
        }
      : undefined
  };
}

function stopActiveStream() {
  activePort?.postMessage({ type: 'cancel' });
  activePort?.disconnect();
  activePort = undefined;
}

function debugLog(enabled: boolean, message: string, details?: unknown) {
  if (!enabled) return;
  console.debug('[Browser Agent Copilot][content]', message, details ?? '');
}

function getApiErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return '无法连接本地 API，会话列表暂时不可用。';
  }
  return message || '会话请求失败，请稍后重试。';
}

async function fetchJson<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers
    }
  });

  if (!response.ok) {
    throw new Error(`会话服务返回 ${response.status}。`);
  }

  return response.json() as Promise<T>;
}

async function getTabConversationState() {
  return browser.runtime.sendMessage({ type: 'get-tab-conversation' }) as Promise<TabConversationResponse>;
}

async function setTabConversationState(payload: PersistedConversation) {
  return browser.runtime.sendMessage({
    type: 'set-tab-conversation',
    payload
  }) as Promise<TabConversationResponse>;
}

async function requestOpenAgentTab(url: string) {
  return browser.runtime.sendMessage({
    type: 'open-agent-tab',
    url
  }) as Promise<OpenAgentTabResponse>;
}

async function getOrCreateClientId() {
  const stored = await browser.storage.local.get(clientIdKey);
  const existing = stored[clientIdKey];
  if (typeof existing === 'string' && existing) {
    return existing;
  }

  const nextClientId = createId('client');
  await browser.storage.local.set({ [clientIdKey]: nextClientId });
  return nextClientId;
}

function sanitizeLlmModel(value: unknown): UserLlmModel | null {
  const model = value as Partial<UserLlmModel> | undefined;
  if (
    typeof model?.id !== 'string' ||
    typeof model.displayName !== 'string' ||
    typeof model.providerName !== 'string' ||
    typeof model.baseUrl !== 'string' ||
    typeof model.apiKey !== 'string' ||
    typeof model.model !== 'string'
  ) {
    return null;
  }

  return {
    id: model.id,
    displayName: model.displayName,
    providerName: model.providerName,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
    model: model.model,
    createdAt: typeof model.createdAt === 'string' ? model.createdAt : new Date().toISOString(),
    updatedAt: typeof model.updatedAt === 'string' ? model.updatedAt : new Date().toISOString()
  };
}

function normalizeHistoryText(text?: string) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function deriveLocalConversationTitle(messages: ChatMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === 'user' && message.content.trim());
  const title = normalizeHistoryText(firstUserMessage?.content);
  if (title) {
    return title.length > 34 ? `${title.slice(0, 34)}...` : title;
  }

  const pageTitle = messages.find((message) => message.context?.title)?.context?.title;
  return normalizeHistoryText(pageTitle) || '新对话';
}

function getLastVisibleMessage(messages: ChatMessage[]) {
  return [...messages]
    .reverse()
    .find((message) => (message.role === 'user' || message.role === 'assistant') && message.content.trim());
}

function getLatestPageContext(messages: ChatMessage[]) {
  return [...messages].reverse().find((message) => message.context)?.context;
}

function sanitizeLocalConversationRecord(value: unknown): LocalConversationRecord | null {
  const record = value as Partial<LocalConversationRecord> | undefined;
  if (
    typeof record?.id !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string' ||
    !Array.isArray(record.messages)
  ) {
    return null;
  }

  return {
    id: record.id,
    conversationId: typeof record.conversationId === 'string' ? record.conversationId : record.id,
    contextScope:
      record.contextScope === 'selection' || record.contextScope === 'full-page'
        ? record.contextScope
        : 'visible-page',
    messages: record.messages.filter((message): message is ChatMessage => {
      const item = message as Partial<ChatMessage>;
      return (
        typeof item?.id === 'string' &&
        typeof item.role === 'string' &&
        typeof item.content === 'string' &&
        typeof item.createdAt === 'string'
      );
    }),
    updatedAt: record.updatedAt,
    createdAt: record.createdAt,
    title: record.title,
    pageUrl: typeof record.pageUrl === 'string' ? record.pageUrl : undefined,
    pageTitle: typeof record.pageTitle === 'string' ? record.pageTitle : undefined
  };
}

function sanitizeLocalConversationHistory(value: unknown) {
  return Array.isArray(value)
    ? value
        .map(sanitizeLocalConversationRecord)
        .filter((record): record is LocalConversationRecord => Boolean(record))
    : [];
}

async function readLocalConversationHistory() {
  const stored = await browser.storage.local.get(localConversationHistoryKey);
  return sanitizeLocalConversationHistory(stored[localConversationHistoryKey]);
}

async function writeLocalConversationHistory(records: LocalConversationRecord[]) {
  await browser.storage.local.set({
    [localConversationHistoryKey]: records.slice(0, maxLocalConversationHistory)
  });
}

function localRecordToSummary(record: LocalConversationRecord): ConversationSummary {
  const lastMessage = getLastVisibleMessage(record.messages);
  return {
    id: record.id,
    title: record.title || deriveLocalConversationTitle(record.messages),
    pageUrl: record.pageUrl,
    pageTitle: record.pageTitle,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messageCount: record.messages.length,
    lastMessage: lastMessage
      ? {
          role: lastMessage.role,
          content: lastMessage.content,
          createdAt: lastMessage.createdAt
        }
      : undefined
  };
}

function mergeConversationSummaries(
  localSummaries: ConversationSummary[],
  serverSummaries: ConversationSummary[]
) {
  const byId = new Map<string, ConversationSummary>();

  for (const summary of serverSummaries) {
    byId.set(summary.id, summary);
  }

  for (const summary of localSummaries) {
    byId.set(summary.id, {
      ...byId.get(summary.id),
      ...summary
    });
  }

  return [...byId.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

async function upsertLocalConversationHistory(payload: PersistedConversation) {
  if (!payload.conversationId || !payload.messages.some((message) => message.content.trim())) return;

  const history = await readLocalConversationHistory();
  const existing = history.find((record) => record.id === payload.conversationId);
  const pageContext = getLatestPageContext(payload.messages);
  const nextRecord: LocalConversationRecord = {
    id: payload.conversationId,
    conversationId: payload.conversationId,
    contextScope: payload.contextScope,
    messages: payload.messages,
    updatedAt: payload.updatedAt,
    createdAt: existing?.createdAt || payload.messages[0]?.createdAt || payload.updatedAt,
    title: deriveLocalConversationTitle(payload.messages),
    pageUrl: pageContext?.url || existing?.pageUrl,
    pageTitle: pageContext?.title || existing?.pageTitle
  };

  await writeLocalConversationHistory([
    nextRecord,
    ...history.filter((record) => record.id !== payload.conversationId)
  ]);
}

function sanitizeLlmModels(value: unknown) {
  return Array.isArray(value)
    ? value.map(sanitizeLlmModel).filter((model): model is UserLlmModel => Boolean(model))
    : [];
}

function toRuntimeLlmConfig(model?: UserLlmModel): LlmRuntimeConfig | undefined {
  if (!model) return undefined;
  return {
    providerName: model.providerName,
    displayName: model.displayName,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
    model: model.model
  };
}

export const useCopilotStore = defineStore('copilot', {
  state: (): CopilotState => ({
    isOpen: false,
    isHydrated: false,
    debugLogging: false,
    isConversationListOpen: false,
    isToolsOpen: false,
    isExecutingTool: false,
    toolError: null,
    toolCopyStatus: 'idle',
    lastToolResult: null,
    pendingToolConfirmation: null,
    llmModels: [],
    selectedLlmModelId: undefined,
    isTestingLlmModel: false,
    llmConfigStatus: null,
    isLoadingConversations: false,
    conversationError: null,
    conversations: [],
    messages: [],
    draft: '',
    selection: null,
    contextScope: 'visible-page',
    isStreaming: false,
    streamError: null
  }),

  actions: {
    async hydrate() {
      if (this.isHydrated) return;

      try {
        const stored = await browser.storage.local.get([
          debugLoggingKey,
          clientIdKey,
          llmModelsKey,
          selectedLlmModelIdKey
        ]);
        this.debugLogging = stored[debugLoggingKey] === true;
        this.clientId = await getOrCreateClientId();
        this.llmModels = sanitizeLlmModels(stored[llmModelsKey]);
        const selectedModelId = stored[selectedLlmModelIdKey];
        this.selectedLlmModelId =
          typeof selectedModelId === 'string' && this.llmModels.some((model) => model.id === selectedModelId)
            ? selectedModelId
            : this.llmModels[0]?.id;

        const tabState = await getTabConversationState();
        if (tabState.ok && tabState.state) {
          this.conversationId = tabState.state.conversationId;
          this.messages = tabState.state.messages || [];
          this.contextScope = tabState.state.contextScope || 'visible-page';
        }
      } catch (error) {
        this.streamError = (error as Error).message || '恢复本地对话失败。';
      }

      this.isHydrated = true;
      this.installStorageSync();
    },

    installStorageSync() {
      if (storageListenerInstalled) return;
      storageListenerInstalled = true;

      browser.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;

        if (changes[debugLoggingKey]) {
          this.debugLogging = changes[debugLoggingKey].newValue === true;
          debugLog(this.debugLogging, 'Debug logging changed.', { enabled: this.debugLogging });
        }

        if (changes[clientIdKey]) {
          const nextClientId = changes[clientIdKey].newValue;
          this.clientId = typeof nextClientId === 'string' ? nextClientId : this.clientId;
        }

        if (changes[llmModelsKey]) {
          this.llmModels = sanitizeLlmModels(changes[llmModelsKey].newValue);
          if (this.selectedLlmModelId && !this.llmModels.some((model) => model.id === this.selectedLlmModelId)) {
            this.selectedLlmModelId = this.llmModels[0]?.id;
          }
        }

        if (changes[selectedLlmModelIdKey]) {
          const nextSelectedModelId = changes[selectedLlmModelIdKey].newValue;
          this.selectedLlmModelId =
            typeof nextSelectedModelId === 'string' ? nextSelectedModelId : this.selectedLlmModelId;
        }
      });
    },

    persistConversationSoon() {
      if (persistTimer) {
        clearTimeout(persistTimer);
      }

      persistTimer = setTimeout(() => {
        void this.persistConversation();
      }, 250);
    },

    async persistConversation() {
      const payload: PersistedConversation = {
        conversationId: this.conversationId,
        contextScope: this.contextScope,
        messages: compactMessages(this.messages),
        updatedAt: new Date().toISOString()
      };

      try {
        const response = await setTabConversationState(payload);
        if (!response.ok) {
          throw new Error(response.error || '保存当前标签页对话失败。');
        }
      } catch (error) {
        this.streamError = (error as Error).message || '保存本地对话失败。';
      }

      try {
        await upsertLocalConversationHistory(payload);
      } catch (error) {
        debugLog(this.debugLogging, 'Persisting local conversation history failed.', {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    },

    open() {
      this.isOpen = true;
    },

    close() {
      this.isOpen = false;
    },

    async setDebugLogging(enabled: boolean) {
      this.debugLogging = enabled;
      await browser.storage.local.set({ [debugLoggingKey]: enabled });
      debugLog(this.debugLogging, 'Debug logging changed.', { enabled });
    },

    async toggleDebugLogging() {
      await this.setDebugLogging(!this.debugLogging);
    },

    getSelectedLlmModel() {
      return this.llmModels.find((model) => model.id === this.selectedLlmModelId);
    },

    async selectLlmModel(modelId: string) {
      if (!this.llmModels.some((model) => model.id === modelId)) return;
      this.selectedLlmModelId = modelId;
      this.llmConfigStatus = null;
      await browser.storage.local.set({ [selectedLlmModelIdKey]: modelId });
    },

    clearLlmConfigStatus() {
      this.llmConfigStatus = null;
    },

    async saveLlmModel(input: {
      id?: string;
      displayName: string;
      providerName: string;
      baseUrl: string;
      apiKey: string;
      model: string;
    }) {
      const now = new Date().toISOString();
      const existing = input.id ? this.llmModels.find((model) => model.id === input.id) : undefined;
      const nextModel: UserLlmModel = {
        id: existing?.id || createId('llm'),
        displayName: input.displayName.trim(),
        providerName: input.providerName.trim(),
        baseUrl: input.baseUrl.trim(),
        apiKey: input.apiKey.trim(),
        model: input.model.trim(),
        createdAt: existing?.createdAt || now,
        updatedAt: now
      };

      if (!nextModel.displayName || !nextModel.providerName || !nextModel.baseUrl || !nextModel.apiKey || !nextModel.model) {
        this.llmConfigStatus = '请完整填写模型名称、厂商、URL、API Key 和模型。';
        return null;
      }

      const nextModels = existing
        ? this.llmModels.map((model) => (model.id === existing.id ? nextModel : model))
        : [nextModel, ...this.llmModels];

      this.llmModels = nextModels;
      this.selectedLlmModelId = nextModel.id;
      this.llmConfigStatus = '已保存并选中该模型。';
      await browser.storage.local.set({
        [llmModelsKey]: nextModels,
        [selectedLlmModelIdKey]: nextModel.id
      });
      return nextModel;
    },

    async testLlmModel(input: {
      displayName?: string;
      providerName?: string;
      baseUrl: string;
      apiKey: string;
      model: string;
    }) {
      if (!input.baseUrl.trim() || !input.apiKey.trim() || !input.model.trim()) {
        const response = { ok: false, message: '请先填写 URL、API Key 和模型。' };
        this.llmConfigStatus = response.message;
        return response;
      }

      this.isTestingLlmModel = true;
      this.llmConfigStatus = null;

      try {
        const response = await fetchJson<LlmConfigTestResponse>('/chat/test-model', {
          method: 'POST',
          body: JSON.stringify({
            displayName: input.displayName,
            providerName: input.providerName,
            baseUrl: input.baseUrl.trim(),
            apiKey: input.apiKey.trim(),
            model: input.model.trim()
          })
        });
        this.llmConfigStatus = response.message;
        return response;
      } catch {
        const response = { ok: false, message: '连接测试失败，请检查模型配置。' };
        this.llmConfigStatus = response.message;
        return response;
      } finally {
        this.isTestingLlmModel = false;
      }
    },

    async openConversationList() {
      this.isConversationListOpen = true;
      await this.loadConversations();
    },

    closeConversationList() {
      this.isConversationListOpen = false;
    },

    async toggleConversationList() {
      if (this.isConversationListOpen) {
        this.closeConversationList();
        return;
      }

      await this.openConversationList();
    },

    toggleTools() {
      this.isToolsOpen = !this.isToolsOpen;
    },

    async executeBrowserAction(
      action: BrowserActionName,
      input?: unknown,
      options?: {
        risk?: ToolRiskLevel;
        summary?: string;
        confirmed?: boolean;
      }
    ) {
      const risk = options?.risk || 'low';

      if (risk !== 'low' && !options?.confirmed) {
        this.pendingToolConfirmation = {
          action,
          input,
          risk,
          summary: options?.summary || action
        };
        this.toolError = null;
        return {
          ok: false,
          action,
          error: '此浏览器动作需要确认后才能执行。'
        } satisfies BrowserActionResponse;
      }

      this.isExecutingTool = true;
      this.toolError = null;
      this.toolCopyStatus = 'idle';
      this.pendingToolConfirmation = null;

      try {
        const response = (await browser.runtime.sendMessage({
          type: 'execute-browser-action',
          request: {
            action,
            input,
            risk,
            summary: options?.summary,
            confirmed: options?.confirmed
          }
        })) as BrowserActionResponse;

        this.lastToolResult = response;
        if (!response.ok) {
          this.toolError = response.error;
        }
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : '页面工具执行失败。';
        this.toolError = message;
        this.lastToolResult = { ok: false, action, error: message };
        return this.lastToolResult;
      } finally {
        this.isExecutingTool = false;
      }
    },

    async confirmPendingToolAction() {
      const pending = this.pendingToolConfirmation;
      if (!pending) return;

      await this.executeBrowserAction(pending.action, pending.input, {
        risk: pending.risk,
        summary: pending.summary,
        confirmed: true
      });
    },

    rejectPendingToolAction() {
      this.pendingToolConfirmation = null;
      this.toolError = null;
    },

    async openAgentTab(url: string) {
      try {
        const response = await requestOpenAgentTab(url);
        if (!response.ok) {
          throw new Error(response.error || 'Agent 新标签页创建失败。');
        }
        return response;
      } catch (error) {
        this.toolError = error instanceof Error ? error.message : 'Agent 新标签页创建失败。';
        return {
          ok: false,
          error: this.toolError
        } satisfies OpenAgentTabResponse;
      }
    },

    async copyLastToolResult() {
      if (!this.lastToolResult) return;

      const content = this.lastToolResult.ok
        ? JSON.stringify(this.lastToolResult.output, null, 2)
        : this.lastToolResult.error;

      try {
        await navigator.clipboard.writeText(content);
        this.toolCopyStatus = 'copied';
        window.setTimeout(() => {
          if (this.toolCopyStatus === 'copied') {
            this.toolCopyStatus = 'idle';
          }
        }, 1600);
      } catch {
        this.toolCopyStatus = 'failed';
      }
    },

    async loadConversations() {
      await this.hydrate();
      if (!this.clientId || this.isLoadingConversations) return;

      this.isLoadingConversations = true;
      this.conversationError = null;

      try {
        const localSummaries = (await readLocalConversationHistory()).map(localRecordToSummary);
        this.conversations = localSummaries;

        try {
          const serverSummaries = await fetchJson<ConversationSummary[]>(
            `/conversations?clientId=${encodeURIComponent(this.clientId)}`
          );
          this.conversations = mergeConversationSummaries(localSummaries, serverSummaries);
        } catch (error) {
          debugLog(this.debugLogging, 'Loading server conversation history failed; using local history.', {
            message: error instanceof Error ? error.message : String(error)
          });
        }
      } catch {
        this.conversationError = '历史记录暂时不可用，请稍后重试。';
      } finally {
        this.isLoadingConversations = false;
      }
    },

    async selectConversation(conversationId: string) {
      await this.hydrate();
      if (!this.clientId || this.isStreaming) return;

      this.conversationError = null;

      try {
        const localConversation = (await readLocalConversationHistory()).find(
          (record) => record.id === conversationId || record.conversationId === conversationId
        );

        if (localConversation) {
          this.conversationId = localConversation.conversationId || localConversation.id;
          this.messages = localConversation.messages;
          this.contextScope = localConversation.contextScope;
          this.draft = '';
          this.streamError = null;
          await this.persistConversation();
          this.closeConversationList();
          return;
        }

        const conversation = await fetchJson<ConversationDetail>(
          `/conversations/${encodeURIComponent(conversationId)}?clientId=${encodeURIComponent(
            this.clientId
          )}`
        );
        this.conversationId = conversation.id;
        this.messages = conversation.messages;
        this.draft = '';
        this.streamError = null;
        await this.persistConversation();
        this.closeConversationList();
      } catch (error) {
        this.conversationError = getApiErrorMessage(error);
      }
    },

    async renameConversation(conversationId: string, title: string) {
      const nextTitle = title.trim();
      if (!nextTitle) return;

      this.conversationError = null;

      try {
        await fetchJson(`/conversations/${encodeURIComponent(conversationId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ title: nextTitle })
        });
        await this.loadConversations();
      } catch (error) {
        this.conversationError = getApiErrorMessage(error);
      }
    },

    async deleteConversation(conversationId: string) {
      this.conversationError = null;

      try {
        await fetchJson(`/conversations/${encodeURIComponent(conversationId)}`, {
          method: 'DELETE'
        });
        if (this.conversationId === conversationId) {
          await this.startNewConversation();
        }
        await this.loadConversations();
      } catch (error) {
        this.conversationError = getApiErrorMessage(error);
      }
    },

    async startNewConversation() {
      if (this.isStreaming) {
        stopActiveStream();
        this.isStreaming = false;
      }

      this.conversationId = undefined;
      this.messages = [];
      this.draft = '';
      this.streamError = null;
      this.selection = null;
      this.contextScope = 'visible-page';
      await this.persistConversation();
      if (this.isConversationListOpen) {
        await this.loadConversations();
      }
    },

    async clearCurrentConversation() {
      if (this.isStreaming) {
        stopActiveStream();
        this.isStreaming = false;
      }

      this.messages = [];
      this.draft = '';
      this.streamError = null;
      await this.persistConversation();
    },

    setSelection(selection: CapturedSelection) {
      this.selection = selection;
    },

    clearSelection() {
      this.selection = null;
      if (this.contextScope === 'selection') {
        this.contextScope = 'visible-page';
      }
    },

    setContextScope(scope: ContextScope) {
      this.contextScope = scope;
      this.persistConversationSoon();
    },

    async sendCurrentDraft(context: PageContext) {
      await this.hydrate();

      const content = this.draft.trim();
      if (!content || this.isStreaming) return;
      await this.sendMessageContent(content, context, true);
    },

    async sendMessageContent(content: string, context: PageContext, appendUserMessage: boolean) {
      if (!content || this.isStreaming) return;

      this.streamError = null;
      this.draft = '';

      const userMessage: ChatMessage = {
        id: createId('user'),
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
        context,
        contextScope: this.contextScope
      };

      if (appendUserMessage) {
        this.messages.push(userMessage);
      }
      let assistantIndex = -1;
      let assistantMessageId = createId('assistant');
      this.isStreaming = true;
      this.persistConversationSoon();

      const request: ChatStreamRequest = {
        clientId: this.clientId,
        conversationId: this.conversationId,
        message: content,
        context,
        scope: this.contextScope,
        llmConfig: toRuntimeLlmConfig(this.getSelectedLlmModel())
      };

      debugLog(this.debugLogging, 'Sending chat message.', {
        clientId: this.clientId,
        conversationId: this.conversationId,
        scope: this.contextScope,
        pageUrl: context.url,
        visibleTextLength: context.visibleText?.length ?? 0,
        fullTextLength: context.fullText?.length ?? 0,
        selectedTextLength: context.selection?.text.length ?? 0
      });

      const ensureAssistantMessage = () => {
        if (assistantIndex >= 0 && this.messages[assistantIndex]) {
          return assistantIndex;
        }

        const assistantMessage: ChatMessage = {
          id: assistantMessageId,
          role: 'assistant',
          content: '',
          createdAt: new Date().toISOString()
        };
        this.messages.push(assistantMessage);
        assistantIndex = this.messages.length - 1;
        return assistantIndex;
      };

      const appendAssistantContent = (contentDelta: string) => {
        const nextAssistantIndex = ensureAssistantMessage();
        const current = this.messages[nextAssistantIndex];
        if (!current) return;

        this.messages[nextAssistantIndex] = {
          ...current,
          content: `${current.content}${contentDelta}`
        };
        this.persistConversationSoon();
      };

      const updateAssistantId = (messageId: string) => {
        assistantMessageId = messageId;
        if (assistantIndex < 0) return;
        const current = this.messages[assistantIndex];
        if (!current) return;

        this.messages[assistantIndex] = {
          ...current,
          id: messageId
        };
        this.persistConversationSoon();
      };

      const updateAssistantToolCall = (toolCall: ToolCallPreview) => {
        const nextAssistantIndex = ensureAssistantMessage();
        const current = this.messages[nextAssistantIndex];
        if (!current) return;

        const key = toolCall.id || `${toolCall.toolName}:${toolCall.summary}`;
        const existingToolCalls = current.toolCalls || [];
        const existingIndex = existingToolCalls.findIndex(
          (item) => (item.id || `${item.toolName}:${item.summary}`) === key
        );
        const nextToolCalls = [...existingToolCalls];
        if (existingIndex >= 0) {
          nextToolCalls[existingIndex] = {
            ...nextToolCalls[existingIndex],
            ...toolCall
          };
        } else {
          nextToolCalls.push(toolCall);
        }

        this.messages[nextAssistantIndex] = {
          ...current,
          toolCalls: nextToolCalls
        };
        this.persistConversationSoon();
      };

      const handleEvent = (event: ChatStreamEvent) => {
        debugLog(this.debugLogging, 'Received stream event.', {
          type: event.type,
          contentLength: event.type === 'delta' ? event.content.length : undefined
        });

        if (event.type === 'meta') {
          this.conversationId = event.conversationId;
          updateAssistantId(event.messageId);
        }
        if (event.type === 'delta') {
          appendAssistantContent(event.content);
        }
        if (event.type === 'tool_call') {
          updateAssistantToolCall(event.toolCall);
        }
        if (event.type === 'error') {
          this.streamError = event.message;
        }
      };

      try {
        await new Promise<void>((resolve) => {
          activePort?.disconnect();
          activePort = browser.runtime.connect({ name: 'bac-chat-stream' });

          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            activePort = undefined;
            resolve();
          };

          activePort.onMessage.addListener((rawMessage) => {
            const message = rawMessage as ChatPortResponse;
            if (message.type === 'error') {
              this.streamError = message.message;
              debugLog(this.debugLogging, 'Received stream port error.', {
                message: message.message
              });
              settle();
              return;
            }

            handleEvent(message.event);
            if (message.event.type === 'done') {
              settle();
            }
          });

          activePort.onDisconnect.addListener(() => {
            const current = assistantIndex >= 0 ? this.messages[assistantIndex] : undefined;
            if (this.isStreaming && !current?.content && !current?.toolCalls?.length) {
              this.streamError = '流式连接已中断，请稍后重试。';
            }
            debugLog(this.debugLogging, 'Chat stream port disconnected.');
            settle();
          });

          activePort.postMessage({ type: 'start', request });
        });
      } catch (error) {
        const message =
          (error as Error).message || '请求失败，请确认本地 API 已启动。';
        this.streamError = message;
      } finally {
        const current = assistantIndex >= 0 ? this.messages[assistantIndex] : undefined;
        if (current && !current.content) {
          this.messages.splice(assistantIndex, 1);
        }
        this.isStreaming = false;
        activePort = undefined;
        await this.persistConversation();
        if (this.isConversationListOpen) {
          await this.loadConversations();
        }
      }
    },

    async resendUserMessage(messageId: string, content: string, context: PageContext) {
      const nextContent = content.trim();
      if (!nextContent || this.isStreaming) return;

      const userIndex = this.messages.findIndex((message) => message.id === messageId && message.role === 'user');
      if (userIndex < 0) return;

      this.streamError = null;
      this.draft = '';
      this.messages[userIndex] = {
        ...this.messages[userIndex],
        content: nextContent,
        context,
        contextScope: this.contextScope,
        createdAt: new Date().toISOString()
      };
      this.messages.splice(userIndex + 1);
      await this.persistConversation();
      await this.sendMessageContent(nextContent, context, false);
    },

    async retryAssistantMessage(messageId: string, context: PageContext) {
      if (this.isStreaming) return;

      const assistantIndex = this.messages.findIndex((message) => message.id === messageId);
      if (assistantIndex < 0) return;

      const previousUser = [...this.messages.slice(0, assistantIndex)]
        .reverse()
        .find((message) => message.role === 'user');
      if (!previousUser?.content) return;

      const retryContext = previousUser.context || context;
      const previousScope = previousUser.contextScope;
      const currentScope = this.contextScope;

      this.messages.splice(assistantIndex, 1);
      await this.persistConversation();

      if (previousScope) {
        this.contextScope = previousScope;
      }

      try {
        await this.sendMessageContent(previousUser.content, retryContext, false);
      } finally {
        this.contextScope = currentScope;
        this.persistConversationSoon();
      }
    },

    async rateAssistantMessage(messageId: string, rating: 'up' | 'down') {
      const messageIndex = this.messages.findIndex((message) => message.id === messageId);
      if (messageIndex >= 0) {
        this.messages[messageIndex] = {
          ...this.messages[messageIndex],
          feedbackRating: rating
        };
        this.persistConversationSoon();
      }

      const persistLocalFeedback = async () => {
        await browser.storage.local.set({
          [`bac.feedback.${messageId}`]: {
            rating,
            createdAt: new Date().toISOString()
          }
        });
      };

      if (!this.conversationId) {
        await persistLocalFeedback();
        return;
      }

      try {
        await fetchJson(
          `/conversations/${encodeURIComponent(this.conversationId)}/messages/${encodeURIComponent(
            messageId
          )}/feedback`,
          {
            method: 'PATCH',
            body: JSON.stringify({ rating })
          }
        );
      } catch (error) {
        debugLog(this.debugLogging, 'Persisting message feedback failed; using local fallback.', {
          message: error instanceof Error ? error.message : String(error)
        });
        await persistLocalFeedback();
      }
    },

    cancelStream() {
      stopActiveStream();
      this.isStreaming = false;
      void this.persistConversation();
    },

    async copyLastAssistantMessage() {
      const message = [...this.messages].reverse().find((item) => item.role === 'assistant');
      if (!message?.content) return;
      await navigator.clipboard.writeText(message.content);
    },

    async copyMessage(messageId: string) {
      const message = this.messages.find((item) => item.id === messageId);
      if (!message?.content) return;
      await navigator.clipboard.writeText(message.content);
    }
  }
});
