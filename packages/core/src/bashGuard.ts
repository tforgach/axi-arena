// Backstop for arm lockdown: decides whether a Bash command is made up solely of
// allowed programs (plus harmless helpers). It is the single source of truth for Bash:
// the lockdown hook allows what it approves and denies + logs the rest as escape attempts.

export type GuardVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Commands allowed anywhere in every arm: they can't fetch or substitute for an AXI's data.
 * Anything that runs *other* commands (xargs, env, command, sh, eval…) is excluded on purpose,
 * since it would launder an escape. Packs override with `harmless_commands`.
 */
export const DEFAULT_HARMLESS_COMMANDS = [
  "cd", "pwd", "echo", "printf", "true", "false", "which", "type", "test", "[", "sleep", "date",
  "export", "unset", "ls", "mkdir", "basename", "dirname",
];

/**
 * Text filters allowed downstream of an allowed or harmless command in a pipe
 * (`axi-fetch url | head -50`, `| grep -i foo`, `| jq .`): they only see that command's output,
 * so they can't be an equivalent. Standalone, file readers stay denied. Packs override with
 * `pipe_filters`.
 */
export const DEFAULT_PIPE_FILTERS = [
  "head", "tail", "grep", "egrep", "fgrep", "rg", "sed", "awk", "cut", "tr", "sort", "uniq", "wc",
  "jq", "yq", "cat", "less", "more", "column", "fold", "fmt", "nl", "tee", "rev", "paste",
];

export interface Segment {
  text: string;
  /** True when this segment reads the previous one's output through `|`. */
  piped: boolean;
}

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
  return splitPipeline(command)?.map((s) => s.text) ?? null;
}

/** Like splitSegments, but records which segments are fed by a pipe. */
export function splitPipeline(command: string): Segment[] | null {
  const segs: Segment[] = [];
  let cur = "";
  let piped = false;
  const push = (next: boolean) => {
    if (cur.trim()) segs.push({ text: cur.trim(), piped });
    cur = "";
    piped = next;
  };
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
    if (c === "|" && command[i + 1] === "|") { push(false); i++; continue; } // `||` is a sequence, not a pipe
    if (c === "|") { push(true); continue; }
    if (c === ";" || c === "&" || c === "\n") { push(false); continue; }
    cur += c;
  }
  if (quote) return null;
  push(false);
  return segs;
}

function matchesPrefix(segment: string, prefix: string): boolean {
  return segment === prefix || segment.startsWith(prefix + " ") || segment.startsWith(prefix + "\t");
}

/** `/any/path/axi-fetch args` is still the allowed program; compare it by basename. */
function withoutProgramPath(segment: string): string {
  const [first, ...rest] = segment.split(/(\s+)/);
  if (!first.includes("/")) return segment;
  return [first.slice(first.lastIndexOf("/") + 1), ...rest].join("");
}

export function checkBash(
  command: string,
  allowPrefixes: string[],
  denyPrefixes: string[] = [],
  harmless: string[] = DEFAULT_HARMLESS_COMMANDS,
  pipeFilters: string[] = DEFAULT_PIPE_FILTERS,
): GuardVerdict {
  const segs = splitPipeline(command);
  if (!segs) return { ok: false, reason: "uses substitution, subshells or heredocs" };
  if (segs.length === 0) return { ok: false, reason: "empty command" };
  // Whether the current pipeline started with an allowed or harmless command.
  let pipelineOk = false;
  for (const seg of segs) {
    const raw = seg.text;
    const s = withoutProgramPath(raw);
    const denied = denyPrefixes.find((p) => matchesPrefix(s, p));
    if (denied) return { ok: false, reason: `\`${denied}\` is denied in this arm` };
    if (seg.piped && pipelineOk && pipeFilters.some((f) => matchesPrefix(s, f))) continue;
    const ok = allowPrefixes.some((p) => matchesPrefix(s, p)) || harmless.some((h) => matchesPrefix(raw, h));
    if (!ok) {
      const program = raw.split(/\s+/)[0] ?? raw;
      const hint = pipeFilters.includes(program) ? " (text filters are allowed only after an allowed command in a pipe)" : "";
      return { ok: false, reason: `\`${program}\` is not allowed in this arm${hint}` };
    }
    if (!seg.piped) pipelineOk = true;
  }
  return { ok: true };
}
