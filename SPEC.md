# axi-arena — Spec

> Status: **Draft v0.2** · 2026-09-29
> A local tool that benchmarks an AXI (Agent Experience Interface) against its native counterpart by running real agent trials, scoring them, and showing the results in a local web UI.

## 1. Goals and non-goals

### Goals
- Measure whether an AXI actually beats its native counterpart on **real agent tasks**, not only on raw output size.
- Be **generic.** Any AXI can be benchmarked by pointing the arena at a *pack* directory. Packs for private or work AXIs live outside this repo, and the arena never needs to see their source.
- Produce a **composite Arena Score** per AXI, with a full breakdown underneath: correctness, tokens, turns, time and errors.
- Keep runs **reproducible.** Network traffic is recorded once and replayed after that, so both arms see identical inputs and results stay comparable over time.
- Run from the **CLI**, and watch and analyze in a **local web app**: live trial transcripts, results and history.
- Support a **model matrix**, so one run covers several models.

### Non-goals (v1)
- Hosted or multi-user deployment. The app is local only and binds to localhost.
- Model providers other than Claude.
- A public leaderboard or sharing of results.
- An "adoption" arm, where both tools are available and we measure which one the agent picks. Deferred to v2 (see §13).

## 2. Glossary

| Term | Meaning |
|---|---|
| **AXI** | An agent-first CLI following the [axi.md](https://axi.md) principles: TOON output, content-first, next-step hints, structured errors, ambient hooks. |
| **Native counterpart / baseline** | What an agent would use without the AXI: a built-in Claude Code tool (e.g. `WebFetch`), a raw CLI (e.g. `gh`, `curl`), or an MCP server. |
| **Pack** | A directory describing one AXI's benchmark: its arms, tasks, fixtures and setup scripts. |
| **Arm** | One tool configuration an agent runs with: allowed tools, skills, hooks, MCP servers and env. Each pack has one `axi` arm and one or more baseline arms. |
| **Task** | A prompt plus a way to judge the answer: deterministic checks and an LLM rubric. |
| **Trial** | One agent run of one task, with one arm and one model. |
| **Run** | One CLI invocation: a set of trials covering tasks × arms × models × N. |
| **Match** | A task's AXI trials compared with the baseline trials for the same model. The Arena Score is built from matches. |

## 3. How a run works

```
axi-arena run ./packs/axi-fetch --models haiku,sonnet --trials 3
        │
        ├─ load + validate pack (arena.yaml)
        ├─ show estimate (trial count, rough token budget) → confirm
        ├─ pack.setup
        ├─ for each (model × task × arm × trial):      ← concurrency-limited queue
        │     task.before → start replay proxy → spawn isolated agent
        │     → stream SDK messages to SQLite (live UI reads them)
        │     → collect metrics → run deterministic checks → LLM judge
        │     → task.after
        ├─ pack.teardown
        └─ compute matches + Arena Score → print summary + UI URL
```

A match is the same task, same model, same system prompt and same inputs for both arms. **The only thing that differs is the tool.**

## 4. Agent runtime

### 4.1 Runner
- **Claude Agent SDK (TypeScript)**, `@anthropic-ai/claude-agent-sdk`, calling `query()`.
- Uses the `claude_code` system prompt preset, so trials reflect real Claude Code usage. Its overhead is identical in both arms and cancels out in the relative scores.
- Runner backends sit behind a `Runner` interface so a second one can be added:
  - `sdk` (default): Agent SDK `query()`.
  - `cli`: `claude -p --output-format stream-json` as a subprocess. This is the fallback if SDK auth under a subscription turns out not to be allowed (see §4.4).

### 4.2 Isolation (every trial)
- A fresh temporary working directory (`cwd`), created per trial and deleted afterwards. With `--keep` it is kept for debugging.
- `settingSources: []`. None of the user's `~/.claude` settings, CLAUDE.md, skills, hooks or MCP servers are loaded.
- `strictMcpConfig: true` and an explicit `mcpServers`. *(M0 finding: without these, claude.ai account connectors leak into the session even with `settingSources: []`.)*
- `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` and an explicit `skills` list. *(M0: this took the base context from ~4.2k to ~1.3k input tokens.)* Two built-in plugins (`agents-md`, `telemetry`) and the `design`/`doctor` entries still load, but they're identical in both arms.
- `persistSession: false`, and the runner deletes `~/.claude/projects/<trial path>` after each trial. *(M1 finding: Claude Code still saves large tool outputs there. A per-trial `CLAUDE_CONFIG_DIR` would avoid it, but it breaks the subscription login.)*
- `XDG_CACHE_HOME` (and the other XDG dirs) point inside the trial dir, so AXI disk caches can't carry over between trials. *(M0: axi-fetch's 15-minute cache would otherwise have served stale content.)*
- `env` is built explicitly. The SDK replaces the environment rather than merging it, so the trial gets only a minimal PATH, the proxy vars, the arm's env and the auth vars.
- `maxTurns` (default 30) and a per-trial wall-clock timeout (default 5 minutes) enforced through `abortController`.
- The arm's skills, hooks and MCP servers are injected per trial as a **generated local plugin** (`plugins: [{type:'local', path}]`), with `skills: ['<plugin>:<skill>']`. *(M0: confirmed. The skill and the SessionStart hook's ambient output both reached the session.)*
- `effort` is passed straight to `query()` (the CLI backend uses `CLAUDE_CODE_EFFORT_LEVEL`).

