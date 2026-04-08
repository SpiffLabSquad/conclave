// Minimal standalone "central" for end-to-end testing the conclave hub
// without standing up the full popebot Next.js stack.
//
// Boots an http server with the WS hub mounted, binds to 0.0.0.0 so remote
// node-workers on the LAN can reach it, and exposes a tiny HTTP API:
//
//   POST /dispatch       body: { runtime, labels?, payload }
//   GET  /nodes          → live in-memory node connections
//
// Also keeps the sqlite DB up-to-date with node status. The new `node`
// CLI commands (npx thepopebot node add|list|revoke) write to the same DB,
// so use those to register a node before pointing a worker at this server.
//
// Usage:
//   DATABASE_PATH=/tmp/conclave-host.sqlite \
//     node scripts/hub-host.mjs --port 4747
//
// Defaults: port 4747, binds 0.0.0.0, DB path from $DATABASE_PATH (no default).

import { createServer } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const argv = process.argv.slice(2);
const PORT = parseInt(arg('--port') || '4747', 10);
const HOST = arg('--host') || '0.0.0.0';

if (!process.env.DATABASE_PATH) {
  console.error('error: set DATABASE_PATH (e.g. DATABASE_PATH=/tmp/conclave-host.sqlite)');
  process.exit(1);
}

function arg(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

// Ensure migrations are applied to whatever DB the operator pointed at.
{
  const dir = path.dirname(process.env.DATABASE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const sqlite = new Database(process.env.DATABASE_PATH);
  sqlite.pragma('journal_mode = WAL');
  migrate(drizzle(sqlite), { migrationsFolder: path.join(REPO, 'drizzle') });
  sqlite.close();
}

const { attachHub, dispatchToNode, listLiveConnections } = await import(
  path.join(REPO, 'lib/transport/ws-hub.js')
);

const server = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') {
    return res.end(JSON.stringify({ ok: true, nodes: listLiveConnections().length }));
  }
  if (req.url === '/nodes') {
    return res.end(JSON.stringify(listLiveConnections(), null, 2));
  }
  if (req.method === 'POST' && req.url === '/dispatch') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let spec;
      try { spec = JSON.parse(body); } catch { res.statusCode = 400; return res.end('{"error":"bad json"}'); }
      try {
        const result = await dispatchToNode({
          runtime: spec.runtime,
          labels: spec.labels || [],
          payload: spec.payload || {},
          jobKind: spec.jobKind || 'interactive',
          jobKey: spec.jobKey || `manual-${Date.now()}`,
        });
        res.end(JSON.stringify(result, null, 2));
      } catch (e) {
        res.statusCode = 502;
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.statusCode = 404;
  res.end('{"error":"not found"}');
});

attachHub(server);

server.listen(PORT, HOST, () => {
  console.log(`[hub-host] listening on http://${HOST}:${PORT}`);
  console.log(`[hub-host] WS endpoint: ws://${HOST}:${PORT}/conclave/ws`);
  console.log(`[hub-host] DB:          ${process.env.DATABASE_PATH}`);
  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /health');
  console.log('  GET  /nodes      — live connected workers');
  console.log("  POST /dispatch   — body: { runtime, labels, payload, jobKind?, jobKey? }");
});

// Status ping every 30s.
setInterval(() => {
  const live = listLiveConnections();
  console.log(`[hub-host] connected nodes: ${live.length}${live.length ? ' — ' + live.map((n) => n.nodeId.slice(0, 8)).join(', ') : ''}`);
}, 30_000).unref?.();
