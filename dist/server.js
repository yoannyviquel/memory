#!/usr/bin/env node

// src/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import {
  existsSync as existsSync4,
  copyFileSync,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync5,
  writeFileSync as writeFileSync3,
  readdirSync,
  unlinkSync as unlinkSync2,
  watch
} from "fs";
import path7 from "path";

// src/config.ts
import os from "os";
import path from "path";
import { readFileSync } from "fs";
var DEFAULT_DIGEST_MODEL = "haiku";
var DIGEST_VERSION = 1;
var EMBED_TEXT_VERSION = 1;
var EMBED_TIERS = {
  light: { model: "Xenova/multilingual-e5-small", dim: 384 },
  medium: { model: "Xenova/multilingual-e5-base", dim: 768 },
  heavy: { model: "Xenova/multilingual-e5-large", dim: 1024 }
};
var DEFAULT_TIER = "light";
function readConfigFile(dataDir) {
  try {
    return JSON.parse(readFileSync(path.join(dataDir, "config.json"), "utf8"));
  } catch {
    return {};
  }
}
function loadConfig() {
  const dataDir = process.env.MEMORY_DATA_DIR || path.join(os.homedir(), ".claude-memory");
  const file = readConfigFile(dataDir);
  const get = (envKey, fileKey) => {
    const e = process.env[envKey];
    if (e !== void 0 && e !== "" && !e.startsWith("${")) return e;
    const f = file[fileKey];
    return f === void 0 || f === null ? void 0 : String(f);
  };
  const getFileFirst = (fileKey, envKey) => {
    const f = file[fileKey];
    if (f !== void 0 && f !== null && String(f) !== "") return String(f);
    const e = process.env[envKey];
    if (e !== void 0 && e !== "" && !e.startsWith("${")) return e;
    return void 0;
  };
  const dbPath = get("MEMORY_DB_PATH", "dbPath") || path.join(dataDir, "memories.db");
  const contextLimit = Number(get("MEMORY_CONTEXT_LIMIT", "contextLimit")) || 10;
  const tier = (getFileFirst("embedTier", "MEMORY_EMBED_TIER") || DEFAULT_TIER).toLowerCase();
  const picked = EMBED_TIERS[tier] ?? EMBED_TIERS[DEFAULT_TIER];
  const model = get("MEMORY_EMBED_MODEL", "embedModel") || picked.model;
  const dim = Number(get("MEMORY_EMBED_DIM", "embedDim")) || picked.dim;
  const enabled = get("MEMORY_EMBED_ENABLED", "embedEnabled") !== "0";
  const cacheDir = get("MEMORY_EMBED_CACHE_DIR", "embedCacheDir") || path.join(dataDir, "models");
  const dtype = (get("MEMORY_EMBED_DTYPE", "embedDtype") || "q8").toLowerCase();
  const threadFraction = { light: 0.25, medium: 0.5, heavy: 0.75 };
  const fraction = threadFraction[tier] ?? 0.25;
  const threads = Math.max(1, Math.floor(os.cpus().length * fraction));
  const digestEnabled = get("MEMORY_DIGEST_ENABLED", "digestEnabled") !== "0";
  const digestModel = get("MEMORY_DIGEST_MODEL", "digestModel") || DEFAULT_DIGEST_MODEL;
  return {
    dbPath,
    dataDir,
    contextLimit,
    embed: { enabled, tier, model, dim, cacheDir, dtype, threads, dataDir },
    digest: { enabled: digestEnabled, model: digestModel, version: DIGEST_VERSION }
  };
}

