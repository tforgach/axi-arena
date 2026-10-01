#!/bin/sh
# Ambient usage (AXI principle 7): the agent learns the AXI without spending a turn loading a skill.
cat <<'TXT'
To fetch any URL (web pages, JSON APIs, plain-text/Markdown files), use axi-fetch instead of WebFetch or curl: run `axi-fetch <url>` directly in Bash (it's on PATH).
Looking for a specific fact? Pass keywords on the first call: `axi-fetch <url> --find "<keywords>"` returns only the matching passages (or JSON fields).
Without --find you get the opening content (3000 chars) and a sections list; `--section "<heading>"` returns one section, `--full` pages through everything.
TXT
