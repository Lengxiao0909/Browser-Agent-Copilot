import { Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ChatPlanResponse, ChatStreamEvent, ChatStreamRequest } from '@bac/shared';
import { ChatService } from './chat.service.js';

@Controller('/chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('/plan')
  plan(@Body() body: ChatStreamRequest): ChatPlanResponse {
    return this.chatService.createToolPlan(body);
  }

  @Post('/stream')
  async stream(@Body() body: ChatStreamRequest, @Res() response: Response) {
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders?.();

    const writeEvent = (event: ChatStreamEvent) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      for await (const event of this.chatService.createStream(body)) {
        writeEvent(event);
      }
    } catch (error) {
      writeEvent({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unknown stream error'
      });
    } finally {
      response.end();
    }
  }
}
