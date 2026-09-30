// Arena-wide config (~/.axi-arena/config.yaml): credentials, model aliases, pack registry.
// Trials never load the user's Claude settings wholesale (SPEC §4.2); only the auth- and
// provider-related parts are imported here, so work setups (apiKeyHelper, Bedrock, Vertex,
// gateways) authenticate the same way they do in Claude Code.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { arenaHome } from "./paths.ts";

export const ConfigSchema = z
  .object({
    auth: z
      .object({
        /** Import apiKeyHelper, cloud-auth helpers, provider env and modelOverrides from ~/.claude/settings.json. */
        import_claude_settings: z.boolean().default(true),
        /** Explicit helper script that prints an API key (Claude Code's apiKeyHelper). */
        api_key_helper: z.string().optional(),
        /** Extra env for every trial and the judge (e.g. CLAUDE_CODE_USE_BEDROCK, AWS_PROFILE). */
        env: z.record(z.string(), z.string()).default({}),
        /** Extra variable names copied from your shell, beyond the built-in auth/provider list. */
        env_passthrough: z.array(z.string()).default([]),
      })
      .prefault({}),
    models: z
      .object({
        /** Friendly names → model IDs, e.g. { sonnet: claude-sonnet-5-5 }. Unknown names pass through. */
        aliases: z.record(z.string(), z.string()).default({}),
        /** Anthropic model ID → provider model ID (Claude Code's modelOverrides), per provider. */
        providers: z.record(z.string(), z.record(z.string(), z.string())).default({}),
      })
      .prefault({}),
    /** Pack registry: name → directory, so `axi-arena run jira` works. */
    packs: z.record(z.string(), z.string()).default({}),
  })
  .prefault({});
export type ArenaConfig = z.infer<typeof ConfigSchema>;

export function configPath(): string {
  return process.env.AXI_ARENA_CONFIG || join(arenaHome(), "config.yaml");
}

