import { useEffect, useState } from "react";
import { getJson } from "../api.ts";
import type { RunListItem } from "../types.ts";
import { ciText, duration, score, when } from "../format.ts";
import { Loading, StatusPill } from "../components/common.tsx";
import { navigate } from "../router.ts";

export function RunsPage() {
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refresh while any run is in progress so new runs and progress show up.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const load = () =>
      getJson<RunListItem[]>("/api/runs")
        .then((r) => {
          if (cancelled) return;
          setRuns(r);
          timer = setTimeout(load, r.some((x) => x.status === "running") ? 2000 : 10000);
        })
        .catch((e) => !cancelled && setError(String(e.message ?? e)));
    load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  if (!runs) return <Loading error={error} />;
  if (runs.length === 0) {
    return (
      <div className="empty">
        No runs yet. Start one with <code>npm run arena -- run packs/axi-fetch</code>
      </div>
    );
  }
  const packs = [...new Set(runs.map((r) => r.pack_name))];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Runs</h1>
          <div className="sub">
            Packs: {packs.map((p, i) => <span key={p}>{i > 0 && ", "}<a href={`#/packs/${encodeURIComponent(p)}`}>{p}</a></span>)}
          </div>
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>started</th><th>pack</th><th>status</th><th>models</th><th className="num">trials</th>
                <th className="num">duration</th><th className="num">Arena Score</th><th className="num">95% CI</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/runs/${r.id}`)}>
                  <td><a href={`#/runs/${r.id}`} onClick={(e) => e.stopPropagation()}>{when(r.started_at)}</a></td>
                  <td>{r.pack_name} <span className="muted">{r.axi_version ?? ""}</span></td>
                  <td><StatusPill status={r.status} /></td>
                  <td className="small">{r.models.join(", ")}</td>
                  <td className="num">{r.progress.done}/{r.progress.total}</td>
                  <td className="num">{duration(r.started_at, r.finished_at)}</td>
                  <td className="num"><b>{r.overall ? score(r.overall.score) : "–"}</b></td>
                  <td className="num muted">{r.overall ? ciText(r.overall.ci) : "not graded"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
