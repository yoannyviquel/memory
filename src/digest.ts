import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A durable, typed fact extracted from a session. */
export interface Insight {
  kind: 'decision' | 'bugfix' | 'discovery' | 'conclusion';
  text: string;
  files?: string[];
}

export interface DigestResult {
  conclusion: string;
  insights: Insight[];
  /**
   * How satisfied/content the user seemed across the session, in [0, 1]: 0 = clearly
   * frustrated/dissatisfied, 0.5 = neutral, 1 = clearly satisfied/pleased. Defaults to 0.5 (neutral)
   * when the model gives no usable signal. Drives the satisfaction weighting at search time.
   */
  satisfaction: number;
  /** One or two words for the user's overall mood (e.g. "satisfied", "frustrated"). Optional. */
  mood?: string;
  /** Usage envelope from `claude -p --output-format json`, for transparency/logging. */
  usage?: unknown;
  costUsd?: number;
}

export interface DigestInput {
  session_id: string;
  project?: string;
  branch?: string;
  /** Model id for the digest call (e.g. Haiku). Omitted → CLI default model. */
  model?: string;
  turns: Array<{
    user_prompt?: string;
    assistant_text?: string;
    tools: string[];
    files_modified: string[];
  }>;
}

const KINDS = new Set(['decision', 'bugfix', 'discovery', 'conclusion']);
const INPUT_BUDGET = 48_000; // chars of session text fed to the model
const TIMEOUT_MS = 180_000;

/**
 * Signatures of a usage/rate-limit/quota exhaustion in `claude -p` output (stdout JSON, stderr, or
 * the human "Claude AI usage limit reached" line). When matched, the digest loop must PAUSE rather
 * than keep retrying every tick — otherwise it hammers a quota that is already spent.
 */
const QUOTA_RE =
  /usage limit reached|rate[ _-]?limit|\b429\b|\b529\b|overloaded|quota (?:exceeded|reached)|insufficient_quota/i;

/**
 * Parses a reset time when the CLI exposes one. The headless usage-limit line carries an epoch:
 * `Claude AI usage limit reached|1700000000`. Returns the reset moment in epoch-ms, or undefined
 * (caller then falls back to exponential backoff). Tolerates epoch given in seconds or ms.
 */
export function parseResetMs(text: string): number | undefined {
  const m = text.match(/usage limit reached\s*\|\s*(\d{9,13})/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return n < 1e12 ? n * 1000 : n; // seconds → ms
}

/** Outcome of one digest attempt: a result, a quota pause signal, or a skippable failure. */
export type DigestOutcome =
  | { status: 'ok'; result: DigestResult }
  | { status: 'rate_limited'; retryAtMs?: number }
  | { status: 'skip' };

/** Outcome of one `claude -p` invocation. */
type ClaudeRun =
  | { kind: 'ok'; envelope: any }
  | { kind: 'rate_limited'; retryAtMs?: number }
  | { kind: 'fail' };

/** Builds the session text fed to the digest model (chronological, budget-capped). */
function renderSession(input: DigestInput): string {
  const parts: string[] = [];
  let size = 0;
  let truncated = false;
  for (const t of input.turns) {
    const u = (t.user_prompt ?? '').trim();
    const a = (t.assistant_text ?? '').trim();
    const files = t.files_modified.length ? `\n  files: ${t.files_modified.join(', ')}` : '';
    const block = `> user: ${u}\n  assistant: ${a}${files}`;
    if (size + block.length > INPUT_BUDGET) {
      truncated = true;
      break;
    }
    parts.push(block);
    size += block.length;
  }
  if (truncated) parts.push('… [session truncated for length]');
  return parts.join('\n\n');
}

function buildPrompt(input: DigestInput): string {
  return [
    'You compress a Claude Code coding session into durable memory for future sessions.',
    'Read the session (user prompts + assistant turns + touched files) and extract only durable, reusable facts.',
    '',
    'Output ONLY a JSON object — no prose, no markdown fences — with exactly this shape:',
    '{',
    '  "conclusion": "1-3 sentences: what was achieved and the final state",',
    '  "insights": [',
    '    { "kind": "decision|bugfix|discovery|conclusion", "text": "one concrete durable fact", "files": ["path"] }',
    '  ],',
    '  "satisfaction": 0.0,',
    '  "mood": "one or two words"',
    '}',
    '',
    'Rules:',
    '- 3 to 8 insights max. Only decisions made, bugs fixed, things discovered, or conclusions. Skip chit-chat and intermediate noise.',
    '- "files" is optional; include only files actually touched for that fact.',
    '- "satisfaction" is a number in [0, 1] rating how satisfied/content the USER seemed by the end:',
    '  0 = clearly frustrated or dissatisfied (repeated corrections, complaints, things still broken),',
    '  0.5 = neutral or unclear, 1 = clearly satisfied/pleased (thanks, praise, goal achieved cleanly).',
    '  Judge ONLY from the user\'s tone and reactions, not your own opinion. Use 0.5 when in doubt.',
    '- "mood" is one or two words for the user\'s overall mood (e.g. satisfied, frustrated, neutral, grateful).',
    '- Be concise and specific. Write in the language of the session.',
    '- Do not use any tools. Just read the session text below and respond with the JSON.',
    '',
    `SESSION (project: ${input.project ?? '?'}, branch: ${input.branch ?? '?'}):`,
    renderSession(input),
  ].join('\n');
}

/** Extracts the first balanced JSON object from arbitrary text (model may wrap it in prose). */
function extractJsonObject(text: string): any | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Locates the native `claude` executable. We need the real binary (not the npm .cmd shim) so we can
 * spawn WITHOUT a shell — a shell mangles the empty-string `--setting-sources ""` argument on Windows.
 * Returns null if only a .cmd shim exists (digests then degrade off; raw memory still works).
 */
export function resolveClaudeExe(): string | null {
  const isWin = process.platform === 'win32';
  const name = isWin ? 'claude.exe' : 'claude';
  const sep = isWin ? ';' : ':';
  const dirs = [path.join(os.homedir(), '.local', 'bin'), ...(process.env.PATH || '').split(sep)];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** True if a spawnable native `claude` binary is present (digests possible). */
export function claudeAvailable(): boolean {
  return resolveClaudeExe() !== null;
}

/**
 * Runs `claude -p` headless with the digest model (Haiku by default, via --model). Isolation without --bare
 * (which would skip keychain reads → "Not logged in"): `--setting-sources ""` drops user/project/
 * local settings, so hooks AND plugins don't load (no re-entrance with our own hooks; the user's
 * plugin MCP servers stay down). `--strict-mcp-config` blocks any .mcp.json; `--disable-slash-commands`
 * drops skills. MEMORY_HOOK_DISABLE=1 is a belt-and-suspenders guard read by our hooks. Spawned
 * without a shell (native exe) so the empty-string arg survives. Prompt via stdin. Returns the JSON
 * envelope, or null. Verified flags for CLI v2.1.x (no --max-turns in this version).
 */
function runClaude(prompt: string, model?: string): Promise<ClaudeRun> {
  return new Promise((resolve) => {
    const exe = resolveClaudeExe();
    if (!exe) {
      resolve({ kind: 'fail' });
      return;
    }
    const args = [
      '-p',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--output-format',
      'json',
    ];
    if (model) args.push('--model', model);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, MEMORY_HOOK_DISABLE: '1' },
      });
    } catch {
      resolve({ kind: 'fail' });
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    // Classifies a non-success run: a quota/rate-limit signal (→ pause) vs a generic failure (→ skip).
    const classifyFailure = (): ClaudeRun => {
      const blob = `${out}\n${err}`;
      if (QUOTA_RE.test(blob)) return { kind: 'rate_limited', retryAtMs: parseResetMs(blob) };
      return { kind: 'fail' };
    };
    const finish = (v: ClaudeRun) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish({ kind: 'fail' }), TIMEOUT_MS);
    timer.unref?.();
    child.on('error', () => finish({ kind: 'fail' })); // ENOENT: claude not on PATH
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve(classifyFailure());
        return;
      }
      let envelope: any;
      try {
        envelope = JSON.parse(out);
      } catch {
        resolve(classifyFailure());
        return;
      }
      // A zero exit can still carry an in-band error (is_error) whose text is a quota signal.
      if (envelope?.is_error && QUOTA_RE.test(String(envelope.result ?? out))) {
        resolve({ kind: 'rate_limited', retryAtMs: parseResetMs(String(envelope.result ?? out)) });
        return;
      }
      resolve({ kind: 'ok', envelope });
    });
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      finish({ kind: 'fail' });
    }
  });
}

