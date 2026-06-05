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
  watch,
} from 'node:fs';
import path from 'node:path';
import { loadConfig, EMBED_TEXT_VERSION, type MemoryConfig } from './config.js';
import { MemoryStore, type MemoryDoc } from './store.js';
import { embed, embedReady } from './embeddings.js';
import { digestSession, claudeAvailable } from './digest.js';
import { refreshLeadership, readLock, releaseLeadership } from './leader.js';
import { startEmbedServer, remoteEmbed } from './embed-service.js';
import { randomBytes } from 'node:crypto';
import { nowIso, uniq } from './memory.js';
import { allTools } from './tools/index.js';
import { log, writeStatus } from './log.js';

declare const __PKG_VERSION__: string;
const PKG_VERSION = typeof __PKG_VERSION__ !== 'undefined' ? __PKG_VERSION__ : '0.0.0-dev';

// The MCP SDK communicates on stdout: we guard against console.log (transformers.js logs the
// model download via console → redirected to stderr so as not to corrupt the protocol).
console.log = (...args: unknown[]) => console.error('[stdout-redirected]', ...args);

const BACKFILL_INTERVAL_MS = 60_000;
const HEARTBEAT_MS = 30_000;
let backfilling = false;
// Only the elected leader runs the heavy background work; updated by the heartbeat below.
let amLeader = false;
// Leader's loopback embedding endpoint (set once we become leader and start the service).
let myEmbedPort = 0;
let myEmbedToken = '';

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

let digesting = false;
// Drip rate: sessions digested per tick. Keeps the first-run backlog from bursting `claude -p` calls.
const DIGEST_PER_TICK = 3;

/**
 * Background LLM compression: turns completed sessions into a typed `digest` + `insight` docs
 * (decisions/bugfixes/discoveries/conclusions), via `claude -p --bare` (user's default model).
 * Decoupled from the hooks through the DB — same pattern as backfill. Drip-limited and best-effort:
 * a missing `claude` binary or a parse failure just skips the session (raw turns stay searchable).
 */
let warnedNoClaude = false;

