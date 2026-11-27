#!/bin/sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$SCRIPT_DIR/../bin/run-node.sh" "$SCRIPT_DIR/statusline.mjs"
