// Derives per-trial metrics from the raw SDK message stream (SPEC §6.1).
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { GuardDenial } from "./arm.ts";

export interface ModelTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Plain sum of the four kinds. */
  total: number;
  /** Cost-weighted, in input-token equivalents (see TOKEN_WEIGHTS). */
  weighted: number;
}

/**
 * Relative prices per token kind, as multiples of the model's input price. These ratios
 * hold for every current Claude model. Cache writes use the 5-minute rate. Models are
 * summed without scaling by their absolute prices, so the score stays in token units.
 */
export const TOKEN_WEIGHTS = { input: 1, cacheCreation: 1.25, cacheRead: 0.1, output: 5 } as const;

export interface TrialMetrics {
  toolCalls: number;
  toolErrors: number;
  escapeAttempts: number;
  tokensTotal: number | null;
  /** The scored token metric: cost-weighted input-token equivalents across all models. */
  tokensWeighted: number | null;
  tokensByModel: Record<string, ModelTokens>;
  numTurns: number | null;
  durationMs: number | null;
  durationApiMs: number | null;
  costUsd: number | null;
  resultText: string | null;
  sdkSubtype: string | null;
}

export function tokensByModel(result: SDKResultMessage): Record<string, ModelTokens> {
  const out: Record<string, ModelTokens> = {};
  for (const [model, u] of Object.entries(result.modelUsage ?? {})) {
    const t = {
      input: u.inputTokens ?? 0,
      output: u.outputTokens ?? 0,
      cacheRead: u.cacheReadInputTokens ?? 0,
      cacheCreation: u.cacheCreationInputTokens ?? 0,
      total: 0,
      weighted: 0,
    };
    t.total = t.input + t.output + t.cacheRead + t.cacheCreation;
    t.weighted =
      t.input * TOKEN_WEIGHTS.input + t.cacheCreation * TOKEN_WEIGHTS.cacheCreation +
      t.cacheRead * TOKEN_WEIGHTS.cacheRead + t.output * TOKEN_WEIGHTS.output;
    out[model] = t;
  }
  return out;
}

export function computeMetrics(messages: SDKMessage[], guardDenials: GuardDenial[]): TrialMetrics {
  let toolCalls = 0;
  const erroredIds: string[] = [];
  let result: SDKResultMessage | undefined;

  for (const m of messages) {
    if (m.type === "assistant") {
      for (const b of m.message.content) if (b.type === "tool_use") toolCalls++;
    } else if (m.type === "user" && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (typeof b === "object" && b.type === "tool_result" && b.is_error) erroredIds.push(b.tool_use_id);
      }
    } else if (m.type === "result") {
      result = m;
    }
  }

  // Escapes = SDK permission denials ∪ backstop denials (hook denials aren't in permission_denials).
  const escaped = new Set<string>(guardDenials.map((d) => d.toolUseId));
  for (const d of result?.permission_denials ?? []) escaped.add(d.tool_use_id);

  const byModel = result ? tokensByModel(result) : {};
  return {
    toolCalls,
    // Denied calls also come back as error tool_results; count them once, as escapes.
    toolErrors: erroredIds.filter((id) => !escaped.has(id)).length,
    escapeAttempts: escaped.size,
    tokensTotal: result ? Object.values(byModel).reduce((s, t) => s + t.total, 0) : null,
    tokensWeighted: result ? Math.round(Object.values(byModel).reduce((s, t) => s + t.weighted, 0)) : null,
    tokensByModel: byModel,
    numTurns: result?.num_turns ?? null,
    durationMs: result?.duration_ms ?? null,
    durationApiMs: result?.duration_api_ms ?? null,
    costUsd: result?.total_cost_usd ?? null,
    resultText: result && result.subtype === "success" ? result.result : null,
    sdkSubtype: result?.subtype ?? null,
  };
}
