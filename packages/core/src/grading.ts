// Checks → judge → correctness, shared by live runs and `rescore` (SPEC §6.2).
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { runChecks, type CheckResult, type ScriptRunner } from "./checks.ts";
import { judge, type Judgment } from "./judge.ts";
import type { TrialMetrics } from "./metrics.ts";
import type { Task } from "./pack.ts";

export interface GradeOptions {
  judgeModel: string;
  useJudge: boolean;
}

export interface Grade {
  correctness: number | null;
  checks: CheckResult[];
  judgment: Judgment;
}

export async function gradeTrial(
  task: Task,
  messages: SDKMessage[],
  metrics: Pick<TrialMetrics, "resultText" | "deniedIds" | "escapeAttempts">,
  ctx: { trialDir: string | null; arm: string; model: string },
  opts: GradeOptions,
  runScript?: ScriptRunner,
): Promise<Grade> {
  const checks = runChecks(
    task,
    { answer: metrics.resultText, messages, deniedIds: metrics.deniedIds, escapeAttempts: metrics.escapeAttempts, ...ctx },
    runScript,
  );
  try {
    const judgment = await judge({ task, answer: metrics.resultText, checks, messages, judgeModel: opts.judgeModel, useJudge: opts.useJudge });
    return { correctness: judgment.correctness, checks, judgment };
  } catch (e) {
    // A judge failure leaves correctness unknown; the trial is excluded from scoring until rescored.
    const reasoning = `judge failed: ${e instanceof Error ? e.message : String(e)}`;
    return { correctness: null, checks, judgment: { correctness: 0, reasoning, source: "judge_error", judgeModel: opts.judgeModel, judgeTokensWeighted: null } };
  }
}
