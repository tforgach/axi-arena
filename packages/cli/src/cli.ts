#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import {
  FixtureStore, ManifestSchema, PackError, baselineArms, fixtureDir, taskNetwork,
  configPath, loadConfig, preflight, resolveAuth, resolveModel, type ArenaConfig, type AuthSetup, computeScoreboard, executeRun, getRun, historicalTokens, listRuns, loadPack,
  median, openDb, planTrials, rescoreRun, runTrials,
  type Db, type Effort, type Match, type Network, type Pack, type RunOptions, type ScoringConfig, type TrialRow,
} from "@axi-arena/core";
import { DEFAULT_PORT, serverRunning, startServer } from "@axi-arena/web";

const USAGE = `axi-arena — benchmark an AXI against its native counterpart

Usage:
  axi-arena run <pack> [flags]       Run trials, grade them, print the Arena Score
  axi-arena record <pack> [flags]    Record network fixtures: 1 trial per arm, fetches and saves what's missing
  axi-arena estimate <pack> [flags]  Show what a run would do, without running it
  axi-arena validate <pack>          Check a pack's manifest, tasks and scripts
  axi-arena list                     Recent runs
  axi-arena show <run-id> [--detail] Scoreboard for a run (--detail adds per-arm metrics)
  axi-arena rescore <run-id>         Re-grade a run from stored transcripts (no agent re-run;
                                     --metrics-only recomputes derived metrics without judging)
  axi-arena serve [--port N]         Web app: live trials, scoreboards, history (default port ${DEFAULT_PORT})
  axi-arena preflight [--models a,b] Check credentials + model access without running anything

Run flags:
  --models a,b         Models to run (default: pack defaults.models)
  --trials N           Trials per task per arm per model (default: pack defaults.trials)
  --tasks glob         Only tasks whose id matches (e.g. 'wiki-*')
  --tags t1,t2         Only tasks with any of these tags
  --arms axi,x         Arms to run (default: all; must include axi and a baseline)
  --concurrency N      Parallel trials (default 4)
  --effort level       low|medium|high|xhigh|max (default: pack defaults.effort)
  --network mode       replay|record|live for every task (default: per task / pack defaults.network)
  --keep               Keep trial working dirs for debugging
  --skip-preflight     Don't check credentials/models before running
  --yes, -y            Skip the confirmation prompt

Packs can be a path or a name registered under \`packs:\` in ~/.axi-arena/config.yaml, which
also holds credentials (apiKeyHelper, provider env) and model aliases; see SPEC §4.4.

Grading flags (run, rescore):
  --judge-model id     Judge model (default: pack defaults.judge_model)
  --no-judge           Deterministic checks only
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    models: { type: "string" },
    trials: { type: "string" },
    tasks: { type: "string" },
    tags: { type: "string" },
    arms: { type: "string" },
    concurrency: { type: "string" },
    effort: { type: "string" },
    "judge-model": { type: "string" },
    "no-judge": { type: "boolean", default: false },
    "skip-preflight": { type: "boolean", default: false },
    "metrics-only": { type: "boolean", default: false },
    detail: { type: "boolean", default: false },
    port: { type: "string" },
    network: { type: "string" },
    keep: { type: "boolean", default: false },
    yes: { type: "boolean", short: "y", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [cmd, target] = positionals;
const list = (s?: string) => s?.split(",").map((x) => x.trim()).filter(Boolean);
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
const fmt = (n: number | null | undefined, digits = 0) =>
  n == null || Number.isNaN(n) ? "–" : n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const signed = (x: number) => `${x >= 0 ? "+" : "−"}${fmt(Math.abs(x * 100), 1)}`;
const pct = (x: number) => `${fmt(x * 100, 0)}%`;

function die(msg: string, code = 1): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

let configCache: ArenaConfig | null = null;
function config(): ArenaConfig {
  if (configCache) return configCache;
  try {
    return (configCache = loadConfig());
  } catch (e) {
    die(e instanceof Error ? e.message : String(e), 2);
  }
}
let authCache: AuthSetup | null = null;
const auth = () => (authCache ??= resolveAuth(config()));

function requirePack(path = target): Pack {
  if (!path) die("missing <pack> path", 2);
  // A registered pack name (config `packs:`) or a path.
  const registered = config().packs[path];
  if (registered && !existsSync(join(path, "arena.yaml"))) path = registered.replace(/^~(?=\/)/, process.env.HOME ?? "~");
  try {
    return loadPack(path);
  } catch (e) {
    if (e instanceof PackError) die(e.message, 2);
    throw e;
  }
}

function positiveInt(s: string | undefined, dflt: number, name: string): number {
  if (s == null) return dflt;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) die(`--${name} must be a positive integer`, 2);
  return n;
}

function resolveOptions(pack: Pack): RunOptions {
  const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  const effort = (flags.effort ?? pack.defaults.effort) as Effort;
  if (!EFFORTS.includes(effort)) die(`--effort must be one of ${EFFORTS.join(", ")}`, 2);

  const arms = list(flags.arms) ?? Object.keys(pack.arms);
  for (const a of arms) if (!(a in pack.arms)) die(`unknown arm "${a}" (pack has: ${Object.keys(pack.arms).join(", ")})`, 2);
  if (!arms.includes("axi") || arms.length < 2) die("--arms must include axi and at least one baseline", 2);

  let tasks = pack.tasks;
  if (flags.tasks) tasks = tasks.filter((t) => globRe(flags.tasks!).test(t.id));
  const tags = list(flags.tags);
  if (tags) tasks = tasks.filter((t) => t.tags.some((x) => tags.includes(x)));
  if (tasks.length === 0) die("no tasks match the filters", 2);

  const NETWORKS = ["replay", "record", "live"];
  if (flags.network && !NETWORKS.includes(flags.network)) die(`--network must be one of ${NETWORKS.join(", ")}`, 2);

  return {
    config: config(),
    auth: auth(),
    network: flags.network as Network | undefined,
    models: list(flags.models) ?? pack.defaults.models,
    trials: positiveInt(flags.trials, pack.defaults.trials, "trials"),
    arms,
    tasks,
    concurrency: positiveInt(flags.concurrency, 4, "concurrency"),
    effort,
    maxTurns: pack.defaults.max_turns,
    timeoutS: pack.defaults.timeout_s,
    keep: flags.keep ?? false,
    judgeModel: flags["judge-model"] ?? pack.defaults.judge_model,
    useJudge: !flags["no-judge"],
  };
}

function printEstimate(pack: Pack, opts: RunOptions): void {
  const planned = planTrials(opts);
  const hist = historicalTokens(openDb(), pack.name);
  let known = 0;
  let tokens = 0;
  for (const t of planned) {
    const avg = hist.get(`${t.task.id}|${t.arm}|${t.model}`);
    if (avg != null) { known++; tokens += avg; }
  }
  console.log(`pack      ${pack.name} (${pack.dir})`);
  console.log(`tasks     ${opts.tasks.length}  ·  arms ${opts.arms.join(", ")}  ·  models ${opts.models.join(", ")}`);
  console.log(`trials    ${planned.length}  (${opts.tasks.length} tasks × ${opts.arms.length} arms × ${opts.models.length} models × ${opts.trials})`);
  console.log(`effort    ${opts.effort}  ·  concurrency ${opts.concurrency}  ·  max turns ${opts.maxTurns}  ·  timeout ${opts.timeoutS}s`);
  console.log(`judge     ${opts.useJudge ? opts.judgeModel : "off (checks only)"}`);
  const a = opts.auth ?? auth();
  console.log(`auth      ${a.provider} · ${a.sources.join(" · ")}`);
  const modes = new Map<string, string[]>();
  for (const t of opts.tasks) {
    const n = taskNetwork(pack, t, opts);
    modes.set(n, [...(modes.get(n) ?? []), t.id]);
  }
  console.log(`network   ${[...modes].map(([n, ids]) => `${n} (${ids.length})`).join(", ")}`);
  const bare = opts.tasks.filter((t) => taskNetwork(pack, t, opts) === "replay" && new FixtureStore(fixtureDir(pack, t.id)).count() === 0);
  if (bare.length) console.log(`          ⚠ replay tasks with no fixtures (every request will miss): ${bare.map((t) => t.id).join(", ")} — run \`axi-arena record\` first`);
  if (known > 0) {
    console.log(`tokens    ~${fmt((tokens / known) * planned.length)} cost-weighted, excl. judge (from ${known}/${planned.length} trials with history)`);
  } else {
    console.log(`tokens    unknown — no previous runs of this pack`);
  }
}