// src/store.ts
import { mkdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { createHash } from "crypto";
import path2 from "path";
var VECTORIZABLE = ["prompt", "turn", "session", "digest", "insight", "core"];
var VECTORIZABLE_SQL = VECTORIZABLE.map((t) => `'${t}'`).join(",");
var HERE = path2.dirname(fileURLToPath(import.meta.url));
var COLS = [
  "mem_id",
  "type",
  "session_id",
  "project",
  "branch",
  "cwd",
  "ts",
  "ts_epoch",
  "prompt_number",
  "user_prompt",
  "assistant_text",
  "summary",
  "tool_name",
  "tool_brief",
  "tools",
  "files_read",
  "files_modified",
  "prompts",
  "prompts_text",
  "turn_count",
  "started_at",
  "ended_at",
  "end_reason",
  "source"
];
var FTS_COLS = ["summary", "user_prompt", "assistant_text", "tool_brief", "prompts_text"];
var BM25_WEIGHTS = "3.0, 2.0, 1.0, 1.0, 1.5";
var RRF_K = 60;
var _DatabaseSync;
async function getDatabaseSync() {
  if (_DatabaseSync) return _DatabaseSync;
  const spec = "node:sqlite";
  ({ DatabaseSync: _DatabaseSync } = await import(spec));
  return _DatabaseSync;
}
function resolveVecExtension() {
  const libName = process.platform === "win32" ? "vec0.dll" : process.platform === "darwin" ? "vec0.dylib" : "vec0.so";
  const candidates = [process.env.MEMORY_VEC_EXTENSION];
  try {
    const req = createRequire(import.meta.url);
    candidates.push(req("sqlite-vec").getLoadablePath());
  } catch {
  }
  candidates.push(path2.join(HERE, libName));
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}
function ftsQuery(q) {
  const tokens = (q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length > 1);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}
function toEpoch(ts) {
  if (!ts) return Date.now();
  const n = Date.parse(ts);
  return Number.isNaN(n) ? Date.now() : n;
}
function jsonArr(v) {
  if (!v || typeof v !== "string") return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function rowToDoc(r) {
  return {
    type: r.type,
    session_id: r.session_id ?? void 0,
    project: r.project ?? void 0,
    branch: r.branch ?? void 0,
    cwd: r.cwd ?? void 0,
    ts: r.ts ?? void 0,
    prompt_number: r.prompt_number ?? void 0,
    user_prompt: r.user_prompt ?? void 0,
    assistant_text: r.assistant_text ?? void 0,
    summary: r.summary ?? void 0,
    tool_name: r.tool_name ?? void 0,
    tool_brief: r.tool_brief ?? void 0,
    tools: jsonArr(r.tools),
    files_read: jsonArr(r.files_read),
    files_modified: jsonArr(r.files_modified),
    prompts: jsonArr(r.prompts),
    turn_count: r.turn_count ?? void 0,
    started_at: r.started_at ?? void 0,
    ended_at: r.ended_at ?? void 0,
    end_reason: r.end_reason ?? void 0,
    source: r.source ?? void 0
  };
}
function toBlob(arr) {
  return new Uint8Array(Float32Array.from(arr).buffer);
}
var MemoryStore = class {
  constructor(dbPath, dim = 384, model = "", embedTextVersion = 0) {
    this.dbPath = dbPath;
    this.dim = dim;
    this.model = model;
    this.embedTextVersion = embedTextVersion;
  }
  dbPath;
  dim;
  model;
  embedTextVersion;
  db;
  _vectorEnabled = false;
  get path() {
    return this.dbPath;
  }
  get vectorEnabled() {
    return this._vectorEnabled;
  }
  metaGet(k) {
    try {
      const r = this.db.prepare("SELECT v FROM meta WHERE k = ?").get(k);
      return r ? String(r.v) : null;
    } catch {
      return null;
    }
  }
  metaSet(k, v) {
    this.db.prepare("INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }
  async init() {
    if (this.db) return;
    const DatabaseSync = await getDatabaseSync();
    mkdirSync(path2.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath, { allowExtension: true });
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA busy_timeout=3000;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        rowid INTEGER PRIMARY KEY,
        mem_id TEXT UNIQUE,
        type TEXT, session_id TEXT, project TEXT, branch TEXT, cwd TEXT,
        ts TEXT, ts_epoch INTEGER, prompt_number INTEGER,
        user_prompt TEXT, assistant_text TEXT, summary TEXT,
        tool_name TEXT, tool_brief TEXT,
        tools TEXT, files_read TEXT, files_modified TEXT,
        prompts TEXT, prompts_text TEXT,
        turn_count INTEGER, started_at TEXT, ended_at TEXT, end_reason TEXT, source TEXT
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_mem_recent ON memories(project, type, ts_epoch);");
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        ${FTS_COLS.join(", ")}, content='memories', content_rowid='rowid'
      );
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, ${FTS_COLS.join(", ")})
        VALUES (new.rowid, ${FTS_COLS.map((c) => "new." + c).join(", ")});
      END;
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, ${FTS_COLS.join(", ")})
        VALUES ('delete', old.rowid, ${FTS_COLS.map((c) => "old." + c).join(", ")});
      END;
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, ${FTS_COLS.join(", ")})
        VALUES ('delete', old.rowid, ${FTS_COLS.map((c) => "old." + c).join(", ")});
        INSERT INTO memories_fts(rowid, ${FTS_COLS.join(", ")})
        VALUES (new.rowid, ${FTS_COLS.map((c) => "new." + c).join(", ")});
      END;
    `);
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);");
    const ext = resolveVecExtension();
    if (ext) {
      try {
        this.db.enableLoadExtension(true);
        this.db.loadExtension(ext);
        const prevModel = this.metaGet("embed_model");
        const prevDim = this.metaGet("embed_dim");
        const prevTextV = this.metaGet("embed_text_version");
        const modelChanged = this.model !== "" && (prevModel !== this.model || prevDim !== null && Number(prevDim) !== this.dim);
        const textChanged = this.embedTextVersion > 0 && prevTextV !== null && Number(prevTextV) !== this.embedTextVersion;
        if (modelChanged || textChanged) this.db.exec("DROP TABLE IF EXISTS vec_memories;");
        this.db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(embedding float[${this.dim}]);`
        );
        this.metaSet("embed_model", this.model);
        this.metaSet("embed_dim", String(this.dim));
        this.metaSet("embed_text_version", String(this.embedTextVersion));
        this._vectorEnabled = true;
      } catch {
        this._vectorEnabled = false;
      } finally {
        try {
          this.db.enableLoadExtension(false);
        } catch {
        }
      }
    }
  }
  docToParams(id, d) {
    const prompts = d.prompts ?? [];
    const promptsText = prompts.join(" \n ");
    const map = {
      mem_id: id,
      type: d.type,
      session_id: d.session_id ?? null,
      project: d.project ?? null,
      branch: d.branch ?? null,
      cwd: d.cwd ?? null,
      ts: d.ts ?? null,
      ts_epoch: toEpoch(d.ts ?? d.ended_at ?? d.started_at),
      prompt_number: d.prompt_number ?? null,
      user_prompt: d.user_prompt ?? null,
      assistant_text: d.assistant_text ?? null,
      summary: d.summary ?? null,
      tool_name: d.tool_name ?? null,
      tool_brief: d.tool_brief ?? null,
      tools: JSON.stringify(d.tools ?? []),
      files_read: JSON.stringify(d.files_read ?? []),
      files_modified: JSON.stringify(d.files_modified ?? []),
      prompts: JSON.stringify(prompts),
      prompts_text: promptsText || null,
      turn_count: d.turn_count ?? null,
      started_at: d.started_at ?? null,
      ended_at: d.ended_at ?? null,
      end_reason: d.end_reason ?? null,
      source: d.source ?? null
    };
    return COLS.map((c) => map[c]);
  }
  upsertSql() {
    const placeholders = COLS.map(() => "?").join(", ");
    const updates = COLS.filter((c) => c !== "mem_id").map((c) => `${c}=excluded.${c}`).join(", ");
    return `INSERT INTO memories (${COLS.join(", ")}) VALUES (${placeholders})
            ON CONFLICT(mem_id) DO UPDATE SET ${updates};`;
  }
  rowidOf(memId) {
    const r = this.db.prepare("SELECT rowid FROM memories WHERE mem_id = ?").get(memId);
    return r ? Number(r.rowid) : null;
  }
  /** Updates a doc's vector (vec0 doesn't support OR REPLACE → DELETE+INSERT). */
  upsertVector(rowid, embedding) {
    if (!this._vectorEnabled || !embedding || embedding.length !== this.dim) return;
    try {
      this.db.prepare("DELETE FROM vec_memories WHERE rowid = ?").run(BigInt(rowid));
      this.db.prepare("INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)").run(BigInt(rowid), toBlob(embedding));
    } catch {
    }
  }
  /** Inserts or updates a document (idempotent on mem_id) + its vector if provided. */
  upsert(id, doc, embedding) {
    this.db.prepare(this.upsertSql()).run(...this.docToParams(id, doc));
    if (embedding) {
      const rid = this.rowidOf(id);
      if (rid != null) this.upsertVector(rid, embedding);
    }
  }
  /** Sets/updates a doc's vector by rowid (used by the server's backfill). */
  setVectorByRowid(rowid, embedding) {
    this.upsertVector(rowid, embedding);
  }
  /**
   * Vectorizable documents (prompt/turn/session) without a vector, most recent first.
   * Returns the rowid + the text to embed. Empty if the vector index is disabled.
   */
  missingVectorDocs(limit = 32) {
    if (!this._vectorEnabled) return [];
    const rows = this.db.prepare(
      `SELECT rowid, summary, user_prompt, assistant_text, prompts_text
         FROM memories
         WHERE type IN (${VECTORIZABLE_SQL})
           AND rowid NOT IN (SELECT rowid FROM vec_memories)
         ORDER BY ts_epoch DESC LIMIT ?;`
    ).all(limit);
    return rows.map((r) => ({
      rowid: Number(r.rowid),
      text: [r.summary, r.user_prompt, r.assistant_text, r.prompts_text].filter((s) => typeof s === "string" && s.trim()).join("\n").slice(0, 2e3)
    }));
  }
  /** Number of vectorizable docs still without a vector (backfill lag). */
  countMissingVectors() {
    if (!this._vectorEnabled) return 0;
    try {
      return Number(
        this.db.prepare(
          `SELECT COUNT(*) c FROM memories
               WHERE type IN (${VECTORIZABLE_SQL})
                 AND rowid NOT IN (SELECT rowid FROM vec_memories);`
        ).get().c
      );
    } catch {
      return 0;
    }
  }
  /** Bulk upsert within a transaction. */
  bulkUpsert(items) {
    if (items.length === 0) return { indexed: 0, errors: 0 };
    const stmt = this.db.prepare(this.upsertSql());
    let indexed = 0;
    let errors = 0;
    this.db.exec("BEGIN;");
    try {
      for (const it of items) {
        try {
          stmt.run(...this.docToParams(it.id, it.doc));
          if (it.embedding) {
            const rid = this.rowidOf(it.id);
            if (rid != null) this.upsertVector(rid, it.embedding);
          }
          indexed++;
        } catch {
          errors++;
        }
      }
      this.db.exec("COMMIT;");
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
    return { indexed, errors };
  }
  /** BM25 rowids ordered by relevance. */
  bm25Rows(query, project, type, n = 40) {
    const ftsq = ftsQuery(query);
    if (!ftsq) return [];
    const where = ["memories_fts MATCH ?"];
    const args = [ftsq];
    if (project) {
      where.push("m.project = ?");
      args.push(project);
    }
    if (type) {
      where.push("m.type = ?");
      args.push(type);
    }
    args.push(n);
    const sql = `SELECT m.rowid FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
                 WHERE ${where.join(" AND ")}
                 ORDER BY bm25(memories_fts, ${BM25_WEIGHTS}) LIMIT ?;`;
    return this.db.prepare(sql).all(...args).map((r) => Number(r.rowid));
  }
  /** KNN (semantic) rowids ordered by distance, filtered by project/type. */
  vecRows(embedding, project, type, n = 40) {
    if (!this._vectorEnabled || embedding.length !== this.dim) return [];
    const knn = this.db.prepare(
      "SELECT rowid, distance FROM vec_memories WHERE embedding MATCH ? ORDER BY distance LIMIT ?;"
    ).all(toBlob(embedding), n).map((r) => Number(r.rowid));
    if (knn.length === 0 || !project && !type) return knn;
    const placeholders = knn.map(() => "?").join(",");
    const where = [`rowid IN (${placeholders})`];
    const args = [...knn];
    if (project) {
      where.push("project = ?");
      args.push(project);
    }
    if (type) {
      where.push("type = ?");
      args.push(type);
    }
    const kept = new Set(
      this.db.prepare(`SELECT rowid FROM memories WHERE ${where.join(" AND ")};`).all(...args).map((r) => Number(r.rowid))
    );
    return knn.filter((rid) => kept.has(rid));
  }
  docsByRowids(rowids) {
    if (rowids.length === 0) return [];
    const placeholders = rowids.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM memories WHERE rowid IN (${placeholders});`).all(...rowids);
    const byRowid = new Map(rows.map((r) => [Number(r.rowid), r]));
    return rowids.map((rid) => byRowid.get(rid)).filter(Boolean).map(rowToDoc);
  }
  /** Search: BM25 only, or hybrid (RRF of BM25 + KNN) if an embedding is provided. */
  search(params) {
    const limit = params.limit ?? 10;
    const cand = Math.max(limit * 4, 40);
    const bm = this.bm25Rows(params.query, params.project, params.type, cand);
    const vec = params.embedding && this._vectorEnabled ? this.vecRows(params.embedding, params.project, params.type, cand) : [];
    if (vec.length === 0) return this.docsByRowids(bm.slice(0, limit));
    const score = /* @__PURE__ */ new Map();
    bm.forEach((rid, i) => score.set(rid, (score.get(rid) ?? 0) + 1 / (RRF_K + i + 1)));
    vec.forEach((rid, i) => score.set(rid, (score.get(rid) ?? 0) + 1 / (RRF_K + i + 1)));
    const ordered = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map((e) => e[0]);
    return this.docsByRowids(ordered);
  }
  recent(params) {
    const where = [];
    const args = [];
    if (params.project) {
      where.push("project = ?");
      args.push(params.project);
    }
    if (params.type) {
      where.push("type = ?");
      args.push(params.type);
    }
    args.push(params.limit ?? 10);
    const sql = `SELECT * FROM memories
                 ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY ts_epoch DESC LIMIT ?;`;
    return this.db.prepare(sql).all(...args).map(rowToDoc);
  }
  stats() {
    const total = Number(this.db.prepare("SELECT COUNT(*) c FROM memories").get().c);
    const byType = {};
    for (const r of this.db.prepare("SELECT type, COUNT(*) c FROM memories GROUP BY type").all())
      byType[r.type] = Number(r.c);
    const byProject = {};
    for (const r of this.db.prepare("SELECT project, COUNT(*) c FROM memories GROUP BY project ORDER BY c DESC LIMIT 20").all())
      byProject[r.project ?? "?"] = Number(r.c);
    let vectorCount = 0;
    if (this._vectorEnabled) {
      try {
        vectorCount = Number(this.db.prepare("SELECT COUNT(*) c FROM vec_memories").get().c);
      } catch {
      }
    }
    return { dbPath: this.dbPath, total, byType, byProject, vectorEnabled: this._vectorEnabled, vectorCount };
  }
  // ---- Digests (LLM session compression) -------------------------------------------------
  /** Turns of a session, in order — the raw material fed to the digest LLM. */
  turnsForSession(session_id) {
    const rows = this.db.prepare(
      `SELECT user_prompt, assistant_text, tools, files_modified
         FROM memories WHERE type='turn' AND session_id = ?
         ORDER BY prompt_number ASC, ts_epoch ASC;`
    ).all(session_id);
    return rows.map((r) => ({
      user_prompt: r.user_prompt ?? void 0,
      assistant_text: r.assistant_text ?? void 0,
      tools: jsonArr(r.tools),
      files_modified: jsonArr(r.files_modified)
    }));
  }
  /**
   * Sessions that have a `session` rollup but no digest at the current version.
   * A digest stores its version in `source`, so bumping DIGEST_VERSION re-selects every session.
   */
  sessionsNeedingDigest(version, limit = 5) {
    const rows = this.db.prepare(
      `SELECT m.session_id, m.project, m.branch FROM memories m
         WHERE m.type='session' AND m.session_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM memories d
             WHERE d.type='digest' AND d.session_id = m.session_id AND d.source = ?
           )
         ORDER BY m.ts_epoch DESC LIMIT ?;`
    ).all(String(version), limit);
    return rows.map((r) => ({
      session_id: r.session_id,
      project: r.project ?? void 0,
      branch: r.branch ?? void 0
    }));
  }
  /** Count of sessions still awaiting a digest at the given version (for status/progress). */
  countSessionsNeedingDigest(version) {
    try {
      return Number(
        this.db.prepare(
          `SELECT COUNT(*) c FROM memories m
               WHERE m.type='session' AND m.session_id IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM memories d
                   WHERE d.type='digest' AND d.session_id = m.session_id AND d.source = ?
                 );`
        ).get(String(version)).c
      );
    } catch {
      return 0;
    }
  }
  /** Replaces a session's digest + insight docs (idempotent). Vectors are filled by the backfill. */
  writeDigest(session_id, digest, insights) {
    this.deleteSessionDigest(session_id);
    this.upsert(`${session_id}:digest`, digest);
    insights.forEach((d, i) => this.upsert(`${session_id}:insight:${i}`, d));
  }
  /** Deletes a session's digest + insights and their vectors. */
  deleteSessionDigest(session_id) {
    const rids = this.db.prepare(`SELECT rowid FROM memories WHERE session_id = ? AND type IN ('digest','insight');`).all(session_id).map((r) => Number(r.rowid));
    this.deleteVectors(rids);
    this.db.prepare(`DELETE FROM memories WHERE session_id = ? AND type IN ('digest','insight');`).run(session_id);
  }
  /** Deletes every digest + insight doc (and their vectors). Used by /memory:reindex. */
  clearDigests() {
    const rids = this.db.prepare(`SELECT rowid FROM memories WHERE type IN ('digest','insight');`).all().map((r) => Number(r.rowid));
    this.deleteVectors(rids);
    const info = this.db.prepare(`DELETE FROM memories WHERE type IN ('digest','insight');`).run();
    return Number(info?.changes ?? rids.length);
  }
  /**
   * Deletes memories matching a filter (+ their vectors; FTS is kept in sync by the delete trigger).
   * Requires at least one filter — never deletes everything implicitly. Returns the count removed.
   */
  deleteMemories(opts) {
    const where = [];
    const args = [];
    if (opts.idPrefix) {
      where.push("substr(mem_id, 1, ?) = ?");
      args.push(opts.idPrefix.length, opts.idPrefix);
    }
    if (opts.project) {
      where.push("project = ?");
      args.push(opts.project);
    }
    if (opts.type) {
      where.push("type = ?");
      args.push(opts.type);
    }
    if (where.length === 0) return 0;
    const w = where.join(" AND ");
    const rids = this.db.prepare(`SELECT rowid FROM memories WHERE ${w};`).all(...args).map((r) => Number(r.rowid));
    this.deleteVectors(rids);
    const info = this.db.prepare(`DELETE FROM memories WHERE ${w};`).run(...args);
    return Number(info?.changes ?? rids.length);
  }
  /** Empties the vector index so the backfill refills it from scratch. Used by /memory:reindex. */
  resetVectors() {
    if (!this._vectorEnabled) return;
    try {
      this.db.exec("DROP TABLE IF EXISTS vec_memories;");
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(embedding float[${this.dim}]);`
      );
    } catch {
    }
  }
  // ---- Core memories (always injected at SessionStart) ------------------------------------
  /**
   * Adds (or updates) a core memory — a high-priority fact injected into every session's context.
   * Global by default (project undefined) or scoped to a project. Idempotent: the id is a hash of
   * (project, text), so the same fact isn't duplicated. Returns the mem_id.
   */
  addCore(text, project) {
    const id = "core:" + createHash("sha1").update(`${project ?? ""}\0${text}`).digest("hex").slice(0, 12);
    this.upsert(id, {
      type: "core",
      project,
      summary: text.trim().slice(0, 2e3),
      ts: (/* @__PURE__ */ new Date()).toISOString()
    });
    return id;
  }
  /** Core memories visible for a project: its own + globals (project IS NULL). Recent first. */
  listCore(project) {
    const sql = project ? `SELECT * FROM memories WHERE type='core' AND (project = ? OR project IS NULL) ORDER BY ts_epoch DESC;` : `SELECT * FROM memories WHERE type='core' ORDER BY ts_epoch DESC;`;
    const rows = project ? this.db.prepare(sql).all(project) : this.db.prepare(sql).all();
    return rows.map((r) => ({ id: r.mem_id, doc: rowToDoc(r) }));
  }
  /** Removes a core memory by id (+ its vector). Returns the count removed (0 or 1). */
  removeCore(id) {
    const rids = this.db.prepare(`SELECT rowid FROM memories WHERE mem_id = ? AND type='core';`).all(id).map((r) => Number(r.rowid));
    this.deleteVectors(rids);
    const info = this.db.prepare(`DELETE FROM memories WHERE mem_id = ? AND type='core';`).run(id);
    return Number(info?.changes ?? 0);
  }
  /**
   * Frequency signals to help propose core memories: files touched across the most memories
   * (a file recurring over many sessions is likely structurally important). Best-effort (JSON1).
   */
  coreSignals(limit = 15) {
    try {
      const rows = this.db.prepare(
        `SELECT j.value AS f, COUNT(*) AS c
           FROM memories, json_each(memories.files_modified) j
           WHERE memories.files_modified IS NOT NULL AND memories.files_modified != '[]'
           GROUP BY j.value ORDER BY c DESC LIMIT ?;`
      ).all(limit);
      return { files: rows.map((r) => ({ file: String(r.f), count: Number(r.c) })) };
    } catch {
      return { files: [] };
    }
  }
  /** vec0 has no FK to memories → orphan vectors must be removed explicitly on delete. */
  deleteVectors(rowids) {
    if (!this._vectorEnabled || rowids.length === 0) return;
    const stmt = this.db.prepare("DELETE FROM vec_memories WHERE rowid = ?");
    for (const rid of rowids) {
      try {
        stmt.run(BigInt(rid));
      } catch {
      }
    }
  }
  close() {
    try {
      this.db?.close();
    } catch {
    }
  }
};

