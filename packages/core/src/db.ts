import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { arenaHome } from "./paths.ts";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  pack_name     TEXT NOT NULL,
  pack_dir      TEXT NOT NULL,
  pack_version  TEXT NOT NULL,
  axi_version   TEXT,
  config_json   TEXT NOT NULL,
  status        TEXT NOT NULL,          -- running | done | failed | aborted
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  error         TEXT
);

CREATE TABLE IF NOT EXISTS trials (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id          TEXT NOT NULL,
  arm              TEXT NOT NULL,
  model            TEXT NOT NULL,
  trial_index      INTEGER NOT NULL,
  status           TEXT NOT NULL,       -- queued | running | success | max_turns | timeout | error | setup_error
  started_at       TEXT,
  finished_at      TEXT,
  result_text      TEXT,
  sdk_subtype      TEXT,
  num_turns        INTEGER,
  tool_calls       INTEGER,
  tool_errors      INTEGER,
  escape_attempts  INTEGER,
  duration_ms      INTEGER,
  duration_api_ms  INTEGER,
  tokens_total     INTEGER,
  tokens_weighted  INTEGER,             -- scored: cost-weighted input-token equivalents
  tokens_json      TEXT,                -- per-model usage breakdown
  cost_usd         REAL,                -- notional; not scored
  trial_dir        TEXT,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS trials_run ON trials(run_id);
CREATE INDEX IF NOT EXISTS trials_match ON trials(task_id, arm, model);

CREATE TABLE IF NOT EXISTS events (
  trial_id  TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  ts        TEXT NOT NULL,
  type      TEXT NOT NULL,
  json      TEXT NOT NULL,
  PRIMARY KEY (trial_id, seq)
);
`;

export type Db = DatabaseSync;

/** Additive migrations for DBs created by older versions. */
const MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: "trials", column: "tokens_weighted", ddl: "ALTER TABLE trials ADD COLUMN tokens_weighted INTEGER" },
];

export function openDb(path = join(arenaHome(), "arena.db")): Db {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  for (const m of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === m.column)) db.exec(m.ddl);
  }
  return db;
}

export interface RunRow {
  id: string;
  pack_name: string;
  pack_dir: string;
  pack_version: string;
  axi_version: string | null;
  config_json: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export interface TrialRow {
  id: string;
  run_id: string;
  task_id: string;
  arm: string;
  model: string;
  trial_index: number;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  result_text: string | null;
  sdk_subtype: string | null;
  num_turns: number | null;
  tool_calls: number | null;
  tool_errors: number | null;
  escape_attempts: number | null;
  duration_ms: number | null;
  duration_api_ms: number | null;
  tokens_total: number | null;
  tokens_weighted: number | null;
  tokens_json: string | null;
  cost_usd: number | null;
  trial_dir: string | null;
  error: string | null;
}

const now = () => new Date().toISOString();

export function insertRun(db: Db, r: Omit<RunRow, "status" | "started_at" | "finished_at" | "error">): void {
  db.prepare(
    `INSERT INTO runs (id, pack_name, pack_dir, pack_version, axi_version, config_json, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
  ).run(r.id, r.pack_name, r.pack_dir, r.pack_version, r.axi_version, r.config_json, now());
}

export function finishRun(db: Db, id: string, status: "done" | "failed" | "aborted", error?: string): void {
  db.prepare(`UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE id = ?`).run(status, now(), error ?? null, id);
}

export function insertTrial(db: Db, t: Pick<TrialRow, "id" | "run_id" | "task_id" | "arm" | "model" | "trial_index">): void {
  db.prepare(
    `INSERT INTO trials (id, run_id, task_id, arm, model, trial_index, status) VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
  ).run(t.id, t.run_id, t.task_id, t.arm, t.model, t.trial_index);
}

export function startTrial(db: Db, id: string, trialDir: string): void {
  db.prepare(`UPDATE trials SET status = 'running', started_at = ?, trial_dir = ? WHERE id = ?`).run(now(), trialDir, id);
}

export type TrialOutcome = Omit<TrialRow, "id" | "run_id" | "task_id" | "arm" | "model" | "trial_index" | "started_at" | "finished_at" | "trial_dir">;

export function finishTrial(db: Db, id: string, o: TrialOutcome): void {
  db.prepare(
    `UPDATE trials SET status = ?, finished_at = ?, result_text = ?, sdk_subtype = ?, num_turns = ?, tool_calls = ?,
       tool_errors = ?, escape_attempts = ?, duration_ms = ?, duration_api_ms = ?, tokens_total = ?, tokens_weighted = ?, tokens_json = ?,
       cost_usd = ?, error = ?
     WHERE id = ?`,
  ).run(
    o.status, now(), o.result_text, o.sdk_subtype, o.num_turns, o.tool_calls, o.tool_errors, o.escape_attempts,
    o.duration_ms, o.duration_api_ms, o.tokens_total, o.tokens_weighted, o.tokens_json, o.cost_usd, o.error, id,
  );
}

export function appendEvent(db: Db, trialId: string, seq: number, type: string, payload: unknown): void {
  db.prepare(`INSERT INTO events (trial_id, seq, ts, type, json) VALUES (?, ?, ?, ?, ?)`).run(
    trialId, seq, now(), type, JSON.stringify(payload),
  );
}

export function listRuns(db: Db, limit = 20): RunRow[] {
  return db.prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`).all(limit) as unknown as RunRow[];
}

export function runTrials(db: Db, runId: string): TrialRow[] {
  return db.prepare(`SELECT * FROM trials WHERE run_id = ? ORDER BY task_id, model, arm, trial_index`).all(runId) as unknown as TrialRow[];
}

/** Mean cost-weighted tokens per (task, arm, model) over finished trials of earlier runs of a pack — for estimates. */
export function historicalTokens(db: Db, packName: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT t.task_id, t.arm, t.model, AVG(t.tokens_weighted) AS avg_tokens
       FROM trials t JOIN runs r ON r.id = t.run_id
       WHERE r.pack_name = ? AND t.tokens_weighted IS NOT NULL
       GROUP BY t.task_id, t.arm, t.model`,
    )
    .all(packName) as { task_id: string; arm: string; model: string; avg_tokens: number }[];
  return new Map(rows.map((r) => [`${r.task_id}|${r.arm}|${r.model}`, r.avg_tokens]));
}