async function confirm(q: string): Promise<boolean> {
  if (flags.yes) return true;
  if (!process.stdin.isTTY) die("not a TTY; pass --yes to run without confirmation", 2);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${q} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

function printTable(rows: string[][], numericCols: Set<number>): void {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const [i, r] of rows.entries()) {
    console.log(r.map((c, j) => (numericCols.has(j) ? c.padStart(widths[j]) : c.padEnd(widths[j]))).join("  ").trimEnd());
    if (i === 0) console.log(widths.map((w) => "─".repeat(w)).join("  "));
  }
}

/** Per-arm metric medians — the raw material behind the scoreboard. */
function printDetail(trials: TrialRow[], armOrder: string[]): void {
  const groups = new Map<string, TrialRow[]>();
  for (const t of trials) {
    const k = `${t.model}\u0000${t.task_id}\u0000${t.arm}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const rows: string[][] = [["model", "task", "arm", "n", "correct", "w-tokens", "tool tok", "raw tokens", "turns", "time s", "tools", "errors", "escapes"]];
  const keys = [...groups.keys()].sort((a, b) => {
    const [ma, ta, aa] = a.split("\u0000");
    const [mb, tb, ab] = b.split("\u0000");
    return ma.localeCompare(mb) || ta.localeCompare(tb) || armOrder.indexOf(aa) - armOrder.indexOf(ab);
  });
  for (const k of keys) {
    const g = groups.get(k)!;
    const [model, task, arm] = k.split("\u0000");
    const med = (f: (t: TrialRow) => number | null) => median(g.map(f).filter((x): x is number => x != null));
    const graded = g.filter((t) => t.correctness != null);
    rows.push([
      model, task, arm, String(g.length),
      graded.length ? pct(graded.reduce((s, t) => s + t.correctness!, 0) / graded.length) : "–",
      fmt(med((t) => t.tokens_weighted)),
      fmt(med((t) => t.tool_tokens)),
      fmt(med((t) => t.tokens_total)),
      fmt(med((t) => t.num_turns), 1),
      fmt((med((t) => t.duration_ms) ?? NaN) / 1000, 1),
      fmt(med((t) => t.tool_calls), 1),
      fmt(med((t) => t.tool_errors), 1),
      fmt(med((t) => t.escape_attempts), 1),
    ]);
  }
  printTable(rows, new Set([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  console.log("medians per arm · correct = mean correctness · w-tokens = cost-weighted (scored)");
}

function printScoreboard(trials: TrialRow[], scoring: ScoringConfig): void {
  const board = computeScoreboard(trials, scoring);
  if (board.matches.length === 0) return console.log("no gradable matches yet");

  const ciStr = (ci: [number, number] | null) => (ci ? `[${signed(ci[0])}, ${signed(ci[1])}]` : "–");
  const verdict = (m: { significant: boolean; ci: [number, number] | null }, gate = true) =>
    !gate ? "✗ gate" : m.ci == null ? "n<2" : m.significant ? "" : "n.s.";
  const delta = (axi: number, base: number) => (base > 0 ? `${axi <= base ? "−" : "+"}${fmt(Math.abs(1 - axi / base) * 100, 0)}%` : "–");

  const rows: string[][] = [["model", "task", "vs", "correct axi/base", "tool tok", "session", "turns", "time", "errors", "score", "95% CI", ""]];
  for (const m of board.matches as Match[]) {
    rows.push([
      m.model, m.task, m.baseline,
      `${pct(m.axi.correctness)} / ${pct(m.base.correctness)}`,
      delta(m.axi.toolTokens, m.base.toolTokens),
      delta(m.axi.sessionTokens, m.base.sessionTokens),
      delta(m.axi.turns, m.base.turns),
      delta(m.axi.time, m.base.time),
      `${fmt(m.axi.errors, 1)} / ${fmt(m.base.errors, 1)}`,
      signed(m.score),
      ciStr(m.ci),
      verdict(m, m.gatePassed),
    ]);
  }
  printTable(rows, new Set([3, 4, 5, 6, 7, 8, 9]));
  const metric = scoring.token_metric ?? "tool";
  console.log(
    `tool tok = what tool calls added to the context (+ side models) · session = whole session, cost-weighted · scored: ${metric === "tool" ? "tool tok" : "session"}\n` +
      "tokens/turns/time: AXI relative to baseline (− is better) · errors: median axi / base, incl. escapes · score includes the correctness bonus",
  );
  const missed = trials.filter((t) => (t.fixture_misses ?? 0) > 0);
  if (missed.length) {
    console.log(`⚠ ${missed.length} trial(s) hit requests with no fixture (answered 599), so those comparisons aren't fully reproducible. Fill the gaps with: axi-arena record <pack> --tasks ${[...new Set(missed.map((t) => t.task_id))].join(",")}`);
  }

  console.log("\nArena Score  (0 = parity with native, + = AXI better)");
  for (const a of [...board.byModel, ...(board.byModel.length > 1 && board.overall ? [board.overall] : [])]) {
    const gates = a.gateFailures ? `  ${a.gateFailures}/${a.matches} failed the correctness gate` : "";
    console.log(`  ${a.key.padEnd(24)} ${signed(a.score).padStart(7)}  ${ciStr(a.ci)}  ${verdict(a)}${gates}`);
  }
}

