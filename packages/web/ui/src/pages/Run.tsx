import { useRun } from "../api.ts";
import type { Match, Trial } from "../types.ts";
import { compact, duration, secs, when } from "../format.ts";
import { Correct, Loading, ScoreTile, StatusPill } from "../components/common.tsx";
import { ScoreGrid } from "../components/ScoreGrid.tsx";
import { navigate } from "../router.ts";

export const matchHref = (runId: string, m: Pick<Match, "task" | "model" | "baseline">) =>
  `#/runs/${runId}/match?task=${encodeURIComponent(m.task)}&model=${encodeURIComponent(m.model)}&vs=${encodeURIComponent(m.baseline)}`;

function TrialsTable({ trials }: { trials: Trial[] }) {
  const order: Record<string, number> = { running: 0, queued: 1 };
  const rows = [...trials].sort(
    (a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2) || a.task_id.localeCompare(b.task_id) || a.arm.localeCompare(b.arm) || a.trial_index - b.trial_index,
  );
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>task</th><th>arm</th><th>model</th><th className="num">#</th><th>status</th><th>correct</th>
              <th className="num">w-tokens</th><th className="num">turns</th><th className="num">time</th><th className="num">escapes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="clickable" onClick={() => navigate(`/trials/${t.id}`)}>
                <td className="mono">{t.task_id}</td>
                <td><b>{t.arm}</b></td>
                <td className="small">{t.model}</td>
                <td className="num">{t.trial_index}</td>
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
      </div>
    </div>
  );
}

export function RunPage({ id }: { id: string }) {
  const { data, error, live } = useRun(id);
  if (!data) return <Loading error={error} />;
  const { run, progress, scoreboard, trials } = data;
  const cfg = run.config;
  const tiles = [...scoreboard.byModel, ...(scoreboard.byModel.length > 1 && scoreboard.overall ? [scoreboard.overall] : [])];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {run.pack_name} <span className="muted" style={{ fontWeight: 400 }}>{run.axi_version ?? ""}</span>
          </h1>
          <div className="meta" style={{ marginTop: 6 }}>
            <StatusPill status={run.status} />
            <span>{when(run.started_at)} · {duration(run.started_at, run.finished_at)}</span>
            <span>arms <b>{cfg.arms.join(" vs ")}</b></span>
            <span>models <b>{cfg.models.join(", ")}</b></span>
            <span><b>{cfg.trials}</b> trials/arm</span>
            <span>effort <b>{cfg.effort}</b></span>
            <span>judge <b>{cfg.useJudge === false ? "off" : cfg.judgeModel ?? "–"}</b></span>
          </div>
        </div>
        <a href={`#/packs/${encodeURIComponent(run.pack_name)}`}>Pack history →</a>
      </div>

      {(live || run.status === "running") && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row-gap">
            <b>{progress.done}/{progress.total}</b> trials done
            <span className="muted">· {progress.running} running · updates live</span>
          </div>
          <div className="progress"><div style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} /></div>
        </div>
      )}
      {run.error && <div className="error-box" style={{ marginBottom: 16 }}>{run.error}</div>}

      {tiles.length > 0 ? (
        <div className="tiles">
          {tiles.map((a, i) => (
            <ScoreTile key={a.key} label={a.key === "overall" ? "Arena Score · all models" : `Arena Score · ${a.key}`} agg={a} hero={i === 0 && tiles.length === 1} />
          ))}
        </div>
      ) : (
        <div className="card muted">No graded matches yet{live ? " — scores appear as trials finish." : "."}</div>
      )}

      {scoreboard.matches.length > 0 && (
        <>
          <h2>Matches</h2>
          <div className="card">
            <ScoreGrid matches={scoreboard.matches} href={(m) => matchHref(run.id, m)} />
          </div>
        </>
      )}

      <h2>Trials</h2>
      <TrialsTable trials={trials} />
    </>
  );
}
