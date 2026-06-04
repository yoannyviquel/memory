import type { MemoryStore } from '../store.js';
import type { EmbedConfig } from '../embeddings.js';

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolContext {
  store: MemoryStore;
  embedCfg: EmbedConfig;
}

export interface ToolDefinition<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  handler: (args: TArgs, ctx: ToolContext) => Promise<string>;
}