function runScoring(db: Db, runId: string): ScoringConfig {
  const run = getRun(db, runId);
  const stored = run ? (JSON.parse(run.config_json) as { scoring?: ScoringConfig }).scoring : undefined;
  return stored ?? ManifestSchema.shape.scoring.parse({});
}

async function cmdRun(): Promise<void> {
  const pack = requirePack();
  await runAndReport(pack, resolveOptions(pack), "Start run?");
}

async function runPreflight(models: string[]): Promise<boolean> {
  console.log(`\npreflight (1 tiny call per model)…`);
  const results = await preflight(models.map((m) => resolveModel(m, config())), auth());
  for (const r of results) {
    const via = r.apiKeySource && r.apiKeySource !== "none" ? ` via ${r.apiKeySource}` : "";
    console.log(
      r.ok
        ? `  ✓ ${r.model}${r.modelId && r.modelId !== r.model ? ` → ${r.modelId}` : ""}${via}  (${(r.ms / 1000).toFixed(1)}s)`
        : `  ✗ ${r.model}: ${r.error}`,
    );
  }
  return results.every((r) => r.ok);
}

async function runAndReport(pack: Pack, opts: RunOptions, question: string): Promise<void> {
  printEstimate(pack, opts);
  if (!flags["skip-preflight"]) {
    const models = [...opts.models, ...(opts.useJudge ? [opts.judgeModel] : [])];
    if (!(await runPreflight(models))) {
      die(`preflight failed; nothing was run. Check credentials (${configPath()}, ~/.claude/settings.json) or pass --skip-preflight`, 1);
    }
  }
  if (!(await confirm(`\n${question}`))) die("aborted", 1);

  const db = openDb();
  const ac = new AbortController();
  process.once("SIGINT", () => {
    process.stderr.write("\ninterrupt — stopping after in-flight trials (Ctrl-C again to force)\n");
    ac.abort();
    process.once("SIGINT", () => process.exit(130));
  });

  let done = 0;
  let total = 0;
  const port = positiveInt(flags.port, DEFAULT_PORT, "port");
  const webUp = await serverRunning(port);
  const runId = await executeRun(db, pack, opts, {
    onRunStart: (id, planned) => {
      total = planned.length;
      console.log(`\nrun ${id}`);
      console.log(
        webUp
          ? `watch live: http://127.0.0.1:${port}/#/runs/${id}\n`
          : `watch live: start \`axi-arena serve\` in another terminal, then open http://127.0.0.1:${port}/#/runs/${id}\n`,
      );
    },
    onTrialEnd: (t, o, g) => {
      done++;
      const c = g?.correctness;
      const mark = c == null ? "?" : c >= 0.5 ? "✓" : "✗";
      const status = o.status === "success" ? "" : `  [${o.status}${o.error ? `: ${o.error}` : ""}]`;
      const judgeErr = g?.judgment.source === "judge_error" ? `  [${g.judgment.reasoning}]` : "";
      const esc = o.escape_attempts ? `  ${o.escape_attempts} escape(s)` : "";
      const miss = o.fixture_misses ? `  ⚠ ${o.fixture_misses} fixture miss(es)` : "";
      console.log(
        `[${String(done).padStart(String(total).length)}/${total}] ${mark} ${t.task.id} · ${t.arm} · ${t.model} #${t.index}` +
          `  correct ${c == null ? "–" : pct(c)}  ${fmt(o.tokens_weighted)} w-tok  ${o.num_turns ?? "–"} turns  ${fmt((o.duration_ms ?? 0) / 1000, 1)}s${esc}${miss}${status}${judgeErr}`,
      );
    },
    onLog: (l) => console.log(l.split("\n").map((x) => `  │ ${x}`).join("\n")),
  }, ac.signal);

  const trials = runTrials(db, runId);
  console.log("");
  if (flags.detail) { printDetail(trials, opts.arms); console.log(""); }
  printScoreboard(trials, pack.scoring);
  console.log(`\nrun id: ${runId}  ·  details: axi-arena show ${runId} --detail`);
}

