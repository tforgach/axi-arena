import { useTrial } from "../api.ts";
import { compact, num, secs } from "../format.ts";
import { Correct, Loading, StatusPill } from "../components/common.tsx";
import { Transcript } from "../components/Transcript.tsx";

export function TrialPage({ id }: { id: string }) {
  const { data, error, live } = useTrial(id);
  if (!data) return <Loading error={error} />;
  const t = data.trial;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="mono" style={{ fontSize: 20 }}>{t.task_id}</h1>
          <div className="meta" style={{ marginTop: 6 }}>
            <span>arm <b>{t.arm}</b></span>
            <span>{t.model}</span>
            <span>trial #{t.trial_index}</span>
            <StatusPill status={t.status} />
            {t.network && (
              <span title="network mode">
                network <b>{t.network}</b>
                {t.proxy && ` · ${t.proxy.hits} fixture hit(s)${t.proxy.recorded ? ` · ${t.proxy.recorded} recorded` : ""}`}
              </span>
            )}
            <a href={`#/runs/${t.run_id}`}>run →</a>
          </div>
        </div>
      </div>

      <div className="tiles">
        <div className="card tile"><div className="label">Correctness</div><div className="value"><Correct value={t.correctness} /></div><div className="note">{t.judgment?.source?.replace("_", " ") ?? (live ? "grading after the trial…" : "not graded")}</div></div>
        <div className="card tile"><div className="label">Tokens, cost-weighted</div><div className="value">{compact(t.tokens_weighted)}</div><div className="note">{num(t.tokens_total)} raw</div></div>
        <div className="card tile"><div className="label">Turns · tool calls</div><div className="value">{t.num_turns ?? "–"} · {t.tool_calls ?? "–"}</div><div className="note">{t.error_recoveries ?? 0} error recoveries · {t.tool_errors ?? 0} errors</div></div>
        <div className="card tile"><div className="label">Time</div><div className="value">{secs(t.duration_ms)}</div><div className="note">{secs(t.duration_api_ms)} in API calls</div></div>
        <div className="card tile"><div className="label">Escape attempts</div><div className={`value${t.escape_attempts ? " bad" : ""}`}>{t.escape_attempts ?? "–"}</div><div className="note">calls denied by lockdown</div></div>
      </div>

      {t.error && <div className="error-box" style={{ marginTop: 16 }}>{t.error}</div>}
      {t.proxy && t.proxy.misses.length > 0 && (
        <div className="card" style={{ marginTop: 16, borderColor: "var(--warning)" }}>
          <h3>⚠ {t.fixture_misses} request(s) had no fixture</h3>
          <div className="small muted" style={{ marginBottom: 6 }}>The agent got HTTP 599 for these, so this trial isn't fully reproducible. Fill the gap with <code>axi-arena record</code>.</div>
          {t.proxy.misses.map((m, i) => <div key={i} className="mono small">{m.method} {m.url}{m.detail ? ` — ${m.detail}` : ""}</div>)}
        </div>
      )}

      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h3>Checks</h3>
          {t.checks?.length ? (
            <ul className="checks">
              {t.checks.map((c) => (
                <li key={c.index}>
                  <span className={c.passed ? "ok" : "bad"}>{c.passed ? "✓" : "✗"}</span>
                  <span><b>{c.type}</b> {c.required && <span className="req">required</span>} <span className="muted">{c.detail}</span></span>
                </li>
              ))}
            </ul>
          ) : <div className="muted">{t.checks ? "No checks for this task." : "Not graded yet."}</div>}
        </div>
        <div className="card">
          <h3>Judgment</h3>
          {t.judgment ? (
            <>
              <div>{t.judgment.reasoning}</div>
              <div className="muted small" style={{ marginTop: 6 }}>
                {t.judgment.source === "judge" ? `${t.judgment.judgeModel} · ${compact(t.judgment.judgeTokensWeighted)} w-tokens (not counted against the arm)` : t.judgment.source.replace("_", " ")}
              </div>
            </>
          ) : <div className="muted">Not graded yet.</div>}
        </div>
      </div>

      {t.tokens && Object.keys(t.tokens).length > 0 && (
        <>
          <h2>Token usage by model</h2>
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead><tr><th>model</th><th className="num">input</th><th className="num">cache write</th><th className="num">cache read</th><th className="num">output</th><th className="num">raw total</th><th className="num">weighted</th></tr></thead>
              <tbody>
                {Object.entries(t.tokens).map(([model, u]) => (
                  <tr key={model}>
                    <td>{model}</td><td className="num">{num(u.input)}</td><td className="num">{num(u.cacheCreation)}</td><td className="num">{num(u.cacheRead)}</td>
                    <td className="num">{num(u.output)}</td><td className="num">{num(u.total)}</td><td className="num"><b>{num(u.weighted)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>Weighted = input ×1 + cache write ×1.25 + cache read ×0.1 + output ×5. Side-model calls (e.g. WebFetch's summarizer) are included.</div>
        </>
      )}

      <h2>Transcript {live && <span className="pill running" style={{ marginLeft: 6 }}><span className="dot" />live</span>}</h2>
      {data.items.length ? <Transcript items={data.items} live={live} /> : <div className="empty">{live ? "Waiting for the agent to start…" : "No events recorded."}</div>}
    </>
  );
}
