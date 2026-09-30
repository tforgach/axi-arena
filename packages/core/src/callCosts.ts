// Measured token cost per tool call. Each API call's prompt size (input + cache write + cache
// read) grows by exactly what the previous tool results — plus the model's own call text —
// added to the context, so the growth between consecutive calls is the call's actual cost.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_HARMLESS_COMMANDS, splitSegments } from "./bashGuard.ts";

/** Below this, a same-model residual is accounting noise, not a side call. */
const SAME_MODEL_SIDE_MIN = 200;

/** Tools whose work runs on a side model (its tokens appear in modelUsage, not in the context). */
const SIDE_MODEL_TOOLS = new Set(["WebFetch", "WebSearch", "Task", "Agent"]);

export interface CallCost {
  /** Tokens this call's result added to the prompt of the next API call (measured). */
  contextTokens: number | null;
  /** Side-model tokens attributed to this call (e.g. WebFetch's summarizer), split evenly. */
  sideTokens: number;
}

export interface CostBreakdown {
  /** Prompt size of the first API call: system prompt, tool definitions, skills, hooks. */
  baseContext: number | null;
  /** Prompt size of the last API call. */
  finalContext: number | null;
  calls: Record<string, CallCost>;
}

interface ApiCall {
  id: string;
  context: number;
  toolUseIds: string[];
}

function toolResultChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) return content.reduce((n, c) => n + (c && typeof c === "object" && "text" in c ? String(c.text).length : 0), 0);
  return 0;
}

export function callCosts(messages: SDKMessage[]): CostBreakdown {
  const calls: ApiCall[] = [];
  const byMsgId = new Map<string, ApiCall>();
  const chars = new Map<string, number>();
  const toolNames = new Map<string, string>();
  let mainModel: string | null = null;
  let result: Extract<SDKMessage, { type: "result" }> | null = null;

  for (const m of messages) {
    if (m.type === "system" && m.subtype === "init") mainModel = m.model;
    if (m.type === "assistant") {
      // Streamed content blocks of one API response share a message id and usage.
      const id = m.message.id;
      let call = byMsgId.get(id);
      if (!call) {
        const u = m.message.usage;
        call = { id, context: (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0), toolUseIds: [] };
        byMsgId.set(id, call);
        calls.push(call);
      }
      for (const b of m.message.content) {
        if (b.type === "tool_use") {
          call.toolUseIds.push(b.id);
          toolNames.set(b.id, b.name);
        }
      }
    } else if (m.type === "user" && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (typeof b === "object" && b.type === "tool_result") chars.set(b.tool_use_id, toolResultChars(b.content));
      }
    } else if (m.type === "result") {
      result = m;
    }
  }

  const out: Record<string, CallCost> = {};
  calls.forEach((call, i) => {
    const next = calls[i + 1];
    const growth = next ? Math.max(0, next.context - call.context) : null;
    // Several parallel tool calls in one response: split the growth by result size.
    const total = call.toolUseIds.reduce((n, id) => n + (chars.get(id) ?? 0), 0);
    for (const id of call.toolUseIds) {
      const share = total > 0 ? (chars.get(id) ?? 0) / total : 1 / call.toolUseIds.length;
      out[id] = { contextTokens: growth == null ? null : Math.round(growth * share), sideTokens: 0 };
    }
  });

  // Attribute side-model usage to side-model tool calls (e.g. WebFetch's summarizer). Other
  // models count whole. On the trial's own model, side calls are whatever its input usage
  // exceeds the main loop's calls by (per-message usage covers every main-loop call; its input
  // side is exact, while streamed output counts are partial, so only input is compared).
  if (result && mainModel) {
    const usage = Object.entries(result.modelUsage ?? {});
    const inputOf = (u: (typeof usage)[number][1]) => (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
    // The main loop's entry: an exact match of the session model, else the largest related entry.
    // A dated variant (claude-haiku-4-5-20251001 next to claude-haiku-4-5) is a separate
    // side-model call, e.g. WebFetch's summarizer, not the main loop.
    const related = usage.filter(([m]) => mainModel.startsWith(m) || m.startsWith(mainModel));
    const mainKey =
      usage.find(([m]) => m === mainModel)?.[0] ??
      related.sort((a, b) => inputOf(b[1]) - inputOf(a[1]))[0]?.[0];
    const mainLoopInput = calls.reduce((n, c) => n + c.context, 0);
    let side = 0;
    for (const [model, u] of usage) {
      const input = inputOf(u);
      if (model !== mainKey) side += input + (u.outputTokens ?? 0);
      else if (input - mainLoopInput > SAME_MODEL_SIDE_MIN) side += input - mainLoopInput;
    }
    const sideCalls = [...toolNames].filter(([, name]) => SIDE_MODEL_TOOLS.has(name)).map(([id]) => id);
    if (side > 0 && sideCalls.length) for (const id of sideCalls) out[id]!.sideTokens = Math.round(side / sideCalls.length);
  }

  return { baseContext: calls[0]?.context ?? null, finalContext: calls.at(-1)?.context ?? null, calls: out };
}

/**
 * A short, comparable label for a tool call: the tool, or for Bash the program plus its flags
 * (skipping harmless helpers, so `cd x && axi-fetch u --full` is `axi-fetch --full`).
 */
export function commandLabel(name: string, input: unknown): string {
  if (name !== "Bash") return name;
  const raw = String((input as { command?: unknown })?.command ?? "").trim();
  const segs = splitSegments(raw) ?? [raw];
  const cmd = segs.find((s) => !DEFAULT_HARMLESS_COMMANDS.includes(s.split(/\s+/)[0])) ?? segs[0] ?? raw;
  const first = cmd.split(/\s+/)[0] ?? "";
  const program = first.includes("/") ? first.slice(first.lastIndexOf("/") + 1) : first;
  const flags = [...cmd.matchAll(/(?:^|\s)(--?[a-zA-Z][\w-]*)/g)].map((m) => m[1]).filter((f, i, a) => a.indexOf(f) === i);
  return [program, ...flags].join(" ") || "Bash";
}
