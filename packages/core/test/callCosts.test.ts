import { test } from "node:test";
import assert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { callCosts, commandLabel } from "../src/callCosts.ts";

const usage = (ctx: number) => ({ input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: ctx - 10, output_tokens: 3 });
const asst = (id: string, ctx: number, blocks: unknown[]) => ({ type: "assistant", message: { id, usage: usage(ctx), content: blocks } });
const result = (id: string, text: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });

test("measures each call's cost as the growth of the next prompt; splits parallel calls by size", () => {
  const msgs = [
    { type: "system", subtype: "init", model: "claude-sonnet-5-5" },
    asst("m1", 12_000, [{ type: "thinking" }]),
    asst("m1", 12_000, [{ type: "tool_use", id: "a", name: "Bash", input: { command: "axi-fetch u" } }]), // same API call, streamed
    result("a", "x".repeat(100)),
    asst("m2", 14_500, [
      { type: "tool_use", id: "b", name: "Bash", input: { command: "axi-fetch u --full" } },
      { type: "tool_use", id: "c", name: "WebFetch", input: { url: "u" } },
    ]),
    result("b", "x".repeat(300)),
    result("c", "x".repeat(100)),
    asst("m3", 18_500, [{ type: "text", text: "done" }]),
    { type: "result", modelUsage: { "claude-sonnet-5-5": { inputTokens: 1 }, "claude-haiku-4-5": { inputTokens: 900, outputTokens: 100 } } },
  ] as unknown as SDKMessage[];
  const c = callCosts(msgs);
  assert.equal(c.baseContext, 12_000);
  assert.equal(c.finalContext, 18_500);
  assert.equal(c.calls.a.contextTokens, 2_500);
  assert.equal(c.calls.b.contextTokens, 3_000, "3/4 of the 4,000 growth by result size");
  assert.equal(c.calls.c.contextTokens, 1_000);
  assert.equal(c.calls.c.sideTokens, 1_000, "haiku summarizer usage lands on the WebFetch call");
  assert.equal(c.calls.b.sideTokens, 0);
});

test("the last call before a stream ends has no measurement yet", () => {
  const c = callCosts([asst("m1", 5_000, [{ type: "tool_use", id: "a", name: "Read", input: {} }]), result("a", "x")] as unknown as SDKMessage[]);
  assert.equal(c.calls.a.contextTokens, null);
});

test("command labels group by program and flags, skipping harmless helpers", () => {
  assert.equal(commandLabel("Bash", { command: "axi-fetch https://a --full --max 3000" }), "axi-fetch --full --max");
  assert.equal(commandLabel("Bash", { command: "cd /x && /p/.bin/axi-fetch https://a" }), "axi-fetch");
  assert.equal(commandLabel("WebFetch", { url: "u" }), "WebFetch");
});
