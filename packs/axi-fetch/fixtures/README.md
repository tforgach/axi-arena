# Fixtures

Network traffic for `network: replay` tasks. Each task has its own folder:

- `fixtures.yaml` holds hand-written synthetic pages. They take precedence over recordings. The
  `canary-*` pages are invented (Tidewright doesn't exist), so no model can answer them from memory.
- `recorded/` holds responses captured by `axi-arena record packs/axi-fetch`. Each response is a
  `.json` metadata file (method, URL, status, headers, time) plus a `.body` file with the raw response body.

Re-record by deleting a task's `recorded/` folder and running `axi-arena record --tasks <id>`.

Recorded bodies are copies of public pages, kept for benchmarking: Wikipedia (CC BY-SA 4.0),
the Python docs (PSF license), MDN Web Docs (CC BY-SA 2.5), go.dev (CC BY 4.0 / BSD),
RFC Editor texts (IETF Trust), GitHub API responses (`repo.json`, public repository metadata
snapshotted by hand), example.com (IANA) and httpbin.org. Check their terms before
redistributing this pack publicly.

Tasks tagged `train` drive changes to the AXI. Tasks tagged `holdout` are only checked after a
change is accepted, to catch overfitting to the train set.
