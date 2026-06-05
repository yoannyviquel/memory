import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { loadConfig, type MemoryConfig } from './config.js';
import { MemoryStore } from './store.js';
import { embed, embedReady } from './embeddings.js';
import { allTools } from './tools/index.js';
import { log, writeStatus } from './log.js';

declare const __PKG_VERSION__: string;
const PKG_VERSION = typeof __PKG_VERSION__ !== 'undefined' ? __PKG_VERSION__ : '0.0.0-dev';

// The MCP SDK communicates on stdout: we guard against console.log (transformers.js logs the
// model download via console → redirected to stderr so as not to corrupt the protocol).
console.log = (...args: unknown[]) => console.error('[stdout-redirected]', ...args);

const BACKFILL_INTERVAL_MS = 60_000;
let backfilling = false;

/** Vectorizes in the background the docs captured by the hooks (which don't bundle the model). */
async function backfill(store: MemoryStore, cfg: MemoryConfig): Promise<void> {
  if (backfilling || !store.vectorEnabled || !cfg.embed.enabled) return;
  if (!(await embedReady(cfg.embed))) return;
  backfilling = true;
  // One doc at a time, no inter-doc delay: CPU is bounded solely by the tier's ONNX thread cap.
  // Docs stay searchable via BM25 while their vectors are still being filled in.
  try {
    for (;;) {
      const docs = store.missingVectorDocs(1);
      if (docs.length === 0) break;
      const doc = docs[0];
      writeStatus(cfg.dataDir, {
        state: 'backfilling',
        model: cfg.embed.model,
        vectorized: store.stats().vectorCount,
        missing: store.countMissingVectors(),
      });
      const vector = await embed(doc.text, cfg.embed);
      if (vector) store.setVectorByRowid(doc.rowid, vector);
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

/**
 * Renames the process so monitoring tools show "yoannyviquel_memory_<tier>" instead of "node".
 * On Linux/macOS process.title rewrites the cmdline (ps; top/htop/comm cap at 15 chars).
 * Windows Task Manager and macOS Activity Monitor read the *executable name* instead, so
 * those need the server to run from a renamed node copy — see ensureNamedBinary().
 *
 * No "claude-code" prefix: the server already runs *under* the Claude Code process, so the prefix
 * is redundant. The tier suffix (light | medium | heavy) tells which embedding model is loaded.
 */
function processName(tier: string): string {
  const safe = (tier || 'light').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `yoannyviquel_memory_${safe}`;
}

/**
 * Windows: make the server run under a "yoannyviquel_memory_<tier>.exe" image name instead of "node.exe".
 *
 * This is done at server startup (not in postinstall) on purpose: Claude Code installs plugin deps
 * with `npm install --ignore-scripts`, so postinstall never runs at install — but the MCP server is
 * always launched, which makes startup the only reliable hook.
 *
 * The current process can't rename itself, so we self-heal for the NEXT launch: copy the running
 * node binary to <pluginRoot>/bin/<name>.exe and repoint .mcp.json#command at it. After the standard
 * post-install `/reload-plugins`, the server relaunches from the renamed copy. Entirely best-effort
 * and cosmetic: the committed command stays "node", so a failure here never blocks start.
 *
 * Because the name carries the tier, a tier switch produces a new target name; stale
 * yoannyviquel_memory_*.exe copies from previous tiers are pruned (skipping the one in use).
 */
function ensureNamedBinary(name: string): void {
  if (process.platform !== 'win32') return; // Linux/macOS CLI is already covered by process.title
  try {
    const scriptPath = process.argv[1];
    if (!scriptPath) return;
    const root = path.resolve(path.dirname(scriptPath), '..'); // <root>/dist/server.js → <root>
    const binDir = path.join(root, 'bin');
    const exe = path.join(binDir, `${name}.exe`);

    if (path.basename(process.execPath).toLowerCase() === `${name}.exe`) return; // already named

    if (!existsSync(exe)) {
      mkdirSync(binDir, { recursive: true });
      copyFileSync(process.execPath, exe); // ~85 MB, one-time (until node upgrades)
    }

    // Prune orphan copies from previous tiers (e.g. switched light → medium). Skip the running exe.
    try {
      const running = path.basename(process.execPath).toLowerCase();
      for (const f of readdirSync(binDir)) {
        const low = f.toLowerCase();
        if (low.startsWith('yoannyviquel_memory_') && low.endsWith('.exe') && low !== `${name}.exe` && low !== running) {
          unlinkSync(path.join(binDir, f));
        }
      }
    } catch {
      /* best-effort prune */
    }

    const mcpPath = path.join(root, '.mcp.json');
    const desired = '${CLAUDE_PLUGIN_ROOT}/bin/' + name + '.exe';
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    if (mcp?.mcpServers?.memory && mcp.mcpServers.memory.command !== desired) {
      mcp.mcpServers.memory.command = desired;
      writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
    }
  } catch {
    /* best-effort: cosmetic rename must never block startup */
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const name = processName(config.embed.tier);
  try {
    process.title = name;
  } catch {
    /* best-effort: never block startup on a cosmetic rename */
  }
  ensureNamedBinary(name);
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
