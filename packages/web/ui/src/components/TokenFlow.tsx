import { useJson } from "../api.ts";
import type { ArmCommands } from "../types.ts";
import { num } from "../format.ts";

/** Mirrors core's SIDE_MODEL_TOOLS: tools whose work runs on a separate model call. */
const SIDE_MODEL_TOOLS = ["WebFetch", "WebSearch", "Task", "Agent"];

/**
 * Where each arm's tokens went in one match, measured from per-call usage: the starting
 * context (system prompt, tools, skills, hooks), then what each kind of command added.
 * One bar scale across both arms so their lengths compare directly; values are always labeled.
 */
export function TokenFlow({ runId, task, model, arms }: { runId: string; task: string; model: string; arms: string[] }) {
  const { data, error } = useJson<Record<string, ArmCommands>>(
    `/api/runs/${runId}/commands?task=${encodeURIComponent(task)}&model=${encodeURIComponent(model)}`,
  );
  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <div className="muted">Measuring…</div>;

  const perTrial = (c: ArmCommands["commands"][number]) => (c.contextTokens ?? 0) * c.callsPerTrial + (c.sideTokens ?? 0) * c.callsPerTrial;
  const max = Math.max(
    1,
    ...arms.flatMap((a) => [data[a]?.baseContext ?? 0, ...(data[a]?.commands ?? []).map(perTrial)]),
  );
  const Bar = ({ value }: { value: number }) => (
    <div style={{ height: 8, background: "var(--surface-2)", borderRadius: 4, minWidth: 80 }}>
      <div style={{ width: `${Math.max(1, (value / max) * 100)}%`, height: 8, background: "var(--series-1)", borderRadius: 4 }} />
    </div>
  );

  return (
    <div className="grid-2">
      {arms.map((arm) => {
        const a = data[arm];
        if (!a) return <div key={arm} className="card muted">No finished trials for {arm}.</div>;
        return (
          <div key={arm} className="card" style={{ padding: 0 }}>
            <div style={{ padding: "12px 16px 0" }}><h3>{arm}</h3></div>
            <table>
              <thead>
                <tr>
                  <th>where</th><th className="num">calls/trial</th><th className="num">+tokens/call</th><th className="num">per trial</th><th style={{ width: "30%" }} />
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Starting context <div className="muted small">system prompt, tools, skills, hooks</div></td>
                  <td className="num">–</td><td className="num">–</td>
                  <td className="num"><b>{num(a.baseContext)}</b></td>
                  <td><Bar value={a.baseContext ?? 0} /></td>
                </tr>
                {a.commands.map((c) => (
                  <tr key={c.label}>
                    <td className="mono">{c.label}{c.sideTokens ? <div className="muted small">+{num(c.sideTokens)} on a side model per call</div> : null}</td>
                    <td className="num">{num(c.callsPerTrial, 1)}</td>
                    <td className="num">{c.contextTokens == null ? "–" : `+${num(c.contextTokens)}`}</td>
                    <td className="num"><b>{num(perTrial(c))}</b></td>
                    <td><Bar value={perTrial(c)} /></td>
                  </tr>
                ))}
                <tr>
                  <td className="muted">Final context (median)</td>
                  <td /><td /><td className="num muted">{num(a.finalContext)}</td><td />
                </tr>
              </tbody>
            </table>
            {a.commands.some((c) => SIDE_MODEL_TOOLS.includes(c.label) && !c.sideTokens) && (
              <div className="small" style={{ padding: "0 16px 8px" }}>
                ⚠ {a.commands.filter((c) => SIDE_MODEL_TOOLS.includes(c.label)).map((c) => c.label).join(", ")} normally runs its own model call, but none
                was found in this arm's usage, so its side cost may be missing here. It is still counted in the session totals.
              </div>
            )}
            <div className="muted small" style={{ padding: "0 16px 12px" }}>
              Medians over {a.trials} trial(s). “+tokens/call” is measured: how much the next API call's prompt grew. The score uses these
              tool tokens (plus any starting context beyond the other arm's); extra turns are scored separately.
            </div>
          </div>
        );
      })}
    </div>
  );
}
