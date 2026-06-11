import type { ToolDefinition, ToolExecutionResult } from '@bac/shared';

export interface McpAdapter {
  id: string;
  title: string;
  isAvailable(): Promise<boolean>;
  listTools(): Promise<ToolDefinition[]>;
  executeTool<Input = unknown, Output = unknown>(
    toolName: string,
    input: Input
  ): Promise<ToolExecutionResult<Output>>;
}
