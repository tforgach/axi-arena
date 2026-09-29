// Executes a run: tasks × arms × models × N isolated agent trials (SPEC §3).
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildArmPlugin, buildQueryOptions, cleanupClaudeProjectDir, trialEnv, trialWorkDir, type GuardDenial } from "./arm.ts";
import { appendEvent, finishRun, finishTrial, insertRun, insertTrial, startTrial, type Db, type TrialOutcome } from "./db.ts";
import { computeMetrics } from "./metrics.ts";
import { packPath, type Effort, type Pack, type Task } from "./pack.ts";
import { runDir as makeRunDir } from "./paths.ts";

export interface RunOptions {
  models: string[];
  trials: number;
  arms: string[];
  tasks: Task[];
  concurrency: number;
  effort: Effort;
  maxTurns: number;
  timeoutS: number;
  keep: boolean;
}

export interface PlannedTrial {
  id: string;
  task: Task;
  arm: string;
  model: string;
  index: number;
}

export interface RunHooks {
  onRunStart?(runId: string, planned: PlannedTrial[]): void;
  onTrialStart?(t: PlannedTrial): void;
  onTrialEnd?(t: PlannedTrial, outcome: TrialOutcome): void;
  onLog?(line: string): void;
}

const shortId = () => randomBytes(3).toString("hex");

export function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${shortId()}`;
}

/**
 * Order: model → task → trial index → arm, so the arms of a match run next to each
 * other in time (less drift from rate limits or upstream changes between arms).
 */
export function planTrials(opts: Pick<RunOptions, "models" | "trials" | "arms" | "tasks">): PlannedTrial[] {
  const out: PlannedTrial[] = [];
  for (const model of opts.models)
    for (const task of opts.tasks)
      for (let index = 0; index < opts.trials; index++)
        for (const arm of opts.arms) out.push({ id: `${task.id}.${arm}.${model}.${index}.${shortId()}`, task, arm, model, index });
  return out;
}

function runScript(pack: Pack, rel: string, env: Record<string, string>, log: (l: string) => void): void {
  const res = spawnSync(packPath(pack, rel), [], {
    cwd: pack.dir,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10 * 60_000,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  if (out) log(out);
  if (res.error) throw new Error(`${rel}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${rel} exited with ${res.status}`);
}

function detectAxiVersion(pack: Pack, trialDirForEnv: string): string | null {
  if (!pack.axi_version_cmd) return null;
  const env = trialEnv(pack, pack.arms.axi, trialDirForEnv);
  const res = spawnSync("/bin/sh", ["-c", pack.axi_version_cmd], { cwd: pack.dir, env, encoding: "utf8", timeout: 30_000 });
  return res.status === 0 ? res.stdout.trim().split("\n")[0] || null : null;
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

export async function executeRun(db: Db, pack: Pack, opts: RunOptions, hooks: RunHooks = {}, signal?: AbortSignal): Promise<string> {
  const runId = newRunId();
  const dir = makeRunDir(runId);
  const log = (l: string) => hooks.onLog?.(l);
  const arenaVars = { ARENA_RUN_ID: runId, ARENA_PACK_DIR: pack.dir, ARENA_RUN_DIR: dir };

  const planned = planTrials(opts);
  let setupDone = false;
  try {
    if (pack.setup) {
      log(`setup: ${pack.setup}`);
      runScript(pack, pack.setup, arenaVars, log);
    }
    setupDone = true;

    const axiVersion = detectAxiVersion(pack, join(dir, "version-probe"));
    insertRun(db, {
      id: runId,
      pack_name: pack.name,
      pack_dir: pack.dir,
      pack_version: pack.version,
      axi_version: axiVersion,
      config_json: JSON.stringify({ ...opts, tasks: opts.tasks.map((t) => t.id) }),
    });

    const plugins = new Map(opts.arms.map((a) => [a, buildArmPlugin(pack, a, pack.arms[a], join(dir, "plugins"))]));
    for (const t of planned) insertTrial(db, { id: t.id, run_id: runId, task_id: t.task.id, arm: t.arm, model: t.model, trial_index: t.index });
    hooks.onRunStart?.(runId, planned);

    const runOne = async (t: PlannedTrial) => {
      if (signal?.aborted) return;
      const trialDir = join(dir, "trials", t.id);
      mkdirSync(trialDir, { recursive: true });
      startTrial(db, t.id, trialDir);
      hooks.onTrialStart?.(t);
      const outcome = await runTrial(db, pack, t, trialDir, plugins.get(t.arm) ?? null, opts, arenaVars, log, signal);
      finishTrial(db, t.id, outcome);
      hooks.onTrialEnd?.(t, outcome);
      if (!opts.keep) rmSync(trialDir, { recursive: true, force: true });
    };

    // Stateful packs/tasks run one at a time, after the parallel-safe ones.
    const serial = (t: PlannedTrial) => pack.sequential || t.task.sequential === true;
    await pool(planned.filter((t) => !serial(t)), opts.concurrency, runOne);
    await pool(planned.filter(serial), 1, runOne);

    finishRun(db, runId, signal?.aborted ? "aborted" : "done");
    return runId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try { finishRun(db, runId, "failed", msg); } catch { /* run row may not exist if setup failed */ }
    throw err;
  } finally {
    if (setupDone && pack.teardown) {
      try {
        log(`teardown: ${pack.teardown}`);
        runScript(pack, pack.teardown, arenaVars, log);
      } catch (e) {
        log(`teardown failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}

