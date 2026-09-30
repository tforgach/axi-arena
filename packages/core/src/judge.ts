// LLM judge (SPEC §6.2): checks are evidence; required-check failures short-circuit to 0.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { cleanupClaudeProjectDir } from "./arm.ts";
import type { CheckResult } from "./checks.ts";
import { tokensByModel } from "./metrics.ts";
import type { Task } from "./pack.ts";
import { arenaHome } from "./paths.ts";
import type { AuthSetup } from "./config.ts";

export const DEFAULT_JUDGE_MODEL = "claude-haiku-4-5";

export interface Judgment {
  correctness: number;
  reasoning: string;
  /** "judge" | "required_check" | "no_answer" | "checks_only" */
  source: string;
  judgeModel: string | null;
  judgeTokensWeighted: number | null;
}

const MAX_TRANSCRIPT_CHARS = 6000;
const MAX_TOOL_OUTPUT_CHARS = 600;

/** Tool calls and truncated outputs, so the judge can see how the answer was reached. */
export function condensedTranscript(messages: SDKMessage[]): string {
  const lines: string[] = [];
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s);
  for (const m of messages) {
    if (m.type === "assistant") {
      for (const b of m.message.content) {
        if (b.type === "tool_use") lines.push(`CALL ${b.name} ${clip(JSON.stringify(b.input), 300)}`);
      }
    } else if (m.type === "user" && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (typeof b !== "object" || b.type !== "tool_result") continue;
        const text = typeof b.content === "string" ? b.content
          : Array.isArray(b.content) ? b.content.map((c) => ("text" in c ? c.text : `[${c.type}]`)).join("\n") : "";
        lines.push(`${b.is_error ? "ERROR" : "RESULT"} ${clip(text.replace(/\s+/g, " "), MAX_TOOL_OUTPUT_CHARS)}`);
      }
    }
  }
  const out = lines.join("\n");
  return out.length > MAX_TRANSCRIPT_CHARS ? `${out.slice(0, MAX_TRANSCRIPT_CHARS)}\n… [transcript truncated]` : out || "(no tool calls)";
}

function fallbackFromChecks(checks: CheckResult[]): Judgment {
  const passed = checks.filter((c) => c.passed).length;
  return {
    correctness: checks.length ? passed / checks.length : 0,
    reasoning: checks.length ? `No judge rubric; ${passed}/${checks.length} checks passed.` : "No judge rubric and no checks.",
    source: "checks_only",
    judgeModel: null,
    judgeTokensWeighted: null,
  };
}

const SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number", minimum: 0, maximum: 1, description: "0 = wrong, 1 = fully correct; partial credit allowed" },
    reasoning: { type: "string", description: "One to three sentences." },
  },
  required: ["score", "reasoning"],
  additionalProperties: false,
} as const;

function judgePrompt(task: Task, answer: string, checks: CheckResult[], transcript: string): string {
  const checkLines = checks.length
    ? checks.map((c) => `- [${c.passed ? "PASS" : "FAIL"}] ${c.type}${c.required ? " (required)" : ""}: ${c.detail}`).join("\n")
    : "(none)";
  return `You are grading an AI agent's answer to a task. Grade only correctness against the rubric. Judge meaning, not wording: an answer that conveys the required facts in different words is fully correct, unless the rubric explicitly says exact wording is required. The reference answer is one acceptable phrasing, not the only one. Do not deduct for omitting details the rubric does not explicitly require, or for extra correct detail. Do not reward or penalize style, length, or which tools were used, except where the rubric says so. If the answer is a refusal or says it could not get the information, score 0.

<task>
${task.prompt.trim()}
</task>

<rubric>
${task.judge!.rubric.trim()}
</rubric>
${task.judge!.reference ? `\n<reference_answer>\n${task.judge!.reference.trim()}\n</reference_answer>\n` : ""}
<deterministic_checks>
${checkLines}
</deterministic_checks>

<agent_tool_transcript>
${transcript}
</agent_tool_transcript>

<agent_final_answer>
${answer.trim()}
</agent_final_answer>

Return a score from 0 to 1 and brief reasoning.`;
}

export interface JudgeInput {
  task: Task;
  answer: string | null;
  checks: CheckResult[];
  messages: SDKMessage[];
  judgeModel: string;
  useJudge: boolean;
  auth?: AuthSetup;
}

/** Isolated env for arena-internal model calls (judge, preflight): no tools, same auth as trials. */
export function internalEnv(auth?: AuthSetup): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...(auth?.env ?? (process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {})),
  };
}

export async function judge(i: JudgeInput): Promise<Judgment> {
  const failedRequired = i.checks.filter((c) => c.required && !c.passed);
  if (i.answer == null || !i.answer.trim()) {
    return { correctness: 0, reasoning: "No final answer.", source: "no_answer", judgeModel: null, judgeTokensWeighted: null };
  }
  if (failedRequired.length) {
    return {
      correctness: 0,
      reasoning: `Required check failed: ${failedRequired.map((c) => `${c.type} (${c.detail})`).join("; ")}`,
      source: "required_check",
      judgeModel: null,
      judgeTokensWeighted: null,
    };
  }
  if (!i.task.judge || !i.useJudge) return fallbackFromChecks(i.checks);

  const cwd = join(arenaHome(), "judge", randomBytes(4).toString("hex"));
  mkdirSync(cwd, { recursive: true });
  try {
    let structured: unknown;
    let weighted: number | null = null;
    let failure: string | null = null;
    for await (const m of query({
      prompt: judgePrompt(i.task, i.answer, i.checks, condensedTranscript(i.messages)),
      options: {
        cwd,
        model: i.judgeModel,
        maxTurns: 3,
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        skills: [],
        persistSession: false,
        outputFormat: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> },
        env: internalEnv(i.auth),
        ...(i.auth && Object.keys(i.auth.settings).length ? { settings: i.auth.settings } : {}),
      },
    })) {
      if (m.type === "result") {
        weighted = Math.round(Object.values(tokensByModel(m)).reduce((s, t) => s + t.weighted, 0));
        if (m.subtype === "success") structured = m.structured_output;
        else failure = m.subtype;
      }
    }
    const out = structured as { score?: unknown; reasoning?: unknown } | undefined;
    if (typeof out?.score !== "number") throw new Error(`judge returned no score${failure ? ` (${failure})` : ""}`);
    return {
      correctness: Math.min(1, Math.max(0, out.score)),
      reasoning: String(out.reasoning ?? ""),
      source: "judge",
      judgeModel: i.judgeModel,
      judgeTokensWeighted: weighted,
    };
  } finally {
    cleanupClaudeProjectDir(cwd);
    rmSync(cwd, { recursive: true, force: true });
  }
}