### 4.3 Arm lockdown (decided: strict)
The AXI arm can **only** call its AXI commands, and baseline arms can only call their native tools.

Note: `allowedTools` in the SDK only *auto-approves* tools. It does **not** restrict them. Lockdown therefore takes three layers:
1. **Same tool definitions in every arm.** `tools` is the union of every arm's tools (plus their MCP servers), plus `Skill` if any arm ships skills, plus the common tools. No arm gets a cheaper context just because it carries fewer tool descriptions. *(Decided after M1: Bash's large description gave the AXI arm about 11.3k tokens of starting context against about 7.6k for WebFetch.)*
2. **Only permissions differ.** `allowedTools` holds just this arm's rules (e.g. `Bash(axi-fetch:*)`), with `permissionMode: 'dontAsk'`, so anything that doesn't match is denied instead of prompting. Calling a tool that's defined but not permitted counts as an escape.
   - **Common tool `Read`** is in every arm, limited to the trial's own saved-output folder. *(Decided after M1: Claude Code saves large tool outputs to a file, and without `Read` the agent can't open it.)*
3. A backstop `PreToolUse` hook that denies and logs anything outside the arm's allowlist. It must **parse compound commands** (`;`, `&&`, `|`, `$(…)`) and require every segment to be allowed. A plain prefix check would let `axi-fetch x; curl y` through.
4. The AXI arm also gets the `Skill` tool, so the agent can read the AXI's skill. That call is part of the AXI's real cost and counts toward its turns and tokens.

*(M0: confirmed. When told to use `curl`, the agent was denied, which was recorded in `permission_denials` and in the hook log, and it then switched to `axi-fetch`.)*

Denied calls are recorded (`permission_denials` plus the hook log) and reported as **escape attempts**. They count as errors in scoring.

### 4.4 Auth (decided: try SDK on subscription, fall back to CLI)
- Runs use the user's **Claude subscription**. We try the `sdk` backend on it first, and if that fails or isn't allowed, fall back to the `cli` backend. M0 confirms which one.
- The Agent SDK docs state: *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods…"* This is aimed at products offered to others. Whether it covers a personal local tool that uses your own login isn't clear, so **confirm this before M1.**
- Design: auth is whatever the runner backend resolves. `ANTHROPIC_API_KEY` is still supported. The `cli` backend (plain Claude Code in headless mode) is the fallback on the subscription path.
- Either way, `total_cost_usd` is treated as a **notional API-price cost**. **Scoring uses tokens, not dollars.** Under a subscription, the real limit is the usage window, so the pre-run estimate matters.

