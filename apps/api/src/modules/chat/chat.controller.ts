import { Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type {
  ChatPlanResponse,
  ChatReplanRequest,
  ChatReplanResponse,
  ChatStreamEvent,
  ChatStreamRequest,
  LlmConfigTestRequest,
  LlmConfigTestResponse
} from '@bac/shared';
import { ChatService } from './chat.service.js';

@Controller('/chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('/plan')
  plan(@Body() body: ChatStreamRequest): ChatPlanResponse {
    return this.chatService.createToolPlan(body);
  }

  @Post('/replan')
  replan(@Body() body: ChatReplanRequest): Promise<ChatReplanResponse> {
    return this.chatService.createToolReplan(body);
  }

  @Post('/test-model')
  testModel(@Body() body: LlmConfigTestRequest): Promise<LlmConfigTestResponse> {
    // Backward-compatible route for older extension builds. New UI uses /llm-models/test.
    return this.chatService.testLlmConfig(body);
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
      console.warn('[Browser Agent Copilot] Chat stream failed unexpectedly.', error);
      writeEvent({
        type: 'error',
        message: '模型响应暂时不可用，请稍后重试。'
      });
    } finally {
      response.end();
    }
  }
}
