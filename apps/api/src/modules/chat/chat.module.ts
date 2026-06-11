import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { ToolsModule } from '../tools/tools.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { DeepseekService } from './deepseek.service.js';

@Module({
  imports: [ToolsModule, ConversationsModule],
  controllers: [ChatController],
  providers: [ChatService, DeepseekService]
})
export class ChatModule {}
