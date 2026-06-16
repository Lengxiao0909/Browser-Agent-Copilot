import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { LlmConfigTestRequest, SaveLlmModelConfigRequest } from '@bac/shared';
import { DeepseekService } from '../chat/deepseek.service.js';
import { LlmModelsService } from './llm-models.service.js';

@Controller('/llm-models')
export class LlmModelsController {
  constructor(
    private readonly llmModelsService: LlmModelsService,
    private readonly deepseekService: DeepseekService
  ) {}

  @Get()
  list(@Query('clientId') clientId?: string) {
    return this.llmModelsService.listModels(clientId);
  }

  @Post()
  create(@Body() body: SaveLlmModelConfigRequest) {
    return this.llmModelsService.createModel(body);
  }

  @Patch('/:id')
  update(@Param('id') id: string, @Body() body: SaveLlmModelConfigRequest) {
    return this.llmModelsService.updateModel(id, body);
  }

  @Delete('/:id')
  delete(@Param('id') id: string, @Query('clientId') clientId?: string) {
    return this.llmModelsService.deleteModel(id, clientId);
  }

  @Post('/:id/test')
  testSaved(@Param('id') id: string, @Query('clientId') clientId?: string) {
    return this.llmModelsService.testSavedModel(id, clientId);
  }

  @Post('/test')
  async testDraft(@Body() body: LlmConfigTestRequest) {
    try {
      await this.deepseekService.testConfig(body);
      return { ok: true, message: '连接测试成功。' };
    } catch {
      return { ok: false, message: '模型连接测试失败，请检查 URL、API Key 和模型名称。' };
    }
  }
}
