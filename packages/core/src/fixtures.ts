// Fixture store for one task (SPEC §7): hand-written fixtures.yaml entries win over recordings.
//
//   fixtures/<task-id>/fixtures.yaml      synthetic pages (canary facts, edge cases, error codes)
//   fixtures/<task-id>/recorded/<k>.json  recorded response metadata (method, url, status, headers)
//   fixtures/<task-id>/recorded/<k>.body  recorded response body, as received (decoded)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export interface FixtureResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  source: "synthetic" | "recorded";
}

const SyntheticSchema = z.array(
  z.object({
    url: z.string().url(),
    method: z.string().default("GET"),
    status: z.number().int().default(200),
    headers: z.record(z.string(), z.string()).default({ "content-type": "text/html; charset=utf-8" }),
    body: z.string().optional(),
    body_file: z.string().optional(),
  }).refine((f) => f.body != null || f.body_file != null || f.status >= 300, "needs body or body_file"),
);

/** Canonical URL: lowercase scheme/host, default port dropped. Paths and queries are kept exactly. */
export function canonicalUrl(url: string): string {
  const u = new URL(url);
  return u.href;
}

export function fixtureKey(method: string, url: string, body?: Buffer): string {
  const bodyHash = body && body.length ? createHash("sha256").update(body).digest("hex") : "";
  return createHash("sha256").update(`${method.toUpperCase()} ${canonicalUrl(url)} ${bodyHash}`).digest("hex").slice(0, 20);
}

/**
 * Response headers kept in recorded fixtures. An allowlist, not a blocklist: servers echo
 * private data back in headers (Wikipedia's `x-client-ip` is the recorder's public IP; CDN
 * `x-served-by`/`server-timing` reveal location), and fixtures get committed with the pack.
 */
export const STORED_HEADERS = new Set([
  "content-type", "content-language", "location", "last-modified", "etag", "cache-control",
  "expires", "link", "content-disposition", "retry-after", "www-authenticate",
]);

export function storableHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v == null || !STORED_HEADERS.has(k.toLowerCase())) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

export class FixtureStore {
  readonly dir: string;
  private synthetic = new Map<string, FixtureResponse>();

  constructor(dir: string) {
    this.dir = dir;
    const manifest = join(dir, "fixtures.yaml");
    if (!existsSync(manifest)) return;
    const parsed = SyntheticSchema.safeParse(parseYaml(readFileSync(manifest, "utf8")) ?? []);
    if (!parsed.success) throw new Error(`invalid ${manifest}:\n${z.prettifyError(parsed.error)}`);
    for (const f of parsed.data) {
      const body = f.body_file ? readFileSync(join(dir, f.body_file)) : Buffer.from(f.body ?? "");
      this.synthetic.set(fixtureKey(f.method, f.url), { status: f.status, headers: f.headers, body, source: "synthetic" });
    }
  }

  get(method: string, url: string, body?: Buffer): FixtureResponse | null {
    const key = fixtureKey(method, url, body);
    const syn = this.synthetic.get(key);
    if (syn) return syn;
    const meta = join(this.dir, "recorded", `${key}.json`);
    if (!existsSync(meta)) return null;
    const m = JSON.parse(readFileSync(meta, "utf8")) as { status: number; headers: Record<string, string> };
    return { status: m.status, headers: m.headers, body: readFileSync(join(this.dir, "recorded", `${key}.body`)), source: "recorded" };
  }

  save(method: string, url: string, reqBody: Buffer | undefined, status: number, headers: Record<string, string>, body: Buffer): void {
    const key = fixtureKey(method, url, reqBody);
    mkdirSync(join(this.dir, "recorded"), { recursive: true });
    writeFileSync(
      join(this.dir, "recorded", `${key}.json`),
      `${JSON.stringify({ method: method.toUpperCase(), url: canonicalUrl(url), status, headers, recorded_at: new Date().toISOString() }, null, 2)}\n`,
    );
    writeFileSync(join(this.dir, "recorded", `${key}.body`), body);
  }

  /** How many fixtures this task has (for validate/estimate). */
  count(): number {
    const rec = join(this.dir, "recorded");
    const recorded = existsSync(rec) ? readdirSync(rec).filter((f) => f.endsWith(".json")).length : 0;
    return this.synthetic.size + recorded;
  }
}
