import { test } from "node:test";
import assert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { runChecks, type CheckContext } from "../src/checks.ts";
import { judge } from "../src/judge.ts";
import { TaskSchema } from "../src/pack.ts";

const messages = [
  { type: "assistant", message: { content: [{ type: "tool_use", id: "s", name: "Skill", input: {} }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "curl" } }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "axi-fetch u" } }] } },
] as unknown as SDKMessage[];

const ctx = (answer: string | null, over: Partial<CheckContext> = {}): CheckContext => ({
  answer, messages, deniedIds: new Set(["x"]), escapeAttempts: 1, trialDir: null, arm: "axi", model: "m", ...over,
});

const task = (checks: unknown[], judge?: unknown) => TaskSchema.parse({ id: "t", prompt: "p", checks, judge });

test("text checks: equals, contains (case-insensitive by default), regex", () => {
  const r = runChecks(
    task([
      { type: "equals", value: "Example Domain" },
      { type: "contains", value: "example domain" },
      { type: "contains", value: "example domain", ignore_case: false },
      { type: "regex", pattern: "\\b18\\d\\d\\b" },
    ]),
    ctx(" Example Domain "),
  );
  assert.deepEqual(r.map((c) => c.passed), [true, true, false, false]);
});

test("json_path reads plain and fenced JSON answers", () => {
  const t = task([{ type: "json_path", path: "$.items[1].id", equals: 7 }]);
  assert.equal(runChecks(t, ctx('{"items":[{"id":1},{"id":7}]}'))[0].passed, true);
  assert.equal(runChecks(t, ctx('Here:\n```json\n{"items":[{"id":1},{"id":7}]}\n```'))[0].passed, true);
  assert.equal(runChecks(t, ctx("not json"))[0].passed, false);
});

test("tool_called ignores Skill loads and denied calls; no_escape counts escapes", () => {
  const r = runChecks(task([{ type: "tool_called", min: 1, max: 1 }, { type: "tool_called", min: 2 }, { type: "no_escape" }]), ctx("a"));
  assert.deepEqual(r.map((c) => c.passed), [true, false, false]);
});

test("script checks fail closed without a runner, and use the runner when given", () => {
  const t = task([{ type: "script", run: "scripts/check.sh" }]);
  assert.equal(runChecks(t, ctx("a"))[0].passed, false);
  assert.equal(runChecks(t, ctx("a"), () => ({ passed: true, detail: "ok" }))[0].passed, true);
});

test("judge short-circuits without calling a model: no answer, failed required check, no rubric", async () => {
  const t = task([{ type: "contains", value: "1804", required: true }, { type: "contains", value: "Paris" }], { rubric: "r" });
  const opts = { messages, judgeModel: "never-called", useJudge: true };

  const none = await judge({ task: t, answer: null, checks: [], ...opts });
  assert.deepEqual([none.correctness, none.source], [0, "no_answer"]);

  const checks = runChecks(t, ctx("1805 in Paris"));
  const req = await judge({ task: t, answer: "1805 in Paris", checks, ...opts });
  assert.deepEqual([req.correctness, req.source], [0, "required_check"]);

  const noRubric = task([{ type: "contains", value: "a" }, { type: "contains", value: "zzz" }]);
  const fallback = await judge({ task: noRubric, answer: "a", checks: runChecks(noRubric, ctx("a")), ...opts });
  assert.deepEqual([fallback.correctness, fallback.source], [0.5, "checks_only"]);

  const off = await judge({ task: t, answer: "1804 in Paris", checks: runChecks(t, ctx("1804 in Paris")), ...opts, useJudge: false });
  assert.deepEqual([off.correctness, off.source], [1, "checks_only"]);
});
