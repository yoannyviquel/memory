#!/usr/bin/env node

// src/migrate.ts
import os2 from "os";
import path4 from "path";
import { existsSync as existsSync3 } from "fs";

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
  const backfillBatch = Math.max(1, Number(get("MEMORY_EMBED_BACKFILL_BATCH", "embedBackfillBatch")) || 16);
  const backfillDelayMs = Math.max(0, Number(get("MEMORY_EMBED_BACKFILL_DELAY_MS", "embedBackfillDelayMs")) || 250);
  const coreCap = Math.max(1, Math.floor(os.cpus().length * 0.25));
  const threads = Math.max(1, Number(get("MEMORY_EMBED_THREADS", "embedThreads")) || coreCap);
  return {
    dbPath,
    dataDir,
    contextLimit,
    embed: { enabled, model, dim, cacheDir, dtype, backfillBatch, backfillDelayMs, threads, dataDir }
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
function embedText(parts, max = 2e3) {
  return parts.filter((p) => !!p && p.trim().length > 0).join("\n").slice(0, max);
}
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
      const session_options = { intraOpNumThreads: threads, interOpNumThreads: threads };
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

// src/migrate.ts
function parseArgs(argv) {
  const args = {
    db: path4.join(os2.homedir(), ".claude-mem", "claude-mem.db"),
    dryRun: false,
    batch: 500,
    embed: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--embed") args.embed = true;
    else if (a === "--db") args.db = argv[++i];
    else if (a === "--project") args.project = argv[++i];
    else if (a === "--batch") args.batch = Number(argv[++i]) || 500;
  }
  return args;
}
function parseJsonArray(v) {
  if (!v || typeof v !== "string") return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function clip(v, max) {
  if (v == null) return void 0;
  const s = String(v).trim();
  return s ? s.slice(0, max) : void 0;
}
function joinParts(parts, max) {
  return parts.filter(([, v]) => v != null && String(v).trim()).map(([label, v]) => `${label}: ${String(v).trim()}`).join("\n\n").slice(0, max);
}
function docEmbedText(d) {
  return embedText([d.summary, d.user_prompt, d.assistant_text, ...d.prompts ?? []]);
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (!existsSync3(args.db)) {
    console.error(`\u274C claude-mem SQLite database not found: ${args.db}`);
    process.exit(1);
  }
  const sqliteModule = "node:sqlite";
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import(sqliteModule));
  } catch {
    console.error(
      `\u274C Module 'node:sqlite' unavailable. Node ${process.version}; requires Node \u2265 22.5.`
    );
    process.exit(1);
  }
  const embedCfg = cfg.embed;
  if (args.embed && !args.dryRun) {
    if (!await embedReady(embedCfg)) {
      console.error(
        `\u274C --embed requested but the local embedder (${embedCfg.model}) failed to load. Migrate without --embed, or check model access.`
      );
      process.exit(1);
    }
  }
  const db = new DatabaseSync(args.db, { readOnly: true });
  const safeAll = (sql) => {
    try {
      return db.prepare(sql).all();
    } catch (err) {
      console.error(`\u26A0\uFE0F Read failed (${sql}): ${err instanceof Error ? err.message : err}`);
      return [];
    }
  };
  const memToContent = /* @__PURE__ */ new Map();
  const contentToProject = /* @__PURE__ */ new Map();
  for (const s of safeAll("SELECT * FROM sdk_sessions")) {
    if (s.memory_session_id && s.content_session_id)
      memToContent.set(s.memory_session_id, s.content_session_id);
    if (s.content_session_id && s.project) contentToProject.set(s.content_session_id, s.project);
  }
  const resolveSession = (memId) => memId && memToContent.get(memId) || memId || "claude-mem";
  const resolveProject = (rowProject, contentId) => args.project || rowProject || contentId && contentToProject.get(contentId) || "claude-mem";
  const items = [];
  const counts = { observations: 0, session_summaries: 0, user_prompts: 0 };
  for (const o of safeAll("SELECT * FROM observations")) {
    counts.observations++;
    items.push({
      id: `migrated:obs:${o.id}`,
      doc: {
        type: "observation",
        session_id: resolveSession(o.memory_session_id),
        project: resolveProject(o.project, memToContent.get(o.memory_session_id)),
        ts: o.created_at,
        prompt_number: o.prompt_number ?? void 0,
        summary: clip(o.title, 1e3) || clip(o.subtitle, 1e3),
        assistant_text: joinParts(
          [
            ["Discovery", o.title],
            ["Detail", o.subtitle],
            ["Narrative", o.narrative],
            ["Facts", o.facts],
            ["Text", o.text]
          ],
          12e3
        ),
        tool_brief: clip(o.type, 100),
        files_read: parseJsonArray(o.files_read),
        files_modified: parseJsonArray(o.files_modified)
      }
    });
  }
  for (const s of safeAll("SELECT * FROM session_summaries")) {
    counts.session_summaries++;
    items.push({
      id: `migrated:session:${s.id}`,
      doc: {
        type: "session",
        session_id: resolveSession(s.memory_session_id),
        project: resolveProject(s.project, memToContent.get(s.memory_session_id)),
        ts: s.created_at,
        started_at: s.created_at,
        prompt_number: s.prompt_number ?? void 0,
        summary: clip(s.request, 1e3),
        assistant_text: joinParts(
          [
            ["Request", s.request],
            ["Investigated", s.investigated],
            ["Learned", s.learned],
            ["Completed", s.completed],
            ["Next steps", s.next_steps],
            ["Notes", s.notes]
          ],
          12e3
        ),
        files_read: parseJsonArray(s.files_read),
        files_modified: parseJsonArray(s.files_edited)
      }
    });
  }
  for (const p of safeAll("SELECT * FROM user_prompts")) {
    counts.user_prompts++;
    items.push({
      id: `migrated:prompt:${p.id}`,
      doc: {
        type: "prompt",
        session_id: p.content_session_id || "claude-mem",
        project: resolveProject(void 0, p.content_session_id),
        ts: p.created_at,
        prompt_number: p.prompt_number ?? void 0,
        user_prompt: clip(p.prompt_text, 4e3),
        summary: clip(p.prompt_text, 200)
      }
    });
  }
  db.close();
  console.error(
    `\u{1F4CA} Read: observations=${counts.observations}, session_summaries=${counts.session_summaries}, user_prompts=${counts.user_prompts} \u2192 ${items.length} documents.`
  );
  if (args.dryRun) {
    console.error(`\u{1F7E1} --dry-run: no writes.${args.embed ? " (--embed would be applied)" : ""}`);
    process.exit(0);
  }
  const store = new MemoryStore(cfg.dbPath, cfg.embed.dim, cfg.embed.model);
  await store.init();
  if (args.embed && !store.vectorEnabled) {
    console.error("\u26A0\uFE0F --embed requested but vector index unavailable (sqlite-vec) \u2192 importing without vectors.");
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
      `  \u2026indexed ${indexed}/${items.length} (errors: ${errors}${doEmbed ? `, vectors: ${embedded}` : ""})`
    );
  }
  store.close();
  console.error(
    `\u2705 Migration done: ${indexed} indexed, ${errors} errors${doEmbed ? `, ${embedded} vectors` : ""} \u2192 ${cfg.dbPath}`
  );
  process.exit(errors > 0 ? 2 : 0);
}
main().catch((err) => {
  console.error(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
//# sourceMappingURL=migrate.js.map