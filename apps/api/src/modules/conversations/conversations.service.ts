import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ChatMessage,
  ChatRole,
  ConversationDetail,
  ConversationSummary,
  ContextScope,
  MessageFeedbackRating,
  PageContext
} from '@bac/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/index.js';

interface ConversationInput {
  clientId?: string;
  title?: string;
  pageUrl?: string;
  pageTitle?: string;
}

interface MessageInput {
  id?: string;
  role: ChatRole;
  content: string;
  context?: PageContext;
  contextScope?: ContextScope;
  pageUrl?: string;
  pageTitle?: string;
}

function deriveTitle(input: ConversationInput) {
  return input.title?.trim() || input.pageTitle?.trim() || '新对话';
}

function getPageInputFromContext(context: PageContext): Pick<ConversationInput, 'pageUrl' | 'pageTitle'> {
  return {
    pageUrl: context.url || undefined,
    pageTitle: context.title || undefined
  };
}

function toChatRole(role: string): ChatRole {
  return role === 'user' || role === 'assistant' || role === 'system' || role === 'tool'
    ? role
    : 'assistant';
}

function toFeedbackRating(rating?: string | null): MessageFeedbackRating | undefined {
  return rating === 'up' || rating === 'down' ? rating : undefined;
}

function toIsoString(value: Date) {
  return value.toISOString();
}

function toPageContext(value: Prisma.JsonValue | null): PageContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const context = value as Partial<PageContext>;
  if (typeof context.url !== 'string' || typeof context.title !== 'string') return undefined;
  return context as PageContext;
}

function toContextScope(value?: string | null): ContextScope | undefined {
  return value === 'selection' || value === 'visible-page' || value === 'full-page'
    ? value
    : undefined;
}

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  async createConversation(input: ConversationInput) {
    return this.prisma.conversation.create({
      data: {
        clientId: input.clientId,
        title: deriveTitle(input),
        pageUrl: input.pageUrl,
        pageTitle: input.pageTitle
      }
    });
  }

  async ensureConversationForChat(input: {
    conversationId?: string;
    clientId?: string;
    context: PageContext;
  }) {
    const pageInput = getPageInputFromContext(input.context);

    if (input.conversationId) {
      const existing = await this.prisma.conversation.findUnique({
        where: { id: input.conversationId }
      });

      if (existing) {
        return this.prisma.conversation.update({
          where: { id: existing.id },
          data: {
            clientId: existing.clientId || input.clientId,
            pageUrl: pageInput.pageUrl || existing.pageUrl,
            pageTitle: pageInput.pageTitle || existing.pageTitle
          }
        });
      }

      return this.prisma.conversation.create({
        data: {
          id: input.conversationId,
          clientId: input.clientId,
          title: pageInput.pageTitle || '新对话',
          pageUrl: pageInput.pageUrl,
          pageTitle: pageInput.pageTitle
        }
      });
    }

    return this.createConversation({
      clientId: input.clientId,
      title: pageInput.pageTitle,
      ...pageInput
    });
  }

  async listConversations(clientId?: string) {
    try {
      const conversations = await this.prisma.conversation.findMany({
        where: clientId ? { clientId } : undefined,
        orderBy: { updatedAt: 'desc' },
        include: {
          _count: { select: { messages: true } },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1
          }
        }
      });

      return conversations.map<ConversationSummary>((conversation) => {
        const lastMessage = conversation.messages[0];
        return {
          id: conversation.id,
          title: conversation.title || conversation.pageTitle || '新对话',
          pageUrl: conversation.pageUrl || undefined,
          pageTitle: conversation.pageTitle || undefined,
          createdAt: toIsoString(conversation.createdAt),
          updatedAt: toIsoString(conversation.updatedAt),
          messageCount: conversation._count.messages,
          lastMessage: lastMessage
            ? {
                role: toChatRole(lastMessage.role),
                content: lastMessage.content,
                createdAt: toIsoString(lastMessage.createdAt)
              }
            : undefined
        };
      });
    } catch (error) {
      console.warn(
        '[Browser Agent Copilot] Conversation list persistence is unavailable; returning an empty history list.',
        error
      );
      return [];
    }
  }

  async getConversation(id: string, clientId?: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id,
        ...(clientId ? { clientId } : {})
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }

    const messages = conversation.messages.map<ChatMessage>((message) => ({
      id: message.id,
      role: toChatRole(message.role),
      content: message.content,
      createdAt: toIsoString(message.createdAt),
      feedbackRating: toFeedbackRating(message.feedbackRating),
      context: toPageContext(message.contextJson),
      contextScope: toContextScope(message.contextScope)
    }));

    return {
      id: conversation.id,
      title: conversation.title || conversation.pageTitle || '新对话',
      pageUrl: conversation.pageUrl || undefined,
      pageTitle: conversation.pageTitle || undefined,
      createdAt: toIsoString(conversation.createdAt),
      updatedAt: toIsoString(conversation.updatedAt),
      messageCount: messages.length,
      messages
    } satisfies ConversationDetail;
  }

  async updateConversation(id: string, input: ConversationInput) {
    return this.prisma.conversation.update({
      where: { id },
      data: {
        title: input.title,
        pageUrl: input.pageUrl,
        pageTitle: input.pageTitle
      }
    });
  }

  async deleteConversation(id: string) {
    try {
      await this.prisma.conversation.delete({ where: { id } });
      return { ok: true, persisted: true };
    } catch (error) {
      console.warn(
        '[Browser Agent Copilot] Conversation delete persistence is unavailable; treating local delete as complete.',
        error
      );
      return { ok: true, persisted: false };
    }
  }

  async createMessage(conversationId: string, input: MessageInput) {
    return this.prisma.$transaction(async (transaction) => {
      const message = await transaction.message.create({
        data: {
          id: input.id,
          conversationId,
          role: input.role,
          content: input.content,
          contextScope: input.contextScope,
          contextJson: input.context ? (input.context as unknown as Prisma.InputJsonValue) : undefined,
          pageUrl: input.pageUrl,
          pageTitle: input.pageTitle
        }
      });

      await transaction.conversation.update({
        where: { id: conversationId },
        data: {
          pageUrl: input.pageUrl,
          pageTitle: input.pageTitle
        }
      });

      return message;
    });
  }

  async updateMessageContent(conversationId: string, messageId: string, content: string) {
    return this.prisma.message.updateMany({
      where: {
        id: messageId,
        conversationId
      },
      data: {
        content
      }
    });
  }

  async setMessageFeedback(
    conversationId: string,
    messageId: string,
    rating: MessageFeedbackRating
  ) {
    if (rating !== 'up' && rating !== 'down') {
      throw new BadRequestException('Feedback rating must be up or down.');
    }

    const result = await this.prisma.message.updateMany({
      where: {
        id: messageId,
        conversationId,
        role: 'assistant'
      },
      data: {
        feedbackRating: rating,
        feedbackCreatedAt: new Date()
      }
    });

    if (result.count === 0) {
      throw new NotFoundException('Message not found.');
    }

    return { ok: true, rating };
  }
}
