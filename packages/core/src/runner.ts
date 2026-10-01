// Executes a run: tasks × arms × models × N isolated agent trials (SPEC §3).
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildArmPlugin, buildQueryOptions, cleanupClaudeProjectDir, trialEnv, trialWorkDir, type GuardDenial } from "./arm.ts";
import { scriptRunner } from "./checks.ts";
import {
  appendEvent, cancelQueuedTrials, copyTrials, finishRun, getRun, finishTrial, insertRun, insertTrial, isCancelRequested, setGrade, startTrial,
  type Db, type TrialOutcome,
} from "./db.ts";
import { gradeTrial, type Grade } from "./grading.ts";
import { computeMetrics } from "./metrics.ts";
import { ensureCa } from "./certs.ts";
import { FixtureStore } from "./fixtures.ts";
import { fixtureDir, packPath, type Effort, type Network, type Pack, type Task } from "./pack.ts";
import { proxyEnv, startProxy, type ProxyHandle } from "./proxy.ts";
import { loadConfig, resolveAuth, resolveModel, type ArenaConfig, type AuthSetup } from "./config.ts";
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
  judgeModel: string;
  useJudge: boolean;
  /** Overrides every task's network mode (e.g. `record`). */
  network?: Network;
  /**
   * Reuse finished baseline trials from this earlier run of the same pack instead of running
   * them again (only the `axi` arm runs). For iterating on an AXI: baselines don't change.
   */
  reuseBaselinesFrom?: string;
  /** Credentials/provider setup; resolved from ~/.axi-arena/config.yaml if omitted. */
  auth?: AuthSetup;
  config?: ArenaConfig;
}

/** Effective network mode for a task: run override → task → pack default. */
export const taskNetwork = (pack: Pack, task: Task, opts: Pick<RunOptions, "network">): Network =>
  opts.network ?? task.network ?? pack.defaults.network;

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
  onTrialEnd?(t: PlannedTrial, outcome: TrialOutcome, grade: Grade | null): void;
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