function cmdValidate(): void {
  const pack = requirePack();
  console.log(`✓ ${pack.name} ${pack.version}`);
  console.log(`  arms: axi vs ${baselineArms(pack).join(", ")}`);
  console.log(`  tasks: ${pack.tasks.length}`);
  for (const t of pack.tasks) {
    const net = taskNetwork(pack, t, {});
    let fixtures = "";
    if (net !== "live") {
      try {
        const n = new FixtureStore(fixtureDir(pack, t.id)).count();
        fixtures = n ? ` · ${n} fixture(s)` : net === "replay" ? " · ⚠ no fixtures — run `axi-arena record`" : " · no fixtures yet";
      } catch (e) {
        die(e instanceof Error ? e.message : String(e), 2);
      }
    }
    console.log(`    ${t.id.padEnd(28)} ${net}${fixtures}`);
  }
  const noChecks = pack.tasks.filter((t) => t.checks.length === 0 && !t.judge);
  if (noChecks.length) console.log(`  ⚠ tasks with no checks or judge: ${noChecks.map((t) => t.id).join(", ")}`);
}

function cmdList(): void {
  const runs = listRuns(openDb());
  if (runs.length === 0) return console.log("no runs yet");
  for (const r of runs) {
    console.log(`${r.id}  ${r.status.padEnd(7)}  ${r.pack_name}${r.axi_version ? ` (${r.axi_version})` : ""}  ${r.started_at}`);
  }
}

