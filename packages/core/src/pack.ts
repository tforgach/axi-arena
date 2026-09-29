import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const HookEvent = z.enum(["SessionStart", "PreToolUse", "PostToolUse", "Stop", "UserPromptSubmit"]);

export const ArmSchema = z.object({
  /** Tools that exist at all in this arm (SDK `tools`). */
  tools: z.array(z.string()).min(1),
  /** Permission rules that are approved, e.g. `Bash(axi-fetch:*)`. Everything else is denied. */
  allow: z.array(z.string()).default([]),
  /** Explicit deny rules, e.g. `Bash(axi-fetch update:*)`. */
  deny: z.array(z.string()).default([]),
  /** Skill directories (each containing SKILL.md), relative to the pack. */
  skills: z.array(z.string()).default([]),
  /** Hook scripts, relative to the pack. Their output counts against this arm. */
  hooks: z.partialRecord(HookEvent, z.string()).default({}),
  /** MCP servers passed straight to the SDK. */
  mcp_servers: z.record(z.string(), z.any()).default({}),
  /** Extra PATH entries (relative to the pack), prepended. */
  path: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});
export type Arm = z.infer<typeof ArmSchema>;

const CheckSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("equals"), value: z.string(), required: z.boolean().default(false) }),
  z.object({ type: z.literal("contains"), value: z.string(), ignore_case: z.boolean().default(true), required: z.boolean().default(false) }),
  z.object({ type: z.literal("regex"), pattern: z.string(), flags: z.string().default("i"), required: z.boolean().default(false) }),
  z.object({ type: z.literal("json_path"), path: z.string(), equals: z.unknown(), required: z.boolean().default(false) }),
  z.object({ type: z.literal("tool_called"), min: z.number().int().default(1), max: z.number().int().optional(), required: z.boolean().default(false) }),
  z.object({ type: z.literal("no_escape"), required: z.boolean().default(false) }),
  z.object({ type: z.literal("script"), run: z.string(), required: z.boolean().default(false) }),
]);
export type Check = z.infer<typeof CheckSchema>;

const Network = z.enum(["replay", "record", "live"]);

export const TaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "task ids are kebab-case"),
  prompt: z.string().min(1),
  tags: z.array(z.string()).default([]),
  network: Network.optional(),
  sequential: z.boolean().optional(),
  checks: z.array(CheckSchema).default([]),
  judge: z.object({ rubric: z.string(), reference: z.string().optional() }).optional(),
  before: z.string().optional(),
  after: z.string().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof Effort>;

export const ManifestSchema = z.object({
  name: z.string(),
  version: z.string().default("0.0.0"),
  axi_version_cmd: z.string().optional(),
  setup: z.string().optional(),
  teardown: z.string().optional(),
  sequential: z.boolean().default(false),
  defaults: z
    .object({
      trials: z.number().int().positive().default(3),
      models: z.array(z.string()).min(1).default(["claude-sonnet-5-5"]),
      max_turns: z.number().int().positive().default(30),
      timeout_s: z.number().positive().default(300),
      effort: Effort.default("medium"),
      network: Network.default("live"),
      judge_model: z.string().default("claude-haiku-4-5"),
    })
    .prefault({}),
  scoring: z
    .object({
      weights: z
        .object({ tokens: z.number(), turns: z.number(), time: z.number(), errors: z.number() })
        .default({ tokens: 0.4, turns: 0.2, time: 0.2, errors: 0.2 }),
      gate: z
        .object({ min_correctness: z.number(), max_regression: z.number() })
        .default({ min_correctness: 0.8, max_regression: 0.05 }),
    })
    .prefault({}),
  arms: z.record(z.string(), ArmSchema).refine((a) => "axi" in a, "arms must include an `axi` arm").refine(
    (a) => Object.keys(a).length >= 2,
    "arms need at least one baseline besides `axi`",
  ),
  tasks: z.array(TaskSchema).default([]),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export interface Pack extends Manifest {
  dir: string;
}

export class PackError extends Error {}

/** Load `arena.yaml` plus `tasks/*.yaml` from a pack directory, validating everything. */
export function loadPack(dirArg: string): Pack {
  const dir = resolve(dirArg);
  const manifestPath = join(dir, "arena.yaml");
  if (!existsSync(manifestPath)) throw new PackError(`no arena.yaml in ${dir}`);

  const raw = parseYaml(readFileSync(manifestPath, "utf8")) ?? {};
  const taskDir = join(dir, "tasks");
  const fileTasks: unknown[] = [];
  if (existsSync(taskDir)) {
    for (const f of readdirSync(taskDir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
      fileTasks.push(parseYaml(readFileSync(join(taskDir, f), "utf8")));
    }
  }
  raw.tasks = [...(raw.tasks ?? []), ...fileTasks];

  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PackError(`invalid pack ${dir}:\n${z.prettifyError(parsed.error)}`);
  }
  const pack: Pack = { ...parsed.data, dir };
  validateReferences(pack);
  return pack;
}

function validateReferences(pack: Pack): void {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const t of pack.tasks) {
    if (ids.has(t.id)) problems.push(`duplicate task id: ${t.id}`);
    ids.add(t.id);
  }
  if (pack.tasks.length === 0) problems.push("pack has no tasks");

  const mustExist = (rel: string | undefined, what: string, kind: "file" | "dir" = "file") => {
    if (!rel) return;
    const p = packPath(pack, rel);
    if (!existsSync(p)) problems.push(`${what}: ${rel} does not exist`);
    else if (kind === "dir" && !statSync(p).isDirectory()) problems.push(`${what}: ${rel} is not a directory`);
  };
  mustExist(pack.setup, "setup");
  mustExist(pack.teardown, "teardown");
  for (const [name, arm] of Object.entries(pack.arms)) {
    for (const s of arm.skills) {
      mustExist(s, `arms.${name}.skills`, "dir");
      if (existsSync(packPath(pack, s)) && !existsSync(join(packPath(pack, s), "SKILL.md"))) {
        problems.push(`arms.${name}.skills: ${s} has no SKILL.md`);
      }
    }
    for (const [ev, script] of Object.entries(arm.hooks)) mustExist(script, `arms.${name}.hooks.${ev}`);
  }
  for (const t of pack.tasks) {
    mustExist(t.before, `tasks.${t.id}.before`);
    mustExist(t.after, `tasks.${t.id}.after`);
  }
  if (problems.length) throw new PackError(`invalid pack ${pack.dir}:\n  - ${problems.join("\n  - ")}`);
}

export function packPath(pack: Pack, rel: string): string {
  return isAbsolute(rel) ? rel : join(pack.dir, rel);
}

export function baselineArms(pack: Pack): string[] {
  return Object.keys(pack.arms).filter((a) => a !== "axi");
}
