import { useRun } from "../api.ts";
import type { ArmSummary, Trial } from "../types.ts";
import { ciText, compact, num, pct, relDelta, score, secs } from "../format.ts";
import { Correct, Loading, StatusPill } from "../components/common.tsx";
import { MetricBars } from "../components/MetricBars.tsx";
import { divergingFill } from "../components/ScoreGrid.tsx";
import { navigate } from "../router.ts";

function ArmTrials({ title, trials }: { title: string; trials: Trial[] }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ padding: "12px 16px 0" }}><h3>{title}</h3></div>
      <table>
        <thead>
          <tr><th className="num">#</th><th>status</th><th>correct</th><th className="num">w-tokens</th><th className="num">turns</th><th className="num">time</th><th className="num">esc.</th></tr>
        </thead>
        <tbody>
          {trials.map((t) => (
            <tr key={t.id} className="clickable" onClick={() => navigate(`/trials/${t.id}`)} title={t.judgment?.reasoning ?? ""}>
              <td className="num"><a href={`#/trials/${t.id}`} onClick={(e) => e.stopPropagation()}>{t.trial_index}</a></td>
              <td><StatusPill status={t.status} /></td>
              <td><Correct value={t.correctness} /></td>
              <td className="num">{compact(t.tokens_weighted)}</td>
              <td className="num">{t.num_turns ?? "–"}</td>
              <td className="num">{secs(t.duration_ms)}</td>
              <td className={`num${t.escape_attempts ? " bad" : ""}`}>{t.escape_attempts ?? "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ padding: "8px 16px 14px" }} className="small">
        {trials.map((t) =>
          t.judgment ? (
            <div key={t.id} style={{ marginTop: 6 }}>
              <span className="muted">#{t.trial_index} {t.judgment.source === "judge" ? `judge (${t.judgment.judgeModel})` : t.judgment.source.replace("_", " ")}:</span>{" "}
              {t.judgment.reasoning}
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}

function SummaryTable({ axi, base, baseline }: { axi: ArmSummary; base: ArmSummary; baseline: string }) {
  const rows: [string, string, string, string][] = [
    ["Correctness (mean)", pct(axi.correctness), pct(base.correctness), axi.correctness === base.correctness ? "=" : `${axi.correctness > base.correctness ? "+" : "−"}${num(Math.abs(axi.correctness - base.correctness) * 100)} pts`],
    ["Tokens, cost-weighted (median)", num(axi.tokens), num(base.tokens), relDelta(axi.tokens, base.tokens)],
    ["Turns (median)", num(axi.turns, 1), num(base.turns, 1), relDelta(axi.turns, base.turns)],
    ["Time (median)", secs(axi.time), secs(base.time), relDelta(axi.time, base.time)],
    ["Errors + escapes (median)", num(axi.errors, 1), num(base.errors, 1), base.errors === axi.errors ? "=" : `${axi.errors > base.errors ? "+" : "−"}${num(Math.abs(axi.errors - base.errors), 1)}`],
  ];
  return (
    <table>
      <thead>
        <tr><th>metric</th><th className="num">axi (n={axi.n})</th><th className="num">{baseline} (n={base.n})</th><th className="num">axi vs {baseline}</th></tr>
      </thead>
      <tbody>
        {rows.map(([k, a, b, d]) => (
          <tr key={k}><td>{k}</td><td className="num"><b>{a}</b></td><td className="num">{b}</td><td className="num">{d}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

export function MatchPage({ runId, task, model, vs }: { runId: string; task: string; model: string; vs: string }) {
  const { data, error } = useRun(runId);
  if (!data) return <Loading error={error} />;
  const m = data.scoreboard.matches.find((x) => x.task === task && x.model === model && x.baseline === vs);
  const trials = data.trials.filter((t) => t.task_id === task && t.model === model);
  if (!m) return <Loading error={`No graded match for ${task} · ${model} vs ${vs} in this run.`} />;
  const fill = divergingFill(m.score);
  const gate = data.run.config.scoring.gate;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="mono" style={{ fontSize: 20 }}>{task}</h1>
          <div className="sub">axi vs <b>{vs}</b> · {model}</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card tile">
          <div className="label">Match score</div>
          <div className="row-gap">
            <span className="value">{score(m.score)}</span>
            <span className="pill" style={{ background: fill.background, color: fill.strong ? "var(--on-strong)" : "var(--ink)" }}>
              {m.gatePassed ? (m.score >= 0 ? "AXI better" : "AXI worse") : "✗ failed gate"}
            </span>
          </div>
          <div className="note">95% CI {ciText(m.ci)}{m.ci && !m.significant ? " · not significant" : ""}</div>
          <div className="note" style={{ marginTop: 8 }}>
            Weighted efficiency {score(m.efficiency)}.{" "}
            {m.gatePassed
              ? "Correctness gate passed, so the score is the efficiency."
              : `Correctness gate failed (AXI needs ≥ ${pct(gate.min_correctness)} and within ${pct(gate.max_regression)} of ${vs}), so the score is min(0, efficiency) minus the correctness gap.`}
          </div>
        </div>
        <div className="card">
          <h3>Relative improvement per metric</h3>
          <MetricBars match={m} weights={data.run.config.scoring.weights} />
        </div>
      </div>

      <h2>Side by side</h2>
      <div className="card" style={{ padding: 0 }}>
        <SummaryTable axi={m.axi} base={m.base} baseline={vs} />
      </div>

      <h2>Trials</h2>
      <div className="grid-2">
        <ArmTrials title="axi" trials={trials.filter((t) => t.arm === "axi")} />
        <ArmTrials title={vs} trials={trials.filter((t) => t.arm === vs)} />
      </div>
    </>
  );
}
