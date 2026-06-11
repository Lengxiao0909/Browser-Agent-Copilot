import { Injectable } from '@nestjs/common';
import type {
  AgentToolCall,
  AgentToolResult,
  ChatPlanResponse,
  ChatStreamEvent,
  ChatStreamRequest,
  ContextScope,
  PageContext
} from '@bac/shared';
import { ConversationsService } from '../conversations/conversations.service.js';
import { ToolsService } from '../tools/tools.service.js';
import { DeepseekService } from './deepseek.service.js';

function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeText(text?: string) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function getContextText(context: PageContext, scope: ContextScope) {
  if (scope === 'selection') {
    return normalizeText(context.selection?.text);
  }
  if (scope === 'full-page') {
    return normalizeText(context.fullText || context.visibleText || context.selection?.text);
  }
  return normalizeText(context.visibleText || context.selection?.text);
}

function formatHeadings(context: PageContext) {
  if (!context.headings?.length) return '';
  return context.headings
    .map((heading) => `${'#'.repeat(Math.min(heading.level, 6))} ${heading.text}`)
    .join('\n');
}

function formatLinks(context: PageContext) {
  if (!context.links?.length) return '';
  return context.links.map((link) => `- ${link.text}: ${link.href}`).join('\n');
}

function formatLandmarks(context: PageContext) {
  if (!context.landmarks?.length) return '';
  return context.landmarks
    .map((landmark) => {
      const name = [landmark.tag, landmark.role, landmark.label].filter(Boolean).join(' / ');
      return `- ${name}${landmark.text ? `: ${landmark.text}` : ''}`;
    })
    .join('\n');
}