// src/log.ts
import { appendFileSync, mkdirSync as mkdirSync2, existsSync as existsSync2, statSync, renameSync, readFileSync as readFileSync2, writeFileSync } from "fs";
import path3 from "path";
function logDir(dataDir) {
  return path3.join(dataDir, "logs");
}
var MAX_LOG_BYTES = 1e6;
function log(dataDir, msg) {
  try {
    const dir = logDir(dataDir);
    mkdirSync2(dir, { recursive: true });
    const file = path3.join(dir, "memory.log");
    try {
      if (existsSync2(file) && statSync(file).size > MAX_LOG_BYTES) {
        renameSync(file, `${file}.1`);
      }
    } catch {
    }
    appendFileSync(file, `${(/* @__PURE__ */ new Date()).toISOString()} pid=${process.pid} ${msg}
`);
  } catch {
  }
}
function statusPath(dataDir) {
  return path3.join(dataDir, "status.json");
}
function writeStatus(dataDir, patch) {
  try {
    mkdirSync2(dataDir, { recursive: true });
    const file = statusPath(dataDir);
    let cur = {};
    try {
      cur = JSON.parse(readFileSync2(file, "utf8"));
    } catch {
    }
    writeFileSync(file, JSON.stringify({ ...cur, ...patch, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }));
  } catch {
  }
}