async function runTrial(
  db: Db,
  pack: Pack,
  t: PlannedTrial,
  trialDir: string,
  plugin: { path: string; skills: string[] } | null,
  opts: RunOptions,
  arenaVars: Record<string, string>,
  log: (l: string) => void,
  signal?: AbortSignal,
): Promise<TrialOutcome> {
  const empty: TrialOutcome = {
    status: "error", result_text: null, sdk_subtype: null, num_turns: null, tool_calls: null, tool_errors: null,
    escape_attempts: null, duration_ms: null, duration_api_ms: null, tokens_total: null, tokens_json: null,
    cost_usd: null, error: null,
  };
  const scriptEnv = { ...arenaVars, ARENA_TRIAL_ID: t.id, ARENA_ARM: t.arm, ARENA_MODEL: t.model, ARENA_TRIAL_DIR: trialDir };

  if (t.task.before) {
    try {
      runScript(pack, t.task.before, scriptEnv, log);
    } catch (e) {
      return { ...empty, status: "setup_error", error: e instanceof Error ? e.message : String(e) };
    }
  }

  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abortController.abort(); }, opts.timeoutS * 1000);
  const onAbort = () => abortController.abort();
  signal?.addEventListener("abort", onAbort);

  const denials: GuardDenial[] = [];
  const messages: SDKMessage[] = [];
  let error: string | null = null;
  try {
    const options = buildQueryOptions({
      pack, armName: t.arm, plugin, trialDir, model: t.model, effort: opts.effort,
      maxTurns: opts.maxTurns, abortController, denials,
    });
    let seq = 0;
    for await (const msg of query({ prompt: t.task.prompt, options })) {
      messages.push(msg);
      appendEvent(db, t.id, seq++, msg.type === "system" ? `system:${msg.subtype}` : msg.type, msg);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    cleanupClaudeProjectDir(trialWorkDir(trialDir));
  }

  if (t.task.after) {
    try { runScript(pack, t.task.after, scriptEnv, log); } catch (e) { log(`after failed for ${t.id}: ${e}`); }
  }

  const m = computeMetrics(messages, denials);
  const status =
    timedOut ? "timeout"
    : m.sdkSubtype === "success" ? "success"
    : m.sdkSubtype === "error_max_turns" ? "max_turns"
    : "error";
  return {
    status,
    result_text: m.resultText,
    sdk_subtype: m.sdkSubtype,
    num_turns: m.numTurns,
    tool_calls: m.toolCalls,
    tool_errors: m.toolErrors,
    escape_attempts: m.escapeAttempts,
    duration_ms: m.durationMs,
    duration_api_ms: m.durationApiMs,
    tokens_total: m.tokensTotal,
    tokens_json: JSON.stringify(m.tokensByModel),
    cost_usd: m.costUsd,
    error: timedOut ? `timed out after ${opts.timeoutS}s` : error,
  };
}
