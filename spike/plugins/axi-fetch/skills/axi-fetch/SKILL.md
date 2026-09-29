---
name: axi-fetch
description: >
  Fetch a web page and get a compact, token-efficient TOON response instead of raw
  HTML. Use whenever the user asks to look something up, read, check, or fetch a URL
  or web page — prefer this over a raw web fetch to save tokens.
---

# axi-fetch

`axi-fetch` fetches a URL, extracts the meaningful content (article body or a
readability fallback), and prints it as [TOON](https://toonformat.dev/) — a
token-oriented format ~40% smaller than JSON. Use it in place of a raw web fetch
when you need the *content* of a page, not a full DOM.

## Usage

Run it via shell:

```sh
axi-fetch <url>
```

Examples:

```sh
axi-fetch https://en.wikipedia.org/wiki/Token_bucket
axi-fetch example.com --full          # skip content truncation
axi-fetch example.com --no-links      # omit outbound links
axi-fetch example.com --timeout 20000 # slow sites
axi-fetch example.com --max 3000      # raise the truncation limit
axi-fetch example.com --no-cache      # bypass the 15-min disk cache
```

## Output

TOON on stdout, e.g.:

```
url: "https://en.wikipedia.org/wiki/Token_bucket"
title: Token bucket
type: article
confidence: 0.8
truncated: true
content: From Wikipedia, the free encyclopedia The token bucket is...
sections[2]{heading,level}:
  Comparison to leaky bucket,2
  Hierarchical token bucket,2
help[1]: Re-run with `--full` to get the complete content
```

- `type` is `article`, `documentation`, or `generic`.
- `truncated: true` means content was cut to the limit — re-run with `--full`.
- `help` lists next-step suggestions; follow a link with another `axi-fetch <url>`.

## Errors

Failures print a structured error and use a non-zero exit code (2 for bad
input/flags, 1 otherwise):

```
error: "HTTP 404 Not Found for https://example.com/missing"
code: HTTP_ERROR
```

## Install

```sh
npm install -g @tforgach/axi-fetch
```
