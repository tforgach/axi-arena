// Per-trial record/replay proxy (SPEC §7). Infrastructure hosts (Anthropic API, Claude Code's
// own services) are tunneled untouched; every other host is intercepted with a local-CA cert
// and served from the task's fixtures (replay), or fetched and saved when missing (record).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { AddressInfo } from "node:net";
import { hostCert, type Ca } from "./certs.ts";
import { storableHeaders, type FixtureStore } from "./fixtures.ts";

export type ProxyMode = "replay" | "record";

/** Hosts that always pass straight through: never recorded, never replayed. */
export const PASSTHROUGH_HOSTS = [
  "anthropic.com", // api.anthropic.com, statsig.anthropic.com, …
  "claude.ai", // incl. WebFetch's domain safety check
  "claude.com",
  "datadoghq.com", // Claude Code telemetry, in case it isn't fully disabled
  "sentry.io",
];

export const isPassthrough = (host: string, extra: string[] = []) =>
  [...PASSTHROUGH_HOSTS, ...extra].some((d) => host === d || host.endsWith(`.${d}`));

export interface ProxyEvent {
  kind: "hit" | "miss" | "recorded" | "passthrough" | "upstream_error";
  method: string;
  url: string;
  status?: number;
  detail?: string;
}

export interface ProxyHandle {
  url: string;
  port: number;
  events: ProxyEvent[];
  misses(): ProxyEvent[];
  close(): Promise<void>;
}

export interface ProxyOptions {
  mode: ProxyMode;
  store: FixtureStore;
  ca: Ca;
  passthrough?: string[];
  /** Upstream timeout when recording. */
  timeoutMs?: number;
  /** Corporate egress proxy to chain through (passthrough tunnels and recording). */
  upstreamProxy?: string | null;
  /** Hosts that bypass the upstream proxy (NO_PROXY semantics: suffix match, `*` = all). */
  noProxy?: string[];
}

const bypassUpstream = (host: string, noProxy: string[] = []) =>
  noProxy.some((n) => n === "*" || host === n.replace(/^\./, "") || host.endsWith(n.startsWith(".") ? n : `.${n}`));

/**
 * A raw TCP path to host:port: direct, or a CONNECT tunnel through the upstream proxy
 * (with Basic proxy auth if the proxy URL carries credentials).
 */
export function openTunnel(host: string, port: number, upstream?: string | null, noProxy?: string[]): Promise<net.Socket> {
  if (!upstream || bypassUpstream(host, noProxy)) {
    return new Promise((resolve, reject) => {
      const s = net.connect(port, host, () => resolve(s));
      s.once("error", reject);
    });
  }
  const up = new URL(upstream);
  const auth = up.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(up.username)}:${decodeURIComponent(up.password)}`).toString("base64")}\r\n`
    : "";
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(up.port) || (up.protocol === "https:" ? 443 : 80), up.hostname, () => {
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      s.off("data", onData);
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString("latin1"))?.[1];
      if (status !== "200") return reject(new Error(`upstream proxy refused CONNECT ${host}:${port} (${status ?? "bad response"})`));
      const rest = buf.subarray(end + 4);
      if (rest.length) s.unshift(rest);
      resolve(s);
    };
    s.on("data", onData);
    s.once("error", reject);
  });
}

const MISS_STATUS = 599;

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function fetchUpstream(
  url: URL,
  method: string,
  headers: http.IncomingHttpHeaders,
  body: Buffer,
  timeoutMs: number,
  upstream?: string | null,
  noProxy?: string[],
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const lib = url.protocol === "https:" ? https : http;
  const fwd: http.OutgoingHttpHeaders = { ...headers, host: url.host };
  // Ask for an unencoded body so fixtures are stored readable and replay is byte-identical.
  delete fwd["accept-encoding"];
  delete fwd["proxy-connection"];
  delete fwd["proxy-authorization"];
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  let extra: https.RequestOptions = {};
  if (upstream && !bypassUpstream(url.hostname, noProxy)) {
    if (url.protocol === "https:") {
      const tunnel = await openTunnel(url.hostname, port, upstream, noProxy);
      const secure = tls.connect({ socket: tunnel, servername: url.hostname });
      extra = { agent: false, createConnection: () => secure };
    } else {
      // Plain HTTP through a proxy: absolute-form request to the proxy itself.
      const up = new URL(upstream);
      return fetchUpstreamPlain(up, url, method, fwd, body, timeoutMs);
    }
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method, headers: fwd, timeout: timeoutMs, ...extra }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`upstream timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(body);
  });
}

function fetchUpstreamPlain(
  up: URL,
  url: URL,
  method: string,
  headers: http.OutgoingHttpHeaders,
  body: Buffer,
  timeoutMs: number,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: up.hostname, port: Number(up.port) || 80, method, path: url.href, headers, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`upstream timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(body);
  });
}

