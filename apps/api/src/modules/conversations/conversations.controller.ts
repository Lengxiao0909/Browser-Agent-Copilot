import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { ChatRole, MessageFeedbackRating } from '@bac/shared';
import { ConversationsService } from './conversations.service.js';

interface ConversationBody {
  clientId?: string;
  title?: string;
  pageUrl?: string;
  pageTitle?: string;
}

interface MessageBody {
  id?: string;
  role: ChatRole;
  content: string;
  pageUrl?: string;
  pageTitle?: string;
}

interface FeedbackBody {
  rating: MessageFeedbackRating;
}

@Controller('/conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Get()
  list(@Query('clientId') clientId?: string) {
    return this.conversationsService.listConversations(clientId);
  }

  @Post()
  create(@Body() body: ConversationBody) {
    return this.conversationsService.createConversation(body);
  }

  @Get('/:id')
  get(@Param('id') id: string, @Query('clientId') clientId?: string) {
    return this.conversationsService.getConversation(id, clientId);
  }

  @Patch('/:id')
  update(@Param('id') id: string, @Body() body: ConversationBody) {
    return this.conversationsService.updateConversation(id, body);
  }

  @Delete('/:id')
  delete(@Param('id') id: string) {
    return this.conversationsService.deleteConversation(id);
  }

  @Post('/:id/messages')
  createMessage(@Param('id') id: string, @Body() body: MessageBody) {
    return this.conversationsService.createMessage(id, body);
  }

  @Patch('/:id/messages/:messageId/feedback')
  setMessageFeedback(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() body: FeedbackBody
  ) {
    return this.conversationsService.setMessageFeedback(id, messageId, body.rating);
  }
}
