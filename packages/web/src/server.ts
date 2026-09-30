// Local web app: JSON API + SSE over the arena SQLite DB, plus the built UI (SPEC §11).
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ManifestSchema, callCosts, commandLabel, computeScoreboard, median, requestCancel, getRun, getTrial, listRuns, openDb, packRuns, runTrials, transcriptItems,
  trialEventsSince, type Db, type RunRow, type ScoringConfig, type TrialRow,
} from "@axi-arena/core";

export const DEFAULT_PORT = 4477;
const UI_DIR = resolve(import.meta.dirname, "..", "dist");

const parse = <T>(s: string | null): T | null => (s ? (JSON.parse(s) as T) : null);

/** What executeRun stores in runs.config_json (older runs may lack newer fields). */
interface StoredRunConfig {
  models: string[];
  trials: number;
  arms: string[];
  tasks: string[];
  effort: string;
  concurrency: number;
  maxTurns: number;
  timeoutS: number;
  judgeModel?: string;
  useJudge?: boolean;
  scoring: ScoringConfig;
}

function runConfig(run: RunRow): StoredRunConfig {
  const cfg = JSON.parse(run.config_json) as Partial<StoredRunConfig>;
  return { ...(cfg as StoredRunConfig), scoring: cfg.scoring ?? ManifestSchema.shape.scoring.parse({}) };
}

function trialSummary(t: TrialRow) {
  const { tokens_json, checks_json, judgment_json, proxy_json, ...rest } = t;
  return { ...rest, tokens: parse(tokens_json), checks: parse(checks_json), judgment: parse(judgment_json), proxy: parse(proxy_json) };
}

function progress(trials: TrialRow[]) {
  const done = trials.filter((t) => !["queued", "running"].includes(t.status)).length;
  return { total: trials.length, done, running: trials.filter((t) => t.status === "running").length };
}

function runPayload(db: Db, run: RunRow) {
  const trials = runTrials(db, run.id);
  const config = runConfig(run);
  return {
    run: { ...run, config_json: undefined, config },
    progress: progress(trials),
    scoreboard: computeScoreboard(trials, config.scoring),
    trials: trials.map(trialSummary),
  };
}

function runListItem(db: Db, run: RunRow) {
  const trials = runTrials(db, run.id);
  const config = runConfig(run);
  const board = computeScoreboard(trials, config.scoring, 500);
  return {
    id: run.id,
    pack_name: run.pack_name,
    axi_version: run.axi_version,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    models: config.models ?? [],
    effort: config.effort,
    progress: progress(trials),
    overall: board.overall ?? board.byModel[0] ?? null,
  };
}

function trialEvents(db: Db, trialId: string) {
  return trialEventsSince(db, trialId, -1).map((e) => ({ seq: e.seq, msg: JSON.parse(e.json) as SDKMessage }));
}

function trialPayload(db: Db, t: TrialRow) {
  const events = trialEvents(db, t.id);
  return {
    trial: trialSummary(t),
    items: transcriptItems(events),
    costs: callCosts(events.map((e) => e.msg)),
    lastSeq: events.at(-1)?.seq ?? -1,
  };
}

