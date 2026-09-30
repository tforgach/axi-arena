import type { ReactNode } from "react";
import type { Aggregate } from "../types.ts";
import { ciText, score } from "../format.ts";

const STATUS_LABEL: Record<string, string> = {
  running: "running", done: "done", failed: "failed", aborted: "aborted", queued: "queued",
  success: "finished", max_turns: "max turns", timeout: "timed out", error: "error", setup_error: "setup error",
  cancelled: "cancelled",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`pill ${status}`}>
      <span className="dot" aria-hidden="true" />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function Correct({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="muted">–</span>;
  const ok = value >= 0.5;
  return (
    <span className={ok ? "ok" : "bad"}>
      {ok ? "✓" : "✗"} {Math.round(value * 100)}%
    </span>
  );
}

export function ScoreTile({ label, agg, hero = false }: { label: string; agg: Aggregate; hero?: boolean }) {
  const verdict = agg.ci == null ? "fewer than 2 trials per arm — no CI" : agg.significant ? "significant" : "not significant (CI includes 0)";
  return (
    <div className={`card tile${hero ? " hero" : ""}`}>
      <div className="label">{label}</div>
      <div className="value">{score(agg.score)}</div>
      <div className="note">95% CI {ciText(agg.ci)} · {verdict}</div>
      {agg.gateFailures > 0 && (
        <div className="note bad">✗ {agg.gateFailures} of {agg.matches} tasks failed the correctness gate</div>
      )}
    </div>
  );
}

export function Loading({ error, children }: { error: string | null; children?: ReactNode }) {
  if (error) return <div className="error-box">{error}</div>;
  return <div className="empty">{children ?? "Loading…"}</div>;
}