// src/embeddings.ts
var _pipe = null;
var _loading = null;
var _failed = false;
async function getPipe(cfg) {
  if (!cfg.enabled) return null;
  if (_pipe) return _pipe;
  if (_failed) return null;
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      const mod = "@huggingface/transformers";
      const tf = await import(mod);
      tf.env.cacheDir = cfg.cacheDir;
      tf.env.allowRemoteModels = true;
      const threads = Math.max(1, cfg.threads || 1);
      try {
        tf.env.backends.onnx.numThreads = threads;
        if (tf.env.backends.onnx.wasm) tf.env.backends.onnx.wasm.numThreads = threads;
      } catch {
      }
      log(cfg.dataDir, `[embed] onnx threads capped at ${threads}`);
      const dtype = cfg.dtype || "q8";
      log(cfg.dataDir, `[embed] loading ${cfg.model} (dtype=${dtype}) cache=${cfg.cacheDir}`);
      writeStatus(cfg.dataDir, { state: "loading", model: cfg.model, progress: void 0, file: void 0 });
      const lastPct = {};
      const progress_callback = (p) => {
        try {
          if (p?.status === "progress" && p.file && typeof p.progress === "number") {
            const pct = Math.round(p.progress);
            const bucket = Math.floor(pct / 10);
            if (lastPct[p.file] !== bucket) {
              lastPct[p.file] = bucket;
              log(cfg.dataDir, `[embed] download ${p.file} ${pct}%`);
            }
            writeStatus(cfg.dataDir, { state: "downloading", model: cfg.model, file: p.file, progress: pct });
          } else if (p?.status === "done" && p.file) {
            log(cfg.dataDir, `[embed] downloaded ${p.file}`);
          } else if (p?.status === "ready") {
            log(cfg.dataDir, `[embed] model ready (${cfg.model})`);
          }
        } catch {
        }
      };
      const session_options = {
        intraOpNumThreads: threads,
        interOpNumThreads: 1,
        executionMode: "sequential",
        graphOptimizationLevel: "all"
      };
      let pipe;
      try {
        pipe = await tf.pipeline("feature-extraction", cfg.model, {
          dtype,
          progress_callback,
          session_options
        });
      } catch (e) {
        log(
          cfg.dataDir,
          `[embed] dtype=${dtype} unavailable (${e instanceof Error ? e.message : String(e)}); falling back to fp32`
        );
        pipe = await tf.pipeline("feature-extraction", cfg.model, {
          dtype: "fp32",
          progress_callback,
          session_options
        });
      }
      _pipe = pipe;
      writeStatus(cfg.dataDir, { state: "idle", progress: void 0, file: void 0 });
      return pipe;
    } catch (err) {
      _failed = true;
      const message = err instanceof Error ? err.message : String(err);
      log(cfg.dataDir, `[embed] unavailable: ${message}`);
      writeStatus(cfg.dataDir, { state: "idle", progress: void 0, file: void 0 });
      process.stderr.write(`[memory] embedder unavailable: ${message}
`);
      return null;
    } finally {
      _loading = null;
    }
  })();
  return _loading;
}
async function embedReady(cfg) {
  return !!await getPipe(cfg);
}
function embedLoaded() {
  return _pipe !== null;
}
async function embed(text, cfg) {
  const r = await embedBatch([text], cfg);
  return r[0] ?? null;
}
async function embedBatch(texts, cfg) {
  if (!cfg.enabled || texts.length === 0) return texts.map(() => null);
  const pipe = await getPipe(cfg);
  if (!pipe) return texts.map(() => null);
  try {
    const out = await pipe(texts, { pooling: "mean", normalize: true });
    const arr = out.tolist();
    return texts.map((_, i) => Array.isArray(arr[i]) && arr[i].length > 0 ? arr[i] : null);
  } catch {
    return texts.map(() => null);
  }
}