## 5. Packs

A pack is a directory anywhere on disk. The arena repo ships `packs/axi-fetch/` as the reference pack. Work packs stay private.

```
my-axi-pack/
├── arena.yaml          # manifest: arms, defaults, weights, setup
├── tasks/*.yaml        # one file per task (or inline in arena.yaml)
├── fixtures/           # recorded HTTP traffic + synthetic pages (§7)
├── skills/             # SKILL.md files injected into the axi arm
├── hooks/              # SessionStart etc. scripts for ambient context
└── scripts/            # setup / teardown / before / after
```

### 5.1 `arena.yaml` (sketch)

```yaml
name: axi-fetch
version: 0.1.0                 # pack version; AXI version captured at runtime
axi_version_cmd: axi-fetch --version

setup: scripts/setup.sh        # once per run (install CLI, seed sandbox…)
teardown: scripts/teardown.sh
sequential: false              # true ⇒ no concurrent trials (stateful systems)

defaults:
  trials: 3
  models: [claude-sonnet-5-5]
  max_turns: 30
  timeout_s: 300
  effort: medium               # fixed for the whole run, not a matrix dimension
  network: replay              # replay | record | live

scoring:
  weights: { tokens: 0.4, turns: 0.2, time: 0.2, errors: 0.2 }
  gate: { min_correctness: 0.8, max_regression: 0.05 }

arms:
  axi:
    tools: [Bash]
    allow: ["Bash(axi-fetch:*)"]
    skills: [skills/axi-fetch]
    hooks: { SessionStart: hooks/session-start.sh }
    env: { NODE_USE_ENV_PROXY: "1" }
  webfetch:                    # baseline(s): any name except `axi`
    tools: [WebFetch]
    allow: [WebFetch]
  # curl:
  #   tools: [Bash]
  #   allow: ["Bash(curl:*)"]
```

Baselines can also be MCP servers (`mcp_servers:` block passed to the SDK) or raw CLIs (`Bash(gh:*)`).

### 5.2 Task file (sketch)

```yaml
id: napoleon-coronation-year
prompt: >
  Using https://en.wikipedia.org/wiki/Napoleon, in what year was Napoleon
  crowned Emperor? Reply with just the year.
network: replay                # overrides pack default
tags: [article, single-fetch]

checks:                        # deterministic, run first
  - type: regex
    pattern: '\b1804\b'
    required: true             # hard gate: failing ⇒ correctness 0
  - type: tool_called          # proves the answer came from the tool, not memory
    min: 1

judge:
  rubric: >
    Correct if the answer is 1804 and nothing contradictory is stated.
  reference: "1804"

before: scripts/reset-ticket.sh   # optional per-trial hooks
after:  scripts/cleanup.sh
```

### 5.3 Check types
`equals`, `contains`, `regex`, `json_path` (on the final answer or structured output), `tool_called` (min/max count), `no_escape` (zero denied calls), and `script`. A `script` check receives the answer and the trial dir as JSON on stdin and exits 0 on pass. It's the escape hatch for checks against real systems, e.g. "the Jira ticket now exists."

### 5.4 Task authoring guidance (for the docs)
- **Beat prior knowledge.** Models already know Napoleon's coronation year. Prefer **synthetic fixture pages with planted "canary" facts**, or require details only the page contains, and add a `tool_called` check.
- Mix difficulty levels: single lookup, answer buried deep (tests truncation and `--full`), multi-hop (follow a link), error cases (404, timeouts, bad input) and tiny pages (fixed overhead).

## 6. Scoring

