import type { ContextScope, PageContext } from './context.js';
import type { BrowserActionName, BrowserActionResponse, ToolRiskLevel } from './tools.js';

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageFeedbackRating = 'up' | 'down';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  feedbackRating?: MessageFeedbackRating;
  context?: PageContext;
  contextScope?: ContextScope;
  toolCalls?: ToolCallPreview[];
}

export type QuickActionId =
  | 'explain-selection'
  | 'summarize-context'
  | 'analyze-page'
  | 'generate-interview-questions'
  | 'extract-key-info';

export interface QuickAction {
  id: QuickActionId;
  label: string;
  prompt: string;
  preferredScope: ContextScope;
}

export interface ChatStreamRequest {
  clientId?: string;
  conversationId?: string;
  message: string;
  context: PageContext;
  scope: ContextScope;
  toolResults?: AgentToolResult[];
  llmConfig?: LlmRuntimeConfig;
}

export interface LlmRuntimeConfig {
  providerName?: string;
  displayName?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export type LlmConfigTestRequest = LlmRuntimeConfig;

export interface LlmConfigTestResponse {
  ok: boolean;
  message: string;
}

export interface AgentToolCall {
  id: string;
  toolName: BrowserActionName;
  summary: string;
  risk: ToolRiskLevel;
  input?: unknown;
}

export interface AgentToolResult {
  call: AgentToolCall;
  response: BrowserActionResponse;
  completedAt: string;
}

export interface ChatPlanResponse {
  toolCalls: AgentToolCall[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  pageUrl?: string;
  pageTitle?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage?: {
    role: ChatRole;
    content: string;
    createdAt: string;
  };
}

export interface ConversationDetail extends Omit<ConversationSummary, 'lastMessage'> {
  messages: ChatMessage[];
}

export type ChatStreamEvent =
  | { type: 'meta'; conversationId: string; messageId: string }
  | { type: 'delta'; content: string }
  | { type: 'tool_call'; toolCall: ToolCallPreview }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface ToolCallPreview {
  id?: string;
  toolName: BrowserActionName | string;
  summary: string;
  risk: ToolRiskLevel;
  status?: 'planned' | 'running' | 'success' | 'error';
  input?: unknown;
  output?: unknown;
  error?: string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'explain-selection',
    label: '解释选中内容',
    prompt: '请解释我选中的内容，并补充必要背景。',
    preferredScope: 'selection'
  },
  {
    id: 'summarize-context',
    label: '总结上下文',
    prompt: '请总结当前上下文，突出核心结论和关键细节。',
    preferredScope: 'visible-page'
  },
  {
    id: 'analyze-page',
    label: '分析当前页面',
    prompt: '请分析当前页面的主题、结构、关键信息和可能的后续操作。',
    preferredScope: 'visible-page'
  },
  {
    id: 'generate-interview-questions',
    label: '生成面试问题',
    prompt: '请基于当前内容生成有区分度的面试问题，并附参考考察点。',
    preferredScope: 'visible-page'
  },
  {
    id: 'extract-key-info',
    label: '提取关键信息',
    prompt: '请提取当前内容中的关键信息，按结构化要点输出。',
    preferredScope: 'visible-page'
  }
];
