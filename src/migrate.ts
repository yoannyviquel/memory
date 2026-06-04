import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { MemoryStore, type BulkItem, type MemoryDoc } from './store.js';
import { embedBatch, embedText, embedReady, type EmbedConfig } from './embeddings.js';

interface Args {
  db: string;
  project?: string;
  dryRun: boolean;
  batch: number;
  embed: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: path.join(os.homedir(), '.claude-mem', 'claude-mem.db'),
    dryRun: false,
    batch: 500,
    embed: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--embed') args.embed = true;
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--batch') args.batch = Number(argv[++i]) || 500;
  }
  return args;
}

function parseJsonArray(v: unknown): string[] {
  if (!v || typeof v !== 'string') return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function clip(v: unknown, max: number): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s ? s.slice(0, max) : undefined;
}

function joinParts(parts: Array<[string, unknown]>, max: number): string {
  return parts
    .filter(([, v]) => v != null && String(v).trim())
    .map(([label, v]) => `${label}: ${String(v).trim()}`)
    .join('\n\n')
    .slice(0, max);
}

/** Text to embed for a migrated doc. */
function docEmbedText(d: MemoryDoc): string {
  return embedText([d.summary, d.user_prompt, d.assistant_text, ...(d.prompts ?? [])]);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();

  if (!existsSync(args.db)) {
    console.error(`❌ claude-mem SQLite database not found: ${args.db}`);
    process.exit(1);
  }

  const sqliteModule = 'node:sqlite';
  let DatabaseSync: any;
  try {
    ({ DatabaseSync } = await import(sqliteModule));
  } catch {
    console.error(
      `❌ Module 'node:sqlite' unavailable. Node ${process.version}; requires Node ≥ 22.5.`,
    );
    process.exit(1);
  }

  // Migration embeddings (local transformers.js model, loaded once for the whole batch).
  const embedCfg: EmbedConfig = cfg.embed;
  if (args.embed && !args.dryRun) {
    if (!(await embedReady(embedCfg))) {
      console.error(
        `❌ --embed requested but the local embedder (${embedCfg.model}) failed to load. Migrate without --embed, or check model access.`,
      );
      process.exit(1);
    }
  }

  const db = new DatabaseSync(args.db, { readOnly: true });
  const safeAll = (sql: string): any[] => {
    try {
      return db.prepare(sql).all();
    } catch (err) {
      console.error(`⚠️ Read failed (${sql}): ${err instanceof Error ? err.message : err}`);
      return [];
    }
  };

  const memToContent = new Map<string, string>();
  const contentToProject = new Map<string, string>();
  for (const s of safeAll('SELECT * FROM sdk_sessions')) {
    if (s.memory_session_id && s.content_session_id)
      memToContent.set(s.memory_session_id, s.content_session_id);
    if (s.content_session_id && s.project) contentToProject.set(s.content_session_id, s.project);
  }
  const resolveSession = (memId?: string): string =>
    (memId && memToContent.get(memId)) || memId || 'claude-mem';
  const resolveProject = (rowProject?: string, contentId?: string): string =>
    args.project || rowProject || (contentId && contentToProject.get(contentId)) || 'claude-mem';

  const items: BulkItem[] = [];
  const counts = { observations: 0, session_summaries: 0, user_prompts: 0 };

  for (const o of safeAll('SELECT * FROM observations')) {
    counts.observations++;
    items.push({
      id: `migrated:obs:${o.id}`,
      doc: {
        type: 'observation',
        session_id: resolveSession(o.memory_session_id),
        project: resolveProject(o.project, memToContent.get(o.memory_session_id)),
        ts: o.created_at,
        prompt_number: o.prompt_number ?? undefined,
        summary: clip(o.title, 1000) || clip(o.subtitle, 1000),
        assistant_text: joinParts(
          [
            ['Discovery', o.title],
            ['Detail', o.subtitle],
            ['Narrative', o.narrative],
            ['Facts', o.facts],
            ['Text', o.text],
          ],
          12000,
        ),
        tool_brief: clip(o.type, 100),
        files_read: parseJsonArray(o.files_read),
        files_modified: parseJsonArray(o.files_modified),
      },
    });
  }

  for (const s of safeAll('SELECT * FROM session_summaries')) {
    counts.session_summaries++;
    items.push({
      id: `migrated:session:${s.id}`,
      doc: {
        type: 'session',
        session_id: resolveSession(s.memory_session_id),
        project: resolveProject(s.project, memToContent.get(s.memory_session_id)),
        ts: s.created_at,
        started_at: s.created_at,
        prompt_number: s.prompt_number ?? undefined,
        summary: clip(s.request, 1000),
        assistant_text: joinParts(
          [
            ['Request', s.request],
            ['Investigated', s.investigated],
            ['Learned', s.learned],
            ['Completed', s.completed],
            ['Next steps', s.next_steps],
            ['Notes', s.notes],
          ],
          12000,
        ),
        files_read: parseJsonArray(s.files_read),
        files_modified: parseJsonArray(s.files_edited),
      },
    });
  }

  for (const p of safeAll('SELECT * FROM user_prompts')) {
    counts.user_prompts++;
    items.push({
      id: `migrated:prompt:${p.id}`,
      doc: {
        type: 'prompt',
        session_id: p.content_session_id || 'claude-mem',
        project: resolveProject(undefined, p.content_session_id),
        ts: p.created_at,
        prompt_number: p.prompt_number ?? undefined,
        user_prompt: clip(p.prompt_text, 4000),
        summary: clip(p.prompt_text, 200),
      },
    });
  }

  db.close();

  console.error(
    `📊 Read: observations=${counts.observations}, session_summaries=${counts.session_summaries}, user_prompts=${counts.user_prompts} → ${items.length} documents.`,
  );

  if (args.dryRun) {
    console.error(`🟡 --dry-run: no writes.${args.embed ? ' (--embed would be applied)' : ''}`);
    process.exit(0);
  }

  const store = new MemoryStore(cfg.dbPath, cfg.embed.dim, cfg.embed.model);
  await store.init();
  if (args.embed && !store.vectorEnabled) {
    console.error('⚠️ --embed requested but vector index unavailable (sqlite-vec) → importing without vectors.');
  }
  const doEmbed = args.embed && store.vectorEnabled;

  let indexed = 0;
  let errors = 0;
  let embedded = 0;
  for (let i = 0; i < items.length; i += args.batch) {
    const slice = items.slice(i, i + args.batch);
    if (doEmbed) {
      const vectors = await embedBatch(slice.map((it) => docEmbedText(it.doc)), embedCfg);
      slice.forEach((it, j) => {
        it.embedding = vectors[j];
        if (vectors[j]) embedded++;
      });
    }
    const res = store.bulkUpsert(slice);
    indexed += res.indexed;
    errors += res.errors;
    console.error(
      `  …indexed ${indexed}/${items.length} (errors: ${errors}${doEmbed ? `, vectors: ${embedded}` : ''})`,
    );
  }
  store.close();

  console.error(
    `✅ Migration done: ${indexed} indexed, ${errors} errors${doEmbed ? `, ${embedded} vectors` : ''} → ${cfg.dbPath}`,
  );
  process.exit(errors > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
