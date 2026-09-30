import { test } from "node:test";
import assert from "node:assert/strict";
import { computeScoreboard, scoreMatch, summarize, type ScoredTrial, type ScoringConfig } from "../src/scoring.ts";

const cfg: ScoringConfig = {
  weights: { tokens: 0.4, turns: 0.2, time: 0.2, errors: 0.2 },
  gate: { min_correctness: 0.8, max_regression: 0.05 },
};

const trial = (arm: string, o: Partial<ScoredTrial> = {}): ScoredTrial => ({
  task_id: "t", arm, model: "m", status: "success", correctness: 1,
  tokens_weighted: 1000, num_turns: 2, duration_ms: 1000, tool_errors: 0, error_recoveries: 0, escape_attempts: 0, ...o,
});

const arm = (o: Partial<ReturnType<typeof summarize>>) => ({ n: 3, correctness: 1, tokens: 1000, sessionTokens: 1000, toolTokens: 0, turns: 2, time: 1000, errors: 0, ...o });

test("parity scores 0; halving tokens with everything else equal scores +20", () => {
  assert.equal(scoreMatch(arm({}), arm({}), cfg).score, 0);
  const s = scoreMatch(arm({ tokens: 500 }), arm({}), cfg);
  assert.ok(Math.abs(s.score - 0.2) < 1e-9);
  assert.equal(s.gatePassed, true);
});

test("relative metrics clamp to ±1 and handle zero baselines", () => {
  const s = scoreMatch(arm({ tokens: 5000, errors: 3 }), arm({ errors: 0 }), cfg);
  assert.equal(s.r.tokens, -1);
  assert.equal(s.r.errors, -1);
  assert.equal(scoreMatch(arm({ errors: 0 }), arm({ errors: 0 }), cfg).r.errors, 0);
});

test("correctness gate: below the floor, or regressing past tolerance, caps the score at ≤ 0 minus the regression", () => {
  const cheapButWrong = scoreMatch(arm({ tokens: 100, correctness: 0.5 }), arm({ correctness: 1 }), cfg);
  assert.equal(cheapButWrong.gatePassed, false);
  assert.ok(Math.abs(cheapButWrong.score - -0.5) < 1e-9, "min(0, efficiency) − 0.5");

  const smallRegression = scoreMatch(arm({ tokens: 500, correctness: 0.96 }), arm({ correctness: 1 }), cfg);
  assert.equal(smallRegression.gatePassed, true, "within max_regression");

  const bothBad = scoreMatch(arm({ correctness: 0.5 }), arm({ correctness: 0.5 }), cfg);
  assert.equal(bothBad.gatePassed, false, "below min_correctness even at parity");
});

test("correctness beyond the baseline is rewarded; a small in-tolerance regression costs a little", () => {
  const better = scoreMatch(arm({ correctness: 1 }), arm({ correctness: 0.67 }), cfg);
  assert.ok(better.gatePassed);
  assert.ok(Math.abs(better.score - 0.33) < 1e-9, "parity efficiency + 1.0 × 0.33");
  assert.ok(Math.abs(scoreMatch(arm({ correctness: 0.97 }), arm({ correctness: 1 }), cfg).score - -0.03) < 1e-9);
  const noReward = scoreMatch(arm({ correctness: 1 }), arm({ correctness: 0.67 }), { ...cfg, correctness_weight: 0 });
  assert.equal(noReward.score, 0);
});

test("scoreboard: CI needs ≥2 trials per arm, is reproducible, and flags significance", () => {
  const single = computeScoreboard([trial("axi"), trial("native")], cfg);
  assert.equal(single.matches[0].ci, null);

  const many = [
    ...[400, 420, 380, 410, 390].map((t) => trial("axi", { tokens_weighted: t })),
    ...[1000, 1100, 950, 1050, 980].map((t) => trial("native", { tokens_weighted: t })),
  ];
  const a = computeScoreboard(many, cfg);
  const b = computeScoreboard(many, cfg);
  assert.deepEqual(a.matches[0].ci, b.matches[0].ci);
  assert.equal(a.matches[0].significant, true);
  assert.ok(a.byModel[0].score > 0.2);
});

test("scoreboard skips setup errors and ungraded trials, and matches each baseline separately", () => {
  const board = computeScoreboard(
    [
      trial("axi"), trial("webfetch"), trial("curl"),
      trial("axi", { status: "setup_error" }), trial("webfetch", { correctness: null }),
    ],
    cfg,
  );
  assert.deepEqual(board.matches.map((m) => [m.baseline, m.axi.n, m.base.n]), [["curl", 1, 1], ["webfetch", 1, 1]]);
});
