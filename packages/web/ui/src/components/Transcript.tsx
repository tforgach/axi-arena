import { useEffect, useRef } from "react";
import type { TranscriptItem } from "../types.ts";
import { num, secs } from "../format.ts";

function inputPreview(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === "Bash" && typeof i.command === "string") return i.command;
  if (name === "WebFetch" && typeof i.url === "string") return `${i.url}${i.prompt ? `\n→ ${String(i.prompt)}` : ""}`;
  if (name === "Read" && typeof i.file_path === "string") return i.file_path;
  if (name === "Skill" && typeof i.skill === "string") return `${i.skill}${i.args ? ` ${String(i.args)}` : ""}`;
  return JSON.stringify(input, null, 2);
}

const LONG = 1200;

/** Tool calls paired with their results, assistant text, hooks and the final answer. */
export function Transcript({ items, live }: { items: TranscriptItem[]; live: boolean }) {
  const results = new Map(items.flatMap((it) => (it.kind === "tool_result" ? [[it.id, it] as const] : [])));
  // The SDK repeats the last assistant text as the result; show it once, in the final-answer card.
  const finalText = items.find((it) => it.kind === "result")?.text?.trim();
  const end = useRef<HTMLDivElement>(null);
  const count = items.length;
  useEffect(() => {
    if (live) end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [count, live]);

  return (
    <div className="transcript">
      {items.map((it, idx) => {
        switch (it.kind) {
          case "init":
            return (
              <div key={idx} className="tx system">
                <div className="tx-body">
                  Session started on <b>{it.model}</b> · tools: {it.tools.join(", ") || "none"}
                  {it.skills.length > 0 && <> · skills: {it.skills.join(", ")}</>}
                </div>
              </div>
            );
          case "hook":
            return (
              <div key={idx} className="tx system">
                <div className="tx-head"><span className="name">{it.name}</span><span>ambient context (counts against this arm)</span></div>
                <div className="tx-body"><pre>{it.output || "(no output)"}</pre></div>
              </div>
            );
          case "text":
            if (finalText && it.text.trim() === finalText) return null;
            return <div key={idx} className="tx text"><div className="tx-body">{it.text}</div></div>;
          case "tool_call": {
            const r = results.get(it.id);
            const cls = r?.escape ? "escape" : r?.isError ? "error" : "";
            return (
              <div key={idx} className={`tx ${cls}`}>
                <div className="tx-head">
                  <span className="name">{it.name}</span>
                  {r?.escape && <span className="bad">⛔ escape attempt — denied by lockdown</span>}
                  {r && !r.escape && r.isError && <span className="bad">✗ error</span>}
                  <span className="right">
                    {r ? <span>~{num(r.approxTokens)} tok · {num(r.chars)} chars</span> : live ? <span>running…</span> : <span>no result</span>}
                  </span>
                </div>
                <div className="tx-body">
                  <pre>{inputPreview(it.name, it.input)}</pre>
                  {r && (
                    r.text.length > LONG ? (
                      <details style={{ marginTop: 8 }}>
                        <summary>output ({num(r.chars)} chars)</summary>
                        <pre style={{ marginTop: 6 }}>{r.text}</pre>
                      </details>
                    ) : (
                      <pre style={{ marginTop: 8, color: "var(--ink-2)" }}>{r.text || "(empty)"}</pre>
                    )
                  )}
                </div>
              </div>
            );
          }
          case "tool_result":
            return null; // rendered with its call
          case "result":
            return (
              <div key={idx} className="tx final">
                <div className="tx-head">
                  <span className="name">final answer</span>
                  <span className="right">{it.turns} turns · {secs(it.durationMs)} · {it.subtype}</span>
                </div>
                <div className="tx-body" style={{ whiteSpace: "pre-wrap" }}>{it.text ?? <span className="muted">(no answer)</span>}</div>
              </div>
            );
        }
      })}
      {live && <div className="muted small">● live — waiting for the agent…</div>}
      <div ref={end} />
    </div>
  );
}