### 6.1 Per trial
| Metric | Source |
|---|---|
| `correctness` ∈ [0,1] | LLM judge (§6.2) |
| `tokens_weighted` **(scored)** | Cost-weighted input-token equivalents, summed over every model in `modelUsage`: input ×1, cache write ×1.25, cache read ×0.1, output ×5. These are ratios to the model's own input price and hold for all current models. Models are not scaled by their absolute price. *(Decided after M1: cache reads made up most of the plain sum.)* |
| `tokens_total` | Plain sum over `modelUsage` of input + cache_creation + cache_read + output. **Includes side-model calls**, e.g. WebFetch's internal summarizer. *(M0: confirmed. On a Sonnet trial, WebFetch's summarizer shows up as a separate `claude-haiku-4-5` entry.)* |
| `tokens_breakdown` | Per model and per kind (input/output/cache), plus estimated **tool-output tokens**: the tokens tool results added to context. This is the AXI's direct lever. |
| `turns` | `num_turns` |
| `tool_calls` | Counted from the transcript |
| `time_ms` | `duration_ms` (also `duration_api_ms`) |
| `errors` **(scored)** | Escape attempts + **error recoveries**: tool calls that errored and were followed by further tool calls. An error on the final call that *is* the answer (e.g. a clean 404 exit, which AXI principle 6 encourages) isn't penalized. Raw `tool_errors` is stored and shown too. *(Decided in M2.)* |
| `status` | `success` / `max_turns` / `timeout` / `error` |
| `cost_usd_notional` | `total_cost_usd`. Shown for reference, not scored. |

### 6.2 Correctness: checks feed the judge (decided)
1. Deterministic checks run first.
2. The LLM judge receives: task prompt, rubric, reference answer, **check results**, the final answer, and a condensed transcript (the list of tool calls with truncated outputs). It returns `{score: 0..1, reasoning}` as structured output.
3. Any failed check marked `required: true` forces `correctness = 0` whatever the judge says. This is my addition, so a judge can't talk its way past a hard fact.
4. The judge grades **meaning, not wording**. The reference answer is one acceptable phrasing. *(M2: a rubric with a parenthetical phrase made Haiku demand that exact wording.)*
5. The judge uses a **cheap model, pinned** (default `claude-haiku-4-5`, configurable with `--judge-model`), recorded on every judgment so scores stay comparable. The deterministic checks do most of the work, so a small judge is enough. Judge calls are logged and counted separately from trial tokens, and use the same runner backend as the trials.

### 6.3 Arena Score (per match, then aggregated)
For each (task, model, baseline):

1. Take the **median** of each metric over the N trials per arm.
2. Relative improvement per efficiency metric, where higher is better for the AXI:
   `r_m = clamp((baseline_m − axi_m) / baseline_m, −1, 1)` for m ∈ {tokens (= `tokens_weighted`), turns, time, errors}. Errors include escape attempts. If `errors` is 0 on both sides, r = 0.
3. `efficiency = Σ w_m · r_m` using the pack's weights (default tokens 0.4, turns 0.2, time 0.2, errors 0.2).
4. **Correctness gate:**
   - If `axi_correctness < min_correctness`, or `axi_correctness < baseline_correctness − max_regression`, the match **fails the gate**. Its score is `min(0, efficiency) − (baseline_correctness − axi_correctness)`, and it's marked ✗.
   - Otherwise `score = efficiency`.
5. Display `Arena Score = 100 × score`. **0 means parity with native**, +40 means 40% better on weighted efficiency with correctness intact, and negative means worse. Scores run from −200 to +100; below −100 only happens when a match fails the gate.

Aggregate score per pack and model = mean over tasks. The overall pack score = mean over models. The report lets you slice by model, tag and baseline.

### 6.4 Statistics
- Bootstrap 95% CI on every per-match score and on the aggregates, resampling trials within each arm, with a seeded PRNG so the numbers are reproducible. Matches with fewer than 2 trials per arm show `n<2` instead of a CI.
- Deltas whose CI crosses 0 are marked **"not significant"** in the UI and in the CLI summary.
- Headline numbers are medians, with CIs shown beside them.