// src/digest.ts
import { spawn } from "child_process";
import { existsSync as existsSync3 } from "fs";
import os2 from "os";
import path4 from "path";
var KINDS = /* @__PURE__ */ new Set(["decision", "bugfix", "discovery", "conclusion"]);
var INPUT_BUDGET = 48e3;
var TIMEOUT_MS = 18e4;
function renderSession(input) {
  const parts = [];
  let size = 0;
  let truncated = false;
  for (const t of input.turns) {
    const u = (t.user_prompt ?? "").trim();
    const a = (t.assistant_text ?? "").trim();
    const files = t.files_modified.length ? `
  files: ${t.files_modified.join(", ")}` : "";
    const block = `> user: ${u}
  assistant: ${a}${files}`;
    if (size + block.length > INPUT_BUDGET) {
      truncated = true;
      break;
    }
    parts.push(block);
    size += block.length;
  }
  if (truncated) parts.push("\u2026 [session truncated for length]");
  return parts.join("\n\n");
}
function buildPrompt(input) {
  return [
    "You compress a Claude Code coding session into durable memory for future sessions.",
    "Read the session (user prompts + assistant turns + touched files) and extract only durable, reusable facts.",
    "",
    "Output ONLY a JSON object \u2014 no prose, no markdown fences \u2014 with exactly this shape:",
    "{",
    '  "conclusion": "1-3 sentences: what was achieved and the final state",',
    '  "insights": [',
    '    { "kind": "decision|bugfix|discovery|conclusion", "text": "one concrete durable fact", "files": ["path"] }',
    "  ]",
    "}",
    "",
    "Rules:",
    "- 3 to 8 insights max. Only decisions made, bugs fixed, things discovered, or conclusions. Skip chit-chat and intermediate noise.",
    '- "files" is optional; include only files actually touched for that fact.',
    "- Be concise and specific. Write in the language of the session.",
    "- Do not use any tools. Just read the session text below and respond with the JSON.",
    "",
    `SESSION (project: ${input.project ?? "?"}, branch: ${input.branch ?? "?"}):`,
    renderSession(input)
  ].join("\n");
}
function extractJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
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
function resolveClaudeExe() {
  const isWin = process.platform === "win32";
  const name = isWin ? "claude.exe" : "claude";
  const sep = isWin ? ";" : ":";
  const dirs = [path4.join(os2.homedir(), ".local", "bin"), ...(process.env.PATH || "").split(sep)];
  for (const d of dirs) {
    if (!d) continue;
    const p = path4.join(d, name);
    if (existsSync3(p)) return p;
  }
  return null;
}
function claudeAvailable() {
  return resolveClaudeExe() !== null;
}
function runClaude(prompt, model) {
  return new Promise((resolve) => {
    const exe = resolveClaudeExe();
    if (!exe) {
      resolve(null);
      return;
    }
    const args = [
      "-p",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--output-format",
      "json"
    ];
    if (model) args.push("--model", model);
    let child;
    try {
      child = spawn(exe, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, MEMORY_HOOK_DISABLE: "1" }
      });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    timer.unref?.();
    child.on("error", () => finish(null));
    child.stdout?.on("data", (d) => out += d);
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve(null);
      }
    });
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      finish(null);
    }
  });
}
async function digestSession(input) {
  if (input.turns.length === 0) return null;
  const envelope = await runClaude(buildPrompt(input), input.model);
  if (!envelope || typeof envelope.result !== "string") return null;
  const parsed = extractJsonObject(envelope.result);
  const conclusion = parsed && typeof parsed.conclusion === "string" && parsed.conclusion.trim() || envelope.result.trim().slice(0, 1e3);
  if (!conclusion) return null;
  const rawInsights = parsed && Array.isArray(parsed.insights) ? parsed.insights : [];
  const insights = rawInsights.filter((x) => x && typeof x.text === "string" && x.text.trim()).slice(0, 8).map((x) => ({
    kind: KINDS.has(x.kind) ? x.kind : "discovery",
    text: String(x.text).trim().slice(0, 1e3),
    files: Array.isArray(x.files) ? x.files.filter((f) => typeof f === "string").slice(0, 10) : void 0
  }));
  return {
    conclusion,
    insights,
    usage: envelope.usage,
    costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : void 0
  };
}

// src/leader.ts
import { readFileSync as readFileSync3, writeFileSync as writeFileSync2, mkdirSync as mkdirSync3, unlinkSync } from "fs";
import path5 from "path";
var STALE_MS = 9e4;
function lockPath(dataDir) {
  return path5.join(dataDir, "worker.lock");
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}
function readLock(dataDir) {
  try {
    return JSON.parse(readFileSync3(lockPath(dataDir), "utf8"));
  } catch {
    return null;
  }
}
function releaseLeadership(dataDir) {
  try {
    const cur = readLock(dataDir);
    if (cur && cur.pid === process.pid) unlinkSync(lockPath(dataDir));
  } catch {
  }
}
function refreshLeadership(dataDir, extra) {
  const file = lockPath(dataDir);
  const now = Date.now();
  const cur = readLock(dataDir);
  if (cur && cur.pid !== process.pid) {
    const fresh = typeof cur.ts === "number" && now - cur.ts < STALE_MS;
    if (fresh && typeof cur.pid === "number" && pidAlive(cur.pid)) return false;
  }
  try {
    mkdirSync3(path5.dirname(file), { recursive: true });
    writeFileSync2(file, JSON.stringify({ pid: process.pid, ts: now, ...extra ?? {} }));
    return true;
  } catch {
    return false;
  }
}

