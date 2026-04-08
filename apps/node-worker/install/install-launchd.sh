#!/bin/bash
#
# Install conclave-node-worker as a per-user launchd LaunchAgent on macOS.
#
# Idempotent: re-running this script bootouts any prior copy and reinstalls.
# Run as the user the worker should run as (usually your normal account, NOT
# root) — LaunchAgents live under ~/Library/LaunchAgents.
#
# Pre-reqs:
#   1. node available on PATH (>=18) and a local clone of conclave's apps/node-worker
#   2. ~/.conclave/node.json populated (centralUrl, nodeId, token, runtimes, ...)
#   3. `node index.js` works manually from this directory
#
# After install: tail the log to confirm it's running:
#   tail -f ~/Library/Logs/conclave-node-worker.err.log

set -euo pipefail

cd "$(dirname "$0")/.."
WORKER_DIR="$(pwd)"
NODE_BIN="$(command -v node || true)"
LABEL="com.spifflabsquad.conclave-node-worker"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST_DEST="$LAUNCH_AGENTS/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs"
TEMPLATE="$WORKER_DIR/install/${LABEL}.plist.template"

if [ -z "$NODE_BIN" ]; then
  echo "error: node not found on PATH" >&2
  exit 1
fi
if [ ! -f "$WORKER_DIR/index.js" ]; then
  echo "error: $WORKER_DIR/index.js missing — run from apps/node-worker/install/" >&2
  exit 1
fi
if [ ! -f "$TEMPLATE" ]; then
  echo "error: template missing at $TEMPLATE" >&2
  exit 1
fi
if [ ! -f "$HOME/.conclave/node.json" ]; then
  echo "warning: $HOME/.conclave/node.json not found — the worker will exit on startup until you create it" >&2
fi

mkdir -p "$LAUNCH_AGENTS" "$LOG_DIR"

sed \
  -e "s|{{NODE_BIN}}|${NODE_BIN}|g" \
  -e "s|{{WORKER_DIR}}|${WORKER_DIR}|g" \
  -e "s|{{LOG_DIR}}|${LOG_DIR}|g" \
  "$TEMPLATE" > "$PLIST_DEST"

# Bootout any prior copy (ignore errors — first install hits this).
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
launchctl enable "gui/$(id -u)/${LABEL}"

echo ""
echo "  installed: $PLIST_DEST"
echo "  logs:      $LOG_DIR/conclave-node-worker.{out,err}.log"
echo ""
echo "  status:"
launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | head -8 || true
echo ""
echo "  to remove:  launchctl bootout gui/$(id -u)/${LABEL} && rm $PLIST_DEST"
