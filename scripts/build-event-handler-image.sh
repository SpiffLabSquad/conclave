#!/bin/bash
#
# Build the conclave event-handler Docker image FROM LOCAL FORK SOURCE.
#
# Why this exists: upstream popebot's docker/event-handler/Dockerfile installs
# `thepopebot` from npm, so it can never bake in fork changes. And building
# Next inside a small colima VM OOMs. So we:
#
#   1. npm pack the fork → thepopebot-<version>-conclave.<n>.tgz
#   2. Set up a scratch consumer project at /tmp/conclave-builder/
#      (real `node_modules/thepopebot` from the tgz, not a self-symlink)
#   3. Run `next build` ON THE HOST (where there's plenty of RAM)
#   4. Build a thin runtime Docker image that COPYs the pre-built bundle in
#      and `npm rebuild`s the native bindings for Linux.
#
# Tag: conclave/event-handler:local
#
# Run from the repo root:
#   ./scripts/build-event-handler-image.sh

set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)

echo "[1/5] esbuild + npm pack the fork"
npm run build >/dev/null
rm -f thepopebot-*.tgz
npm pack >/dev/null
TGZ=$(ls thepopebot-*.tgz)
echo "       $TGZ"

echo "[2/5] scratch consumer project at /tmp/conclave-builder"
rm -rf /tmp/conclave-builder
mkdir -p /tmp/conclave-builder
cp -R web/* /tmp/conclave-builder/
echo '{"private":true}' > /tmp/conclave-builder/package.json

echo "[3/5] npm install fork tgz + tailwind + next 15 + auth"
cd /tmp/conclave-builder
npm install --silent --no-audit --no-fund \
  "$REPO/$TGZ" \
  tailwindcss @tailwindcss/postcss \
  next@15.5.12 react@^19 react-dom@^19 next-auth@5.0.0-beta.30 next-themes >/dev/null

echo "[4/5] next build (on host — colima VM is too small)"
echo "AUTH_SECRET=stub-for-build" > .env
npx next build 2>&1 | tail -3

echo "[5/5] docker build → conclave/event-handler:local"
cp "$REPO/docker/event-handler/Dockerfile.local" Dockerfile
docker build -t conclave/event-handler:local . 2>&1 | tail -3

echo ""
echo "  Done. Run with:"
echo "    docker run -d --name conclave-eh -p 5050:80 \\"
echo "      -v /path/to/your/popebot-project/.env:/app/.env \\"
echo "      -v /path/to/your/popebot-project/data:/app/data \\"
echo "      ... conclave/event-handler:local"
