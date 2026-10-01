#!/bin/sh
# Ambient usage (AXI principle 7): every token here is charged to the AXI on every task, so only
# the lines that change behavior; axi-fetch's own hints cover --section/--full when relevant.
cat <<'TXT'
To fetch any URL (web pages, JSON APIs, plain-text/Markdown files), use axi-fetch instead of WebFetch or curl: run `axi-fetch <url>` directly in Bash (it's on PATH).
Looking for a specific fact? Pass keywords on the first call: `axi-fetch <url> --find "<keywords>"` returns only the matching passages (or JSON fields).
TXT
