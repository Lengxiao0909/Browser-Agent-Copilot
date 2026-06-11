export type ToolLayer = 'browser-action' | 'devtools-mcp' | 'external-mcp';
export type ToolRiskLevel = 'low' | 'medium' | 'high';

export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  title: string;
  description: string;
  layer: ToolLayer;
  risk: ToolRiskLevel;
  inputSchema?: unknown;
  execute(input: Input): Promise<Output>;
}

export interface ToolExecutionRequest<Input = unknown> {
  toolName: string;
  input: Input;
  requiresConfirmation: boolean;
}

export interface ToolExecutionResult<Output = unknown> {
  toolName: string;
  ok: boolean;
  output?: Output;
  error?: string;
}

export type BrowserActionName =
  | 'browser.get_page_summary'
  | 'browser.extract_links'
  | 'browser.describe_page_structure'
  | 'browser.find_text'
  | 'browser.highlight_text'
  | 'browser.scroll_to_text'
  | 'browser.read_selected_text';

export interface BrowserActionRequest<Input = unknown> {
  action: BrowserActionName;
  input?: Input;
  risk?: ToolRiskLevel;
  summary?: string;
  confirmed?: boolean;
}

export type BrowserActionResponse<Output = unknown> =
  | {
      ok: true;
      action: BrowserActionName;
      output: Output;
    }
  | {
      ok: false;
      action: BrowserActionName;
      error: string;
    };

export interface BrowserTextQueryInput {
  query: string;
  maxMatches?: number;
}

export interface BrowserTextMatch {
  index: number;
  text: string;
  before?: string;
  after?: string;
}