## 7. Network replay

**Purpose:** both arms see byte-identical responses, and results stay comparable across weeks and AXI versions.

- A local HTTP(S) **record/replay proxy** is started per run. It has its own local CA, and trial env gets `HTTPS_PROXY`/`HTTP_PROXY`, `NODE_EXTRA_CA_CERTS`, and `NODE_USE_ENV_PROXY=1` so that Node's `fetch` honors the proxy.
- **Infrastructure traffic always passes straight through** and is never recorded. That's a fixed allowlist: `api.anthropic.com` and the other Anthropic/Claude hosts. Telemetry is turned off in trials (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`) so it doesn't add noise. Every other host goes through record/replay rules. *(M0 saw datadog telemetry going through the proxy.)*
- Certificates: a per-install local CA generates leaf certificates for each host as needed. Trials trust it through `NODE_EXTRA_CA_CERTS`.
- Modes, set per task (the pack default can be overridden):
  - `record`: forward to the internet and save the responses to `fixtures/<task-id>/`.
  - `replay`: serve only from fixtures. An unmatched request returns 599 and gets logged, and the trial is flagged **fixture miss**.
  - `live`: pass everything through. Needed for AXIs that change state, and flagged as non-reproducible.
- Fixture key: method + URL (+ body hash for non-GET). Stored as readable files: the body on its own, plus a metadata JSON.
- **Synthetic fixtures:** a pack can hand-write pages in `fixtures/` (for canary facts, edge cases and error codes) with no recording needed.
- **Built-in tools:** *(M0: confirmed that Claude Code's `WebFetch` goes through `HTTPS_PROXY`, trusts `NODE_EXTRA_CA_CERTS`, and fetches locally with UA `Claude-User`. axi-fetch works too with `NODE_USE_ENV_PROXY=1`. Both arms returned a planted canary string from a replayed fixture.)* If some other baseline tool doesn't go through the proxy, that arm runs `live` and the report shows a "baseline not replayed" warning.
- `axi-arena record <pack>` re-records fixtures on purpose. Fixtures are committed with the pack.

## 8. Side effects and sandboxes
- Hooks run in this order: pack-level `setup`/`teardown` once per run, then task-level `before`/`after` around every trial.
- `sequential: true` (per pack or per task) turns off concurrency for stateful systems, so AXI and baseline trials don't interfere with each other.
- The hooks get context as env vars: `ARENA_TRIAL_ID`, `ARENA_ARM`, `ARENA_MODEL`, `ARENA_TRIAL_DIR`.
- A failure in `before` skips the trial and marks it `setup_error`. It isn't counted against either arm.

## 9. Model matrix
- `--models haiku,sonnet,opus` (aliases resolve to full IDs, which are stored per trial).
- Trial count = tasks × arms × models × N. It is shown in the pre-run estimate together with rough token use from previous runs of the same pack, if any exist.
- **Effort is fixed per run** (pack default, `--effort` override) and recorded on every trial. It is not a matrix dimension. Runs at different effort levels are not compared in history views.
- Results are always reported per model. The UI can show the AXI advantage by model, since it often grows on smaller models.

## 10. CLI

```
axi-arena run <pack> [--models a,b] [--trials N] [--tasks glob] [--tags t]
                     [--arms axi,webfetch] [--concurrency 4] [--network replay|live]
                     [--judge-model id] [--effort level] [--keep] [--yes] [--dry-run]
axi-arena record <pack> [--tasks glob]      # (re)record fixtures
axi-arena validate <pack>                   # schema + check scripts + arm lockdown sanity
axi-arena estimate <pack> [...run flags]    # trial count + token estimate, no execution
axi-arena serve [--port 4477]               # start web app (run also auto-starts it)
axi-arena list [runs|packs]
axi-arena rescore <run-id> [--judge-model id] [--no-judge]  # re-grade from stored transcripts using the pack's *current* task definitions; script checks reuse their original results
```

`run` prints a URL to the live run view right away, and a summary table at the end.

## 11. Web app

Local only (`127.0.0.1`). It reads from SQLite and streams live updates over SSE.

| View | Contents |
|---|---|
| **Runs** | List of runs: pack, AXI version, models, status, Arena Score, date. |
| **Run overview** | Task × model grid of match scores (colored cells, ✗ for gate failures, "n.s." for not significant). Live progress while running. |
| **Match detail** | AXI vs baseline, side by side: metric medians with CIs, per-trial rows, check results and judge reasoning. |
| **Trial transcript** | Live-streamed message by message: the assistant's text, tool calls and tool outputs (with token counts), escape attempts highlighted, and final answer plus grading. |
| **Pack history** | Arena Score and key metrics over time and across AXI versions, to catch regressions. |

## 12. Architecture and stack (proposed)

- **TypeScript on Node ≥24, npm workspaces.** Node runs the `.ts` files directly, so there's no build step; `tsc` is only used for typechecking. (The plan said pnpm, but it isn't installed and npm is enough.)
  - `packages/core`: pack schema (zod), runner, proxy, checks, judge, scoring, and the DB layer.
  - `packages/cli`: the `axi-arena` binary.
  - `packages/web`: the web app. Vite + React UI, served by a small Hono server with SSE.
