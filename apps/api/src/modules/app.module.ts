import { Module } from '@nestjs/common';
import { ChatModule } from './chat/chat.module.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { HealthController } from './health.controller.js';
import { ToolsModule } from './tools/tools.module.js';

@Module({
  imports: [ToolsModule, ConversationsModule, ChatModule],
  controllers: [HealthController]
})
export class AppModule {}
