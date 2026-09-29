// Display-ready transcript items from the raw SDK stream (web app trial view).
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export type TranscriptItem =
  | { kind: "init"; seq: number; model: string; tools: string[]; skills: string[] }
  | { kind: "hook"; seq: number; name: string; output: string }
  | { kind: "text"; seq: number; text: string }
  | { kind: "tool_call"; seq: number; id: string; name: string; input: unknown }
  | {
      kind: "tool_result";
      seq: number;
      id: string;
      isError: boolean;
      escape: boolean;
      text: string;
      chars: number;
      /** Rough size (chars / 4). The scored token numbers come from SDK usage, not this. */
      approxTokens: number;
    }
  | {
      kind: "result";
      seq: number;
      subtype: string;
      text: string | null;
      turns: number;
      durationMs: number;
    };

const LOCKDOWN_MARKER = "arena lockdown:";
const MAX_RESULT_CHARS = 20_000;

function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" ? ("text" in c ? String(c.text) : `[${String((c as { type?: unknown }).type)}]`) : ""))
      .join("\n");
  }
  return "";
}

/** Converts messages (with their stored sequence numbers) into transcript items. */
export function transcriptItems(events: { seq: number; msg: SDKMessage }[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const { seq, msg: m } of events) {
    if (m.type === "system" && m.subtype === "init") {
      items.push({ kind: "init", seq, model: m.model, tools: m.tools, skills: m.skills ?? [] });
    } else if (m.type === "system" && m.subtype === "hook_response") {
      const h = m as unknown as { hook_name?: string; output?: string };
      items.push({ kind: "hook", seq, name: h.hook_name ?? "hook", output: (h.output ?? "").trim() });
    } else if (m.type === "assistant") {
      for (const b of m.message.content) {
        if (b.type === "text" && b.text.trim()) items.push({ kind: "text", seq, text: b.text });
        if (b.type === "tool_use") items.push({ kind: "tool_call", seq, id: b.id, name: b.name, input: b.input });
      }
    } else if (m.type === "user" && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (typeof b !== "object" || b.type !== "tool_result") continue;
        const full = toText(b.content);
        items.push({
          kind: "tool_result",
          seq,
          id: b.tool_use_id,
          isError: b.is_error === true,
          escape: b.is_error === true && full.includes(LOCKDOWN_MARKER),
          text: full.length > MAX_RESULT_CHARS ? `${full.slice(0, MAX_RESULT_CHARS)}\n… [${full.length - MAX_RESULT_CHARS} more chars]` : full,
          chars: full.length,
          approxTokens: Math.round(full.length / 4),
        });
      }
    } else if (m.type === "result") {
      items.push({
        kind: "result",
        seq,
        subtype: m.subtype,
        text: m.subtype === "success" ? m.result : null,
        turns: m.num_turns,
        durationMs: m.duration_ms,
      });
    }
  }
  return items;
}
