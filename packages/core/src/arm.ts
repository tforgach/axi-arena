// Turns a pack arm into isolated Agent SDK options. See SPEC §4.2–4.3 and the M0 findings.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { bashPrefixes, checkBash } from "./bashGuard.ts";
import { packPath, type Arm, type Effort, type Pack } from "./pack.ts";
import { arenaHome } from "./paths.ts";

export interface GuardDenial {
  toolUseId: string;
  tool: string;
  input: unknown;
  reason: string;
}

/** Name the generated plugin registers under; skills are addressed as `<plugin>:<skill>`. */
export const pluginName = (armName: string) => `arena-${armName}`;

function skillName(skillDir: string): string {
  const md = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const m = /^---\s*\n[\s\S]*?^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(md);
  return (m?.[1] ?? basename(skillDir)).trim();
}

/**
 * Materialize an arm's skills and hooks as a local plugin under `outDir`.
 * Returns the plugin path and the qualified skill names, or null if the arm has neither.
 */
export function buildArmPlugin(pack: Pack, armName: string, arm: Arm, outDir: string): { path: string; skills: string[] } | null {
  if (arm.skills.length === 0 && Object.keys(arm.hooks).length === 0) return null;
  const dir = join(outDir, pluginName(armName));
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: pluginName(armName), version: pack.version, description: `axi-arena ${pack.name}/${armName}` }, null, 2),
  );

  const skills: string[] = [];
  for (const rel of arm.skills) {
    const src = packPath(pack, rel);
    const name = skillName(src);
    cpSync(src, join(dir, "skills", name), { recursive: true });
    skills.push(`${pluginName(armName)}:${name}`);
  }

  if (Object.keys(arm.hooks).length) {
    const hooks: Record<string, unknown[]> = {};
    for (const [event, rel] of Object.entries(arm.hooks)) {
      hooks[event] = [{ hooks: [{ type: "command", command: JSON.stringify(packPath(pack, rel)) }] }];
    }
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks }, null, 2));
  }
  return { path: dir, skills };
}

const SYSTEM_PATH = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];

/** A minimal, explicit env. The SDK replaces process.env rather than merging it. */
export function trialEnv(pack: Pack, arm: Arm, trialDir: string, extra: Record<string, string> = {}): Record<string, string> {
  const path = [...arm.path.map((p) => packPath(pack, p)), dirname(process.execPath), ...SYSTEM_PATH];
  const env: Record<string, string> = {
    PATH: [...new Set(path)].join(":"),
    // Real HOME is needed for the subscription login; XDG dirs keep AXI caches per-trial.
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TMPDIR: join(trialDir, "tmp"),
    XDG_CACHE_HOME: join(trialDir, "xdg", "cache"),
    XDG_CONFIG_HOME: join(trialDir, "xdg", "config"),
    XDG_DATA_HOME: join(trialDir, "xdg", "data"),
    XDG_STATE_HOME: join(trialDir, "xdg", "state"),
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...extra,
    ...arm.env,
  };
  if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  for (const k of ["TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
    mkdirSync(env[k], { recursive: true });
  }
  return env;
}

/** PreToolUse backstop: denies anything outside the arm's allowlist and records it. */
export function lockdownHook(arm: Arm, denials: GuardDenial[]): HookCallback {
  const allow = bashPrefixes(arm.allow);
  const deny = bashPrefixes(arm.deny);
  const mcpPrefixes = Object.keys(arm.mcp_servers).map((s) => `mcp__${s}__`);
  const permitted = new Set([...arm.tools, "Skill"]);

  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const { tool_name: tool, tool_input: toolInput, tool_use_id: toolUseId } = input;
    let reason: string | null = null;
    if (tool === "Bash") {
      const cmd = String((toolInput as { command?: unknown })?.command ?? "");
      const v = checkBash(cmd, allow, deny);
      if (!v.ok) reason = v.reason;
    } else if (!permitted.has(tool) && !mcpPrefixes.some((p) => tool.startsWith(p))) {
      reason = `tool ${tool} is not available in this arm`;
    }
    if (!reason) return {};
    denials.push({ toolUseId, tool, input: toolInput, reason });
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `arena lockdown: ${reason}`,
      },
    };
  };
}

/**
 * Claude Code stores large tool outputs under ~/.claude/projects/<cwd with non-alphanumerics
 * replaced by "-">, even with persistSession: false. A per-trial CLAUDE_CONFIG_DIR would avoid
 * that but breaks subscription login (M1 finding), so we delete the folder after each trial.
 */
export function claudeProjectDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
}

export function cleanupClaudeProjectDir(cwd: string): void {
  if (!existsSync(cwd)) return;
  // Only ever delete the folder of a trial that lives inside the arena home.
  if (!realpathSync(cwd).startsWith(realpathSync(arenaHome()) + "/")) return;
  rmSync(claudeProjectDir(cwd), { recursive: true, force: true });
}

export const trialWorkDir = (trialDir: string) => join(trialDir, "work");

export interface QueryOptionsInput {
  pack: Pack;
  armName: string;
  plugin: { path: string; skills: string[] } | null;
  trialDir: string;
  model: string;
  effort: Effort;
  maxTurns: number;
  abortController: AbortController;
  denials: GuardDenial[];
  extraEnv?: Record<string, string>;
}

export function buildQueryOptions(i: QueryOptionsInput): Options {
  const arm = i.pack.arms[i.armName];
  const hasSkills = (i.plugin?.skills.length ?? 0) > 0;
  const cwd = trialWorkDir(i.trialDir);
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
  return {
    cwd,
    env: trialEnv(i.pack, arm, i.trialDir, i.extraEnv),
    model: i.model,
    effort: i.effort,
    maxTurns: i.maxTurns,
    abortController: i.abortController,
    systemPrompt: { type: "preset", preset: "claude_code" },
    // Isolation from the user's own Claude setup (M0 findings).
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    mcpServers: arm.mcp_servers,
    skills: i.plugin?.skills ?? [],
    plugins: i.plugin ? [{ type: "local", path: i.plugin.path }] : [],
    // Lockdown: only these tools exist; only these rules are approved; the rest is denied.
    tools: hasSkills ? [...new Set([...arm.tools, "Skill"])] : arm.tools,
    allowedTools: hasSkills ? [...arm.allow, "Skill"] : arm.allow,
    disallowedTools: arm.deny,
    permissionMode: "dontAsk",
    hooks: { PreToolUse: [{ hooks: [lockdownHook(arm, i.denials)] }] },
  };
}
