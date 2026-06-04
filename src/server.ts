import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, type MemoryConfig } from './config.js';
import { MemoryStore } from './store.js';
import { embedBatch, embedReady } from './embeddings.js';
import { allTools } from './tools/index.js';
import { log, writeStatus } from './log.js';

/**
 * statusLine snippet (opt-in): reads status.json and shows a discreet presence reminder
 * "🧠 mem" (+ ⚙ during a backfill, ⏳x% during a download). Written to a stable path
 * in dataDir so the settings.json config doesn't depend on the plugin version.
 */
function statusLineScript(dataDir: string): string {
  const status = JSON.stringify(path.join(dataDir, 'status.json'));
  return `import { readFileSync } from 'node:fs';
try {
  const s = JSON.parse(readFileSync(${status}, 'utf8'));
  let glyph = '';
  if (s.state === 'downloading') glyph = ' \\u23F3' + (s.progress ?? '') + '%';
  else if (s.state === 'backfilling') glyph = ' \\u2699';
  else if (s.state === 'loading') glyph = ' \\u2026';
  process.stdout.write('\\uD83E\\uDDE0 mem' + glyph);
} catch {
  process.stdout.write('\\uD83E\\uDDE0 mem');
}
`;
}

function ensureStatusLineScript(dataDir: string): void {
  try {
    const file = path.join(dataDir, 'statusline.mjs');
    const content = statusLineScript(dataDir);
    if (!existsSync(file)) writeFileSync(file, content);
  } catch {
    /* best-effort */
  }
}

declare const __PKG_VERSION__: string;
const PKG_VERSION = typeof __PKG_VERSION__ !== 'undefined' ? __PKG_VERSION__ : '0.0.0-dev';

// The MCP SDK communicates on stdout: we guard against console.log (transformers.js logs the
// model download via console → redirected to stderr so as not to corrupt the protocol).
console.log = (...args: unknown[]) => console.error('[stdout-redirected]', ...args);

const BACKFILL_BATCH = 32;
const BACKFILL_INTERVAL_MS = 60_000;
let backfilling = false;

/** Vectorizes in the background the docs captured by the hooks (which don't bundle the model). */
async function backfill(store: MemoryStore, cfg: MemoryConfig): Promise<void> {
  if (backfilling || !store.vectorEnabled || !cfg.embed.enabled) return;
  if (!(await embedReady(cfg.embed))) return;
  backfilling = true;
  try {
    for (;;) {
      const docs = store.missingVectorDocs(BACKFILL_BATCH);
      if (docs.length === 0) break;
      const s = store.stats();
      writeStatus(cfg.dataDir, {
        state: 'backfilling',
        model: cfg.embed.model,
        vectorized: s.vectorCount,
        missing: store.countMissingVectors(),
      });
      const vectors = await embedBatch(
        docs.map((d) => d.text),
        cfg.embed,
      );
      for (let i = 0; i < docs.length; i++) {
        if (vectors[i]) store.setVectorByRowid(docs[i].rowid, vectors[i] as number[]);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  } catch {
    /* best-effort */
  } finally {
    backfilling = false;
    const s = store.stats();
    writeStatus(cfg.dataDir, {
      state: 'idle',
      vectorized: s.vectorCount,
      missing: store.countMissingVectors(),
    });
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new MemoryStore(config.dbPath, config.embed.dim, config.embed.model);
  await store.init();
  const ctx = { store, embedCfg: config.embed };

  const server = new Server(
    { name: 'memory', version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = allTools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `❌ Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const text = await tool.handler(
        (req.params.arguments ?? {}) as Record<string, unknown>,
        ctx,
      );
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `❌ ${tool.name} failed: ${message}` }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `memory v${PKG_VERSION} ready (stdio) → ${config.dbPath} | vectors: ${store.vectorEnabled ? 'on' : 'off'}\n`,
  );

  // First-startup diagnostics (also captures slow model downloads).
  ensureStatusLineScript(config.dataDir);
  log(config.dataDir, `[server] memory v${PKG_VERSION} — node ${process.version} ${process.platform}/${process.arch}`);
  log(config.dataDir, `[server] db=${config.dbPath} model=${config.embed.model} dim=${config.embed.dim} dtype=${config.embed.dtype} vectors=${store.vectorEnabled ? 'on' : 'off'}`);
  const modelDir = path.join(config.embed.cacheDir, ...config.embed.model.split('/'));
  log(config.dataDir, `[server] model cache: ${existsSync(modelDir) ? 'present' : 'absent → download on first use'} (${modelDir})`);
  writeStatus(config.dataDir, {
    state: 'idle',
    model: config.embed.model,
    vectorized: store.stats().vectorCount,
    missing: store.countMissingVectors(),
  });

  // Background vectorization (non-blocking): at startup then periodically.
  if (store.vectorEnabled && config.embed.enabled) {
    void backfill(store, config);
    const timer = setInterval(() => void backfill(store, config), BACKFILL_INTERVAL_MS);
    timer.unref?.();
  }
}

main().catch((err) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
