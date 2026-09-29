#!/bin/sh
# Install the pinned AXI under test into the pack's own .tools/ directory.
set -eu
VERSION="${AXI_FETCH_VERSION:-0.1.0}"
cd "$ARENA_PACK_DIR"
if [ "$(.tools/node_modules/.bin/axi-fetch --version 2>/dev/null)" != "$VERSION" ]; then
  npm install --silent --no-audit --no-fund --prefix .tools "@tforgach/axi-fetch@$VERSION"
fi