/**
 * Compresses a session into a conclusion + typed insights. Best-effort: returns `skip` on any
 * non-quota failure (raw turns stay searchable), or `rate_limited` when `claude -p` reports a
 * usage/rate-limit so the caller can pause instead of hammering a spent quota.
 */
export async function digestSession(input: DigestInput): Promise<DigestOutcome> {
  if (input.turns.length === 0) return { status: 'skip' };
  const run = await runClaude(buildPrompt(input), input.model);
  if (run.kind === 'rate_limited') return { status: 'rate_limited', retryAtMs: run.retryAtMs };
  if (run.kind !== 'ok') return { status: 'skip' };
  const envelope = run.envelope;
  if (!envelope || typeof envelope.result !== 'string') return { status: 'skip' };

  const parsed = extractJsonObject(envelope.result);
  const conclusion =
    (parsed && typeof parsed.conclusion === 'string' && parsed.conclusion.trim()) ||
    envelope.result.trim().slice(0, 1000);
  if (!conclusion) return { status: 'skip' };

  const rawInsights: any[] = parsed && Array.isArray(parsed.insights) ? parsed.insights : [];
  const insights: Insight[] = rawInsights
    .filter((x) => x && typeof x.text === 'string' && x.text.trim())
    .slice(0, 8)
    .map((x) => ({
      kind: KINDS.has(x.kind) ? x.kind : 'discovery',
      text: String(x.text).trim().slice(0, 1000),
      files: Array.isArray(x.files)
        ? x.files.filter((f: unknown) => typeof f === 'string').slice(0, 10)
        : undefined,
    }));

  // Satisfaction: clamp to [0, 1]; default to 0.5 (neutral) when the model gives no usable number.
  const satRaw = parsed ? Number(parsed.satisfaction) : NaN;
  const satisfaction = Number.isFinite(satRaw) ? Math.max(0, Math.min(1, satRaw)) : 0.5;
  const mood =
    parsed && typeof parsed.mood === 'string' && parsed.mood.trim()
      ? parsed.mood.trim().slice(0, 40)
      : undefined;

  return {
    status: 'ok',
    result: {
      conclusion,
      insights,
      satisfaction,
      mood,
      usage: envelope.usage,
      costUsd: typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : undefined,
    },
  };
}
