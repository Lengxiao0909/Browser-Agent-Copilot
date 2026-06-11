import type { AgentToolCall, ChatPlanResponse, ChatStreamRequest } from '@bac/shared';

function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeText(text?: string) {
  return (text || '').replace(/\s+/g, ' ').trim();
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
  const lowerText = text.toLowerCase();
  for (const keyword of keywords) {
    const index = lowerText.indexOf(keyword.toLowerCase());
    if (index < 0) continue;
    const quoted = extractQuotedQuery(text.slice(index + keyword.length));
    if (quoted) return quoted;
    const tail = cleanQueryTail(text.slice(index + keyword.length));
    if (tail) return tail;
  }

  return '';
}

export function createToolPlan(request: ChatStreamRequest): ChatPlanResponse {
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
    includesAny(message, ['页面摘要', '页面信息', '总结页面', '分析页面', '分析当前页面', 'page summary', 'summarize page'])
  ) {
    addToolCall(createToolCall('browser.get_page_summary', '读取当前页面摘要信息'));
  }

  return { toolCalls };
}
