// Preflight (SPEC §4.4): prove each model authenticates and answers, with the exact auth the
// trials will use, before any trial spends anything. One tiny call per distinct model.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { cleanupClaudeProjectDir } from "./arm.ts";
import type { AuthSetup } from "./config.ts";
import { internalEnv } from "./judge.ts";
import { arenaHome } from "./paths.ts";

export interface PreflightResult {
  model: string;
  ok: boolean;
  /** Model the session resolved to (alias/provider mapping applied). */
  modelId: string | null;
  apiKeySource: string | null;
  error: string | null;
  ms: number;
}

// Failures Claude Code reports as an ordinary "success" result text rather than an error.
const AUTH_FAILURE = /not logged in|please run \/login|invalid api key|invalid x-api-key|authentication[_ ]error|credit balance|could not load credentials|expired token|access denied|not authorized/i;

export async function preflightModel(model: string, auth?: AuthSetup, timeoutMs = 60_000): Promise<PreflightResult> {
  const started = Date.now();
  const cwd = join(arenaHome(), "preflight", randomBytes(4).toString("hex"));
  mkdirSync(cwd, { recursive: true });
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  let modelId: string | null = null;
  let apiKeySource: string | null = null;
  let error: string | null = null;
  let answered = false;
  try {
    for await (const m of query({
      prompt: "Reply with exactly: ok",
      options: {
        cwd, model, maxTurns: 1, tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {}, skills: [],
        persistSession: false, abortController, env: internalEnv(auth),
        ...(auth && Object.keys(auth.settings).length ? { settings: auth.settings } : {}),
      },
    })) {
      if (m.type === "system" && m.subtype === "init") {
        modelId = m.model;
        apiKeySource = m.apiKeySource;
      }
      if (m.type === "result") {
        const text = m.subtype === "success" ? m.result : "";
        const status = "api_error_status" in m ? m.api_error_status : null;
        if (m.is_error || m.subtype !== "success") error = `${m.subtype}${status ? ` (HTTP ${status})` : ""}${text ? `: ${text}` : ""}`;
        else if (AUTH_FAILURE.test(text)) error = text.trim();
        else if (status) error = `HTTP ${status}: ${text}`;
        else answered = true;
      }
    }
  } catch (e) {
    error = abortController.signal.aborted ? `no response within ${timeoutMs / 1000}s` : e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
    cleanupClaudeProjectDir(cwd);
    rmSync(cwd, { recursive: true, force: true });
  }
  if (!answered && !error) error = "no result from the model";
  return { model, ok: answered && !error, modelId, apiKeySource, error: error?.slice(0, 400) ?? null, ms: Date.now() - started };
}

/** Preflight every distinct model in parallel. */
export async function preflight(models: string[], auth?: AuthSetup): Promise<PreflightResult[]> {
  return Promise.all([...new Set(models)].map((m) => preflightModel(m, auth)));
}
