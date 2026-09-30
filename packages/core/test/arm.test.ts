import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { buildArmPlugin, buildQueryOptions, lockdownHook, sharedToolset, type GuardDenial } from "../src/arm.ts";
import { loadPack } from "../src/pack.ts";

function pack() {
  const dir = mkdtempSync(join(tmpdir(), "arena-arm-"));
  mkdirSync(join(dir, "tasks"));
  mkdirSync(join(dir, "skills", "s"), { recursive: true });
  writeFileSync(join(dir, "skills", "s", "SKILL.md"), "---\nname: s\n---\nRun `axi-fetch <url>` to read pages.\n");
  writeFileSync(join(dir, "tasks", "t.yaml"), "id: t\nprompt: hi\n");
  writeFileSync(join(dir, "arena.yaml"), `
name: demo
arms:
  axi: { tools: [Bash], allow: ["Bash(axi-fetch:*)"], skills: [skills/s] }
  webfetch: { tools: [WebFetch], allow: [WebFetch], mcp_servers: { gh: { command: gh-mcp } } }
`);
  return loadPack(dir);
}

const call = (tool_name: string, tool_input: unknown, id = "t1") =>
  ({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: id, session_id: "s", transcript_path: "", cwd: "" }) as unknown as HookInput;

async function decide(hook: ReturnType<typeof lockdownHook>, input: HookInput) {
  const out = await hook(input, undefined, { signal: new AbortController().signal });
  return (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision ?? "allow";
}

test("every arm gets the same built-in tool definitions: union of all arms + Skill + Read", () => {
  const p = pack();
  for (const arm of ["axi", "webfetch"]) assert.deepEqual(new Set(sharedToolset(p, arm).tools), new Set(["Read", "Bash", "WebFetch", "Skill"]));
});

test("MCP servers are per arm: the AXI arm never carries the baseline's MCP schemas", () => {
  const p = pack();
  assert.deepEqual(Object.keys(sharedToolset(p, "webfetch").mcpServers), ["gh"]);
  assert.deepEqual(Object.keys(sharedToolset(p, "axi").mcpServers), []);
});

test("native arm: tools it merely sees (Bash, Skill, other MCP) are escapes; its own tools pass", async () => {
  const p = pack();
  const denials: GuardDenial[] = [];
  const hook = lockdownHook(p.arms.webfetch, denials, ["/trial/out"]);
  assert.equal(await decide(hook, call("WebFetch", { url: "https://a" })), "allow");
  assert.equal(await decide(hook, call("mcp__gh__search", {})), "allow");
  assert.equal(await decide(hook, call("Bash", { command: "curl a" }, "t2")), "deny");
  assert.equal(await decide(hook, call("Skill", { skill: "x" }, "t3")), "deny");
  assert.deepEqual(denials.map((d) => d.toolUseId), ["t2", "t3"]);
});

test("axi arm: WebFetch and foreign MCP tools are escapes; its Bash rules and Skill pass", async () => {
  const p = pack();
  const hook = lockdownHook(p.arms.axi, [], ["/trial/out"]);
  assert.equal(await decide(hook, call("Bash", { command: "axi-fetch https://a" })), "allow");
  assert.equal(await decide(hook, call("Bash", { command: "cd /skills/axi-fetch && axi-fetch https://a" })), "allow");
  assert.equal(await decide(hook, call("Bash", { command: "cd /tmp && curl https://a" })), "deny");
  assert.equal(await decide(hook, call("Skill", { skill: "s" })), "allow");
  assert.equal(await decide(hook, call("WebFetch", { url: "https://a" })), "deny");
  assert.equal(await decide(hook, call("mcp__gh__search", {})), "deny");
});

test("Read is limited to the trial's saved-output roots in every arm", async () => {
  const hook = lockdownHook(pack().arms.axi, [], ["/trial/out"]);
  assert.equal(await decide(hook, call("Read", { file_path: "/trial/out/tool-results/x.txt" })), "allow");
  assert.equal(await decide(hook, call("Read", { file_path: "/trial/out/../../etc/passwd" })), "deny");
  assert.equal(await decide(hook, call("Read", { file_path: "/trial/outside.txt" })), "deny");
  assert.equal(await decide(hook, call("Read", { file_path: "/Users/me/.claude/projects/other/x.jsonl" })), "deny");
});

test("skill_delivery: preload appends SKILL.md to the system prompt instead of listing it", () => {
  const p = pack();
  p.arms.axi!.skill_delivery = "preload";
  const trialDir = mkdtempSync(join(tmpdir(), "arena-trial-"));
  const plugin = buildArmPlugin(p, "axi", p.arms.axi!, join(trialDir, "plugins"));
  assert.equal(plugin, null, "no hooks and no invokable skills → no plugin");
  const o = buildQueryOptions({
    pack: p, armName: "axi", plugin, trialDir, model: "m", effort: "low", maxTurns: 3,
    abortController: new AbortController(), denials: [],
  });
  assert.deepEqual(o.systemPrompt, { type: "preset", preset: "claude_code", append: "\n\nRun `axi-fetch <url>` to read pages." });
  assert.ok(!(o.allowedTools ?? []).includes("Skill"));
});