async function digestPending(store: MemoryStore, cfg: MemoryConfig): Promise<void> {
  if (digesting || !cfg.digest.enabled) return;
  // No native `claude` binary → digests can't run. Log once; raw memory stays fully functional.
  if (!claudeAvailable()) {
    if (!warnedNoClaude) {
      warnedNoClaude = true;
      log(cfg.dataDir, '[digest] disabled: no native `claude` binary found on PATH (~/.local/bin)');
    }
    return;
  }
  digesting = true;
  try {
    const sessions = store.sessionsNeedingDigest(cfg.digest.version, DIGEST_PER_TICK);
    for (const sess of sessions) {
      const turns = store.turnsForSession(sess.session_id);
      if (turns.length === 0) continue;
      writeStatus(cfg.dataDir, {
        state: 'digesting',
        digestPending: store.countSessionsNeedingDigest(cfg.digest.version),
      });
      const result = await digestSession({
        session_id: sess.session_id,
        project: sess.project,
        branch: sess.branch,
        model: cfg.digest.model,
        turns,
      });
      if (!result) continue;
      const ts = nowIso();
      const base = { session_id: sess.session_id, project: sess.project, branch: sess.branch, ts };
      const digestFiles = uniq(result.insights.flatMap((i) => i.files ?? []));
      const digestDoc: MemoryDoc = {
        type: 'digest',
        ...base,
        summary: result.conclusion,
        source: String(cfg.digest.version), // version marker → re-digest selector
        files_modified: digestFiles,
      };
      const insightDocs: MemoryDoc[] = result.insights.map((ins) => ({
        type: 'insight',
        ...base,
        summary: ins.text,
        assistant_text: ins.text,
        source: ins.kind, // decision | bugfix | discovery | conclusion
        files_modified: ins.files ?? [],
      }));
      store.writeDigest(sess.session_id, digestDoc, insightDocs);
      log(
        cfg.dataDir,
        `[digest] ${sess.session_id} → ${result.insights.length} insights${
          result.costUsd != null ? ` ($${result.costUsd.toFixed(4)})` : ''
        }`,
      );
    }
  } catch {
    /* best-effort: never block the server */
  } finally {
    digesting = false;
    const remaining = store.countSessionsNeedingDigest(cfg.digest.version);
    if (remaining === 0) writeStatus(cfg.dataDir, { state: 'idle', digestPending: 0 });
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
  const store = new MemoryStore(
    config.dbPath,
    config.embed.dim,
    config.embed.model,
    EMBED_TEXT_VERSION,
  );
  await store.init();

  // Query embedding for search: the leader embeds locally (it holds the model); a non-leader routes
  // to the leader's loopback service so it never loads its own copy of the model. If the leader is
  // unreachable (e.g. mid-failover) → null → the search degrades to BM25-only.
  const embedQuery = async (text: string): Promise<number[] | null> => {
    if (!config.embed.enabled || !store.vectorEnabled) return null;
    if (amLeader) return embed(text, config.embed);
    const lock = readLock(config.dataDir);
    if (lock?.port && lock?.token) {
      const v = await remoteEmbed({ port: lock.port, token: lock.token }, text);
      if (v) return v;
    }
    return null;
  };
  const ctx = { store, embedCfg: config.embed, config, embedQuery };

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
  log(config.dataDir, `[server] exec=${process.execPath}`); // reveals whether we run as node or the renamed exe
  log(config.dataDir, `[server] db=${config.dbPath} model=${config.embed.model} dim=${config.embed.dim} dtype=${config.embed.dtype} vectors=${store.vectorEnabled ? 'on' : 'off'}`);
  const modelDir = path.join(config.embed.cacheDir, ...config.embed.model.split('/'));
  log(config.dataDir, `[server] model cache: ${existsSync(modelDir) ? 'present' : 'absent → download on first use'} (${modelDir})`);
  writeStatus(config.dataDir, {
    state: 'idle',
    model: config.embed.model,
    vectorized: store.stats().vectorCount,
    missing: store.countMissingVectors(),
  });

  // Leader election: one server instance (across all open sessions) owns the heavy background work
  // AND the single loaded model, exposed to the others via a loopback embedding service. Heartbeat
  // renews the lease + republishes the endpoint; a non-leader takes over within ~STALE_MS if the
  // leader dies (and then starts its own service).
  const leaderExtra = () => (myEmbedPort ? { port: myEmbedPort, token: myEmbedToken } : {});
  const syncLeadership = async (): Promise<void> => {
    const was = amLeader;
    amLeader = refreshLeadership(config.dataDir, leaderExtra());
    if (amLeader && !myEmbedPort && store.vectorEnabled && config.embed.enabled) {
      myEmbedToken = randomBytes(16).toString('hex');
      try {
        myEmbedPort = await startEmbedServer(config.embed, myEmbedToken);
        refreshLeadership(config.dataDir, leaderExtra()); // publish the endpoint
        log(config.dataDir, `[server] embed service on 127.0.0.1:${myEmbedPort}`);
      } catch {
        myEmbedPort = 0;
      }
    }
    if (amLeader !== was) {
      log(config.dataDir, `[server] leadership → ${amLeader}`);
      if (amLeader) {
        // Just took leadership (startup or failover) → warm the model and drain now, instead of
        // waiting up to a full interval. Keeps the embed service ready for the other sessions.
        if (store.vectorEnabled && config.embed.enabled) void backfill(store, config);
        if (config.digest.enabled) void digestPending(store, config);
      }
    }
  };
  await syncLeadership();
  log(config.dataDir, `[server] leader=${amLeader} (pid ${process.pid})`);
  const heartbeat = setInterval(() => void syncLeadership(), HEARTBEAT_MS);
  heartbeat.unref?.();

  // Release leadership the instant this session closes so a sibling takes over on its next heartbeat
  // (~30 s) instead of waiting out the stale timeout. Claude Code closing the window ends our stdin
  // pipe (Windows) or sends a signal (POSIX); both paths clean up. A hard kill falls back to STALE_MS.
  let releasing = false;
  const releaseAndExit = () => {
    if (releasing) return;
    releasing = true;
    if (amLeader) {
      releaseLeadership(config.dataDir);
      log(config.dataDir, `[server] released leadership on exit (pid ${process.pid})`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', releaseAndExit);
  process.on('SIGINT', releaseAndExit);
  process.stdin.on('end', releaseAndExit);
  process.stdin.on('close', releaseAndExit);

  // Near-instant failover: watch the lock file. When the leader releases it (or it changes), a
  // follower re-checks leadership immediately instead of waiting for its 30s heartbeat. Only
  // followers react (a leader ignores its own writes → no self-trigger loop). Heartbeat remains the
  // fallback if fs.watch is unsupported or misses an event.
  try {
    let watchT: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(config.dataDir, (_event, filename) => {
      if (!amLeader && filename && String(filename).includes('worker.lock')) {
        clearTimeout(watchT);
        watchT = setTimeout(() => void syncLeadership(), 200);
      }
    });
    watcher.unref?.();
  } catch {
    /* fs.watch unsupported → heartbeat covers failover */
  }

  // Background vectorization (leader-only, non-blocking): at startup then periodically.
  if (store.vectorEnabled && config.embed.enabled) {
    const tick = () => {
      if (amLeader) void backfill(store, config);
    };
    tick();
    const timer = setInterval(tick, BACKFILL_INTERVAL_MS);
    timer.unref?.();
  }

  // Background LLM digests (leader-only, non-blocking): at startup then periodically. Drip-limited.
  if (config.digest.enabled) {
    const tick = () => {
      if (amLeader) void digestPending(store, config);
    };
    tick();
    const timer = setInterval(tick, BACKFILL_INTERVAL_MS);
    timer.unref?.();
  }
}

main().catch((err) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