// src/embed-service.ts
import { createServer, request as httpRequest } from "http";
var TOKEN_HEADER = "x-mem-token";
async function startEmbedServer(cfg, token) {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/embed" || req.headers[TOKEN_HEADER] !== token) {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", async () => {
      try {
        const { text } = JSON.parse(body);
        const vector = await embed(String(text ?? ""), cfg);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ vector }));
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  server.unref?.();
  return port;
}
function remoteEmbed(endpoint, text, timeoutMs = 5e3) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ text });
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: endpoint.port,
        method: "POST",
        path: "/embed",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          [TOKEN_HEADER]: endpoint.token
        }
      },
      (res) => {
        let d = "";
        res.on("data", (c) => d += c);
        res.on("end", () => {
          try {
            const j = JSON.parse(d);
            resolve(Array.isArray(j.vector) ? j.vector : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

// src/server.ts
import { randomBytes } from "crypto";

// src/memory.ts
import { readFileSync as readFileSync4 } from "fs";
import path6 from "path";
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

// src/tools/search.ts
var TYPES = ["observation", "prompt", "turn", "session", "digest", "insight"];
function fmtDoc(d) {
  const date = (d.ts ?? d.ended_at ?? "").slice(0, 16).replace("T", " ");
  const proj = d.project ?? "?";
  const label = d.summary || d.user_prompt || d.assistant_text || d.prompts && d.prompts.join(" | ") || d.tool_brief || "(no summary)";
  const text = label.replace(/\s+/g, " ").trim().slice(0, 300);
  const files = (d.files_modified ?? []).slice(0, 4);
  const filesLine = files.length ? `
  \u{1F4DD} ${files.join(", ")}` : "";
  return `- **[${d.type}]** \`${proj}\` \xB7 ${date}
  ${text}${filesLine}`;
}
var memorySearch = {
  name: "memory_search",
  description: "Searches the Claude Code session memories (local SQLite). Hybrid: BM25 full-text + semantic (local embeddings) if available. Useful to recall how a problem was solved, what was decided, which files were touched in previous sessions.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text to search for." },
      project: {
        type: "string",
        description: "Limit to a project (directory basename). Optional."
      },
      type: { type: "string", enum: TYPES, description: "Filter by memory type. Optional." },
      limit: { type: "number", description: "Number of results (default 10)." }
    },
    required: ["query"],
    additionalProperties: false
  },
  handler: async (args, { store, embedQuery }) => {
    const query = String(args.query ?? "").trim();
    if (!query) return "\u274C `query` is required.";
    const embedding = store.vectorEnabled ? await embedQuery(query) : null;
    const docs = store.search({
      query,
      project: args.project ? String(args.project) : void 0,
      type: args.type ? String(args.type) : void 0,
      limit: args.limit ? Number(args.limit) : 10,
      embedding
    });
    if (docs.length === 0) return `No memory for "${query}".`;
    const mode = embedding ? "hybrid BM25+semantic" : "BM25";
    return `\u{1F50E} **${docs.length} memory(ies)** for "${query}" _(${mode})_:

${docs.map(fmtDoc).join("\n")}`;
  }
};
var memoryRecent = {
  name: "memory_recent",
  description: "Lists the most recent memories (sorted by date), optionally filtered by project or type.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Limit to a project. Optional." },
      type: { type: "string", enum: TYPES, description: "Filter by type. Optional." },
      limit: { type: "number", description: "Number of results (default 10)." }
    },
    additionalProperties: false
  },
  handler: async (args, { store }) => {
    const docs = store.recent({
      project: args.project ? String(args.project) : void 0,
      type: args.type ? String(args.type) : void 0,
      limit: args.limit ? Number(args.limit) : 10
    });
    if (docs.length === 0) return "No indexed memory.";
    return `\u{1F551} **${docs.length} recent memory(ies)**:

${docs.map(fmtDoc).join("\n")}`;
  }
};
var memoryStats = {
  name: "memory_stats",
  description: "Diagnostics: SQLite database path, total documents, breakdown by type/project, state of the vector index and the local embedder.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, { store, embedCfg }) => {
    const s = store.stats();
    const missing = store.countMissingVectors();
    const embedderUp = embedCfg.enabled && s.vectorEnabled ? embedLoaded() : false;
    const lines = [];
    lines.push(`**memory \u2014 state**`);
    lines.push(`- SQLite database: \`${s.dbPath}\``);
    lines.push(`- Documents: **${s.total}**`);
    const byType = Object.entries(s.byType).map(([k, v]) => `${k}=${v}`).join(", ");
    const byProj = Object.entries(s.byProject).slice(0, 10).map(([k, v]) => `${k}=${v}`).join(", ");
    if (byType) lines.push(`- By type: ${byType}`);
    if (byProj) lines.push(`- By project: ${byProj}`);
    lines.push(
      `- Vectors (sqlite-vec): ${s.vectorEnabled ? `\u2705 enabled (${s.vectorCount} indexed, ${missing} pending)` : "\u274C disabled"}`
    );
    lines.push(
      `- Embedder (${embedCfg.model}): ${!embedCfg.enabled ? "disabled (MEMORY_EMBED_ENABLED=0)" : embedderUp ? "\u2705 loaded" : "\u23F3 not loaded yet / unavailable"}`
    );
    return lines.join("\n");
  }
};
var searchTools = [memorySearch, memoryRecent, memoryStats];

// src/tools/reindex.ts
var memoryReindex = {
  name: "memory_reindex",
  description: "Forces reprocessing of existing memories. `vectors` empties the vector index (backfill refills it). `digests` deletes all LLM digests/insights (the digest loop regenerates them). With no argument, does both. Background, non-blocking; BM25 stays available throughout.",
  inputSchema: {
    type: "object",
    properties: {
      vectors: { type: "boolean", description: "Clear and rebuild the vector index. Default: true if neither given." },
      digests: { type: "boolean", description: "Delete and regenerate LLM digests/insights. Default: true if neither given." }
    },
    additionalProperties: false
  },
  handler: async (args, { store }) => {
    const both = args.vectors === void 0 && args.digests === void 0;
    const doVectors = both || args.vectors === true;
    const doDigests = both || args.digests === true;
    const lines = ["**memory \u2014 reindex**"];
    if (doDigests) {
      const n = store.clearDigests();
      lines.push(`- Digests/insights: deleted **${n}** doc(s) \u2192 will be regenerated by the digest loop.`);
    }
    if (doVectors) {
      if (store.vectorEnabled) {
        store.resetVectors();
        lines.push("- Vectors: index emptied \u2192 will be refilled by the backfill.");
      } else {
        lines.push("- Vectors: index disabled (nothing to do).");
      }
    }
    lines.push("_Reprocessing runs in the background (non-blocking). BM25 stays available meanwhile._");
    return lines.join("\n");
  }
};
var reindexTools = [memoryReindex];

