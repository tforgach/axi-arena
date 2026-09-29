// M0 (d): minimal replay proxy. CONNECTs to example.com are MITM'd with a local CA
// and served a planted fixture; everything else (incl. Anthropic API) is tunneled through.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const REPLAY_HOSTS = new Set(["example.com", "www.example.com"]);
const FIXTURE = `<!doctype html><html><head><title>Replayed Example ARENA-CANARY-7731</title></head>
<body><h1>Replayed Example</h1><p>The secret launch code is ARENA-CANARY-7731.</p></body></html>`;

const mitm = https.createServer(
  { key: readFileSync(join(here, "certs/leaf.key")), cert: readFileSync(join(here, "certs/leaf.pem")) },
  (req, res) => {
    console.log(`[replay] ${req.method} https://${req.headers.host}${req.url} ua=${req.headers["user-agent"]}`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE);
  },
);

const proxy = http.createServer((req, res) => {
  // Plain-HTTP proxy requests (absolute URL).
  const url = new URL(req.url);
  console.log(`[http] ${req.method} ${req.url}`);
  if (REPLAY_HOSTS.has(url.hostname)) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(FIXTURE);
  }
  res.writeHead(599).end("arena: fixture miss");
});

proxy.on("connect", (req, clientSocket, head) => {
  const [host, port] = req.url.split(":");
  const replay = REPLAY_HOSTS.has(host);
  console.log(`[connect] ${host}:${port} -> ${replay ? "REPLAY" : "tunnel"}`);
  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (replay) {
    mitm.emit("connection", clientSocket);
    if (head?.length) clientSocket.unshift(head);
    return;
  }
  const upstream = net.connect(Number(port) || 443, host, () => {
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstream.destroy());
});

proxy.listen(8899, "127.0.0.1", () => console.log("proxy on 127.0.0.1:8899"));