function detectAxiVersion(pack: Pack, trialDirForEnv: string, auth?: AuthSetup): string | null {
  if (!pack.axi_version_cmd) return null;
  const env = trialEnv(pack, pack.arms.axi, trialDirForEnv, {}, auth);
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

export async function executeRun(db: Db, pack: Pack, optsIn: RunOptions, hooks: RunHooks = {}, externalSignal?: AbortSignal): Promise<string> {
  // One abort signal for Ctrl-C (external) and cancel requests from the web UI (polled below).
  const cancel = new AbortController();
  const signal = cancel.signal;
  const onExternal = () => cancel.abort();
  externalSignal?.addEventListener("abort", onExternal);
  let cancelPoll: ReturnType<typeof setInterval> | undefined;
  const config = optsIn.config ?? loadConfig();
  const opts: RunOptions = { ...optsIn, config, auth: optsIn.auth ?? resolveAuth(config) };
  const runId = newRunId();
  const dir = makeRunDir(runId);
  const log = (l: string) => hooks.onLog?.(l);
  const arenaVars = { ARENA_RUN_ID: runId, ARENA_PACK_DIR: pack.dir, ARENA_RUN_DIR: dir };

  if (opts.reuseBaselinesFrom) {
    const src = getRun(db, opts.reuseBaselinesFrom);
    if (!src) throw new Error(`--reuse-baselines: no run ${opts.reuseBaselinesFrom}`);
    if (src.pack_name !== pack.name) throw new Error(`--reuse-baselines: run ${src.id} is pack ${src.pack_name}, not ${pack.name}`);
  }
  const reusedArms = opts.reuseBaselinesFrom ? opts.arms.filter((a) => a !== "axi") : [];
  const planned = planTrials({ ...opts, arms: opts.reuseBaselinesFrom ? ["axi"] : opts.arms });
  let setupDone = false;
  try {
    if (pack.setup) {
      log(`setup: ${pack.setup}`);
      runScript(pack, pack.setup, arenaVars, log);
    }
    setupDone = true;

    const axiVersion = detectAxiVersion(pack, join(dir, "version-probe"), opts.auth);
    insertRun(db, {
      id: runId,
      pack_name: pack.name,
      pack_dir: pack.dir,
      pack_version: pack.version,
      axi_version: axiVersion,
      config_json: JSON.stringify({
        ...opts,
        auth: undefined, // never persist credentials; keep only what was used, redacted
        config: undefined,
        authSources: opts.auth!.sources,
        provider: opts.auth!.provider,
        tasks: opts.tasks.map((t) => t.id),
        scoring: pack.scoring,
      }),
    });

    const plugins = new Map(opts.arms.map((a) => [a, buildArmPlugin(pack, a, pack.arms[a], join(dir, "plugins"))]));
    for (const t of planned) insertTrial(db, { id: t.id, run_id: runId, task_id: t.task.id, arm: t.arm, model: t.model, trial_index: t.index });
    if (opts.reuseBaselinesFrom) {
      const n = copyTrials(db, opts.reuseBaselinesFrom, runId, { arms: reusedArms, tasks: opts.tasks.map((t) => t.id), models: opts.models });
      hooks.onLog?.(`reused ${n} baseline trial(s) (${reusedArms.join(", ")}) from run ${opts.reuseBaselinesFrom}`);
      if (n === 0) throw new Error(`--reuse-baselines: run ${opts.reuseBaselinesFrom} has no finished ${reusedArms.join("/")} trials for these tasks/models`);
    }
    hooks.onRunStart?.(runId, planned);
    cancelPoll = setInterval(() => {
      if (!signal.aborted && isCancelRequested(db, runId)) {
        hooks.onLog?.("cancel requested from the web UI — stopping in-flight trials");
        cancel.abort();
      }
    }, 1000);

    const runOne = async (t: PlannedTrial) => {
      if (signal?.aborted) return;
      const trialDir = join(dir, "trials", t.id);
      mkdirSync(trialDir, { recursive: true });
      startTrial(db, t.id, trialDir);
      hooks.onTrialStart?.(t);
      const { outcome, grade } = await runTrial(db, pack, t, trialDir, plugins.get(t.arm) ?? null, opts, arenaVars, log, signal);
      finishTrial(db, t.id, outcome);
      if (grade) setGrade(db, t.id, grade.correctness, JSON.stringify(grade.checks), JSON.stringify(grade.judgment));
      hooks.onTrialEnd?.(t, outcome, grade);
      if (!opts.keep) rmSync(trialDir, { recursive: true, force: true });
    };

    // Stateful packs/tasks run one at a time, after the parallel-safe ones.
    const serial = (t: PlannedTrial) => pack.sequential || t.task.sequential === true;
    await pool(planned.filter((t) => !serial(t)), opts.concurrency, runOne);
    await pool(planned.filter(serial), 1, runOne);

    if (signal.aborted) cancelQueuedTrials(db, runId);
    finishRun(db, runId, signal.aborted ? "aborted" : "done");
    return runId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try { finishRun(db, runId, "failed", msg); } catch { /* run row may not exist if setup failed */ }
    throw err;
  } finally {
    clearInterval(cancelPoll);
    externalSignal?.removeEventListener("abort", onExternal);
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

/** The model ID the session actually ran (after alias/provider resolution). */
function initModel(messages: SDKMessage[]): string | null {
  for (const m of messages) if (m.type === "system" && m.subtype === "init") return m.model;
  return null;
}

function proxySummary(p: ProxyHandle) {
  const count = (k: string) => p.events.filter((e) => e.kind === k).length;
  return {
    hits: count("hit"),
    recorded: count("recorded"),
    passthrough: count("passthrough"),
    misses: p.misses().slice(0, 20).map((e) => ({ method: e.method, url: e.url, detail: e.detail })),
  };
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
): Promise<{ outcome: TrialOutcome; grade: Grade | null }> {
  const empty: TrialOutcome = {
    status: "error", result_text: null, sdk_subtype: null, num_turns: null, tool_calls: null, tool_errors: null, error_recoveries: null,
    escape_attempts: null, duration_ms: null, duration_api_ms: null, tokens_total: null, tokens_weighted: null, tool_tokens: null, base_context: null, tokens_json: null,
    cost_usd: null, error: null, network: null, model_id: null, fixture_misses: null, proxy_json: null,
  };
  const network = taskNetwork(pack, t.task, opts);
  const scriptEnv = { ...arenaVars, ARENA_TRIAL_ID: t.id, ARENA_ARM: t.arm, ARENA_MODEL: t.model, ARENA_TRIAL_DIR: trialDir };

  if (t.task.before) {
    try {
      runScript(pack, t.task.before, scriptEnv, log);
    } catch (e) {
      return { outcome: { ...empty, network, status: "setup_error", error: e instanceof Error ? e.message : String(e) }, grade: null };
    }
  }

  // Replay/record: a proxy per trial, so concurrent trials of different tasks never share fixtures.
  let proxy: ProxyHandle | null = null;
  let extraEnv: Record<string, string> = {};
  if (network !== "live") {
    try {
      const ca = ensureCa();
      proxy = await startProxy({
        mode: network, store: new FixtureStore(fixtureDir(pack, t.task.id)), ca,
        upstreamProxy: opts.auth?.upstreamProxy, noProxy: opts.auth?.noProxy,
      });
      extraEnv = proxyEnv(proxy, ca, opts.auth?.extraCaFile);
    } catch (e) {
      return { outcome: { ...empty, network, status: "setup_error", error: `replay proxy: ${e instanceof Error ? e.message : e}` }, grade: null };
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
      pack, armName: t.arm, plugin, trialDir, model: resolveModel(t.model, opts.config!), effort: opts.effort,
      maxTurns: opts.maxTurns, abortController, denials, extraEnv, auth: opts.auth,
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
    await proxy?.close();
  }

  const m = computeMetrics(messages, denials);
  const cancelled = Boolean(signal?.aborted) && !timedOut;
  // Grade before `after`, so script checks can inspect real-system state the trial left behind.
  // A cancelled trial isn't graded: no judge spend on a transcript that was cut short.
  const grade = cancelled ? null : await gradeTrial(
    t.task, messages, m, { trialDir, arm: t.arm, model: t.model },
    { judgeModel: resolveModel(opts.judgeModel, opts.config!), useJudge: opts.useJudge, auth: opts.auth }, scriptRunner(pack, t.task),
  );

  if (t.task.after) {
    try { runScript(pack, t.task.after, scriptEnv, log); } catch (e) { log(`after failed for ${t.id}: ${e}`); }
  }

  const status =
    cancelled ? "cancelled"
    : timedOut ? "timeout"
    : m.sdkSubtype === "success" ? "success"
    : m.sdkSubtype === "error_max_turns" ? "max_turns"
    : "error";
  const outcome: TrialOutcome = {
    status,
    result_text: m.resultText,
    sdk_subtype: m.sdkSubtype,
    num_turns: m.numTurns,
    tool_calls: m.toolCalls,
    tool_errors: m.toolErrors,
    error_recoveries: m.errorRecoveries,
    escape_attempts: m.escapeAttempts,
    duration_ms: m.durationMs,
    duration_api_ms: m.durationApiMs,
    tokens_total: m.tokensTotal,
    tokens_weighted: m.tokensWeighted,
    tool_tokens: m.toolTokens,
    base_context: m.baseContext,
    tokens_json: JSON.stringify(m.tokensByModel),
    cost_usd: m.costUsd,
    error: timedOut ? `timed out after ${opts.timeoutS}s` : error,
    network,
    model_id: initModel(messages),
    fixture_misses: proxy ? proxy.misses().length : null,
    proxy_json: proxy ? JSON.stringify(proxySummary(proxy)) : null,
  };
  return { outcome, grade };
}
