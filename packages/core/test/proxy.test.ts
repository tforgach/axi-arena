import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { ensureCa } from "../src/certs.ts";
import { FixtureStore, storableHeaders } from "../src/fixtures.ts";
import { isPassthrough, proxyEnv, startProxy } from "../src/proxy.ts";

const run = promisify(execFile);
const tmp = () => mkdtempSync(join(tmpdir(), "arena-proxy-"));
const ca = ensureCa(join(tmp(), "ca"));

function taskDir(yaml?: string): string {
  const dir = tmp();
  if (yaml) writeFileSync(join(dir, "fixtures.yaml"), yaml);
  return dir;
}

/** Fetch through the proxy from a child Node process, exactly as an AXI would. */
async function childFetch(url: string, env: Record<string, string>): Promise<{ status: number; body: string }> {
  const code = `const r = await fetch(${JSON.stringify(url)}); console.log(JSON.stringify({ status: r.status, body: await r.text() }));`;
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", code], {
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  return JSON.parse(stdout);
}

/** Plain-HTTP proxy request (absolute URL). */
function viaProxy(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url, headers: { host: new URL(url).host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("passthrough list covers Anthropic/Claude infrastructure but not look-alikes", () => {
  assert.ok(isPassthrough("api.anthropic.com"));
  assert.ok(isPassthrough("claude.ai"));
  assert.ok(!isPassthrough("notanthropic.com"));
  assert.ok(!isPassthrough("example.com"));
});

test("replay serves synthetic HTTPS fixtures to Node fetch and 599s everything else", async () => {
  const store = new FixtureStore(
    taskDir(`- url: https://example.com/arena/canary\n  body: "<title>ARENA-CANARY-42</title>"\n- url: https://example.com/gone\n  status: 404\n  body: nope\n`),
  );
  const proxy = await startProxy({ mode: "replay", store, ca });
  try {
    const env = proxyEnv(proxy, ca);
    assert.deepEqual(await childFetch("https://example.com/arena/canary", env), { status: 200, body: "<title>ARENA-CANARY-42</title>" });
    assert.equal((await childFetch("https://example.com/gone", env)).status, 404);
    assert.equal((await childFetch("https://example.com/not-recorded", env)).status, 599);
    assert.deepEqual(proxy.misses().map((m) => m.url), ["https://example.com/not-recorded"]);
    assert.deepEqual(proxy.events.filter((e) => e.kind === "hit").map((e) => e.detail), ["synthetic", "synthetic"]);
  } finally {
    await proxy.close();
  }
});

test("record fetches and saves misses; replay then serves them with the upstream gone", async () => {
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "text/plain", "x-upstream": "yes" });
    res.end(`hello from ${req.url}`);
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/page?q=1`;
  const dir = taskDir();

  const rec = await startProxy({ mode: "record", store: new FixtureStore(dir), ca });
  assert.deepEqual(await viaProxy(rec.port, url), { status: 200, body: "hello from /page?q=1" });
  assert.deepEqual(await viaProxy(rec.port, url), { status: 200, body: "hello from /page?q=1" });
  assert.equal(hits, 1, "second request is served from the new fixture");
  assert.deepEqual(rec.events.map((e) => e.kind), ["recorded", "hit"]);
  await rec.close();
  await new Promise<void>((r) => upstream.close(() => r()));

  const replay = await startProxy({ mode: "replay", store: new FixtureStore(dir), ca });
  try {
    assert.deepEqual(await viaProxy(replay.port, url), { status: 200, body: "hello from /page?q=1" });
    assert.equal(replay.misses().length, 0);
  } finally {
    await replay.close();
  }
});

test("recorded fixtures keep only allowlisted headers (no client IPs, cookies, CDN nodes)", () => {
  assert.deepEqual(
    storableHeaders({
      "Content-Type": "text/html", location: "/x", "x-client-ip": "2001:db8::1", "set-cookie": ["a=b"],
      "x-served-by": "cache-lga", "server-timing": "host;desc=cp1", "x-request-id": "r", "content-encoding": "gzip",
    }),
    { "content-type": "text/html", location: "/x" },
  );
});

test("fixtures.yaml validates entries and supports body_file", () => {
  const dir = taskDir(`- url: https://example.com/big\n  body_file: big.html\n`);
  mkdirSync(join(dir, "x"), { recursive: true });
  writeFileSync(join(dir, "big.html"), "<p>big</p>");
  assert.equal(new FixtureStore(dir).get("GET", "https://example.com/big")?.body.toString(), "<p>big</p>");
  assert.throws(() => new FixtureStore(taskDir(`- url: not-a-url\n  body: x\n`)), /invalid/);
});
