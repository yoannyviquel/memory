import { loadConfig, EMBED_TEXT_VERSION, type MemoryConfig } from './config.js';
import { MemoryStore, type MemoryDoc } from './store.js';
import { loadState, saveState, clearState, type SessionState } from './state.js';
import { readNewTurn } from './transcript.js';
import {
  projectFromCwd,
  gitBranch,
  summarize,
  filesFromToolInput,
  toolBrief,
  nowIso,
  uniq,
} from './memory.js';

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
  reason?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;
}

const CONTINUE = JSON.stringify({ continue: true, suppressOutput: true });

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 4000).unref?.();
  });
}

function baseFields(payload: HookPayload, state: SessionState): Partial<MemoryDoc> {
  return {
    session_id: payload.session_id,
    project: state.project ?? projectFromCwd(payload.cwd),
    branch: state.branch ?? gitBranch(payload.cwd),
    cwd: payload.cwd,
    ts: nowIso(),
  };
}

// The hooks are ephemeral processes → NO embedding here (loading a model on every hook
// would be too slow). Capture is BM25-only; vectorization is done in the background by
// the persistent MCP server (backfill).

function handleSessionStart(cfg: MemoryConfig, store: MemoryStore, payload: HookPayload): string {
  const project = projectFromCwd(payload.cwd);
  // Core memories: primordial facts the user (or Claude) marked → always injected, on top.
  const cores = store.listCore(project).slice(0, 30);
  // Prefer LLM digests (conclusions/decisions = high signal); fall back to raw memories if none yet.
  const digests = store.recent({ project, type: 'digest', limit: cfg.contextLimit });
  const recent =
    digests.length > 0 ? digests : store.recent({ project, limit: cfg.contextLimit });

  // Presence header: reminds that the plugin is active and uses a little resource
  // (background indexing). stdio transport → no URL/port to expose.
  const total = store.stats().total;
  const header = `🧠 mem active — db: ${cfg.dbPath} · model: ${cfg.embed.model} · ${total} docs · vectors: ${store.vectorEnabled ? 'on' : 'off'}`;

  if (cores.length === 0 && recent.length === 0) {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: header },
    });
  }

  const lines: string[] = [header, ''];

  // Core memories first — these must be in context from the start.
  if (cores.length > 0) {
    lines.push(`## ⭐ Core memory (always-on)`);
    for (const c of cores) {
      const scope = c.doc.project ? `[${c.doc.project}]` : '[global]';
      lines.push(`- ${scope} ${summarize(c.doc.summary ?? '', 240)}`);
    }
    lines.push('');
  }

  if (recent.length > 0) {
    lines.push(`## Project memory "${project}"`);
    lines.push(`Latest memories from previous sessions:`);
    for (const d of recent) {
      const date = (d.ts ?? '').slice(0, 10);
      const label =
        d.summary ||
        d.user_prompt ||
        d.assistant_text ||
        (d.prompts && d.prompts[0]) ||
        d.tool_brief ||
        '(no summary)';
      const files = (d.files_modified ?? []).slice(0, 3).join(', ');
      lines.push(
        `- [${date}] (${d.type}) ${summarize(label, 160)}${files ? ` — files: ${files}` : ''}`,
      );
    }
    lines.push('');
  }

  lines.push(`_Search: \`memory_search\` · core: \`memory_core_add\` / \`/memory:core\`._`);

  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') },
  });
}

function handlePrompt(cfg: MemoryConfig, store: MemoryStore, payload: HookPayload): string {
  if (!payload.session_id || !payload.prompt) return CONTINUE;
  const state = loadState(cfg, payload.session_id);
  state.project = projectFromCwd(payload.cwd);
  state.branch = gitBranch(payload.cwd);
  state.cwd = payload.cwd;
  state.promptNumber += 1;
  state.prompts.push(payload.prompt.slice(0, 4000));

  const doc: MemoryDoc = {
    type: 'prompt',
    ...baseFields(payload, state),
    prompt_number: state.promptNumber,
    user_prompt: payload.prompt.slice(0, 4000),
    summary: summarize(payload.prompt),
  };
  store.upsert(`${payload.session_id}:prompt:${state.promptNumber}`, doc);
  saveState(cfg, payload.session_id, state);
  return CONTINUE;
}

