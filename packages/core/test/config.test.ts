import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ConfigSchema, detectProvider, loadConfig, redactUrl, resolveAuth, resolveModel } from "../src/config.ts";
import { openTunnel } from "../src/proxy.ts";

const cfg = (o: unknown = {}) => ConfigSchema.parse(o);

test("imports only auth/provider env from the shell", () => {
  const a = resolveAuth(cfg(), {
    ANTHROPIC_API_KEY: "sk-test", AWS_PROFILE: "work", CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_DEFAULT_HAIKU_MODEL: "h",
    PATH: "/bin", GITHUB_TOKEN: "ghp_secret", HOME: "/home/x",
  }, {});
  assert.deepEqual(Object.keys(a.env).sort(), ["ANTHROPIC_API_KEY", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "AWS_PROFILE", "CLAUDE_CODE_USE_BEDROCK"]);
  assert.equal(a.provider, "bedrock");
  assert.ok(!a.sources.join(" ").includes("sk-test"), "sources list names, never values");
});

test("imports credential helpers, filtered settings env and modelOverrides from Claude settings", () => {
  const a = resolveAuth(cfg(), {}, {
    apiKeyHelper: "~/bin/key.sh", awsAuthRefresh: "aws sso login", hooks: { x: 1 }, enabledPlugins: { p: true },
    env: { CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "us-east5", DEBUG: "1" },
    modelOverrides: { "claude-sonnet-5-5": "vertex-sonnet" },
  });
  assert.deepEqual(a.settings, { apiKeyHelper: "~/bin/key.sh", awsAuthRefresh: "aws sso login", modelOverrides: { "claude-sonnet-5-5": "vertex-sonnet" } });
  assert.deepEqual(a.env, { CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "us-east5" });
  assert.equal(a.provider, "vertex");
});

test("arena config: explicit helper, env, passthrough names and per-provider model overrides", () => {
  const a = resolveAuth(
    cfg({
      auth: { import_claude_settings: false, api_key_helper: "/opt/key", env: { CLAUDE_CODE_USE_BEDROCK: "1" }, env_passthrough: ["GATEWAY_TOKEN"] },
      models: { providers: { bedrock: { "claude-haiku-4-5": "us.anthropic.haiku" }, vertex: { x: "y" } } },
    }),
    { GATEWAY_TOKEN: "t", OTHER: "no" },
    { apiKeyHelper: "ignored-when-import-off" },
  );
  assert.equal(a.settings.apiKeyHelper, "/opt/key");
  assert.deepEqual(a.settings.modelOverrides, { "claude-haiku-4-5": "us.anthropic.haiku" }, "only the active provider's map");
  assert.deepEqual(a.env, { GATEWAY_TOKEN: "t", CLAUDE_CODE_USE_BEDROCK: "1" });
});

test("corporate proxy and CA are picked up; proxy credentials are redacted in sources", () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-cfg-"));
  writeFileSync(join(dir, "corp.pem"), "-----BEGIN CERTIFICATE-----\n");
  const a = resolveAuth(cfg(), { HTTPS_PROXY: "http://me:pw@proxy.corp:8080", NO_PROXY: "internal.corp, localhost", NODE_EXTRA_CA_CERTS: join(dir, "corp.pem") }, {});
  assert.equal(a.upstreamProxy, "http://me:pw@proxy.corp:8080");
  assert.deepEqual(a.noProxy, ["internal.corp", "localhost"]);
  assert.equal(a.extraCaFile, join(dir, "corp.pem"));
  assert.ok(!a.sources.join(" ").includes("pw"));
  assert.equal(redactUrl("http://me:pw@proxy.corp:8080"), "http://***@proxy.corp:8080/");
});

test("provider detection and model aliases", () => {
  assert.equal(detectProvider({}), "anthropic");
  assert.equal(detectProvider({ CLAUDE_CODE_USE_BEDROCK: "0" }), "anthropic");
  const c = cfg({ models: { aliases: { fast: "claude-haiku-4-5" } } });
  assert.equal(resolveModel("fast", c), "claude-haiku-4-5");
  assert.equal(resolveModel("sonnet", c), "sonnet", "unknown names pass through to Claude Code's own aliases");
});

test("loadConfig validates and defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-cfg-"));
  assert.equal(loadConfig(join(dir, "missing.yaml")).auth.import_claude_settings, true);
  writeFileSync(join(dir, "bad.yaml"), "auth: { env: [1, 2] }\n");
  assert.throws(() => loadConfig(join(dir, "bad.yaml")), /invalid/);
});

test("openTunnel chains through an upstream CONNECT proxy with Basic auth", async () => {
  // Target: echo server. Upstream: a minimal CONNECT proxy recording what it saw.
  const target = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const tport = (target.address() as AddressInfo).port;
  const seen: string[] = [];
  const upstream = http.createServer();
  upstream.on("connect", (req, client) => {
    seen.push(`${req.url} ${req.headers["proxy-authorization"] ?? ""}`);
    const [h, p] = (req.url ?? "").split(":");
    const s = net.connect(Number(p), h, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      s.pipe(client);
      client.pipe(s);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const uport = (upstream.address() as AddressInfo).port;
  try {
    const sock = await openTunnel("127.0.0.1", tport, `http://u:p@127.0.0.1:${uport}`);
    const echoed = await new Promise<string>((resolve) => {
      sock.once("data", (d) => resolve(d.toString()));
      sock.write("ping");
    });
    sock.destroy();
    assert.equal(echoed, "ping");
    assert.deepEqual(seen, [`127.0.0.1:${tport} Basic ${Buffer.from("u:p").toString("base64")}`]);

    const direct = await openTunnel("127.0.0.1", tport, `http://127.0.0.1:${uport}`, ["127.0.0.1"]);
    direct.destroy();
    assert.equal(seen.length, 1, "NO_PROXY hosts bypass the upstream");
  } finally {
    upstream.close();
    target.close();
  }
});
