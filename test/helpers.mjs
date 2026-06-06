import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(REPO, 'dist', 'server.js');
const HOOK = path.join(REPO, 'dist', 'hook.js');

/** A fresh, isolated data dir (its own DB + worker.lock) so tests never touch the real plugin. */
export function freshDataDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'mem-e2e-'));
}

export function cleanup(dataDir) {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** Common child env: isolated data dir, no rename/digest/rerank, light tier, shared model cache. */
export function baseEnv(dataDir, extra = {}) {
  return {
    ...process.env,
    MEMORY_DATA_DIR: dataDir,
    MEMORY_DB_PATH: path.join(dataDir, 'memories.db'),
    MEMORY_DISABLE_RENAME: '1',
    MEMORY_DIGEST_ENABLED: '0',
    MEMORY_RERANK_ENABLED: '0',
    MEMORY_EMBED_TIER: 'light',
    // Reuse the real model cache so the light model isn't re-downloaded per test.
    MEMORY_EMBED_CACHE_DIR: path.join(os.homedir(), '.claude-memory', 'models'),
    ...extra,
  };
}

export function lockPath(dataDir) {
  return path.join(dataDir, 'worker.lock');
}

export function readLock(dataDir) {
  try {
    return JSON.parse(readFileSync(lockPath(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** Runs a hook (node dist/hook.js <mode>) with a JSON payload on stdin; returns parsed stdout. */
export function runHook(mode, payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [HOOK, mode], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(out.trim() ? JSON.parse(out) : {});
      } catch {
        resolve({ raw: out });
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/** Spawns dist/server.js as an MCP server and connects a client. close() ends stdin → graceful exit. */
export async function startServer(env) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER],
    env,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'e2e', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    async close() {
      try {
        await client.close();
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Calls a tool and returns the concatenated text content. */
export async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  return (res.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls fn() until it returns truthy, or throws on timeout. Returns fn's value. */
export async function pollUntil(fn, { timeoutMs = 10000, stepMs = 300, label = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`pollUntil timed out: ${label}`);
    await sleep(stepMs);
  }
}
