import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPack, PackError } from "../src/pack.ts";
import { planTrials } from "../src/runner.ts";

function makePack(manifest: string, tasks: Record<string, string> = {}, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "arena-pack-"));
  writeFileSync(join(dir, "arena.yaml"), manifest);
  mkdirSync(join(dir, "tasks"));
  for (const [f, body] of Object.entries(tasks)) writeFileSync(join(dir, "tasks", f), body);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  return dir;
}

const ARMS = `
arms:
  axi: { tools: [Bash], allow: ["Bash(x:*)"] }
  native: { tools: [WebFetch], allow: [WebFetch] }
`;
const TASK = `id: t1\nprompt: hi\nchecks: [{ type: contains, value: x }]\n`;

test("loads a minimal pack and applies defaults", () => {
  const p = loadPack(makePack(`name: demo\n${ARMS}`, { "t1.yaml": TASK }));
  assert.equal(p.name, "demo");
  assert.equal(p.defaults.trials, 3);
  assert.equal(p.defaults.effort, "medium");
  assert.deepEqual(p.scoring.weights, { tokens: 0.4, turns: 0.2, time: 0.2, errors: 0.2 });
  assert.equal(p.tasks[0].checks[0].type, "contains");
});

test("rejects packs without an axi arm or without a baseline", () => {
  assert.throws(() => loadPack(makePack(`name: d\narms:\n  native: { tools: [WebFetch] }\n  other: { tools: [Bash] }\n`, { "t.yaml": TASK })), PackError);
  assert.throws(() => loadPack(makePack(`name: d\narms:\n  axi: { tools: [Bash] }\n`, { "t.yaml": TASK })), PackError);
});

test("rejects missing referenced files, skills without SKILL.md, duplicate ids, no tasks", () => {
  assert.throws(() => loadPack(makePack(`name: d\nsetup: scripts/nope.sh\n${ARMS}`, { "t.yaml": TASK })), /setup: scripts\/nope.sh does not exist/);
  assert.throws(
    () => loadPack(makePack(`name: d\narms:\n  axi: { tools: [Bash], skills: [skills/s] }\n  n: { tools: [WebFetch] }\n`, { "t.yaml": TASK }, { "skills/s/README.md": "" })),
    /has no SKILL.md/,
  );
  assert.throws(() => loadPack(makePack(`name: d\n${ARMS}`, { "a.yaml": TASK, "b.yaml": TASK })), /duplicate task id/);
  assert.throws(() => loadPack(makePack(`name: d\n${ARMS}`)), /no tasks/);
});

test("rejects unknown check types with a readable error", () => {
  assert.throws(() => loadPack(makePack(`name: d\n${ARMS}`, { "t.yaml": `id: t1\nprompt: hi\nchecks: [{ type: vibes }]\n` })), PackError);
});

test("planTrials interleaves arms so each match's arms run close together", () => {
  const p = loadPack(makePack(`name: demo\n${ARMS}`, { "t1.yaml": TASK }));
  const plan = planTrials({ models: ["m"], trials: 2, arms: ["axi", "native"], tasks: p.tasks });
  assert.deepEqual(plan.map((t) => `${t.arm}#${t.index}`), ["axi#0", "native#0", "axi#1", "native#1"]);
  assert.equal(new Set(plan.map((t) => t.id)).size, plan.length);
});
