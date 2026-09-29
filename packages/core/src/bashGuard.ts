// Backstop for arm lockdown: decides whether a Bash command is made up solely of
// allowed programs. The SDK's own permission rules are the first line of defense;
// this guard catches anything they let through and logs it as an escape attempt.

export type GuardVerdict = { ok: true } | { ok: false; reason: string };

/** Extract allowed command prefixes from rules like `Bash(axi-fetch:*)` or `Bash(gh pr *)`. */
export function bashPrefixes(rules: string[]): string[] {
  const out: string[] = [];
  for (const r of rules) {
    const m = /^Bash\((.+)\)$/.exec(r.trim());
    if (!m) continue;
    out.push(m[1].replace(/:\*$/, "").replace(/\s*\*$/, "").trim());
  }
  return out;
}

/**
 * Split a shell command into simple-command segments on unquoted `;`, `&`, `|`,
 * and newlines. Returns null if the command uses constructs we refuse to reason
 * about (command/process substitution, subshells, heredocs, unterminated quotes).
 */
export function splitSegments(command: string): string[] | null {
  const segs: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && (c === "`" || (c === "$" && command[i + 1] === "("))) return null;
      else if (quote === '"' && c === "\\") { cur += c + (command[++i] ?? ""); continue; }
      cur += c;
      continue;
    }
    if (c === "\\") { cur += c + (command[++i] ?? ""); continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "`" || c === "(" || c === ")" || c === "{" || c === "}") return null;
    if (c === "$" && command[i + 1] === "(") return null;
    if (c === "<" && command[i + 1] === "<") return null;
    // `2>&1` / `&>file` are redirections, not command separators.
    if (c === "&" && (cur.endsWith(">") || command[i + 1] === ">")) { cur += c; continue; }
    if (c === ";" || c === "&" || c === "|" || c === "\n") {
      segs.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (quote) return null;
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

function matchesPrefix(segment: string, prefix: string): boolean {
  return segment === prefix || segment.startsWith(prefix + " ") || segment.startsWith(prefix + "\t");
}

export function checkBash(command: string, allowPrefixes: string[], denyPrefixes: string[] = []): GuardVerdict {
  const segs = splitSegments(command);
  if (!segs) return { ok: false, reason: "uses substitution, subshells or heredocs" };
  if (segs.length === 0) return { ok: false, reason: "empty command" };
  for (const s of segs) {
    const denied = denyPrefixes.find((p) => matchesPrefix(s, p));
    if (denied) return { ok: false, reason: `\`${denied}\` is denied in this arm` };
    if (!allowPrefixes.some((p) => matchesPrefix(s, p))) {
      return { ok: false, reason: `\`${s.split(/\s+/)[0]}\` is not allowed in this arm` };
    }
  }
  return { ok: true };
}
