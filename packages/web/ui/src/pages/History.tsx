import { useJson } from "../api.ts";
import type { HistoryPoint } from "../types.ts";
import { ciText, score, when } from "../format.ts";
import { Loading, StatusPill } from "../components/common.tsx";
import { HistoryChart } from "../components/HistoryChart.tsx";

export function HistoryPage({ pack }: { pack: string }) {
  const { data, error } = useJson<HistoryPoint[]>(`/api/packs/${encodeURIComponent(pack)}/history`);
  if (!data) return <Loading error={error} />;
  const efforts = new Set(data.map((d) => d.effort));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{pack}</h1>
          <div className="sub">Arena Score across runs and AXI versions · 0 = parity with native, above 0 = AXI better</div>
        </div>
      </div>
      {efforts.size > 1 && (
        <div className="card small" style={{ marginBottom: 12 }}>
          ⚠ These runs use different effort levels ({[...efforts].join(", ")}), which changes token use, so compare them with care.
        </div>
      )}
      <div className="card">
        <HistoryChart points={data} />
      </div>
      <h2>Runs</h2>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr><th>started</th><th>status</th><th>axi version</th><th>models</th><th>effort</th><th className="num">score</th><th className="num">95% CI</th></tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id}>
                <td><a href={`#/runs/${r.id}`}>{when(r.started_at)}</a></td>
                <td><StatusPill status={r.status} /></td>
                <td>{r.axi_version ?? "–"}</td>
                <td className="small">{r.models?.join(", ")}</td>
                <td>{r.effort}</td>
                <td className="num"><b>{r.overall ? score(r.overall.score) : "–"}</b></td>
                <td className="num muted">{r.overall ? ciText(r.overall.ci) : "not graded"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
