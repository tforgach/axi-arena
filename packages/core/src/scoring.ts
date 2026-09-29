// Arena Score (SPEC §6.3–6.4): per-match relative improvement, correctness gate, bootstrap CIs.
import { median } from "./stats.ts";

export interface ScoringConfig {
  weights: { tokens: number; turns: number; time: number; errors: number };
  gate: { min_correctness: number; max_regression: number };
}

export interface ScoredTrial {
  task_id: string;
  arm: string;
  model: string;
  status: string;
  correctness: number | null;
  tokens_weighted: number | null;
  num_turns: number | null;
  duration_ms: number | null;
  tool_errors: number | null;
  error_recoveries: number | null;
  escape_attempts: number | null;
}

export const METRICS = ["tokens", "turns", "time", "errors"] as const;
export type Metric = (typeof METRICS)[number];

export interface ArmSummary {
  n: number;
  correctness: number;
  tokens: number;
  turns: number;
  time: number;
  errors: number;
}

export interface MatchScore {
  score: number;
  efficiency: number;
  r: Record<Metric, number>;
  gatePassed: boolean;
}

export interface Match extends MatchScore {
  task: string;
  model: string;
  baseline: string;
  axi: ArmSummary;
  base: ArmSummary;
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

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Trials that count: finished with a correctness value; setup errors are nobody's fault. */
const scorable = (t: ScoredTrial) => t.status !== "setup_error" && t.status !== "queued" && t.status !== "running" && t.correctness != null;

export function summarize(trials: ScoredTrial[]): ArmSummary {
  const med = (f: (t: ScoredTrial) => number | null) => median(trials.map(f).filter((x): x is number => x != null)) ?? 0;
  return {
    n: trials.length,
    // Correctness is a rate, so it's averaged; efficiency metrics use medians.
    correctness: mean(trials.map((t) => t.correctness ?? 0)),
    tokens: med((t) => t.tokens_weighted),
    turns: med((t) => t.num_turns),
    time: med((t) => t.duration_ms),
    // Scored errors: escapes + errors the agent had to recover from (falls back to raw errors for old rows).
    errors: med((t) => (t.error_recoveries ?? t.tool_errors ?? 0) + (t.escape_attempts ?? 0)),
  };
}

export function scoreMatch(axi: ArmSummary, base: ArmSummary, cfg: ScoringConfig): MatchScore {
  // max(b, 1) avoids dividing by zero: 0 errors vs 0 errors is parity; 0 vs 2 is clamped to −1.
  const rel = (b: number, a: number) => clamp((b - a) / Math.max(b, 1), -1, 1);
  const r = {
    tokens: rel(base.tokens, axi.tokens),
    turns: rel(base.turns, axi.turns),
    time: rel(base.time, axi.time),
    errors: rel(base.errors, axi.errors),
  };
  const w = cfg.weights;
  const wsum = w.tokens + w.turns + w.time + w.errors || 1;
  const efficiency = (w.tokens * r.tokens + w.turns * r.turns + w.time * r.time + w.errors * r.errors) / wsum;
  const gatePassed =
    axi.correctness >= cfg.gate.min_correctness && axi.correctness >= base.correctness - cfg.gate.max_regression;
  const score = gatePassed ? efficiency : Math.min(0, efficiency) - Math.max(0, base.correctness - axi.correctness);
  return { score, efficiency, r, gatePassed };
}

/** Small seeded PRNG so CIs are reproducible for a given set of trials. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];

interface MatchGroup {
  task: string;
  model: string;
  baseline: string;
  axi: ScoredTrial[];
  base: ScoredTrial[];
}

export function computeScoreboard(trials: ScoredTrial[], cfg: ScoringConfig, iterations = 2000, seed = 42): Scoreboard {
  const ok = trials.filter(scorable);
  const groups: MatchGroup[] = [];
  const keyOf = (t: ScoredTrial) => `${t.model}\u0000${t.task_id}`;
  const byKey = new Map<string, ScoredTrial[]>();
  for (const t of ok) byKey.set(keyOf(t), [...(byKey.get(keyOf(t)) ?? []), t]);
  for (const [key, ts] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
    const [model, task] = key.split("\u0000");
    const axi = ts.filter((t) => t.arm === "axi");
    if (axi.length === 0) continue;
    for (const baseline of [...new Set(ts.map((t) => t.arm).filter((a) => a !== "axi"))].sort()) {
      groups.push({ task, model, baseline, axi, base: ts.filter((t) => t.arm === baseline) });
    }
  }

  const point = groups.map((g) => ({ g, s: scoreMatch(summarize(g.axi), summarize(g.base), cfg) }));

  // Bootstrap: resample trials within each arm of every match, jointly, so aggregates get CIs too.
  const rand = mulberry32(seed);
  const resample = (xs: ScoredTrial[]) => xs.map(() => xs[Math.floor(rand() * xs.length)]);
  const canBootstrap = (g: MatchGroup) => g.axi.length > 1 && g.base.length > 1;
  const draws: number[][] = groups.map(() => []);
  if (groups.some(canBootstrap)) {
    for (let i = 0; i < iterations; i++) {
      groups.forEach((g, gi) => {
        draws[gi].push(canBootstrap(g) ? scoreMatch(summarize(resample(g.axi)), summarize(resample(g.base)), cfg).score : point[gi].s.score);
      });
    }
  }
  const ciOf = (xs: number[]): [number, number] | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return [percentile(s, 0.025), percentile(s, 0.975)];
  };
  const sig = (ci: [number, number] | null) => ci != null && (ci[0] > 0 || ci[1] < 0);

  const matches: Match[] = point.map(({ g, s }, gi) => {
    const ci = canBootstrap(g) ? ciOf(draws[gi]) : null;
    return { task: g.task, model: g.model, baseline: g.baseline, axi: summarize(g.axi), base: summarize(g.base), ...s, ci, significant: sig(ci) };
  });

  const aggregate = (key: string, idx: number[]): Aggregate => {
    const bootable = idx.some((i) => canBootstrap(groups[i]));
    const ci = bootable ? ciOf(Array.from({ length: iterations }, (_, it) => mean(idx.map((i) => draws[i][it])))) : null;
    return {
      key,
      score: mean(idx.map((i) => matches[i].score)),
      ci,
      significant: sig(ci),
      matches: idx.length,
      gateFailures: idx.filter((i) => !matches[i].gatePassed).length,
    };
  };

  const models = [...new Set(matches.map((m) => m.model))].sort();
  const byModel = models.map((m) => aggregate(m, matches.flatMap((x, i) => (x.model === m ? [i] : []))));
  const overall = matches.length ? aggregate("overall", matches.map((_, i) => i)) : null;
  return { matches, byModel, overall };
}
