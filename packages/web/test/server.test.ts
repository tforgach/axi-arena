import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, finishRun, finishTrial, insertRun, insertTrial, openDb, setGrade, type TrialOutcome } from "@axi-arena/core";
import { createApp } from "../src/server.ts";

function seededApp() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "arena-web-")), "arena.db"));
  insertRun(db, {
    id: "r1", pack_name: "demo", pack_dir: "/tmp/demo", pack_version: "0.1.0", axi_version: "1.2.3",
    config_json: JSON.stringify({ models: ["m"], trials: 1, arms: ["axi", "native"], tasks: ["t"], effort: "medium" }),
  });
  const outcome = (tokens: number): TrialOutcome => ({
    status: "success", result_text: "answer", sdk_subtype: "success", num_turns: 2, tool_calls: 1, tool_errors: 0,
    error_recoveries: 0, escape_attempts: 0, duration_ms: 1000, duration_api_ms: 900, tokens_total: tokens,
    tokens_weighted: tokens, tokens_json: "{}", cost_usd: 0, error: null,
  });
  for (const [id, arm, tokens] of [["a", "axi", 500], ["b", "native", 1000]] as const) {
    insertTrial(db, { id, run_id: "r1", task_id: "t", arm, model: "m", trial_index: 0 });
    finishTrial(db, id, outcome(tokens));
    setGrade(db, id, 1, "[]", JSON.stringify({ correctness: 1, reasoning: "ok", source: "checks_only", judgeModel: null, judgeTokensWeighted: null }));
  }
  appendEvent(db, "a", 0, "assistant", { type: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "axi x" } }] } });
  appendEvent(db, "a", 1, "user", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", is_error: true, content: "arena lockdown: nope" }] } });
  finishRun(db, "r1", "done");
  return createApp(db);
}

test("runs list includes progress and the overall score", async () => {
  const runs = (await (await seededApp().request("/api/runs")).json()) as { id: string; progress: { done: number }; overall: { score: number } }[];
  assert.equal(runs[0].id, "r1");
  assert.equal(runs[0].progress.done, 2);
  assert.ok(runs[0].overall.score > 0, "axi used half the tokens");
});

test("run payload carries config with default scoring, scoreboard, and parsed trial fields", async () => {
  const run = (await (await seededApp().request("/api/runs/r1")).json()) as {
    run: { config: { scoring: { weights: { tokens: number } } } };
    scoreboard: { matches: unknown[] };
    trials: { judgment: { source: string } }[];
  };
  assert.equal(run.run.config.scoring.weights.tokens, 0.4);
  assert.equal(run.scoreboard.matches.length, 1);
  assert.equal(run.trials[0].judgment.source, "checks_only");
});

test("trial payload pairs calls with results and flags escapes", async () => {
  const t = (await (await seededApp().request("/api/trials/a")).json()) as { items: { kind: string; escape?: boolean }[]; lastSeq: number };
  assert.deepEqual(t.items.map((i) => i.kind), ["tool_call", "tool_result"]);
  assert.equal(t.items[1].escape, true);
  assert.equal(t.lastSeq, 1);
});

test("unknown ids 404; finished trial stream ends immediately", async () => {
  const app = seededApp();
  assert.equal((await app.request("/api/runs/nope")).status, 404);
  assert.equal((await app.request("/api/trials/nope")).status, 404);
  const body = await (await app.request("/api/trials/a/stream?after=-1")).text();
  assert.match(body, /event: items/);
  assert.match(body, /event: end/);
});
