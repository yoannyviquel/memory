import type { MemoryStore } from '../store.js';
import type { EmbedConfig, EmbedderHost } from '../embeddings.js';
import type { MemoryConfig } from '../config.js';

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolContext {
  store: MemoryStore;
  embedCfg: EmbedConfig;
  config: MemoryConfig;
  /** The embedder host — for status reporting only (loaded()/deviceUsed()); never forces a load. */
  embedder: EmbedderHost;
  /** Embeds a search query — locally if leader, else via the leader's loopback service (null → BM25). */
  embedQuery: (text: string) => Promise<number[] | null>;
  /** Reranks candidate docs for a query — scores aligned to docs, or null (→ keep RRF order). */
  rerank: (query: string, docs: string[]) => Promise<number[] | null>;
}

export interface ToolDefinition<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  handler: (args: TArgs, ctx: ToolContext) => Promise<string>;
}
