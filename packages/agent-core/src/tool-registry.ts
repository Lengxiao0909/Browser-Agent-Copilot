import type { ToolDefinition, ToolExecutionResult } from '@bac/shared';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition) {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  list() {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      layer: tool.layer,
      risk: tool.risk,
      inputSchema: tool.inputSchema
    }));
  }

  get(name: string) {
    return this.tools.get(name);
  }

  async execute<Input = unknown, Output = unknown>(
    name: string,
    input: Input
  ): Promise<ToolExecutionResult<Output>> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { toolName: name, ok: false, error: `Unknown tool: ${name}` };
    }

    try {
      const output = await tool.execute(input);
      return { toolName: name, ok: true, output: output as Output };
    } catch (error) {
      return {
        toolName: name,
        ok: false,
        error: error instanceof Error ? error.message : 'Tool execution failed'
      };
    }
  }
}
