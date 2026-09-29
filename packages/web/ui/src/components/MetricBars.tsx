import type { Match, Metric } from "../types.ts";
import { num } from "../format.ts";

const LABELS: Record<Metric, string> = { tokens: "Tokens (weighted)", turns: "Turns", time: "Time", errors: "Errors + escapes" };
const METRICS: Metric[] = ["tokens", "turns", "time", "errors"];

/**
 * Diverging bars of relative improvement per metric (−1..+1, right = AXI better),
 * with each metric's weight in the score. Values are labeled; no hover needed.
 */
export function MetricBars({ match, weights }: { match: Match; weights: Record<Metric, number> }) {
  const W = 540, rowH = 34, labelW = 150, valueW = 92, pad = 6;
  const plotW = W - labelW - valueW;
  const mid = labelW + plotW / 2;
  const H = METRICS.length * rowH + 22;
  const x = (r: number) => mid + (r * plotW) / 2;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Relative improvement per metric" style={{ maxWidth: W }}>
      {[-1, -0.5, 0.5, 1].map((g) => (
        <line key={g} x1={x(g)} x2={x(g)} y1={0} y2={H - 20} stroke="var(--grid)" strokeWidth={1} />
      ))}
      {METRICS.map((m, i) => {
        const r = match.r[m];
        const y = i * rowH + pad;
        const barH = rowH - pad * 2 - 6;
        const x0 = Math.min(x(0), x(r));
        const w = Math.max(Math.abs(x(r) - x(0)), r === 0 ? 0 : 2);
        const fill = r >= 0 ? "var(--div-pos)" : "var(--div-neg)";
        return (
          <g key={m}>
            <text x={0} y={y + barH / 2 + 4} fontSize={12} fill="var(--ink)">{LABELS[m]}</text>
            <text x={0} y={y + barH / 2 + 17} fontSize={10.5} fill="var(--ink-muted)">weight {num(weights[m] * 100)}%</text>
            <rect x={x0} y={y} width={w} height={barH} rx={Math.min(4, w / 2)} fill={fill} />
            <text
              x={W}
              y={y + barH / 2 + 4}
              fontSize={12}
              textAnchor="end"
              fill="var(--ink)"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {Math.abs(r) < 0.005 ? "parity" : `${num(Math.abs(r) * 100)}% ${r > 0 ? "better" : "worse"}`}
            </text>
          </g>
        );
      })}
      <line x1={x(0)} x2={x(0)} y1={0} y2={H - 20} stroke="var(--axis)" strokeWidth={1} />
      <text x={x(-1)} y={H - 4} fontSize={10.5} fill="var(--ink-muted)" textAnchor="start">AXI worse</text>
      <text x={x(0)} y={H - 4} fontSize={10.5} fill="var(--ink-muted)" textAnchor="middle">parity</text>
      <text x={x(1)} y={H - 4} fontSize={10.5} fill="var(--ink-muted)" textAnchor="end">AXI better</text>
    </svg>
  );
}
