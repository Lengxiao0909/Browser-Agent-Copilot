import { Injectable } from '@nestjs/common';
import { ToolRegistry, createBuiltinBrowserActions } from '@bac/agent-core';
import type { ToolExecutionRequest } from '@bac/shared';

@Injectable()
export class ToolsService {
  private readonly registry = new ToolRegistry();

  constructor() {
    for (const tool of createBuiltinBrowserActions()) {
      this.registry.register(tool);
    }
  }

  listTools() {
    return this.registry.list();
  }

  async executeTool(request: ToolExecutionRequest) {
    const tool = this.registry.get(request.toolName);
    if (!tool) {
      return {
        toolName: request.toolName,
        ok: false,
        error: `Unknown tool: ${request.toolName}`
      };
    }

    if (tool.risk !== 'low' && !request.requiresConfirmation) {
      return {
        toolName: request.toolName,
        ok: false,
        error: 'This tool requires explicit confirmation.'
      };
    }

    return this.registry.execute(request.toolName, request.input);
  }
}