// src/tools/delete.ts
var TYPES2 = ["observation", "prompt", "turn", "session", "digest", "insight"];
var memoryDelete = {
  name: "memory_delete",
  description: 'DESTRUCTIVE. Deletes memories matching a filter (and their vectors). Filters combine with AND; at least one is required. Use idPrefix "migrated:" to remove claude-mem imports. Always confirm with the user before calling.',
  inputSchema: {
    type: "object",
    properties: {
      idPrefix: {
        type: "string",
        description: 'Delete docs whose mem_id starts with this (e.g. "migrated:" for claude-mem imports).'
      },
      project: { type: "string", description: "Limit to a project (directory basename)." },
      type: { type: "string", enum: TYPES2, description: "Limit to a memory type." }
    },
    additionalProperties: false
  },
  handler: async (args, { store }) => {
    const idPrefix = args.idPrefix ? String(args.idPrefix) : void 0;
    const project = args.project ? String(args.project) : void 0;
    const type = args.type ? String(args.type) : void 0;
    if (!idPrefix && !project && !type) {
      return "\u274C Refusing to delete: provide at least one filter (idPrefix, project, or type).";
    }
    const n = store.deleteMemories({ idPrefix, project, type });
    const filters = [
      idPrefix ? `idPrefix="${idPrefix}"` : null,
      project ? `project="${project}"` : null,
      type ? `type="${type}"` : null
    ].filter(Boolean).join(", ");
    return `\u{1F5D1}\uFE0F Deleted **${n}** memory(ies) matching ${filters}. Their vectors were removed too; BM25 index stays in sync.`;
  }
};
var deleteTools = [memoryDelete];

// src/tools/core.ts
function line(d) {
  const date = (d.ts ?? "").slice(0, 10);
  const proj = d.project ?? "global";
  return `\`${proj}\`${date ? ` \xB7 ${date}` : ""} \u2014 ${(d.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 200)}`;
}
var coreAdd = {
  name: "memory_core_add",
  description: "Saves a CORE memory: a primordial fact injected into every session at load time. Use when the user explicitly asks to remember something important, or \u2014 after confirming with the user \u2014 for a recurring fact you detected. Keep it one concise, durable sentence. Omit `project` for a global core (shown everywhere); pass a project name to scope it.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The core fact (one concise, durable sentence)." },
      project: { type: "string", description: "Scope to a project (directory basename). Omit for global." }
    },
    required: ["text"],
    additionalProperties: false
  },
  handler: async (args, { store }) => {
    const text = String(args.text ?? "").trim();
    if (!text) return "\u274C `text` is required.";
    const project = args.project ? String(args.project) : void 0;
    const id = store.addCore(text, project);
    return `\u{1F9E0}\u2B50 Core memory saved (${project ? `project \`${project}\`` : "global"}): "${text}"
_id: ${id}_ \u2014 it will be injected at the start of every${project ? " matching" : ""} session.`;
  }
};
var coreList = {
  name: "memory_core_list",
  description: "Lists core memories (the always-injected facts). Optionally scoped to a project (also shows globals).",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Limit to a project (also includes globals). Optional." }
    },
    additionalProperties: false
  },
  handler: async (args, { store }) => {
    const project = args.project ? String(args.project) : void 0;
    const cores = store.listCore(project);
    if (cores.length === 0) return "No core memory yet.";
    return `\u{1F9E0}\u2B50 **${cores.length} core memory(ies)**:

${cores.map((c) => `- ${line(c.doc)}
  _id: ${c.id}_`).join("\n")}`;
  }
};
var coreRemove = {
  name: "memory_core_remove",
  description: "Removes a core memory by its id (get ids from memory_core_list). Confirm with the user first.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: 'The core memory id (e.g. "core:ab12cd34ef56").' } },
    required: ["id"],
    additionalProperties: false
  },
  handler: async (args, { store }) => {
    const id = String(args.id ?? "").trim();
    if (!id) return "\u274C `id` is required.";
    const n = store.removeCore(id);
    return n > 0 ? `\u{1F5D1}\uFE0F Core memory \`${id}\` removed.` : `No core memory with id \`${id}\`.`;
  }
};
var coreSuggest = {
  name: "memory_core_suggest",
  description: "Surfaces signals to help propose a core memory: files touched across many memories, and recent conclusions. Review them; if a durable, important fact recurs, PROPOSE it to the user and, on agreement, call memory_core_add. Do not create a core without the user agreeing.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Bias toward a project. Optional." }
    },
    additionalProperties: false
  },
  handler: async (args, { store }) => {
    const project = args.project ? String(args.project) : void 0;
    const { files } = store.coreSignals(15);
    const digests = store.recent({ project, type: "digest", limit: 8 });
    const existing = store.listCore(project);
    const lines = ["**Core-memory signals** \u2014 review, then propose to the user if warranted."];
    if (files.length) {
      lines.push("\nFiles recurring across many memories:");
      for (const f of files) lines.push(`- ${f.file} (${f.count})`);
    }
    if (digests.length) {
      lines.push("\nRecent conclusions:");
      for (const d of digests) lines.push(`- ${line(d)}`);
    }
    if (existing.length) {
      lines.push(`
Already core (${existing.length}) \u2014 do not duplicate:`);
      for (const c of existing) lines.push(`- ${line(c.doc)}`);
    }
    lines.push(
      "\nIf a durable, repeatedly-relevant fact stands out (a convention, a key path, a deploy step, a decision that keeps mattering), propose it as a core memory and, once the user agrees, call `memory_core_add`."
    );
    return lines.join("\n");
  }
};
var coreTools = [coreAdd, coreList, coreRemove, coreSuggest];

// src/tools/index.ts
var allTools = [
  ...searchTools,
  ...reindexTools,
  ...deleteTools,
  ...coreTools
];