export async function startProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  const events: ProxyEvent[] = [];
  const sockets = new Set<net.Socket>();
  const timeoutMs = opts.timeoutMs ?? 30_000;

  /** Serves one intercepted request (absolute URL known). */
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    const method = req.method ?? "GET";
    const body = await readBody(req);
    const hit = opts.store.get(method, url.href, body);
    if (hit) {
      events.push({ kind: "hit", method, url: url.href, status: hit.status, detail: hit.source });
      res.writeHead(hit.status, { ...hit.headers, "content-length": String(hit.body.length) });
      return res.end(method === "HEAD" ? undefined : hit.body);
    }
    if (opts.mode === "replay") {
      events.push({ kind: "miss", method, url: url.href, status: MISS_STATUS });
      res.writeHead(MISS_STATUS, { "content-type": "text/plain" });
      return res.end(`axi-arena replay: no fixture for ${method} ${url.href}`);
    }
    try {
      const up = await fetchUpstream(url, method, req.headers, body, timeoutMs, opts.upstreamProxy, opts.noProxy);
      const headers = storableHeaders(up.headers);
      opts.store.save(method, url.href, body, up.status, headers, up.body);
      events.push({ kind: "recorded", method, url: url.href, status: up.status });
      res.writeHead(up.status, { ...headers, "content-length": String(up.body.length) });
      res.end(method === "HEAD" ? undefined : up.body);
    } catch (e) {
      events.push({ kind: "upstream_error", method, url: url.href, detail: e instanceof Error ? e.message : String(e) });
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`axi-arena record: upstream error for ${url.href}`);
    }
  };

  const onError = (res: http.ServerResponse) => (e: unknown) => {
    if (!res.headersSent) res.writeHead(500);
    res.end(`axi-arena proxy error: ${e instanceof Error ? e.message : e}`);
  };

  // Decrypted HTTPS requests from intercepted CONNECT tunnels land here.
  const inner = http.createServer((req, res) => {
    const host = (req.socket as tls.TLSSocket & { arenaHost?: string }).arenaHost ?? req.headers.host ?? "";
    handle(req, res, new URL(req.url ?? "/", `https://${host}`)).catch(onError(res));
  });

  const proxy = http.createServer((req, res) => {
    // Plain-HTTP proxy requests carry an absolute URL.
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("axi-arena proxy: expected an absolute URL");
      return;
    }
    if (isPassthrough(url.hostname, opts.passthrough)) {
      events.push({ kind: "passthrough", method: req.method ?? "GET", url: url.href });
      const up = http.request(url, { method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on("error", onError(res));
      req.pipe(up);
      return;
    }
    handle(req, res, url).catch(onError(res));
  });

  proxy.on("connect", (req, client: net.Socket, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const [host, portStr] = (req.url ?? "").split(":");
    const port = Number(portStr) || 443;
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    if (isPassthrough(host, opts.passthrough)) {
      events.push({ kind: "passthrough", method: "CONNECT", url: `${host}:${port}` });
      openTunnel(host, port, opts.upstreamProxy, opts.noProxy).then(
        (upstream) => {
          sockets.add(upstream);
          upstream.on("close", () => sockets.delete(upstream));
          upstream.on("error", () => client.destroy());
          if (head?.length) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        },
        (e) => {
          events.push({ kind: "upstream_error", method: "CONNECT", url: `${host}:${port}`, detail: e instanceof Error ? e.message : String(e) });
          client.destroy();
        },
      );
      return;
    }

    if (head?.length) client.unshift(head);
    const { key, cert } = hostCert(opts.ca, host);
    const secure = new tls.TLSSocket(client, { isServer: true, key, cert, ALPNProtocols: ["http/1.1"] }) as tls.TLSSocket & {
      arenaHost?: string;
    };
    secure.arenaHost = port === 443 ? host : `${host}:${port}`;
    secure.on("error", () => client.destroy());
    inner.emit("connection", secure);
  });

  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as AddressInfo;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    events,
    misses: () => events.filter((e) => e.kind === "miss" || e.kind === "upstream_error"),
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        inner.close();
        proxy.close(() => resolve());
        proxy.closeAllConnections();
      }),
  };
}

/** A file with our CA plus the user's extra CA (e.g. a corporate MITM root), content-addressed. */
function mergedPem(ca: Ca, base: string, extraCaFile: string | null | undefined, name: string): string {
  if (!extraCaFile || !existsSync(extraCaFile)) return base;
  const content = `${readFileSync(base, "utf8")}\n${readFileSync(extraCaFile, "utf8")}`;
  const file = join(ca.dir, `${name}-${createHash("sha256").update(content).digest("hex").slice(0, 12)}.pem`);
  if (!existsSync(file)) writeFileSync(file, content);
  return file;
}

/** Env that routes a trial's traffic through the proxy and trusts the local CA (plus any corporate CA). */
export function proxyEnv(proxy: ProxyHandle, ca: Ca, extraCaFile?: string | null): Record<string, string> {
  const caCerts = mergedPem(ca, ca.certPath, extraCaFile, "trust");
  const bundle = mergedPem(ca, ca.bundlePath, extraCaFile, "bundle");
  return {
    HTTPS_PROXY: proxy.url,
    HTTP_PROXY: proxy.url,
    https_proxy: proxy.url,
    http_proxy: proxy.url,
    NO_PROXY: "",
    no_proxy: "",
    NODE_USE_ENV_PROXY: "1",
    NODE_EXTRA_CA_CERTS: caCerts,
    // Tools that replace (not extend) the trust store get system roots + our CA.
    SSL_CERT_FILE: bundle,
    CURL_CA_BUNDLE: bundle,
    REQUESTS_CA_BUNDLE: bundle,
  };
}
