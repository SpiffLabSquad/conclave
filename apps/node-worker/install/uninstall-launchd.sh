#!/bin/bash
# Reverse install-launchd.sh.
set -euo pipefail
LABEL="com.spifflabsquad.conclave-node-worker"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -f "$PLIST"
echo "  removed $PLIST"