function runTrialsOrDie(db: Db): TrialRow[] {
  if (!target) die("missing <run-id>", 2);
  const trials = runTrials(db, target);
  if (trials.length === 0) die(`no trials for run ${target}`, 1);
  return trials;
}

function cmdShow(): void {
  const db = openDb();
  const trials = runTrialsOrDie(db);
  if (flags.detail) {
    const arms = [...new Set(trials.map((t) => t.arm))].sort((a, b) => (a === "axi" ? -1 : b === "axi" ? 1 : a.localeCompare(b)));
    printDetail(trials, arms);
    console.log("");
  }
  if (trials.every((t) => t.correctness == null)) console.log(`this run has not been graded — try: axi-arena rescore ${target}\n`);
  printScoreboard(trials, runScoring(db, target!));
}

async function cmdRecord(): Promise<void> {
  if (flags.network) die("record always uses --network record", 2);
  if (flags.trials) die("record runs 1 trial per arm; drop --trials", 2);
  flags.network = "record";
  flags.trials = "1";
  const pack = requirePack();
  const opts = resolveOptions(pack);
  // One model is enough to capture traffic; both arms run so each tool's requests are recorded.
  opts.models = list(flags.models) ?? [pack.defaults.models[0]];
  await runAndReport(pack, opts, "Record fixtures?");
  console.log(`\nfixtures saved under ${pack.dir}/fixtures/<task-id>/recorded/ — commit them with the pack, then run with network: replay`);
}

