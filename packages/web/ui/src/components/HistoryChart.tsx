import { useMemo, useRef, useState } from "react";
import type { HistoryPoint } from "../types.ts";
import { ciText, score, when } from "../format.ts";
import { useTooltip } from "./Tooltip.tsx";

/** Fixed categorical slots; color follows the model name (sorted), never its rank. */
const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

interface Props {
  points: HistoryPoint[];
}

/**
 * Arena Score per run over time, one line per model (max 3 series — the validated set),
 * with 95% CI whiskers. Crosshair snaps to the nearest run; a table view sits below.
 */
export function HistoryChart({ points }: Props) {
  const runs = useMemo(() => [...points].filter((p) => p.byModel.length).sort((a, b) => a.started_at.localeCompare(b.started_at)), [points]);
  const models = useMemo(() => [...new Set(runs.flatMap((r) => r.byModel.map((a) => a.key)))].sort().slice(0, SERIES.length), [runs]);
  const tip = useTooltip();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  if (runs.length === 0) return <div className="empty">No graded runs yet.</div>;

  // Coordinate width ≈ rendered width, so SVG text renders near its nominal size.
  const W = 1150, H = 320, m = { l: 52, r: 200, t: 16, b: 36 };
  const vals = runs.flatMap((r) => r.byModel.flatMap((a) => [a.score, ...(a.ci ?? [])]));
  const lo = Math.min(-0.25, ...vals), hi = Math.max(0.25, ...vals);
  const step = hi - lo > 1 ? 0.5 : 0.25;
  const yMin = Math.floor(lo / step) * step, yMax = Math.ceil(hi / step) * step;
  const x = (i: number) => (runs.length === 1 ? m.l + (W - m.l - m.r) / 2 : m.l + (i * (W - m.l - m.r)) / (runs.length - 1));
  const y = (v: number) => m.t + ((yMax - v) * (H - m.t - m.b)) / (yMax - yMin);
  const ticks: number[] = [];
  for (let v = yMin; v <= yMax + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);

  const series = models.map((model, si) => ({
    model,
    color: SERIES[si],
    pts: runs.flatMap((r, i) => {
      const a = r.byModel.find((b) => b.key === model);
      return a ? [{ i, a }] : [];
    }),
  }));

  const onMove = (e: React.PointerEvent) => {
    const box = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    runs.forEach((_, i) => { if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i; });
    setHover(best);
    const r = runs[best];
    tip.show(e, (
      <>
        <div className="tl">{when(r.started_at)} · axi {r.axi_version ?? "?"} · effort {r.effort} · n={r.trials}</div>
        {series.map((s) => {
          const a = r.byModel.find((b) => b.key === s.model);
          return a ? (
            <div className="row" key={s.model}>
              <span className="key" style={{ background: s.color }} />
              <span className="tv">{score(a.score)}</span>
              <span className="tl">{s.model}</span>
            </div>
          ) : null;
        })}
      </>
    ));
  };

  return (
    <div>
      {models.length > 1 && (
        <div className="legend" style={{ marginTop: 0, marginBottom: 8 }}>
          {series.map((s) => (
            <span key={s.model} className="row-gap">
              <svg width="16" height="8" aria-hidden="true"><line x1="0" y1="4" x2="16" y2="4" stroke={s.color} strokeWidth="2" /></svg>
              {s.model}
            </span>
          ))}
        </div>
      )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="Arena Score by run"
        onPointerMove={onMove}
        onPointerLeave={() => { setHover(null); tip.hide(); }}
        style={{ touchAction: "none" }}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth={1} />
            <text x={m.l - 8} y={y(v) + 4} fontSize={11} textAnchor="end" fill="var(--ink-muted)" style={{ fontVariantNumeric: "tabular-nums" }}>
              {v === 0 ? "0" : `${v > 0 ? "+" : "−"}${Math.round(Math.abs(v) * 100)}`}
            </text>
          </g>
        ))}
        <text x={m.l - 8} y={y(0) - 8} fontSize={10} textAnchor="end" fill="var(--ink-muted)">parity</text>
        {runs.map((r, i) => (
          <text key={r.id} x={x(i)} y={H - 14} fontSize={11} textAnchor="middle" fill="var(--ink-muted)">
            {runs.length <= 8 || i % Math.ceil(runs.length / 8) === 0 ? when(r.started_at) : ""}
          </text>
        ))}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={H - m.b} stroke="var(--axis)" strokeWidth={1} />}
        {series.map((s) => (
          <g key={s.model}>
            {s.pts.map(({ i, a }) =>
              a.ci ? <line key={`ci${i}`} x1={x(i)} x2={x(i)} y1={y(a.ci[0])} y2={y(a.ci[1])} stroke={s.color} strokeWidth={1.5} opacity={0.45} /> : null,
            )}
            <polyline
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={s.pts.map(({ i, a }) => `${x(i)},${y(a.score)}`).join(" ")}
            />
            {s.pts.map(({ i, a }) => (
              <circle key={i} cx={x(i)} cy={y(a.score)} r={4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
            ))}
            {s.pts.length > 0 && (() => {
              const last = s.pts[s.pts.length - 1];
              return (
                <text x={x(last.i) + 10} y={y(last.a.score) + 4} fontSize={12} fill="var(--ink)">
                  {score(last.a.score)} <tspan fill="var(--ink-2)">{s.model}</tspan>
                </text>
              );
            })()}
          </g>
        ))}
      </svg>
      {tip.node}
      <details style={{ marginTop: 8 }}>
        <summary>Table view</summary>
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr><th>run</th><th>axi version</th><th>model</th><th className="num">score</th><th className="num">95% CI</th></tr>
          </thead>
          <tbody>
            {runs.flatMap((r) =>
              r.byModel.map((a) => (
                <tr key={r.id + a.key}>
                  <td><a href={`#/runs/${r.id}`}>{when(r.started_at)}</a></td>
                  <td>{r.axi_version ?? "–"}</td>
                  <td>{a.key}</td>
                  <td className="num">{score(a.score)}</td>
                  <td className="num">{ciText(a.ci)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </details>
    </div>
  );
}
