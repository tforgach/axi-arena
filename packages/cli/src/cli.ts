#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import {
  PackError, baselineArms, executeRun, historicalTokens, listRuns, loadPack, median, openDb, planTrials, runTrials,
  type Effort, type Pack, type RunOptions, type TrialRow,
} from "@axi-arena/core";

const USAGE = `axi-arena — benchmark an AXI against its native counterpart

Usage:
  axi-arena run <pack> [flags]       Run trials and store results
  axi-arena estimate <pack> [flags]  Show what a run would do, without running it
  axi-arena validate <pack>          Check a pack's manifest, tasks and scripts
  axi-arena list                     Recent runs
  axi-arena show <run-id>            Summary table for a run

Run flags:
  --models a,b         Models to run (default: pack defaults.models)
  --trials N           Trials per task per arm per model (default: pack defaults.trials)
  --tasks glob         Only tasks whose id matches (e.g. 'wiki-*')
  --tags t1,t2         Only tasks with any of these tags
  --arms axi,x         Arms to run (default: all; must include axi and a baseline)
  --concurrency N      Parallel trials (default 4)
  --effort level       low|medium|high|xhigh|max (default: pack defaults.effort)
  --keep               Keep trial working dirs for debugging
  --yes, -y            Skip the confirmation prompt
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
    keep: { type: "boolean", default: false },
    yes: { type: "boolean", short: "y", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [cmd, target] = positionals;
const list = (s?: string) => s?.split(",").map((x) => x.trim()).filter(Boolean);
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
const fmt = (n: number | null | undefined, digits = 0) =>
  n == null ? "–" : n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });

function die(msg: string, code = 1): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

function requirePack(): Pack {
  if (!target) die("missing <pack> path", 2);
  try {
    return loadPack(target);
  } catch (e) {
    if (e instanceof PackError) die(e.message, 2);
    throw e;
  }
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

  const int = (s: string | undefined, dflt: number, name: string) => {
    if (s == null) return dflt;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1) die(`--${name} must be a positive integer`, 2);
    return n;
  };

  return {
    models: list(flags.models) ?? pack.defaults.models,
    trials: int(flags.trials, pack.defaults.trials, "trials"),
    arms,
    tasks,
    concurrency: int(flags.concurrency, 4, "concurrency"),
    effort,
    maxTurns: pack.defaults.max_turns,
    timeoutS: pack.defaults.timeout_s,
    keep: flags.keep ?? false,
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
  if (known > 0) {
    const projected = (tokens / known) * planned.length;
    console.log(`tokens    ~${fmt(projected)} (from ${known}/${planned.length} trials with history)`);
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

function printSummary(trials: TrialRow[], armOrder: string[]): void {
  const groups = new Map<string, TrialRow[]>();
  for (const t of trials) {
    const k = `${t.model}\u0000${t.task_id}\u0000${t.arm}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const rows: string[][] = [["model", "task", "arm", "ok", "tokens", "turns", "time s", "tools", "errors", "escapes"]];
  const keys = [...groups.keys()].sort((a, b) => {
    const [ma, ta, aa] = a.split("\u0000");
    const [mb, tb, ab] = b.split("\u0000");
    return ma.localeCompare(mb) || ta.localeCompare(tb) || armOrder.indexOf(aa) - armOrder.indexOf(ab);
  });
  for (const k of keys) {
    const g = groups.get(k)!;
    const [model, task, arm] = k.split("\u0000");
    const done = g.filter((t) => t.tokens_total != null);
    const med = (f: (t: TrialRow) => number | null) => median(done.map(f).filter((x): x is number => x != null));
    rows.push([
      model, task, arm,
      `${g.filter((t) => t.status === "success").length}/${g.length}`,
      fmt(med((t) => t.tokens_total)),
      fmt(med((t) => t.num_turns), 1),
      fmt((med((t) => t.duration_ms) ?? NaN) / 1000, 1).replace("NaN", "–"),
      fmt(med((t) => t.tool_calls), 1),
      fmt(med((t) => t.tool_errors), 1),
      fmt(med((t) => t.escape_attempts), 1),
    ]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const numeric = new Set([3, 4, 5, 6, 7, 8, 9]);
  for (const [i, r] of rows.entries()) {
    console.log(r.map((c, j) => (numeric.has(j) ? c.padStart(widths[j]) : c.padEnd(widths[j]))).join("  "));
    if (i === 0) console.log(widths.map((w) => "─".repeat(w)).join("  "));
  }
  console.log("\nmedians per group · correctness and Arena Score arrive in M2");
}

async function cmdRun(): Promise<void> {
  const pack = requirePack();
  const opts = resolveOptions(pack);
  printEstimate(pack, opts);
  if (!(await confirm("\nStart run?"))) die("aborted", 1);

  const db = openDb();
  const ac = new AbortController();
  process.once("SIGINT", () => {
    process.stderr.write("\ninterrupt — stopping after in-flight trials (Ctrl-C again to force)\n");
    ac.abort();
    process.once("SIGINT", () => process.exit(130));
  });

  let done = 0;
  let total = 0;
  const runId = await executeRun(db, pack, opts, {
    onRunStart: (id, planned) => {
      total = planned.length;
      console.log(`\nrun ${id}\n`);
    },
    onTrialEnd: (t, o) => {
      done++;
      const mark = o.status === "success" ? "✓" : "✗";
      const extra = o.status === "success" ? "" : `  [${o.status}${o.error ? `: ${o.error}` : ""}]`;
      const esc = o.escape_attempts ? `  ${o.escape_attempts} escape(s)` : "";
      console.log(
        `[${String(done).padStart(String(total).length)}/${total}] ${mark} ${t.task.id} · ${t.arm} · ${t.model} #${t.index}` +
          `  ${fmt(o.tokens_total)} tok  ${o.num_turns ?? "–"} turns  ${fmt((o.duration_ms ?? 0) / 1000, 1)}s${esc}${extra}`,
      );
    },
    onLog: (l) => console.log(l.split("\n").map((x) => `  │ ${x}`).join("\n")),
  }, ac.signal);

  console.log("");
  printSummary(runTrials(db, runId), opts.arms);
  console.log(`\nrun id: ${runId}`);
}

function cmdValidate(): void {
  const pack = requirePack();
  console.log(`✓ ${pack.name} ${pack.version}`);
  console.log(`  arms: axi vs ${baselineArms(pack).join(", ")}`);
  console.log(`  tasks: ${pack.tasks.length} (${pack.tasks.map((t) => t.id).join(", ")})`);
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

function cmdShow(): void {
  if (!target) die("missing <run-id>", 2);
  const db = openDb();
  const trials = runTrials(db, target);
  if (trials.length === 0) die(`no trials for run ${target}`, 1);
  const arms = [...new Set(trials.map((t) => t.arm))].sort((a, b) => (a === "axi" ? -1 : b === "axi" ? 1 : a.localeCompare(b)));
  printSummary(trials, arms);
}

if (flags.help || !cmd) {
  process.stdout.write(USAGE);
  process.exit(cmd ? 0 : 2);
}

switch (cmd) {
  case "run": await cmdRun(); break;
  case "estimate": printEstimate(requirePack(), resolveOptions(requirePack())); break;
  case "validate": cmdValidate(); break;
  case "list": cmdList(); break;
  case "show": cmdShow(); break;
  default: die(`unknown command "${cmd}"\n\n${USAGE}`, 2);
}