async function cmdServe(): Promise<void> {
  const port = positiveInt(flags.port, DEFAULT_PORT, "port");
  if (await serverRunning(port)) die(`something is already serving axi-arena on port ${port}`, 1);
  const info = await startServer(port);
  console.log(`axi-arena web app: http://127.0.0.1:${info.port}/  (Ctrl-C to stop)`);
}

async function cmdRescore(): Promise<void> {
  const db = openDb();
  runTrialsOrDie(db);
  const run = getRun(db, target!)!;
  if (!existsSync(join(run.pack_dir, "arena.yaml"))) die(`pack for this run is gone: ${run.pack_dir}`, 1);
  const pack = requirePack(run.pack_dir);
  const judgeModel = flags["judge-model"] ?? pack.defaults.judge_model;
  const useJudge = !flags["no-judge"];
  const metricsOnly = flags["metrics-only"] ?? false;
  console.log(`rescoring ${target} ${metricsOnly ? "(metrics only, grades unchanged)" : `with ${useJudge ? `judge ${judgeModel}` : "checks only"}`}\n`);
  const n = await rescoreRun(db, pack, target!, { judgeModel: resolveModel(judgeModel, config()), useJudge, auth: auth() }, (row, g) => {
    if (!g) return;
    const c = g.correctness;
    console.log(`${c == null ? "?" : c >= 0.5 ? "✓" : "✗"} ${row.task_id} · ${row.arm} · ${row.model} #${row.trial_index}  correct ${c == null ? "–" : pct(c)}  (${g.judgment.source})`);
  }, positiveInt(flags.concurrency, 4, "concurrency"), metricsOnly);
  console.log(`\nregraded ${n} trial(s)\n`);
  printScoreboard(runTrials(db, target!), runScoring(db, target!));
}

if (flags.help || !cmd) {
  process.stdout.write(USAGE);
  process.exit(cmd ? 0 : 2);
}

switch (cmd) {
  case "run": await cmdRun(); break;
  case "record": await cmdRecord(); break;
  case "estimate": { const p = requirePack(); printEstimate(p, resolveOptions(p)); break; }
  case "validate": cmdValidate(); break;
  case "list": cmdList(); break;
  case "show": cmdShow(); break;
  case "rescore": await cmdRescore(); break;
  case "serve": await cmdServe(); break;
  case "preflight": {
    const models = list(flags.models) ?? ["claude-haiku-4-5"];
    console.log(`auth: ${auth().provider} · ${auth().sources.join(" · ")}`);
    process.exit((await runPreflight(models)) ? 0 : 1);
  }
  default: die(`unknown command "${cmd}"\n\n${USAGE}`, 2);
}
