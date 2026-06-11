import { Body, Controller, Get, Post } from '@nestjs/common';
import type { ToolExecutionRequest } from '@bac/shared';
import { ToolsService } from './tools.service.js';

@Controller('/tools')
export class ToolsController {
  constructor(private readonly toolsService: ToolsService) {}

  @Get()
  listTools() {
    return this.toolsService.listTools();
  }

  @Post('/execute')
  executeTool(@Body() body: ToolExecutionRequest) {
    return this.toolsService.executeTool(body);
  }
}
