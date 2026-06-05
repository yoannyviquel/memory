#!/usr/bin/env node

// src/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import {
  existsSync as existsSync3,
  copyFileSync,
  mkdirSync as mkdirSync3,
  readFileSync as readFileSync3,
  writeFileSync as writeFileSync2,
  readdirSync,
  unlinkSync
} from "fs";
import path4 from "path";

// src/config.ts
import os from "os";
import path from "path";
import { readFileSync } from "fs";
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
  return {
    dbPath,
    dataDir,
    contextLimit,
    embed: { enabled, tier, model, dim, cacheDir, dtype, threads, dataDir }
  };
}

// src/store.ts
import { mkdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import path2 from "path";
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
  constructor(dbPath, dim = 384, model = "") {
    this.dbPath = dbPath;
    this.dim = dim;
    this.model = model;
  }
  dbPath;
  dim;
  model;
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
        const changed = this.model !== "" && (prevModel !== this.model || prevDim !== null && Number(prevDim) !== this.dim);
        if (changed) this.db.exec("DROP TABLE IF EXISTS vec_memories;");
        this.db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(embedding float[${this.dim}]);`
        );
        this.metaSet("embed_model", this.model);
        this.metaSet("embed_dim", String(this.dim));
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
         WHERE type IN ('prompt','turn','session')
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
               WHERE type IN ('prompt','turn','session')
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

// src/tools/search.ts
var TYPES = ["observation", "prompt", "turn", "session"];
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
  handler: async (args, { store, embedCfg }) => {
    const query = String(args.query ?? "").trim();
    if (!query) return "\u274C `query` is required.";
    const embedding = store.vectorEnabled ? await embed(query, embedCfg) : null;
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
    const embedderUp = embedCfg.enabled && s.vectorEnabled ? await embedReady(embedCfg) : false;
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

// src/tools/index.ts
var allTools = [...searchTools];

// src/server.ts
var PKG_VERSION = true ? "0.1.12" : "0.0.0-dev";
console.log = (...args) => console.error("[stdout-redirected]", ...args);
var BACKFILL_INTERVAL_MS = 6e4;
var backfilling = false;
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
function processName(tier) {
  const safe = (tier || "light").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `yoannyviquel_memory_${safe}`;
}
function ensureNamedBinary(name) {
  if (process.platform !== "win32") return;
  try {
    const scriptPath = process.argv[1];
    if (!scriptPath) return;
    const root = path4.resolve(path4.dirname(scriptPath), "..");
    const binDir = path4.join(root, "bin");
    const exe = path4.join(binDir, `${name}.exe`);
    if (path4.basename(process.execPath).toLowerCase() === `${name}.exe`) return;
    if (!existsSync3(exe)) {
      mkdirSync3(binDir, { recursive: true });
      copyFileSync(process.execPath, exe);
    }
    try {
      const running = path4.basename(process.execPath).toLowerCase();
      for (const f of readdirSync(binDir)) {
        const low = f.toLowerCase();
        if (low.startsWith("yoannyviquel_memory_") && low.endsWith(".exe") && low !== `${name}.exe` && low !== running) {
          unlinkSync(path4.join(binDir, f));
        }
      }
    } catch {
    }
    const mcpPath = path4.join(root, ".mcp.json");
    const desired = "${CLAUDE_PLUGIN_ROOT}/bin/" + name + ".exe";
    const mcp = JSON.parse(readFileSync3(mcpPath, "utf8"));
    if (mcp?.mcpServers?.memory && mcp.mcpServers.memory.command !== desired) {
      mcp.mcpServers.memory.command = desired;
      writeFileSync2(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
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
  const store = new MemoryStore(config.dbPath, config.embed.dim, config.embed.model);
  await store.init();
  const ctx = { store, embedCfg: config.embed };
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
  log(config.dataDir, `[server] db=${config.dbPath} model=${config.embed.model} dim=${config.embed.dim} dtype=${config.embed.dtype} vectors=${store.vectorEnabled ? "on" : "off"}`);
  const modelDir = path4.join(config.embed.cacheDir, ...config.embed.model.split("/"));
  log(config.dataDir, `[server] model cache: ${existsSync3(modelDir) ? "present" : "absent \u2192 download on first use"} (${modelDir})`);
  writeStatus(config.dataDir, {
    state: "idle",
    model: config.embed.model,
    vectorized: store.stats().vectorCount,
    missing: store.countMissingVectors()
  });
  if (store.vectorEnabled && config.embed.enabled) {
    void backfill(store, config);
    const timer = setInterval(() => void backfill(store, config), BACKFILL_INTERVAL_MS);
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