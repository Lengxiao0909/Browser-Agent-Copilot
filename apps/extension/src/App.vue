<script setup lang="ts">
import {
  ArrowDown,
  Bug,
  Check,
  Copy,
  History,
  Link,
  ListTree,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Wrench,
  X
} from 'lucide-vue-next';
import { storeToRefs } from 'pinia';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { QUICK_ACTIONS, type ChatMessage, type ContextScope, type QuickAction } from '@bac/shared';
import { useCopilotStore } from './stores/copilot';
import { collectPageContext, getCurrentSelection } from './utils/pageContext';
import { renderMarkdown } from './utils/markdown';

type DragTarget = 'launcher' | 'panel';

interface Point {
  x: number;
  y: number;
}

const launcherSize = 54;
const panelWidth = 420;
const panelHeight = 620;

const store = useCopilotStore();
const {
  isOpen,
  debugLogging,
  isConversationListOpen,
  isToolsOpen,
  isExecutingTool,
  toolError,
  toolCopyStatus,
  lastToolResult,
  pendingToolConfirmation,
  isLoadingConversations,
  conversationError,
  conversations,
  conversationId,
  messages,
  draft,
  selection,
  isStreaming,
  streamError
} = storeToRefs(store);

const launcherPosition = ref<Point>({ x: 0, y: 0 });
const panelPosition = ref<Point>({ x: 0, y: 0 });
const selectionButton = ref({ visible: false, x: 0, y: 0 });
const currentPageUrl = ref(location.href);
const editingConversationId = ref<string | null>(null);
const editingTitle = ref('');
const toolQuery = ref('');
const messagesViewport = ref<HTMLElement | null>(null);
const composerTextarea = ref<HTMLTextAreaElement | null>(null);
const isComposerFocused = ref(false);
const showScrollToBottom = ref(false);
const editingUserMessageId = ref<string | null>(null);
const pinnedUserMessageId = ref<string | null>(null);
const dragState = ref<{
  target: DragTarget;
  pointerId: number;
  startPointer: Point;
  startPosition: Point;
  moved: boolean;
} | null>(null);
let navigationTimer: ReturnType<typeof setInterval> | undefined;
let selectionTimer: ReturnType<typeof setTimeout> | undefined;
let composerFocusTimer: number | undefined;

const contextualActions = computed(() => {
  const allowedIds = selection.value
    ? ['explain-selection', 'extract-key-info']
    : ['summarize-context', 'analyze-page', 'extract-key-info'];
  return QUICK_ACTIONS.filter((action) => allowedIds.includes(action.id));
});
const explainSelectionAction = computed(() =>
  QUICK_ACTIONS.find((action) => action.id === 'explain-selection')
);

const canSend = computed(() => draft.value.trim().length > 0 && !isStreaming.value);
const hasConversationContent = computed(
  () => messages.value.length > 0 || draft.value.trim().length > 0 || Boolean(streamError.value)
);
const visibleMessages = computed(() =>
  messages.value.filter((message) => message.role === 'user' || message.content.trim())
);
const shouldShowContextualActions = computed(
  () =>
    !isStreaming.value &&
    !editingUserMessageId.value &&
    contextualActions.value.length > 0 &&
    (Boolean(selection.value) || (isComposerFocused.value && !draft.value.trim()))
);
const hasVisibleStreamingAnswer = computed(() => {
  if (!isStreaming.value) return false;
  const lastMessage = messages.value[messages.value.length - 1];
  return Boolean(
    lastMessage?.role === 'assistant' &&
      lastMessage.content.trim()
  );
});
const shouldShowThinking = computed(() => isStreaming.value && !hasVisibleStreamingAnswer.value);
const scrollControlMode = computed<'streaming' | 'arrow'>(() =>
  isStreaming.value ? 'streaming' : 'arrow'
);
const activeConversation = computed(() => {
  const activeId = conversationId?.value;
  if (!activeId) return undefined;
  return conversations.value.find((conversation) => conversation.id === activeId);
});

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function clampToViewport(position: Point, width: number, height: number): Point {
  const margin = 12;
  return {
    x: clamp(position.x, margin, Math.max(margin, window.innerWidth - width - margin)),
    y: clamp(position.y, margin, Math.max(margin, window.innerHeight - height - margin))
  };
}