- **SQLite** (built-in `node:sqlite`) at `~/.axi-arena/arena.db` (`AXI_ARENA_HOME` overrides the location). Tables: `runs`, `trials`, `events` (raw SDK messages, append-only), `checks`, `judgments`, `matches`.
- Raw SDK messages are stored in full, so `rescore` and future metrics never need a re-run.

## 13. Milestones

| # | Milestone | Done when |
|---|---|---|
| **M0** ✅ | Spike: de-risk (done 2026-09-29, see `spike/`) | Confirmed: (a) SDK runs on the subscription login, or the `cli` fallback is wired up instead, (b) strict lockdown works (`tools` + `dontAsk` + hook), (c) injecting skills and hooks per trial with `settingSources: []`, (d) whether `WebFetch` traffic goes through a local proxy, (e) `modelUsage` captures WebFetch's side-model tokens, (f) how to pin effort in each backend. |
| **M1** ✅ | Runner + CLI + SQLite (done 2026-09-29) | `axi-arena run packs/axi-fetch` runs isolated trials for both arms and stores metrics. |
| **M2** ✅ | Checks + judge + scoring (done 2026-09-29) | Correctness, Arena Score and CIs in the CLI summary; `rescore` works. |
| **M3** | Web app | Runs, run overview, match detail, live transcripts. |
| **M4** | Replay | Record/replay proxy, synthetic fixtures, fixture-miss detection. |
| **M5** | Matrix + history + side effects | Multiple models per run, pack history view, `sequential`, before/after hooks. Validated on one private work AXI. |
| v2 | Later | Adoption arm (both tools available), other providers, CI mode (fail on score regression). |

## 14. Open questions
_None open right now._

### Decided
- Tool parity: every arm gets the same tool definitions and only permissions differ (§4.3).
- `Read` is a common tool in every arm, limited to the trial's saved outputs (§4.3).
- Token metric: cost-weighted tokens are scored, and the plain sum is shown next to them (§6.1).
- Gate: min correctness 0.8, max regression 0.05 (§6.3).
- Pack discovery: path, plus an optional name registry in `~/.axi-arena/config.yaml`.
- Tool-output tokens: local tokenizer estimate; headline totals come from SDK usage.
- Auth: SDK on the subscription first, falling back to the `cli` backend (§4.4).
- Judge: a cheap pinned model, default `claude-haiku-4-5` (§6.2).
- Effort: fixed per run, not a matrix dimension (§9).
- Arms: strict lockdown to AXI commands (§4.3).
- Correctness: deterministic checks are fed to the LLM judge (§6.2).
- Score: composite Arena Score with a detailed breakdown (§6).
