#!/bin/sh
# Install the pinned AXI under test into the pack's own .tools/ directory.
set -eu
VERSION="${AXI_FETCH_VERSION:-0.3.0}"
cd "$ARENA_PACK_DIR"
if [ "$(.tools/node_modules/.bin/axi-fetch --version 2>/dev/null)" != "$VERSION" ]; then
  # --prefer-online: a just-released version may not be in npm's local metadata cache yet.
  npm install --silent --prefer-online --no-audit --no-fund --prefix .tools "@tforgach/axi-fetch@$VERSION"
fi
