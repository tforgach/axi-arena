// Re-grade a finished run from its stored event stream, without re-running agents (SPEC §10).
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CheckResult, ScriptRunner } from "./checks.ts";
import { runTrials, setGrade, setToolTokens, trialEvents, type Db, type TrialRow } from "./db.ts";
import { gradeTrial, type Grade, type GradeOptions } from "./grading.ts";
import { computeMetrics } from "./metrics.ts";
import type { Pack } from "./pack.ts";

/** Script checks inspect live state that is gone after the run, so their stored result is reused. */
function storedScriptResults(row: TrialRow): ScriptRunner {
  const prior: CheckResult[] = row.checks_json ? JSON.parse(row.checks_json) : [];
  let i = 0;
  return () => {
    const hit = prior.filter((c) => c.type === "script")[i++];
    return hit ? { passed: hit.passed, detail: `${hit.detail} (from original run)` } : { passed: false, detail: "no stored result" };
  };
}

export async function rescoreRun(
  db: Db,
  pack: Pack,
  runId: string,
  opts: GradeOptions,
  onTrial?: (row: TrialRow, grade: Grade | null) => void,
  concurrency = 4,
  metricsOnly = false,
): Promise<number> {
  const tasks = new Map(pack.tasks.map((t) => [t.id, t]));
  const rows = runTrials(db, runId).filter((r) => r.status !== "setup_error" && r.status !== "queued" && tasks.has(r.task_id));
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      const messages = trialEvents(db, row.id) as SDKMessage[];
      const m = computeMetrics(messages, []);
      setToolTokens(db, row.id, m.toolTokens);
      if (metricsOnly) {
        onTrial?.(row, null);
        continue;
      }
      const grade = await gradeTrial(tasks.get(row.task_id)!, messages, m, { trialDir: null, arm: row.arm, model: row.model }, opts, storedScriptResults(row));
      setGrade(db, row.id, grade.correctness, JSON.stringify(grade.checks), JSON.stringify(grade.judgment));
      onTrial?.(row, grade);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return rows.length;
}