function setInitialPositions() {
  launcherPosition.value = clampToViewport(
    {
      x: window.innerWidth - launcherSize - 24,
      y: window.innerHeight - launcherSize - 24
    },
    launcherSize,
    launcherSize
  );

  panelPosition.value = clampToViewport(
    {
      x: window.innerWidth - panelWidth - 28,
      y: Math.max(24, Math.round((window.innerHeight - panelHeight) / 2))
    },
    panelWidth,
    Math.min(panelHeight, window.innerHeight - 24)
  );
}

function beginDrag(event: PointerEvent, target: DragTarget) {
  const position = target === 'launcher' ? launcherPosition.value : panelPosition.value;
  dragState.value = {
    target,
    pointerId: event.pointerId,
    startPointer: { x: event.clientX, y: event.clientY },
    startPosition: { ...position },
    moved: false
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function updateDrag(event: PointerEvent) {
  const drag = dragState.value;
  if (!drag || drag.pointerId !== event.pointerId) return;

  const delta = {
    x: event.clientX - drag.startPointer.x,
    y: event.clientY - drag.startPointer.y
  };

  if (Math.abs(delta.x) > 3 || Math.abs(delta.y) > 3) {
    drag.moved = true;
  }

  const nextPosition = {
    x: drag.startPosition.x + delta.x,
    y: drag.startPosition.y + delta.y
  };

  if (drag.target === 'launcher') {
    launcherPosition.value = clampToViewport(nextPosition, launcherSize, launcherSize);
    return;
  }

  panelPosition.value = clampToViewport(
    nextPosition,
    Math.min(panelWidth, window.innerWidth - 24),
    Math.min(panelHeight, window.innerHeight - 24)
  );
}

function endDrag(event: PointerEvent) {
  const drag = dragState.value;
  if (!drag || drag.pointerId !== event.pointerId) return;
  dragState.value = null;

  if (drag.target === 'launcher' && !drag.moved) {
    store.open();
  }
}

function updateSelectionButton() {
  const nextSelection = getCurrentSelection();
  if (!nextSelection) {
    selectionButton.value.visible = false;
    return;
  }

  store.setSelection(nextSelection);
  selectionButton.value = {
    visible: true,
    x: nextSelection.rect.left + nextSelection.rect.width - 22,
    y: Math.max(12, nextSelection.rect.top - 42)
  };
}

function scheduleSelectionButtonUpdate() {
  if (selectionTimer) {
    clearTimeout(selectionTimer);
  }
  selectionTimer = setTimeout(updateSelectionButton, 60);
}

function useSelectionAsReference() {
  if (!selection.value) return;
  store.open();
  store.setContextScope('selection');
  selectionButton.value.visible = false;
  draft.value = explainSelectionAction.value?.prompt || '请解释选中的内容，并补充必要背景。';
  void nextTick(() => {
    void sendMessage(explainSelectionAction.value);
  });
}

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function getConversationPreview(content?: string) {
  if (!content?.trim()) return '暂无消息';
  return content.replace(/\s+/g, ' ').trim();
}

function getToolResultPreview() {
  if (!lastToolResult.value) return '';
  if (!lastToolResult.value.ok) return lastToolResult.value.error;
  return JSON.stringify(lastToolResult.value.output, null, 2);
}

async function runTextTool(action: 'browser.find_text' | 'browser.highlight_text' | 'browser.scroll_to_text') {
  const query = toolQuery.value.trim();
  if (!query) return;
  await store.executeBrowserAction(action, { query, maxMatches: 8 });
}

function isActiveConversation(id: string) {
  return id === conversationId?.value;
}

function startRenameConversation(id: string, title: string) {
  editingConversationId.value = id;
  editingTitle.value = title;
}

function cancelRenameConversation() {
  editingConversationId.value = null;
  editingTitle.value = '';
}

async function submitRenameConversation(id: string) {
  await store.renameConversation(id, editingTitle.value);
  cancelRenameConversation();
}

async function removeConversation(id: string) {
  await store.deleteConversation(id);
  if (editingConversationId.value === id) {
    cancelRenameConversation();
  }
}

function inferContextScope(content: string, action?: QuickAction): ContextScope {
  if (action) return action.preferredScope;

  const normalized = content.trim().toLowerCase();
  if (
    selection.value &&
    /(选中|所选|这段|这部分|引用|selection|selected)/i.test(normalized)
  ) {
    return 'selection';
  }

  if (/(整页|全文|全部页面|整个页面|完整页面|所有内容|full page|whole page)/i.test(normalized)) {
    return 'full-page';
  }

  return 'visible-page';
}

function getMessageElement(messageId: string) {
  return messagesViewport.value?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`) || null;
}

function updateScrollButtonState() {
  const viewport = messagesViewport.value;
  if (!viewport) {
    showScrollToBottom.value = false;
    return;
  }

  const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
  showScrollToBottom.value = distanceFromBottom > 80;
}

function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
  const viewport = messagesViewport.value;
  if (!viewport) return;

  viewport.scrollTo({
    top: viewport.scrollHeight,
    behavior
  });
  window.setTimeout(updateScrollButtonState, 180);
}

function scrollMessageToTop(messageId: string, behavior: ScrollBehavior = 'smooth') {
  const viewport = messagesViewport.value;
  const element = getMessageElement(messageId);
  if (!viewport || !element) return;

  const viewportRect = viewport.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const nextTop = viewport.scrollTop + elementRect.top - viewportRect.top - 10;
  viewport.scrollTo({
    top: Math.max(0, nextTop),
    behavior
  });
  window.setTimeout(updateScrollButtonState, 220);
}

function beginEditUserMessage(message: ChatMessage) {
  if (isStreaming.value || message.role !== 'user') return;
  editingUserMessageId.value = message.id;
  draft.value = message.content;
  void nextTick(() => composerTextarea.value?.focus());
}

function cancelEditUserMessage() {
  editingUserMessageId.value = null;
  draft.value = '';
  composerTextarea.value?.focus();
}

function handlePageUrlChanged() {
  if (currentPageUrl.value === location.href) return;

  currentPageUrl.value = location.href;
  selectionButton.value.visible = false;
  store.clearSelection();
}

async function sendMessage(action?: QuickAction) {
  if (isStreaming.value) return;

  if (action) {
    draft.value = action.prompt;
  }

  const content = draft.value.trim();
  if (!content) return;

  store.setContextScope(inferContextScope(content, action));
  const pageContext = collectPageContext(selection.value?.reference);
  const editingId = editingUserMessageId.value;
  editingUserMessageId.value = null;

  if (editingId) {
    pinnedUserMessageId.value = editingId;
    void store.resendUserMessage(editingId, content, pageContext);
    requestAnimationFrame(() => scrollMessageToTop(editingId));
    return;
  }

  void store.sendCurrentDraft(pageContext);
}

async function retryMessage(messageId: string) {
  const pageContext = collectPageContext(selection.value?.reference);
  await store.retryAssistantMessage(messageId, pageContext);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter') return;
  if (event.shiftKey) return;

  if (!event.isComposing) {
    event.preventDefault();
    void sendMessage();
  }
}

function handleComposerFocus() {
  if (composerFocusTimer) {
    clearTimeout(composerFocusTimer);
    composerFocusTimer = undefined;
  }
  isComposerFocused.value = true;
}

function handleComposerBlur() {
  composerFocusTimer = window.setTimeout(() => {
    isComposerFocused.value = false;
  }, 140);
}

function handleResize() {
  launcherPosition.value = clampToViewport(launcherPosition.value, launcherSize, launcherSize);
  panelPosition.value = clampToViewport(
    panelPosition.value,
    Math.min(panelWidth, window.innerWidth - 24),
    Math.min(panelHeight, window.innerHeight - 24)
  );
}

watch(
  () => messages.value.map((message) => `${message.id}:${message.role}`).join('|'),
  async () => {
    await nextTick();
    const lastUserMessage = [...messages.value].reverse().find((message) => message.role === 'user');
    if (!lastUserMessage || pinnedUserMessageId.value === lastUserMessage.id) {
      updateScrollButtonState();
      return;
    }

    if (isStreaming.value) {
      pinnedUserMessageId.value = lastUserMessage.id;
      requestAnimationFrame(() => scrollMessageToTop(lastUserMessage.id));
      return;
    }

    updateScrollButtonState();
  }
);

watch(
  () => messages.value[messages.value.length - 1]?.content,
  async () => {
    await nextTick();
    updateScrollButtonState();
  }
);

watch(isStreaming, async (streaming) => {
  await nextTick();
  if (!streaming) {
    pinnedUserMessageId.value = null;
    updateScrollButtonState();
  }
});

onMounted(() => {
  setInitialPositions();
  void store.hydrate();
  document.addEventListener('mouseup', scheduleSelectionButtonUpdate);
  document.addEventListener('keyup', scheduleSelectionButtonUpdate);
  document.addEventListener('selectionchange', scheduleSelectionButtonUpdate);
  window.addEventListener('resize', handleResize);
  window.addEventListener('popstate', handlePageUrlChanged);
  window.addEventListener('hashchange', handlePageUrlChanged);
  navigationTimer = setInterval(handlePageUrlChanged, 800);
});

onUnmounted(() => {
  document.removeEventListener('mouseup', scheduleSelectionButtonUpdate);
  document.removeEventListener('keyup', scheduleSelectionButtonUpdate);
  document.removeEventListener('selectionchange', scheduleSelectionButtonUpdate);
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('popstate', handlePageUrlChanged);
  window.removeEventListener('hashchange', handlePageUrlChanged);
  if (navigationTimer) {
    clearInterval(navigationTimer);
  }
  if (selectionTimer) {
    clearTimeout(selectionTimer);
  }
  if (composerFocusTimer) {
    clearTimeout(composerFocusTimer);
  }
});
</script>

<template>
  <div class="bac-shell">
    <button
      v-if="selectionButton.visible"
      class="bac-selection-chip"
      :style="{ left: `${selectionButton.x}px`, top: `${selectionButton.y}px` }"
      title="引用选中内容"
      @mousedown.prevent
      @click="useSelectionAsReference"
    >
      <Sparkles :size="15" />
    </button>

    <button
      v-if="!isOpen"
      class="bac-launcher"
      :class="{ dragging: dragState?.target === 'launcher' }"
      :style="{ left: `${launcherPosition.x}px`, top: `${launcherPosition.y}px` }"
      title="Browser Agent Copilot"
      @pointerdown.prevent="beginDrag($event, 'launcher')"
      @pointermove.prevent="updateDrag"
      @pointerup.prevent="endDrag"
      @pointercancel.prevent="endDrag"
    >
      <Sparkles :size="23" />
    </button>

    <aside
      v-else
      class="bac-panel"
      :style="{ left: `${panelPosition.x}px`, top: `${panelPosition.y}px` }"
      aria-label="Browser Agent Copilot"
    >
      <header
        class="bac-header"
        @pointerdown.prevent="beginDrag($event, 'panel')"
        @pointermove.prevent="updateDrag"
        @pointerup.prevent="endDrag"
        @pointercancel.prevent="endDrag"
      >
        <div class="bac-title">Browser Agent Copilot</div>

        <div class="bac-header-actions" @pointerdown.stop>
          <button
            class="bac-icon-button"
            :class="{ active: isConversationListOpen }"
            title="历史对话"
            type="button"
            @click="store.toggleConversationList"
          >
            <History :size="16" />
          </button>
          <button
            class="bac-icon-button"
            :class="{ active: isToolsOpen }"
            title="页面工具"
            type="button"
            @click="store.toggleTools"
          >
            <Wrench :size="16" />
          </button>
          <button
            class="bac-icon-button"
            :class="{ active: debugLogging }"
            :title="debugLogging ? '关闭调试日志' : '开启调试日志'"
            type="button"
            @click="store.toggleDebugLogging"
          >
            <Bug :size="16" />
          </button>
          <button class="bac-icon-button" title="新建对话" type="button" @click="store.startNewConversation">
            <Plus :size="17" />
          </button>
          <button
            class="bac-icon-button"
            title="清空对话"
            type="button"
            :disabled="!hasConversationContent"
            @click="store.clearCurrentConversation"
          >
            <Trash2 :size="16" />
          </button>
          <button class="bac-icon-button" title="最小化" type="button" @click="store.close">
            <Minus :size="17" />
          </button>
        </div>
      </header>

      <section v-if="isToolsOpen" class="bac-tool-drawer" @pointerdown.stop>
        <div class="bac-tool-head">
          <div>
            <span>页面工具</span>
            <small>低风险浏览器动作</small>
          </div>
          <button
            class="bac-tool-copy"
            title="复制工具结果"
            type="button"
            :disabled="!lastToolResult"
            @click="store.copyLastToolResult"
          >
            <Copy :size="12" />
            <span>{{ toolCopyStatus === 'copied' ? '已复制' : toolCopyStatus === 'failed' ? '失败' : '复制结果' }}</span>
          </button>
        </div>

        <div class="bac-tool-actions">
          <button type="button" :disabled="isExecutingTool" @click="store.executeBrowserAction('browser.get_page_summary')">
            <Sparkles :size="13" />
            <span>摘要</span>
          </button>
          <button type="button" :disabled="isExecutingTool" @click="store.executeBrowserAction('browser.extract_links')">
            <Link :size="13" />
            <span>链接</span>
          </button>
          <button type="button" :disabled="isExecutingTool" @click="store.executeBrowserAction('browser.describe_page_structure')">
            <ListTree :size="13" />
            <span>结构</span>
          </button>
          <button type="button" :disabled="isExecutingTool" @click="store.executeBrowserAction('browser.read_selected_text')">
            <Copy :size="13" />
            <span>选区</span>
          </button>
        </div>

        <div class="bac-tool-search">
          <input v-model="toolQuery" type="text" placeholder="查找页面文本">
          <button title="查找" type="button" :disabled="isExecutingTool || !toolQuery.trim()" @click="runTextTool('browser.find_text')">
            <Search :size="13" />
          </button>
          <button title="高亮" type="button" :disabled="isExecutingTool || !toolQuery.trim()" @click="runTextTool('browser.highlight_text')">
            <Sparkles :size="13" />
          </button>
          <button title="滚动到文本" type="button" :disabled="isExecutingTool || !toolQuery.trim()" @click="runTextTool('browser.scroll_to_text')">
            <RotateCcw :size="13" />
          </button>
        </div>

        <div v-if="pendingToolConfirmation" class="bac-tool-confirmation">
          <div>
            <span>需要确认</span>
            <small>{{ pendingToolConfirmation.risk }} risk</small>
          </div>
          <p>{{ pendingToolConfirmation.summary }}</p>
          <div class="bac-tool-confirmation-actions">
            <button type="button" @click="store.confirmPendingToolAction">
              <Check :size="12" />
              <span>确认执行</span>
            </button>
            <button type="button" @click="store.rejectPendingToolAction">
              <X :size="12" />
              <span>取消</span>
            </button>
          </div>
        </div>

        <div v-if="toolError" class="bac-inline-error">{{ toolError }}</div>
        <pre v-else-if="lastToolResult" class="bac-tool-result">{{ getToolResultPreview() }}</pre>
      </section>

      <section v-if="isConversationListOpen" class="bac-conversation-drawer" @pointerdown.stop>
        <div class="bac-conversation-drawer-head">
          <div>
            <span>历史对话</span>
            <small v-if="activeConversation">{{ activeConversation.title }}</small>
          </div>
          <button class="bac-text-button" type="button" @click="store.loadConversations">刷新</button>
        </div>

        <div v-if="conversationError" class="bac-inline-error">{{ conversationError }}</div>
        <div v-else-if="isLoadingConversations" class="bac-conversation-empty">正在加载会话...</div>
        <div v-else-if="conversations.length === 0" class="bac-conversation-empty">还没有服务器会话</div>

        <div v-else class="bac-conversation-list">
          <article
            v-for="conversation in conversations"
            :key="conversation.id"
            class="bac-conversation-item"
            :class="{ active: isActiveConversation(conversation.id) }"
          >
            <button
              class="bac-conversation-main"
              type="button"
              :disabled="isStreaming || editingConversationId === conversation.id"
              @click="store.selectConversation(conversation.id)"
            >
              <span class="bac-conversation-title">{{ conversation.title }}</span>
              <span class="bac-conversation-meta">
                {{ conversation.messageCount }} 条消息 · {{ formatConversationTime(conversation.updatedAt) }}
              </span>
              <span class="bac-conversation-preview">
                {{ getConversationPreview(conversation.lastMessage?.content) }}
              </span>
            </button>

            <div v-if="editingConversationId === conversation.id" class="bac-rename-row">
              <input
                v-model="editingTitle"
                type="text"
                maxlength="60"
                @keydown.enter.prevent="submitRenameConversation(conversation.id)"
                @keydown.esc.prevent="cancelRenameConversation"
              >
              <button class="bac-mini-icon-button" title="保存" type="button" @click="submitRenameConversation(conversation.id)">
                <Check :size="13" />
              </button>
              <button class="bac-mini-icon-button" title="取消" type="button" @click="cancelRenameConversation">
                <X :size="13" />
              </button>
            </div>

            <div v-else class="bac-conversation-actions">
              <button
                class="bac-mini-icon-button"
                title="重命名"
                type="button"
                @click="startRenameConversation(conversation.id, conversation.title)"
              >
                <Pencil :size="13" />
              </button>
              <button
                class="bac-mini-icon-button"
                title="删除"
                type="button"
                @click="removeConversation(conversation.id)"
              >
                <Trash2 :size="13" />
              </button>
            </div>
          </article>
        </div>
      </section>

      <section ref="messagesViewport" class="bac-messages" @scroll.passive="updateScrollButtonState">
        <div v-if="messages.length === 0" class="bac-empty">
          <div class="bac-empty-mark"><Sparkles :size="25" /></div>
          <h2>从当前页面开始</h2>
          <p>划选内容或直接输入任务，我会结合页面上下文给出回答。</p>
        </div>

        <article
          v-for="message in visibleMessages"
          :key="message.id"
          class="bac-message"
          :class="message.role"
          :data-message-id="message.id"
        >
          <div class="bac-message-role">{{ message.role === 'user' ? 'You' : 'Copilot' }}</div>
          <div
            v-if="message.role === 'assistant' && message.content"
            class="bac-message-content markdown"
            v-html="renderMarkdown(message.content)"
          />
          <div v-else-if="message.role === 'user'" class="bac-message-content">{{ message.content }}</div>

          <div v-if="message.role === 'user' && !isStreaming" class="bac-message-actions bac-user-actions">
            <button title="复制" type="button" @click="store.copyMessage(message.id)">
              <Copy :size="13" />
            </button>
            <button title="编辑并重新发送" type="button" @click="beginEditUserMessage(message)">
              <Pencil :size="13" />
            </button>
          </div>

          <div v-if="message.role === 'assistant' && message.content && !isStreaming" class="bac-message-actions">
            <button title="复制" type="button" @click="store.copyMessage(message.id)">
              <Copy :size="13" />
            </button>
            <button
              :class="{ active: message.feedbackRating === 'up' }"
              title="点赞"
              type="button"
              @click="store.rateAssistantMessage(message.id, 'up')"
            >
              <ThumbsUp :size="13" />
            </button>
            <button
              :class="{ active: message.feedbackRating === 'down' }"
              title="点踩"
              type="button"
              @click="store.rateAssistantMessage(message.id, 'down')"
            >
              <ThumbsDown :size="13" />
            </button>
            <button title="重新回答" type="button" @click="retryMessage(message.id)">
              <RotateCcw :size="13" />
            </button>
          </div>
        </article>

        <div v-if="shouldShowThinking" class="bac-thinking" aria-live="polite">
          <span />
        </div>

        <button
          v-if="showScrollToBottom"
          class="bac-scroll-bottom"
          :class="{ streaming: scrollControlMode === 'streaming' }"
          title="滚动到底部"
          type="button"
          @click="scrollToBottom()"
        >
          <span v-if="scrollControlMode === 'streaming'" class="bac-scroll-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <ArrowDown v-else :size="15" />
        </button>
      </section>

      <footer class="bac-composer">
        <section v-if="selection" class="bac-reference">
          <div class="bac-reference-head">
            <span>已引用选中内容</span>
            <button class="bac-text-button" type="button" @click="store.clearSelection">移除</button>
          </div>
          <p>{{ selection.reference.text }}</p>
        </section>

        <Transition name="bac-suggestion-pop">
          <div v-if="shouldShowContextualActions" class="bac-recommendations" aria-label="推荐功能">
            <button
              v-for="action in contextualActions"
              :key="action.id"
              type="button"
              @mousedown.prevent
              @click="sendMessage(action)"
            >
              {{ action.label }}
            </button>
          </div>
        </Transition>

        <div v-if="streamError" class="bac-error">{{ streamError }}</div>

        <div v-if="editingUserMessageId" class="bac-editing-note">
          <span>正在编辑提问</span>
          <button title="取消编辑" type="button" @click="cancelEditUserMessage">
            <X :size="12" />
          </button>
        </div>

        <div class="bac-input-wrap">
          <textarea
            ref="composerTextarea"
            v-model="draft"
            rows="2"
            placeholder="询问当前页面，或描述你想完成的任务"
            @focus="handleComposerFocus"
            @blur="handleComposerBlur"
            @keydown="handleKeydown"
          />
          <button
            v-if="isStreaming"
            class="bac-send"
            title="停止生成"
            type="button"
            @click="store.cancelStream"
          >
            <Square :size="16" />
          </button>
          <button
            v-else
            class="bac-send"
            title="发送"
            type="button"
            :disabled="!canSend"
            @click="sendMessage()"
          >
            <Send :size="16" />
          </button>
        </div>
      </footer>
    </aside>
  </div>
</template>
