import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, copyTrials, insertRun, insertTrial, openDb, runTrials, trialEvents } from "../src/db.ts";

test("copyTrials copies only finished trials of the given arms/tasks/models, with transcripts", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "arena-db-")), "arena.db"));
  for (const id of ["src", "dst"]) insertRun(db, { id, pack_name: "p", pack_dir: "/p", pack_version: "0", axi_version: null, config_json: "{}" });
  const add = (id: string, arm: string, task: string, status: string) => {
    insertTrial(db, { id, run_id: "src", task_id: task, arm, model: "m", trial_index: 0 });
    db.prepare(`UPDATE trials SET status = ?, tool_tokens = 42 WHERE id = ?`).run(status, id);
    appendEvent(db, id, 0, "result", { type: "result", id });
  };
  add("a1", "axi", "t1", "success");
  add("w1", "webfetch", "t1", "success");
  add("w2", "webfetch", "t2", "success");
  add("w3", "webfetch", "t1", "cancelled");
  assert.equal(copyTrials(db, "src", "dst", { arms: ["webfetch"], tasks: ["t1"], models: ["m"] }), 1);
  const [copied] = runTrials(db, "dst");
  assert.equal(copied!.id, "w1@dst");
  assert.equal(copied!.tool_tokens, 42);
  assert.deepEqual(trialEvents(db, "w1@dst"), [{ type: "result", id: "w1" }]);
});