// src/server.ts
var PKG_VERSION = true ? "0.4.2" : "0.0.0-dev";
console.log = (...args) => console.error("[stdout-redirected]", ...args);
var BACKFILL_INTERVAL_MS = 6e4;
var HEARTBEAT_MS = 3e4;
var backfilling = false;
var amLeader = false;
var myEmbedPort = 0;
var myEmbedToken = "";
async function backfill(store, cfg) {
  if (backfilling || !store.vectorEnabled || !cfg.embed.enabled) return;
  if (!await embedReady(cfg.embed)) return;
  backfilling = true;
  try {
    for (; ; ) {
      const docs = store.missingVectorDocs(1);
      if (docs.length === 0) break;
      const doc = docs[0];
      writeStatus(cfg.dataDir, {
        state: "backfilling",
        model: cfg.embed.model,
        vectorized: store.stats().vectorCount,
        missing: store.countMissingVectors()
      });
      const vector = await embed(doc.text, cfg.embed);
      if (vector) store.setVectorByRowid(doc.rowid, vector);
    }
  } catch {
  } finally {
    backfilling = false;
    const s = store.stats();
    writeStatus(cfg.dataDir, {
      state: "idle",
      vectorized: s.vectorCount,
      missing: store.countMissingVectors()
    });
  }
}
var digesting = false;
var DIGEST_PER_TICK = 3;
var warnedNoClaude = false;
async function digestPending(store, cfg) {
  if (digesting || !cfg.digest.enabled) return;
  if (!claudeAvailable()) {
    if (!warnedNoClaude) {
      warnedNoClaude = true;
      log(cfg.dataDir, "[digest] disabled: no native `claude` binary found on PATH (~/.local/bin)");
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
        state: "digesting",
        digestPending: store.countSessionsNeedingDigest(cfg.digest.version)
      });
      const result = await digestSession({
        session_id: sess.session_id,
        project: sess.project,
        branch: sess.branch,
        model: cfg.digest.model,
        turns
      });
      if (!result) continue;
      const ts = nowIso();
      const base = { session_id: sess.session_id, project: sess.project, branch: sess.branch, ts };
      const digestFiles = uniq(result.insights.flatMap((i) => i.files ?? []));
      const digestDoc = {
        type: "digest",
        ...base,
        summary: result.conclusion,
        source: String(cfg.digest.version),
        // version marker → re-digest selector
        files_modified: digestFiles
      };
      const insightDocs = result.insights.map((ins) => ({
        type: "insight",
        ...base,
        summary: ins.text,
        assistant_text: ins.text,
        source: ins.kind,
        // decision | bugfix | discovery | conclusion
        files_modified: ins.files ?? []
      }));
      store.writeDigest(sess.session_id, digestDoc, insightDocs);
      log(
        cfg.dataDir,
        `[digest] ${sess.session_id} \u2192 ${result.insights.length} insights${result.costUsd != null ? ` ($${result.costUsd.toFixed(4)})` : ""}`
      );
    }
  } catch {
  } finally {
    digesting = false;
    const remaining = store.countSessionsNeedingDigest(cfg.digest.version);
    if (remaining === 0) writeStatus(cfg.dataDir, { state: "idle", digestPending: 0 });
  }
}
function processName(tier) {
  const safe = (tier || "light").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `yoannyviquel_memory_${safe}`;
}
function ensureNamedBinary(name) {
  if (process.platform !== "win32") return;
  try {
    const scriptPath = process.argv[1];
    if (!scriptPath) return;
    const root = path7.resolve(path7.dirname(scriptPath), "..");
    const binDir = path7.join(root, "bin");
    const exe = path7.join(binDir, `${name}.exe`);
    if (path7.basename(process.execPath).toLowerCase() === `${name}.exe`) return;
    if (!existsSync4(exe)) {
      mkdirSync4(binDir, { recursive: true });
      copyFileSync(process.execPath, exe);
    }
    try {
      const running = path7.basename(process.execPath).toLowerCase();
      for (const f of readdirSync(binDir)) {
        const low = f.toLowerCase();
        if (low.startsWith("yoannyviquel_memory_") && low.endsWith(".exe") && low !== `${name}.exe` && low !== running) {
          unlinkSync2(path7.join(binDir, f));
        }
      }
    } catch {
    }
    const mcpPath = path7.join(root, ".mcp.json");
    const desired = "${CLAUDE_PLUGIN_ROOT}/bin/" + name + ".exe";
    const mcp = JSON.parse(readFileSync5(mcpPath, "utf8"));
    if (mcp?.mcpServers?.memory && mcp.mcpServers.memory.command !== desired) {
      mcp.mcpServers.memory.command = desired;
      writeFileSync3(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
    }
  } catch {
  }
}
async function main() {
  const config = loadConfig();
  const name = processName(config.embed.tier);
  try {
    process.title = name;
  } catch {
  }
  ensureNamedBinary(name);
  const store = new MemoryStore(
    config.dbPath,
    config.embed.dim,
    config.embed.model,
    EMBED_TEXT_VERSION
  );
  await store.init();
  const embedQuery = async (text) => {
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
    { name: "memory", version: PKG_VERSION },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map(({ name: name2, description, inputSchema }) => ({
      name: name2,
      description,
      inputSchema
    }))
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = allTools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `\u274C Unknown tool: ${req.params.name}` }],
        isError: true
      };
    }
    try {
      const text = await tool.handler(
        req.params.arguments ?? {},
        ctx
      );
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `\u274C ${tool.name} failed: ${message}` }],
        isError: true
      };
    }
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `memory v${PKG_VERSION} ready (stdio) \u2192 ${config.dbPath} | vectors: ${store.vectorEnabled ? "on" : "off"}
`
  );
  log(config.dataDir, `[server] memory v${PKG_VERSION} \u2014 node ${process.version} ${process.platform}/${process.arch}`);
  log(config.dataDir, `[server] exec=${process.execPath}`);
  log(config.dataDir, `[server] db=${config.dbPath} model=${config.embed.model} dim=${config.embed.dim} dtype=${config.embed.dtype} vectors=${store.vectorEnabled ? "on" : "off"}`);
  const modelDir = path7.join(config.embed.cacheDir, ...config.embed.model.split("/"));
  log(config.dataDir, `[server] model cache: ${existsSync4(modelDir) ? "present" : "absent \u2192 download on first use"} (${modelDir})`);
  writeStatus(config.dataDir, {
    state: "idle",
    model: config.embed.model,
    vectorized: store.stats().vectorCount,
    missing: store.countMissingVectors()
  });
  const leaderExtra = () => myEmbedPort ? { port: myEmbedPort, token: myEmbedToken } : {};
  const syncLeadership = async () => {
    const was = amLeader;
    amLeader = refreshLeadership(config.dataDir, leaderExtra());
    if (amLeader && !myEmbedPort && store.vectorEnabled && config.embed.enabled) {
      myEmbedToken = randomBytes(16).toString("hex");
      try {
        myEmbedPort = await startEmbedServer(config.embed, myEmbedToken);
        refreshLeadership(config.dataDir, leaderExtra());
        log(config.dataDir, `[server] embed service on 127.0.0.1:${myEmbedPort}`);
      } catch {
        myEmbedPort = 0;
      }
    }
    if (amLeader !== was) {
      log(config.dataDir, `[server] leadership \u2192 ${amLeader}`);
      if (amLeader) {
        if (store.vectorEnabled && config.embed.enabled) void backfill(store, config);
        if (config.digest.enabled) void digestPending(store, config);
      }
    }
  };
  await syncLeadership();
  log(config.dataDir, `[server] leader=${amLeader} (pid ${process.pid})`);
  const heartbeat = setInterval(() => void syncLeadership(), HEARTBEAT_MS);
  heartbeat.unref?.();
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
  process.on("SIGTERM", releaseAndExit);
  process.on("SIGINT", releaseAndExit);
  process.stdin.on("end", releaseAndExit);
  process.stdin.on("close", releaseAndExit);
  try {
    let watchT;
    const watcher = watch(config.dataDir, (_event, filename) => {
      if (!amLeader && filename && String(filename).includes("worker.lock")) {
        clearTimeout(watchT);
        watchT = setTimeout(() => void syncLeadership(), 200);
      }
    });
    watcher.unref?.();
  } catch {
  }
  if (store.vectorEnabled && config.embed.enabled) {
    const tick = () => {
      if (amLeader) void backfill(store, config);
    };
    tick();
    const timer = setInterval(tick, BACKFILL_INTERVAL_MS);
    timer.unref?.();
  }
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
    `fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}
`
  );
  process.exit(1);
});
//# sourceMappingURL=server.js.map