export function loadConfig(path = configPath()): ArenaConfig {
  if (!existsSync(path)) return ConfigSchema.parse({});
  const parsed = ConfigSchema.safeParse(parseYaml(readFileSync(path, "utf8")) ?? {});
  if (!parsed.success) throw new Error(`invalid ${path}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

// ─── credentials ────────────────────────────────────────────────────────────────

/** Auth/provider variables copied from the shell into trials (exact names). */
const AUTH_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_MODEL", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "CLAUDE_CODE_SKIP_VERTEX_AUTH", "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT",
];
/** …and any variable with these prefixes (AWS profiles/keys, per-model regions, default-model pins). */
const AUTH_ENV_PREFIXES = ["AWS_", "VERTEX_REGION_", "ANTHROPIC_DEFAULT_", "ANTHROPIC_FOUNDRY_", "AZURE_"];

export const isAuthEnv = (name: string, extra: string[] = []) =>
  AUTH_ENV.includes(name) || extra.includes(name) || AUTH_ENV_PREFIXES.some((p) => name.startsWith(p));

/** Settings keys that only concern authentication and model routing. */
const AUTH_SETTINGS_KEYS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh", "proxyAuthHelper"] as const;

export type Provider = "anthropic" | "bedrock" | "vertex" | "foundry";

export interface AuthSetup {
  /** Env merged into every trial/judge env (never overrides arena isolation vars). */
  env: Record<string, string>;
  /** Flag-tier settings for the SDK: credential helpers + modelOverrides. */
  settings: Record<string, unknown>;
  provider: Provider;
  /** Human-readable list of what was picked up, for the pre-run summary. */
  sources: string[];
  /** Corporate egress proxy from the shell (the replay proxy chains through it). */
  upstreamProxy: string | null;
  noProxy: string[];
  /** Extra CA file(s) from the shell (merged with the replay CA). */
  extraCaFile: string | null;
}

function readClaudeSettings(): Record<string, unknown> {
  const p = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

export function detectProvider(env: Record<string, string | undefined>): Provider {
  const on = (k: string) => env[k] && env[k] !== "0" && env[k] !== "false";
  if (on("CLAUDE_CODE_USE_BEDROCK")) return "bedrock";
  if (on("CLAUDE_CODE_USE_VERTEX")) return "vertex";
  if (on("CLAUDE_CODE_USE_FOUNDRY")) return "foundry";
  return "anthropic";
}

export function resolveAuth(config: ArenaConfig, shell: NodeJS.ProcessEnv = process.env, claudeSettings = readClaudeSettings()): AuthSetup {
  const env: Record<string, string> = {};
  const settings: Record<string, unknown> = {};
  const sources: string[] = [];
  const extra = config.auth.env_passthrough;

  for (const [k, v] of Object.entries(shell)) if (v != null && isAuthEnv(k, extra)) env[k] = v;
  if (Object.keys(env).length) sources.push(`shell env: ${Object.keys(env).sort().join(", ")}`);

  if (config.auth.import_claude_settings) {
    const picked: string[] = [];
    for (const k of AUTH_SETTINGS_KEYS) {
      if (typeof claudeSettings[k] === "string") {
        settings[k] = claudeSettings[k];
        picked.push(k);
      }
    }
    const csEnv = (claudeSettings.env ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(csEnv)) {
      if (typeof v === "string" && isAuthEnv(k, extra) && !(k in env)) {
        env[k] = v;
        picked.push(`env.${k}`);
      }
    }
    if (claudeSettings.modelOverrides && typeof claudeSettings.modelOverrides === "object") {
      settings.modelOverrides = { ...(claudeSettings.modelOverrides as Record<string, string>) };
      picked.push("modelOverrides");
    }
    if (picked.length) sources.push(`~/.claude/settings.json: ${picked.join(", ")}`);
  }

  if (config.auth.api_key_helper) {
    settings.apiKeyHelper = config.auth.api_key_helper;
    sources.push("arena config: api_key_helper");
  }
  if (Object.keys(config.auth.env).length) {
    Object.assign(env, config.auth.env);
    sources.push(`arena config env: ${Object.keys(config.auth.env).sort().join(", ")}`);
  }

  const provider = detectProvider(env);
  const overrides = config.models.providers[provider];
  if (overrides && Object.keys(overrides).length) {
    settings.modelOverrides = { ...((settings.modelOverrides as Record<string, string>) ?? {}), ...overrides };
    sources.push(`arena config: ${provider} model overrides (${Object.keys(overrides).length})`);
  }

  const upstreamProxy = shell.HTTPS_PROXY || shell.https_proxy || shell.HTTP_PROXY || shell.http_proxy || null;
  const noProxy = (shell.NO_PROXY || shell.no_proxy || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (upstreamProxy) {
    env.HTTPS_PROXY = env.HTTP_PROXY = upstreamProxy; // live mode; replay swaps in its own proxy
    if (noProxy.length) env.NO_PROXY = noProxy.join(",");
    sources.push(`egress proxy: ${redactUrl(upstreamProxy)}`);
  }
  const extraCaFile = shell.NODE_EXTRA_CA_CERTS && existsSync(shell.NODE_EXTRA_CA_CERTS) ? shell.NODE_EXTRA_CA_CERTS : null;
  if (extraCaFile) {
    env.NODE_EXTRA_CA_CERTS = extraCaFile;
    sources.push(`extra CA: ${extraCaFile}`);
  }
  if (sources.length === 0) sources.push("local Claude Code login (no API key or provider env found)");
  return { env, settings, provider, sources, upstreamProxy, noProxy, extraCaFile };
}

/** Never print proxy credentials. */
export function redactUrl(u: string): string {
  try {
    const url = new URL(u);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "";
    }
    return url.href;
  } catch {
    return "(unparseable)";
  }
}

// ─── models ─────────────────────────────────────────────────────────────────────

/**
 * Resolve a model name for the SDK. Arena aliases map friendly names to IDs; anything else
 * passes through unchanged, so Claude Code's own aliases (`sonnet`, `haiku`, `opus`) and its
 * per-provider resolution (plus modelOverrides) still apply.
 */
export function resolveModel(name: string, config: ArenaConfig): string {
  return config.models.aliases[name] ?? name;
}
