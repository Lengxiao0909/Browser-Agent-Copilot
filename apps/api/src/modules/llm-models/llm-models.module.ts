import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DeepseekService } from '../chat/deepseek.service.js';
import { LlmModelsController } from './llm-models.controller.js';
import { LlmModelsService } from './llm-models.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [LlmModelsController],
  providers: [LlmModelsService, DeepseekService],
  exports: [LlmModelsService]
})
export class LlmModelsModule {}
