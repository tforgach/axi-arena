// M0 (a): does the Agent SDK run on the local subscription login with an isolated env?
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd = mkdtempSync(join(tmpdir(), "arena-trial-"));

// Minimal env: the SDK replaces process.env rather than merging it.
const env = {
  PATH: "/usr/bin:/bin",
  HOME: process.env.HOME,
  USER: process.env.USER,
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
};

for await (const msg of query({
  prompt: "Reply with exactly: pong",
  options: {
    cwd, env, settingSources: [], tools: [], model: "haiku", maxTurns: 1,
    strictMcpConfig: true, mcpServers: {}, skills: [],
  },
})) {
  if (msg.type === "system" && msg.subtype === "init") {
    console.log("init:", { apiKeySource: msg.apiKeySource, model: msg.model, tools: msg.tools, skills: msg.skills, plugins: msg.plugins });
  }
  if (msg.type === "result") {
    console.log("result:", {
      subtype: msg.subtype,
      is_error: msg.is_error,
      result: msg.result,
      num_turns: msg.num_turns,
      duration_ms: msg.duration_ms,
      total_cost_usd: msg.total_cost_usd,
      modelUsage: msg.modelUsage,
    });
  }
}
