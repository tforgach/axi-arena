// Local CA for the replay proxy (SPEC §7). Generated once per install with the openssl CLI;
// per-host leaf certs are generated on demand and cached on disk.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { arenaHome } from "./paths.ts";

export interface Ca {
  dir: string;
  certPath: string;
  keyPath: string;
  /** System roots + our CA, for tools that take a CA bundle path (curl, Python, …). */
  bundlePath: string;
}

function openssl(args: string[], cwd: string): void {
  const res = spawnSync("openssl", args, { cwd, encoding: "utf8" });
  if (res.error) throw new Error(`replay needs the openssl CLI: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`openssl ${args[0]} failed: ${res.stderr.trim()}`);
}

const SYSTEM_BUNDLES = ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"];

export function ensureCa(dir = join(arenaHome(), "ca")): Ca {
  mkdirSync(join(dir, "hosts"), { recursive: true, mode: 0o700 });
  const certPath = join(dir, "ca.pem");
  const keyPath = join(dir, "ca.key");
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    openssl(
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "3650",
        "-subj", "/CN=axi-arena local replay CA",
        "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      ],
      dir,
    );
  }
  const bundlePath = join(dir, "bundle.pem");
  if (!existsSync(bundlePath)) {
    const system = SYSTEM_BUNDLES.find((p) => existsSync(p));
    writeFileSync(bundlePath, `${system ? readFileSync(system, "utf8") : ""}\n${readFileSync(certPath, "utf8")}`);
  }
  return { dir, certPath, keyPath, bundlePath };
}

const cache = new Map<string, { key: Buffer; cert: Buffer }>();

/** Leaf cert for one host, signed by the local CA. */
export function hostCert(ca: Ca, host: string): { key: Buffer; cert: Buffer } {
  const hit = cache.get(host);
  if (hit) return hit;
  const safe = host.replace(/[^a-zA-Z0-9.-]/g, "_");
  const keyPath = join(ca.dir, "hosts", `${safe}.key`);
  const certPath = join(ca.dir, "hosts", `${safe}.pem`);
  if (!existsSync(certPath)) {
    const csr = join(ca.dir, "hosts", `${safe}.csr`);
    const ext = join(ca.dir, "hosts", `${safe}.ext`);
    const san = isIP(host) ? `IP:${host}` : `DNS:${host}`;
    writeFileSync(ext, `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", csr, "-subj", `/CN=${host.slice(0, 64)}`], ca.dir);
    openssl(
      ["x509", "-req", "-in", csr, "-CA", ca.certPath, "-CAkey", ca.keyPath, "-CAcreateserial", "-out", certPath, "-days", "825", "-extfile", ext],
      ca.dir,
    );
  }
  const pair = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  cache.set(host, pair);
  return pair;
}