function handleObserve(cfg: MemoryConfig, store: MemoryStore, payload: HookPayload): string {
  if (!payload.session_id || !payload.tool_name) return CONTINUE;
  const state = loadState(cfg, payload.session_id);
  state.obsSeq += 1;
  const { filesRead, filesModified } = filesFromToolInput(payload.tool_name, payload.tool_input);
  const brief = toolBrief(payload.tool_name, payload.tool_input);

  state.tools = uniq([...state.tools, payload.tool_name]);
  state.filesRead = uniq([...state.filesRead, ...filesRead]);
  state.filesModified = uniq([...state.filesModified, ...filesModified]);

  const doc: MemoryDoc = {
    type: 'observation',
    ...baseFields(payload, state),
    prompt_number: state.promptNumber,
    tool_name: payload.tool_name,
    tool_brief: brief,
    summary: `${payload.tool_name}: ${summarize(brief, 120)}`,
    files_read: filesRead,
    files_modified: filesModified,
  };
  store.upsert(`${payload.session_id}:obs:${state.obsSeq}`, doc);
  saveState(cfg, payload.session_id, state);
  return CONTINUE;
}

function handleStop(cfg: MemoryConfig, store: MemoryStore, payload: HookPayload): string {
  if (!payload.session_id || !payload.transcript_path) return CONTINUE;
  const state = loadState(cfg, payload.session_id);
  const { turn, totalLines } = readNewTurn(payload.transcript_path, state.lines);
  state.lines = totalLines;
  if (!turn.hasContent) {
    saveState(cfg, payload.session_id, state);
    return CONTINUE;
  }
  state.turnSeq += 1;
  state.tools = uniq([...state.tools, ...turn.tools]);
  state.filesRead = uniq([...state.filesRead, ...turn.filesRead]);
  state.filesModified = uniq([...state.filesModified, ...turn.filesModified]);

  const doc: MemoryDoc = {
    type: 'turn',
    ...baseFields(payload, state),
    prompt_number: state.promptNumber,
    user_prompt: turn.userPrompt.slice(0, 4000),
    assistant_text: turn.assistantText.slice(0, 12000),
    summary: summarize(turn.assistantText || turn.userPrompt),
    tools: turn.tools,
    files_read: turn.filesRead,
    files_modified: turn.filesModified,
  };
  store.upsert(`${payload.session_id}:turn:${state.turnSeq}`, doc);
  saveState(cfg, payload.session_id, state);
  return CONTINUE;
}

function handleSessionEnd(cfg: MemoryConfig, store: MemoryStore, payload: HookPayload): string {
  if (!payload.session_id) return CONTINUE;
  const state = loadState(cfg, payload.session_id);
  if (state.promptNumber === 0 && state.turnSeq === 0 && state.obsSeq === 0) {
    clearState(cfg, payload.session_id);
    return CONTINUE;
  }
  const summaryParts = state.prompts.slice(0, 5).map((p) => summarize(p, 120));
  const doc: MemoryDoc = {
    type: 'session',
    ...baseFields(payload, state),
    prompts: state.prompts.map((p) => p.slice(0, 1000)),
    summary: summaryParts.join(' | ').slice(0, 1000),
    tools: state.tools,
    files_read: state.filesRead,
    files_modified: state.filesModified,
    turn_count: state.turnSeq,
    started_at: state.startedAt,
    ended_at: nowIso(),
    end_reason: payload.reason,
  };
  store.upsert(`${payload.session_id}:session`, doc);
  clearState(cfg, payload.session_id);
  return CONTINUE;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  let output = CONTINUE;
  // Re-entrance guard: the digest loop spawns `claude -p` with MEMORY_HOOK_DISABLE=1. That child
  // session must NOT be captured (it would create a session that itself needs digesting → loop).
  if (process.env.MEMORY_HOOK_DISABLE === '1') {
    process.stdout.write(output);
    process.exit(0);
  }
  let store: MemoryStore | undefined;
  try {
    const cfg = loadConfig();
    const raw = await readStdin();
    let payload: HookPayload = {};
    if (raw.trim()) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = {};
      }
    }
    store = new MemoryStore(cfg.dbPath, cfg.embed.dim, cfg.embed.model, EMBED_TEXT_VERSION);
    await store.init();

    switch (mode) {
      case 'sessionstart':
        output = handleSessionStart(cfg, store, payload);
        break;
      case 'prompt':
        output = handlePrompt(cfg, store, payload);
        break;
      case 'observe':
        output = handleObserve(cfg, store, payload);
        break;
      case 'stop':
        output = handleStop(cfg, store, payload);
        break;
      case 'sessionend':
        output = handleSessionEnd(cfg, store, payload);
        break;
      default:
        output = CONTINUE;
    }
  } catch (err) {
    process.stderr.write(
      `[memory] hook ${mode} error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    output = CONTINUE;
  } finally {
    store?.close();
  }
  process.stdout.write(output);
  process.exit(0);
}

void main();
