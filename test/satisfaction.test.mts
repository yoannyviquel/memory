import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, satisfactionFactor } from '../src/store.js';

// satisfactionFactor: bounded, neutral on missing, monotonic.
test('satisfactionFactor is a bounded, neutral-on-missing multiplier', () => {
  assert.equal(satisfactionFactor(undefined, 0.12), 1, 'missing → neutral');
  assert.equal(satisfactionFactor(null, 0.12), 1, 'null → neutral');
  assert.equal(satisfactionFactor(0.5, 0.12), 1, '0.5 → neutral');
  assert.equal(satisfactionFactor(1, 0), 1, 'weight 0 → disabled');
  assert.ok(satisfactionFactor(1, 0.12) > 1, 'satisfied → boost');
  assert.ok(satisfactionFactor(0, 0.12) < 1, 'dissatisfied → penalty');
  // Bounds: [1-w, 1+w].
  assert.ok(Math.abs(satisfactionFactor(1, 0.12) - 1.12) < 1e-9);
  assert.ok(Math.abs(satisfactionFactor(0, 0.12) - 0.88) < 1e-9);
  // Clamps out-of-range input.
  assert.equal(satisfactionFactor(5, 0.12), satisfactionFactor(1, 0.12));
});

// BM25-only search: at equal textual relevance, the more satisfying memory ranks first.
test('search lifts the more satisfying memory at equal relevance', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-sat-'));
  const store = new MemoryStore(path.join(dir, 'm.db'), 384, '', 1);
  await store.init();
  try {
    // Two digests with the SAME searchable text → identical BM25 score; only satisfaction differs.
    const text = 'deployment pipeline azure devops release process';
    store.upsert('low', { type: 'digest', project: 'p', ts: '2026-01-01T00:00:00Z', summary: text, satisfaction: 0.1 });
    store.upsert('high', { type: 'digest', project: 'p', ts: '2026-01-01T00:00:00Z', summary: text, satisfaction: 0.95 });

    // Weight off → tie broken by storage/rowid order, not satisfaction (sanity: both returned).
    const off = store.search({ query: 'deployment pipeline azure', project: 'p', limit: 2, satisfactionWeight: 0 });
    assert.equal(off.length, 2, 'both candidates returned');

    // Weight on → the satisfying one comes first.
    const on = store.search({ query: 'deployment pipeline azure', project: 'p', limit: 2, satisfactionWeight: 0.12 });
    assert.equal(on.length, 2);
    assert.equal(on[0].id, 'high', 'most-satisfying memory ranks first at equal relevance');
    assert.equal(on[0].satisfaction, 0.95);
    assert.equal(on[1].id, 'low');
  } finally {
    store.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL lock — best-effort */ }
  }
});

// Satisfaction is a tie-breaker, not an override: a clearly more relevant memory still wins.
test('satisfaction does not override a clear relevance gap', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-sat2-'));
  const store = new MemoryStore(path.join(dir, 'm.db'), 384, '', 1);
  await store.init();
  try {
    // "relevant" matches both query tokens; "tangential" matches one → higher BM25 even though
    // its satisfaction is rock-bottom and the relevant one's is high-ish.
    store.upsert('relevant', { type: 'digest', project: 'p', ts: '2026-01-01T00:00:00Z', summary: 'redis cache configuration', satisfaction: 0.5 });
    store.upsert('tangential', { type: 'digest', project: 'p', ts: '2026-01-01T00:00:00Z', summary: 'redis only here unrelated', satisfaction: 0.0 });
    const r = store.search({ query: 'redis cache configuration', project: 'p', limit: 2, satisfactionWeight: 0.12 });
    assert.equal(r[0].id, 'relevant', 'relevance still dominates over satisfaction');
  } finally {
    store.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL lock — best-effort */ }
  }
});

// Forward migration: an old DB without the columns gains them on init() without data loss.
test('init() migrates an existing DB to add satisfaction/mood columns', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-mig-'));
  const dbPath = path.join(dir, 'm.db');
  try {
    // Simulate a pre-existing schema WITHOUT satisfaction/mood, with the full FTS index + triggers
    // (mirrors a real upgrade: an older store created everything but the two new columns), then one row.
    const spec = 'node:sqlite';
    const { DatabaseSync } = await import(spec);
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA journal_mode=WAL;');
    raw.exec(`CREATE TABLE memories (
      rowid INTEGER PRIMARY KEY, mem_id TEXT UNIQUE, type TEXT, session_id TEXT, project TEXT,
      branch TEXT, cwd TEXT, ts TEXT, ts_epoch INTEGER, prompt_number INTEGER,
      user_prompt TEXT, assistant_text TEXT, summary TEXT, tool_name TEXT, tool_brief TEXT,
      tools TEXT, files_read TEXT, files_modified TEXT, prompts TEXT, prompts_text TEXT,
      turn_count INTEGER, started_at TEXT, ended_at TEXT, end_reason TEXT, source TEXT);`);
    const FTS = 'summary, user_prompt, assistant_text, tool_brief, prompts_text';
    const NEW = FTS.split(', ').map((c) => 'new.' + c).join(', ');
    const OLD = FTS.split(', ').map((c) => 'old.' + c).join(', ');
    raw.exec(`CREATE VIRTUAL TABLE memories_fts USING fts5(${FTS}, content='memories', content_rowid='rowid');`);
    raw.exec(`CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, ${FTS}) VALUES (new.rowid, ${NEW}); END;`);
    raw.exec(`CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, ${FTS}) VALUES ('delete', old.rowid, ${OLD}); END;`);
    raw.exec(`CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, ${FTS}) VALUES ('delete', old.rowid, ${OLD});
      INSERT INTO memories_fts(rowid, ${FTS}) VALUES (new.rowid, ${NEW}); END;`);
    raw.exec('CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);');
    raw.prepare(`INSERT INTO memories (mem_id, type, project, summary) VALUES (?,?,?,?)`)
      .run('old1', 'digest', 'p', 'legacy memory from before satisfaction');
    raw.close();

    const store = new MemoryStore(dbPath, 384, '', 1);
    await store.init(); // must ALTER TABLE ADD COLUMN, not throw
    // The old row is intact and now an upsert with satisfaction works on it.
    store.upsert('old1', { type: 'digest', project: 'p', summary: 'legacy memory from before satisfaction', satisfaction: 0.8, mood: 'satisfied' });
    const r = store.search({ query: 'legacy memory satisfaction', project: 'p', limit: 1, satisfactionWeight: 0.12 });
    assert.equal(r.length, 1);
    assert.equal(r[0].satisfaction, 0.8);
    assert.equal(r[0].mood, 'satisfied');
    store.close();
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL lock — best-effort */ }
  }
});