/** Where each arm's tokens went in one match: base context, then per command (measured). */
function commandBreakdown(db: Db, trials: TrialRow[]) {
  const arms = new Map<string, { base: number[]; final: number[]; calls: Map<string, { context: number[]; side: number[]; perTrial: number[] }> }>();
  const byArm = new Map<string, TrialRow[]>();
  for (const t of trials) byArm.set(t.arm, [...(byArm.get(t.arm) ?? []), t]);
  for (const [arm, ts] of byArm) {
    const acc = { base: [] as number[], final: [] as number[], calls: new Map<string, { context: number[]; side: number[]; perTrial: number[] }>() };
    for (const t of ts) {
      const msgs = trialEvents(db, t.id).map((e) => e.msg);
      const costs = callCosts(msgs);
      if (costs.baseContext != null) acc.base.push(costs.baseContext);
      if (costs.finalContext != null) acc.final.push(costs.finalContext);
      const seen = new Map<string, number>();
      for (const it of transcriptItems(msgs.map((msg, seq) => ({ seq, msg })))) {
        if (it.kind !== "tool_call") continue;
        const label = commandLabel(it.name, it.input);
        const c = costs.calls[it.id];
        const slot = acc.calls.get(label) ?? { context: [], side: [], perTrial: [] };
        if (c?.contextTokens != null) slot.context.push(c.contextTokens);
        if (c?.sideTokens) slot.side.push(c.sideTokens);
        acc.calls.set(label, slot);
        seen.set(label, (seen.get(label) ?? 0) + 1);
      }
      for (const [label, slot] of acc.calls) slot.perTrial.push(seen.get(label) ?? 0);
    }
    arms.set(arm, acc);
  }
  return Object.fromEntries(
    [...arms].map(([arm, a]) => [
      arm,
      {
        trials: byArm.get(arm)!.length,
        baseContext: median(a.base),
        finalContext: median(a.final),
        commands: [...a.calls].map(([label, s]) => ({
          label,
          callsPerTrial: s.perTrial.reduce((x, y) => x + y, 0) / byArm.get(arm)!.length,
          contextTokens: median(s.context),
          sideTokens: median(s.side),
        })).sort((x, y) => (y.contextTokens ?? 0) * y.callsPerTrial - (x.contextTokens ?? 0) * x.callsPerTrial),
      },
    ]),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isLive = (status: string) => status === "queued" || status === "running";

export function createApp(db: Db = openDb()): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/runs", (c) => c.json(listRuns(db, 100).map((r) => runListItem(db, r))));

  app.get("/api/runs/:id", (c) => {
    const run = getRun(db, c.req.param("id"));
    return run ? c.json(runPayload(db, run)) : c.json({ error: "run not found" }, 404);
  });

  // Pushes a fresh run payload whenever trial state changes, until the run finishes.
  app.get("/api/runs/:id/stream", (c) =>
    streamSSE(c, async (stream) => {
      let last = "";
      let aborted = false;
      stream.onAbort(() => { aborted = true; });
      while (!aborted) {
        const run = getRun(db, c.req.param("id"));
        if (!run) { await stream.writeSSE({ event: "error", data: "run not found" }); return; }
        const payload = runPayload(db, run);
        const key = JSON.stringify([run.status, payload.trials.map((t) => [t.status, t.correctness])]);
        if (key !== last) {
          last = key;
          await stream.writeSSE({ event: "run", data: JSON.stringify(payload) });
        }
        if (run.status !== "running") { await stream.writeSSE({ event: "end", data: run.status }); return; }
        await sleep(1000);
      }
    }),
  );

  // Cancel a running run. The CLI process running it polls the flag and stops in-flight trials.
  // A custom header is required so a cross-site form/fetch can't trigger it (no CORS is served).
  app.post("/api/runs/:id/cancel", (c) => {
    if (c.req.header("x-axi-arena") !== "1") return c.json({ error: "missing x-axi-arena header" }, 403);
    const run = getRun(db, c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    if (!requestCancel(db, run.id)) return c.json({ error: `run is ${run.status}, not running` }, 409);
    return c.json({ ok: true });
  });

  app.get("/api/runs/:id/commands", (c) => {
    const task = c.req.query("task");
    const model = c.req.query("model");
    const trials = runTrials(db, c.req.param("id")).filter((t) => t.task_id === task && t.model === model && !isLive(t.status));
    return c.json(commandBreakdown(db, trials));
  });

  app.get("/api/trials/:id", (c) => {
    const t = getTrial(db, c.req.param("id"));
    return t ? c.json(trialPayload(db, t)) : c.json({ error: "trial not found" }, 404);
  });

  // Streams new transcript items as the agent works, then the final graded trial.
  app.get("/api/trials/:id/stream", (c) =>
    streamSSE(c, async (stream) => {
      const id = c.req.param("id");
      let lastSeq = Number(c.req.query("after") ?? -1);
      let lastTrial = "";
      let aborted = false;
      stream.onAbort(() => { aborted = true; });
      while (!aborted) {
        const t = getTrial(db, id);
        if (!t) { await stream.writeSSE({ event: "error", data: "trial not found" }); return; }
        const events = trialEventsSince(db, id, lastSeq).map((e) => ({ seq: e.seq, msg: JSON.parse(e.json) as SDKMessage }));
        if (events.length) {
          lastSeq = events.at(-1)!.seq;
          // Costs need the next API call to measure, so they're recomputed over the whole stream.
          const costs = callCosts(trialEvents(db, id).map((e) => e.msg));
          await stream.writeSSE({ event: "items", data: JSON.stringify({ items: transcriptItems(events), lastSeq, costs }) });
        }
        const summary = JSON.stringify(trialSummary(t));
        if (summary !== lastTrial) {
          lastTrial = summary;
          await stream.writeSSE({ event: "trial", data: summary });
        }
        // Grading lands just after the status flips, so wait for correctness before ending.
        const graded = t.correctness != null || t.judgment_json != null || t.status === "setup_error";
        if (!isLive(t.status) && (graded || getRun(db, t.run_id)?.status !== "running")) {
          await stream.writeSSE({ event: "end", data: t.status });
          return;
        }
        await sleep(500);
      }
    }),
  );

  app.get("/api/packs/:name/history", (c) => {
    const runs = packRuns(db, c.req.param("name")).filter((r) => r.status !== "running");
    return c.json(
      runs.map((r) => {
        const config = runConfig(r);
        const board = computeScoreboard(runTrials(db, r.id), config.scoring, 500);
        return {
          id: r.id, started_at: r.started_at, axi_version: r.axi_version, status: r.status,
          effort: config.effort, models: config.models, trials: config.trials,
          byModel: board.byModel, overall: board.overall,
        };
      }),
    );
  });

  app.get("/api/*", (c) => c.json({ error: "not found" }, 404));

  // Built UI. Anything that isn't a file falls back to index.html (hash routing).
  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
    ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
  };
  app.get("*", (c) => {
    const index = join(UI_DIR, "index.html");
    if (!existsSync(index)) return c.text("UI not built. Run: npm run build", 503);
    const rel = normalize(decodeURIComponent(c.req.path)).replace(/^([/\\])+/, "");
    const file = resolve(UI_DIR, rel);
    const target = file.startsWith(UI_DIR + "/") && existsSync(file) && statSync(file).isFile() ? file : index;
    return c.body(readFileSync(target), 200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
  });

  return app;
}

export function startServer(port = DEFAULT_PORT, host = "127.0.0.1"): Promise<AddressInfo> {
  const app = createApp();
  return new Promise((resolveStart) => {
    serve({ fetch: app.fetch, port, hostname: host }, (info) => resolveStart(info));
  });
}

export async function serverRunning(port = DEFAULT_PORT): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}
