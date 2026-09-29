import type { Match } from "../types.ts";
import { ciText, pct, relDelta, score } from "../format.ts";
import { useTooltip } from "./Tooltip.tsx";

/**
 * Diverging fill for an Arena Score: blue = AXI better, red = worse, gray = parity.
 * Mixed in OKLCH from the neutral midpoint, so lightness is monotonic along each arm.
 * Magnitude saturates at ±100; gate failures (which can go below −100) are marked separately.
 */
export function divergingFill(s: number): { background: string; strong: boolean } {
  const t = Math.max(-1, Math.min(1, s));
  const pole = t >= 0 ? "var(--div-pos)" : "var(--div-neg)";
  const p = Math.round(Math.abs(t) * 100);
  return { background: `color-mix(in oklch, ${pole} ${p}%, var(--div-mid))`, strong: Math.abs(t) > 0.5 };
}

export function DivergingLegend() {
  return (
    <div className="legend" aria-hidden="true">
      <span>AXI worse</span>
      <span
        className="ramp"
        style={{ background: "linear-gradient(90deg in oklch, var(--div-neg), var(--div-mid), var(--div-pos))" }}
      />
      <span>AXI better</span>
      <span className="muted">· −100 · 0 parity · +100 · ✗ failed correctness gate · n.s. = 95% CI includes 0</span>
    </div>
  );
}

interface Props {
  matches: Match[];
  href: (m: Match) => string;
}

/** Tasks × (model, baseline) grid. Each cell shows its score; hover adds the breakdown. */
export function ScoreGrid({ matches, href }: Props) {
  const tip = useTooltip();
  const tasks = [...new Set(matches.map((m) => m.task))].sort();
  const cols = [...new Map(matches.map((m) => [`${m.model}\u0000${m.baseline}`, { model: m.model, baseline: m.baseline }])).values()];
  const multiBaseline = new Set(cols.map((c) => c.baseline)).size > 1;
  const find = (task: string, c: (typeof cols)[number]) =>
    matches.find((m) => m.task === task && m.model === c.model && m.baseline === c.baseline);

  const breakdown = (m: Match) => (
    <>
      <div className="tv">{score(m.score)}</div>
      <div className="tl">{m.task} · {m.model} vs {m.baseline}</div>
      <div className="spacer" style={{ height: 6 }} />
      <div>95% CI {ciText(m.ci)}</div>
      <div>correct {pct(m.axi.correctness)} / {pct(m.base.correctness)}</div>
      <div>tokens {relDelta(m.axi.tokens, m.base.tokens)} · turns {relDelta(m.axi.turns, m.base.turns)} · time {relDelta(m.axi.time, m.base.time)}</div>
      {!m.gatePassed && <div className="bad">✗ failed the correctness gate</div>}
    </>
  );

  return (
    <div className="table-wrap">
      <table className="score-grid">
        <thead>
          <tr>
            <th scope="col">task</th>
            {cols.map((c) => (
              <th scope="col" key={`${c.model}${c.baseline}`}>
                {c.model}
                {multiBaseline && <div className="muted">vs {c.baseline}</div>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task}>
              <th scope="row" className="task">{task}</th>
              {cols.map((c) => {
                const m = find(task, c);
                if (!m) return <td key={c.model + c.baseline}><span className="cell muted">–</span></td>;
                const fill = divergingFill(m.score);
                return (
                  <td key={c.model + c.baseline}>
                    <a
                      className={`cell${fill.strong ? " strong" : ""}`}
                      style={{ background: fill.background }}
                      href={href(m)}
                      aria-label={`${task}, ${c.model} vs ${c.baseline}: ${score(m.score)}${m.gatePassed ? "" : ", failed correctness gate"}`}
                      onPointerMove={(e) => tip.show(e, breakdown(m))}
                      onPointerLeave={tip.hide}
                      onFocus={(e) => tip.showAt(e.currentTarget, breakdown(m))}
                      onBlur={tip.hide}
                    >
                      <span className="v">{m.gatePassed ? "" : "✗ "}{score(m.score)}</span>
                      <span className="s">
                        <span>{pct(m.axi.correctness)} correct</span>
                        {!m.gatePassed ? <span>gate</span> : m.ci == null ? <span>n&lt;2</span> : !m.significant ? <span>n.s.</span> : null}
                      </span>
                    </a>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <DivergingLegend />
      {tip.node}
    </div>
  );
}
