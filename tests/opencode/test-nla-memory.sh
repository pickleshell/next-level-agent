#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/test-nla-memory.mjs"
node "$SCRIPT_DIR/test-nla-compaction.mjs"
node "$SCRIPT_DIR/test-nla-utility-runtime.mjs"
node "$SCRIPT_DIR/test-nla-prompt-optimizer.mjs"
node "$SCRIPT_DIR/test-nla-capability-cache.mjs"
