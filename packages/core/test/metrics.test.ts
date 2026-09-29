import { test } from "node:test";
import assert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { computeMetrics } from "../src/metrics.ts";

// Shapes mirror what the SDK emitted in the M0 spike; cast because we only fill the fields we read.
const msgs = [
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "curl x" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "denied" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "axi-fetch bad" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "exit 1" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "axi-fetch x" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "ok" }] } },
  {
    type: "result", subtype: "success", result: "Example Domain", num_turns: 4, duration_ms: 5000, duration_api_ms: 4000,
    total_cost_usd: 0.01, permission_denials: [{ tool_name: "Bash", tool_use_id: "t1", tool_input: {} }],
    modelUsage: {
      "claude-sonnet-5-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40 },
      "claude-haiku-4-5": { inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    },
  },
] as unknown as SDKMessage[];

test("computes tool, error, escape and token metrics", () => {
  const m = computeMetrics(msgs, [{ toolUseId: "t1", tool: "Bash", input: {}, reason: "curl" }]);
  assert.equal(m.toolCalls, 3);
  assert.equal(m.escapeAttempts, 1, "hook + permission denial of the same call count once");
  assert.equal(m.toolErrors, 1, "the denied call is an escape, not a tool error");
  assert.equal(m.errorRecoveries, 1, "t2 failed and the agent called another tool afterwards");
  assert.equal(m.tokensTotal, 370 + 1050, "sums every model, including side-model calls");
  assert.equal(m.tokensByModel["claude-haiku-4-5"].total, 1050);
  // weighted: sonnet 10*1 + 20*5 + 300*0.1 + 40*1.25 = 190; haiku 1000 + 50*5 = 1250
  assert.equal(m.tokensWeighted, 190 + 1250);
  assert.equal(m.numTurns, 4);
  assert.equal(m.resultText, "Example Domain");
  assert.equal(m.sdkSubtype, "success");
});

test("an error on the final tool call is the answer, not a recovery", () => {
  const m = computeMetrics(msgs.slice(2, 4), []); // only t2: axi-fetch exits 1, nothing after it
  assert.equal(m.toolErrors, 1);
  assert.equal(m.errorRecoveries, 0);
});

test("backstop denials are recovered from the stream's lockdown marker", () => {
  const stream = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "d", name: "Bash", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "d", is_error: true, content: "PreToolUse:Bash hook error: arena lockdown: `cat` is not allowed" }] } },
  ] as unknown as SDKMessage[];
  const m = computeMetrics(stream, []);
  assert.equal(m.escapeAttempts, 1);
  assert.equal(m.toolErrors, 0);
  assert.ok(m.deniedIds.has("d"));
});

test("handles a stream with no result message", () => {
  const m = computeMetrics(msgs.slice(0, 2), []);
  assert.equal(m.tokensTotal, null);
  assert.equal(m.tokensWeighted, null);
  assert.equal(m.resultText, null);
  assert.equal(m.sdkSubtype, null);
});
