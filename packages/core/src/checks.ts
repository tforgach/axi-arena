// Deterministic checks (SPEC §5.3). They run before the judge and are handed to it as evidence.
import { spawnSync } from "node:child_process";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { packPath, type Check, type Pack, type Task } from "./pack.ts";

export interface CheckResult {
  index: number;
  type: Check["type"];
  required: boolean;
  passed: boolean;
  detail: string;
}

export interface CheckContext {
  answer: string | null;
  messages: SDKMessage[];
  /** tool_use ids that were denied (escapes). */
  deniedIds: Set<string>;
  escapeAttempts: number;
  trialDir: string | null;
  arm: string;
  model: string;
}

/** Tool calls that actually ran as this arm's own tools: not denied, not skill loading. */
export function effectiveToolCalls(messages: SDKMessage[], deniedIds: Set<string>): { name: string; id: string }[] {
  const calls: { name: string; id: string }[] = [];
  for (const m of messages) {
    if (m.type !== "assistant") continue;
    for (const b of m.message.content) {
      if (b.type === "tool_use" && b.name !== "Skill" && !deniedIds.has(b.id)) calls.push({ name: b.name, id: b.id });
    }
  }
  return calls;
}

function jsonPath(value: unknown, path: string): unknown {
  let cur = value;
  for (const part of path.replace(/^\$\.?/, "").split(".").filter(Boolean)) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) return undefined;
    if (m[1]) cur = (cur as Record<string, unknown> | undefined)?.[m[1]];
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) cur = (cur as unknown[] | undefined)?.[Number(idx[1])];
  }
  return cur;
}

function parseJsonAnswer(answer: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(answer);
  return JSON.parse((fenced ? fenced[1] : answer).trim());
}

export type ScriptRunner = (check: Extract<Check, { type: "script" }>, ctx: CheckContext) => { passed: boolean; detail: string };

/** Runs a pack's check script: JSON context on stdin, exit 0 means pass. */
export function scriptRunner(pack: Pack, task: Task): ScriptRunner {
  return (check, ctx) => {
    const res = spawnSync(packPath(pack, check.run), [], {
      cwd: pack.dir,
      input: JSON.stringify({ task: task.id, answer: ctx.answer, arm: ctx.arm, model: ctx.model, trial_dir: ctx.trialDir }),
      encoding: "utf8",
      timeout: 60_000,
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().slice(0, 500);
    if (res.error) return { passed: false, detail: `script error: ${res.error.message}` };
    return { passed: res.status === 0, detail: out || `exit ${res.status}` };
  };
}

export function runChecks(task: Task, ctx: CheckContext, runScript?: ScriptRunner): CheckResult[] {
  const answer = ctx.answer ?? "";
  return task.checks.map((c, index): CheckResult => {
    const r = (passed: boolean, detail: string): CheckResult => ({ index, type: c.type, required: c.required, passed, detail });
    switch (c.type) {
      case "equals":
        return r(answer.trim() === c.value.trim(), `expected exactly ${JSON.stringify(c.value)}`);
      case "contains": {
        const hay = c.ignore_case ? answer.toLowerCase() : answer;
        const needle = c.ignore_case ? c.value.toLowerCase() : c.value;
        return r(hay.includes(needle), `answer ${hay.includes(needle) ? "contains" : "does not contain"} ${JSON.stringify(c.value)}`);
      }
      case "regex": {
        const ok = new RegExp(c.pattern, c.flags).test(answer);
        return r(ok, `/${c.pattern}/${c.flags} ${ok ? "matched" : "did not match"}`);
      }
      case "json_path": {
        try {
          const got = jsonPath(parseJsonAnswer(answer), c.path);
          const ok = JSON.stringify(got) === JSON.stringify(c.equals);
          return r(ok, `${c.path} = ${JSON.stringify(got)}; expected ${JSON.stringify(c.equals)}`);
        } catch {
          return r(false, "answer is not valid JSON");
        }
      }
      case "tool_called": {
        const n = effectiveToolCalls(ctx.messages, ctx.deniedIds).length;
        const ok = n >= c.min && (c.max == null || n <= c.max);
        return r(ok, `${n} tool call(s); expected ${c.min}${c.max != null ? `–${c.max}` : "+"}`);
      }
      case "no_escape":
        return r(ctx.escapeAttempts === 0, `${ctx.escapeAttempts} escape attempt(s)`);
      case "script": {
        if (!runScript) return r(false, "script checks need a live trial");
        const s = runScript(c, ctx);
        return r(s.passed, s.detail);
      }
    }
  });
}