function formatPageContext(request: ChatStreamRequest) {
  const contextText = getContextText(request.context, request.scope);
  const clippedContext = contextText.slice(0, 14000);
  const selectionText = normalizeText(request.context.selection?.text).slice(0, 5000);

  return [
    `Page title: ${request.context.title || 'Untitled'}`,
    `Page URL: ${request.context.url || 'Unknown'}`,
    request.context.description ? `Meta description: ${request.context.description}` : '',
    `Context scope: ${request.scope}`,
    selectionText ? `Selected text:\n${selectionText}` : '',
    formatHeadings(request.context) ? `Headings:\n${formatHeadings(request.context)}` : '',
    formatLandmarks(request.context) ? `Page landmarks:\n${formatLandmarks(request.context)}` : '',
    formatLinks(request.context) ? `Visible links:\n${formatLinks(request.context)}` : '',
    clippedContext ? `Page text:\n${clippedContext}` : 'Page text: not available'
  ]
    .filter(Boolean)
    .join('\n\n');
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatToolResults(toolResults?: AgentToolResult[]) {
  if (!toolResults?.length) return '';

  return toolResults
    .map((result, index) => {
      const response = result.response.ok
        ? safeJson(result.response.output).slice(0, 5000)
        : `ERROR: ${result.response.error}`;
      return [
        `Tool result ${index + 1}: ${result.call.toolName}`,
        `Summary: ${result.call.summary}`,
        `Input: ${safeJson(result.call.input ?? {}).slice(0, 1000)}`,
        `Result:\n${response}`
      ].join('\n');
    })
    .join('\n\n');
}

function buildMessages(request: ChatStreamRequest, toolNames: string[]) {
  const toolResultBlock = formatToolResults(request.toolResults);

  return [
    {
      role: 'system' as const,
      content: [
        'You are Browser Agent Copilot, a page-aware browser assistant.',
        'Answer in the same language as the user unless they ask otherwise.',
        'Use the supplied page context as grounding. If the context is insufficient, say what is missing.',
        'If browser tool results are provided, use them as the freshest source for that specific action.',
        'Be concise, structured, and practical.',
        'Do not claim to have performed browser actions unless a tool result is provided.',
        `Registered tool entries for future use: ${toolNames.join(', ') || 'none'}.`
      ].join('\n')
    },
    {
      role: 'user' as const,
      content: [
        `User task:\n${request.message}`,
        '',
        'Current browser context:',
        formatPageContext(request),
        toolResultBlock ? `\nBrowser tool results:\n${toolResultBlock}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    }
  ];
}

function createToolCall(
  toolName: AgentToolCall['toolName'],
  summary: string,
  input?: unknown
): AgentToolCall {
  return {
    id: createId('tool'),
    toolName,
    summary,
    risk: 'low',
    input
  };
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function extractQuotedQuery(text: string) {
  const match = text.match(/["“”'‘’「」『』《》`]{1}([^"“”'‘’「」『』《》`]{1,80})["“”'‘’「」『』《》`]{1}/);
  return match?.[1]?.trim();
}

function cleanQueryTail(value: string) {
  return value
    .replace(/^(一下|下|当前页面|页面中|网页中|文本|内容|关键词|关键字|为|是|到|至|:|：|,|，|\s)+/u, '')
    .replace(/[。.!！?？]+$/u, '')
    .trim()
    .slice(0, 80);
}

function extractQueryAfterIntent(text: string, keywords: string[]) {
  const quoted = extractQuotedQuery(text);
  if (quoted) return quoted;

  const lowerText = text.toLowerCase();
  for (const keyword of keywords) {
    const index = lowerText.indexOf(keyword.toLowerCase());
    if (index < 0) continue;
    const tail = cleanQueryTail(text.slice(index + keyword.length));
    if (tail) return tail;
  }

  return '';
}

@Injectable()
export class ChatService {
  constructor(
    private readonly deepseekService: DeepseekService,
    private readonly toolsService: ToolsService,
    private readonly conversationsService: ConversationsService
  ) {}

  createToolPlan(request: ChatStreamRequest): ChatPlanResponse {
    const rawMessage = normalizeText(request.message);
    const message = rawMessage.toLowerCase();
    const toolCalls: AgentToolCall[] = [];
    const addToolCall = (call: AgentToolCall) => {
      if (toolCalls.some((existing) => existing.toolName === call.toolName)) return;
      toolCalls.push(call);
    };

    const highlightQuery = extractQueryAfterIntent(rawMessage, ['高亮', '标记', 'highlight']);
    const scrollQuery = extractQueryAfterIntent(rawMessage, ['滚动到', '定位到', '跳转到', 'scroll to']);
    const findQuery = extractQueryAfterIntent(rawMessage, ['查找', '搜索', '寻找', '找到', 'find', 'search']);

    if (highlightQuery) {
      addToolCall(
        createToolCall('browser.highlight_text', `高亮页面中的“${highlightQuery}”`, {
          query: highlightQuery,
          maxMatches: 8
        })
      );
    } else if (scrollQuery) {
      addToolCall(
        createToolCall('browser.scroll_to_text', `滚动到页面中的“${scrollQuery}”`, {
          query: scrollQuery
        })
      );
    } else if (findQuery) {
      addToolCall(
        createToolCall('browser.find_text', `查找页面中的“${findQuery}”`, {
          query: findQuery,
          maxMatches: 8
        })
      );
    }

    if (includesAny(message, ['链接', 'url', 'urls', 'link', 'links'])) {
      addToolCall(createToolCall('browser.extract_links', '提取当前页面可见链接'));
    }

    if (includesAny(message, ['结构', '目录', '标题', '大纲', 'heading', 'headings', 'structure', 'outline'])) {
      addToolCall(createToolCall('browser.describe_page_structure', '读取当前页面结构'));
    }

    if (includesAny(message, ['选中', '选择的', '划选', 'selected', 'selection']) && request.context.selection?.text) {
      addToolCall(createToolCall('browser.read_selected_text', '读取当前页面选中文本'));
    }

    if (
      includesAny(message, ['页面摘要', '页面信息', '当前页面', '总结页面', '分析页面', 'page summary', 'summarize page'])
    ) {
      addToolCall(createToolCall('browser.get_page_summary', '读取当前页面摘要信息'));
    }

    return { toolCalls };
  }

  async *createStream(request: ChatStreamRequest): AsyncGenerator<ChatStreamEvent> {
    let conversationId = request.conversationId || createId('conversation');
    const messageId = createId('assistant');
    let canPersistAssistantMessage = false;

    if (!request.message?.trim()) {
      yield { type: 'meta', conversationId, messageId };
      yield { type: 'error', message: '消息不能为空。' };
      yield { type: 'done' };
      return;
    }

    try {
      const conversation = await this.conversationsService.ensureConversationForChat({
        conversationId: request.conversationId,
        clientId: request.clientId,
        context: request.context
      });
      conversationId = conversation.id;

      await this.conversationsService.createMessage(conversationId, {
        role: 'user',
        content: request.message,
        context: request.context,
        contextScope: request.scope,
        pageUrl: request.context.url,
        pageTitle: request.context.title
      });

      await this.conversationsService.createMessage(conversationId, {
        id: messageId,
        role: 'assistant',
        content: '',
        pageUrl: request.context.url,
        pageTitle: request.context.title
      });
      canPersistAssistantMessage = true;
    } catch (error) {
      console.warn(
        '[Browser Agent Copilot] Conversation persistence is unavailable; continuing without DB storage.',
        error
      );
    }

    yield { type: 'meta', conversationId, messageId };

    const availableTools = this.toolsService.listTools().map((tool) => tool.name);
    const messages = buildMessages(request, availableTools);
    let assistantContent = '';

    try {
      for await (const content of this.deepseekService.streamChat({ messages })) {
        assistantContent += content;
        yield { type: 'delta', content };
      }

      if (assistantContent.trim()) {
        try {
          if (canPersistAssistantMessage) {
            await this.conversationsService.updateMessageContent(conversationId, messageId, assistantContent);
          } else {
            await this.conversationsService.createMessage(conversationId, {
              id: messageId,
              role: 'assistant',
              content: assistantContent,
              pageUrl: request.context.url,
              pageTitle: request.context.title
            });
          }
        } catch (error) {
          console.warn(
            '[Browser Agent Copilot] Assistant message persistence failed; stream already completed.',
            error
          );
        }
      }

      yield { type: 'done' };
    } catch (error) {
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : 'AI streaming response failed.'
      };
      yield { type: 'done' };
    }
  }
}
