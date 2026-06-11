import { Module } from '@nestjs/common';
import { ToolsController } from './tools.controller.js';
import { ToolsService } from './tools.service.js';

@Module({
  controllers: [ToolsController],
  providers: [ToolsService],
  exports: [ToolsService]
})
export class ToolsModule {}
