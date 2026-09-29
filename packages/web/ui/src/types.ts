// Shapes returned by the API in src/server.ts (kept local so the UI doesn't pull in Node types).

export type TrialStatus = "queued" | "running" | "success" | "max_turns" | "timeout" | "error" | "setup_error";

export interface CheckResult {
  index: number;
  type: string;
  required: boolean;
  passed: boolean;
  detail: string;
}

export interface Judgment {
  correctness: number;
  reasoning: string;
  source: "judge" | "required_check" | "no_answer" | "checks_only" | "judge_error";
  judgeModel: string | null;
  judgeTokensWeighted: number | null;
}

export interface ModelTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
  weighted: number;
}

export interface Trial {
  id: string;
  run_id: string;
  task_id: string;
  arm: string;
  model: string;
  trial_index: number;
  status: TrialStatus;
  started_at: string | null;
  finished_at: string | null;
  result_text: string | null;
  sdk_subtype: string | null;
  num_turns: number | null;
  tool_calls: number | null;
  tool_errors: number | null;
  error_recoveries: number | null;
  escape_attempts: number | null;
  duration_ms: number | null;
  duration_api_ms: number | null;
  tokens_total: number | null;
  tokens_weighted: number | null;
  cost_usd: number | null;
  correctness: number | null;
  trial_dir: string | null;
  error: string | null;
  tokens: Record<string, ModelTokens> | null;
  checks: CheckResult[] | null;
  judgment: Judgment | null;
  network: "replay" | "record" | "live" | null;
  fixture_misses: number | null;
  proxy: { hits: number; recorded: number; passthrough: number; misses: { method: string; url: string; detail?: string }[] } | null;
}

export interface ArmSummary {
  n: number;
  correctness: number;
  tokens: number;
  turns: number;
  time: number;
  errors: number;
}

export type Metric = "tokens" | "turns" | "time" | "errors";

export interface Match {
  task: string;
  model: string;
  baseline: string;
  axi: ArmSummary;
  base: ArmSummary;
  score: number;
  efficiency: number;
  r: Record<Metric, number>;
  gatePassed: boolean;
  ci: [number, number] | null;
  significant: boolean;
}

export interface Aggregate {
  key: string;
  score: number;
  ci: [number, number] | null;
  significant: boolean;
  matches: number;
  gateFailures: number;
}

export interface Scoreboard {
  matches: Match[];
  byModel: Aggregate[];
  overall: Aggregate | null;
}

export interface ScoringConfig {
  weights: Record<Metric, number>;
  gate: { min_correctness: number; max_regression: number };
}

export interface RunConfig {
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

export interface Run {
  id: string;
  pack_name: string;
  pack_dir: string;
  pack_version: string;
  axi_version: string | null;
  status: "running" | "done" | "failed" | "aborted";
  started_at: string;
  finished_at: string | null;
  error: string | null;
  config: RunConfig;
}

export interface Progress {
  total: number;
  done: number;
  running: number;
}

export interface RunPayload {
  run: Run;
  progress: Progress;
  scoreboard: Scoreboard;
  trials: Trial[];
}

export interface RunListItem {
  id: string;
  pack_name: string;
  axi_version: string | null;
  status: Run["status"];
  started_at: string;
  finished_at: string | null;
  models: string[];
  effort: string;
  progress: Progress;
  overall: Aggregate | null;
}

export type TranscriptItem =
  | { kind: "init"; seq: number; model: string; tools: string[]; skills: string[] }
  | { kind: "hook"; seq: number; name: string; output: string }
  | { kind: "text"; seq: number; text: string }
  | { kind: "tool_call"; seq: number; id: string; name: string; input: unknown }
  | { kind: "tool_result"; seq: number; id: string; isError: boolean; escape: boolean; text: string; chars: number; approxTokens: number }
  | { kind: "result"; seq: number; subtype: string; text: string | null; turns: number; durationMs: number };

export interface TrialPayload {
  trial: Trial;
  items: TranscriptItem[];
  lastSeq: number;
}

export interface HistoryPoint {
  id: string;
  started_at: string;
  axi_version: string | null;
  status: string;
  effort: string;
  models: string[];
  trials: number;
  byModel: Aggregate[];
  overall: Aggregate | null;
}
