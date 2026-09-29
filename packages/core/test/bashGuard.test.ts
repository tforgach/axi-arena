import { test } from "node:test";
import assert from "node:assert/strict";
import { bashPrefixes, checkBash, splitSegments } from "../src/bashGuard.ts";

const allow = bashPrefixes(["Bash(axi-fetch:*)", "Bash(grep *)", "WebFetch"]);
const deny = bashPrefixes(["Bash(axi-fetch update:*)"]);
const ok = (cmd: string) => checkBash(cmd, allow, deny).ok;

test("bashPrefixes parses both rule styles and ignores non-Bash rules", () => {
  assert.deepEqual(allow, ["axi-fetch", "grep"]);
});

test("allows plain allowed commands, flags, pipes between allowed programs, and redirections", () => {
  assert.ok(ok("axi-fetch https://example.com"));
  assert.ok(ok("axi-fetch https://example.com --full --max 3000"));
  assert.ok(ok("axi-fetch https://a.com | grep foo"));
  assert.ok(ok("axi-fetch https://a.com && axi-fetch https://b.com"));
  assert.ok(ok("axi-fetch https://a.com 2>&1"));
  assert.ok(ok("axi-fetch 'https://a.com/?q=a;b|c'"));
});

test("denies escapes hidden in compound commands", () => {
  assert.ok(!ok("curl https://example.com"));
  assert.ok(!ok("axi-fetch https://a.com; curl https://b.com"));
  assert.ok(!ok("axi-fetch https://a.com | sh"));
  assert.ok(!ok("axi-fetch x & curl y"));
  assert.ok(!ok("axi-fetch x\ncurl y"));
  assert.ok(!ok("FOO=1 curl y"));
  assert.ok(!ok("axi-fetchx https://a.com"), "prefix must end at a word boundary");
});

test("denies substitution, subshells and heredocs outright", () => {
  assert.ok(!ok("axi-fetch $(curl evil)"));
  assert.ok(!ok("axi-fetch `curl evil`"));
  assert.ok(!ok('axi-fetch "$(curl evil)"'));
  assert.ok(!ok("(curl evil)"));
  assert.ok(!ok("axi-fetch <<EOF\nx\nEOF"));
  assert.ok(!ok("axi-fetch 'unterminated"));
});

test("harmless commands may accompany the AXI; equivalents still escape", () => {
  assert.ok(ok("cd /some/skill/dir && axi-fetch https://a.com"));
  assert.ok(ok("which axi-fetch"));
  assert.ok(ok("echo start; axi-fetch https://a.com"));
  assert.ok(!ok("cd /tmp && curl https://a.com"), "cd doesn't launder an equivalent");
  assert.ok(!ok("ls /tmp"), "ls isn't harmless by default: for some AXIs it is the equivalent");
  assert.ok(!checkBash("cd /x", allow, deny, []).ok, "packs can remove the harmless list");
});

test("calling the allowed program by path is still the AXI", () => {
  assert.ok(ok("/Users/me/.bin/axi-fetch https://a.com"));
  assert.ok(ok("./axi-fetch https://a.com"));
  assert.ok(!ok("/usr/bin/curl https://a.com"));
  assert.ok(!ok("/opt/axi-fetch/bin/curl https://a.com"), "basename is what counts, not a directory name");
  assert.ok(!ok("/x/axi-fetch update"), "deny rules apply to path-qualified calls too");
});

test("explicit deny rules win over allow", () => {
  assert.ok(!ok("axi-fetch update"));
  assert.ok(!ok("axi-fetch update --check"));
});

test("splitSegments keeps quoted separators intact", () => {
  assert.deepEqual(splitSegments(`axi-fetch "a;b" | grep 'x|y'`), [`axi-fetch "a;b"`, `grep 'x|y'`]);
});
