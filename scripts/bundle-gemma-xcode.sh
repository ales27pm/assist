#!/usr/bin/env bash
set -euo pipefail

: "${SRCROOT:?Xcode SRCROOT is required}"
# Use the same reviewed Node configuration as the React Native bundle phase.
if [[ -f "$SRCROOT/.xcode.env" ]]; then
  source "$SRCROOT/.xcode.env"
fi
if [[ -f "$SRCROOT/.xcode.env.local" ]]; then
  source "$SRCROOT/.xcode.env.local"
fi
: "${NODE_BINARY:=$(command -v node)}"
exec "$NODE_BINARY" "$SRCROOT/../../scripts/bundle-gemma.mjs" --copy --if-present --incremental
