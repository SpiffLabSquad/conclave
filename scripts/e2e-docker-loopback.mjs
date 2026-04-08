// End-to-end loopback test of the conclave hub <-> worker docker runtime.
//
// 1. Migrates a fresh sqlite db.
// 2. Mounts the WS hub on an http server on a random localhost port.
// 3. Uses createNode() to register a single node.
// 4. Spawns the actual apps/node-worker as a child process, with a temp
//    node.json pointed at the hub.
// 5. Calls dispatchToNode() to send a real `alpine echo hello from conclave`
//    container spec to the worker.
// 6. Asserts: hello text in logs, exit code 0.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DB_PATH = '/tmp/conclave-e2e.sqlite';
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-e2e-'));
const NODE_JSON = path.join(TMPDIR, 'node.json');

process.env.DATABASE_PATH = DB_PATH;
try { fs.unlinkSync(DB_PATH); } catch {}

console.log(`[e2e] db=${DB_PATH} tmp=${TMPDIR}`);

// 1. Migrate.
{
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  migrate(drizzle(sqlite), { migrationsFolder: path.join(REPO, 'drizzle') });
  sqlite.close();
}

const { attachHub, dispatchToNode } = await import(path.join(REPO, 'lib/transport/ws-hub.js'));
const { createNode } = await import(path.join(REPO, 'lib/db/nodes.js'));

// 2. Hub on a random port.
const server = createServer((req, res) => res.end('ok'));
attachHub(server);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const wsUrl = `ws://127.0.0.1:${port}/conclave/ws`;
console.log(`[e2e] hub listening at ${wsUrl}`);

// 3. Register a node.
const { id: nodeId, token } = createNode({
  name: 'e2e-loopback',
  os: process.platform,
  runtimes: ['docker'],
  labels: ['e2e'],
  capacity: 1,
});
console.log(`[e2e] registered node ${nodeId}`);

// Resolve docker socket the same way the worker will, surface it for visibility.
const dockerSocket = process.env.DOCKER_HOST?.startsWith('unix://')
  ? process.env.DOCKER_HOST.slice('unix://'.length)
  : (fs.existsSync('/var/run/docker.sock')
    ? '/var/run/docker.sock'
    : path.join(os.homedir(), '.colima/default/docker.sock'));
console.log(`[e2e] dockerSocket=${dockerSocket}`);

// 4. Write node.json + spawn the worker as a child process.
fs.writeFileSync(NODE_JSON, JSON.stringify({
  centralUrl: wsUrl,
  nodeId, token,
  runtimes: ['docker'],
  labels: ['e2e'],
  capacity: 1,
  dockerSocket,
}, null, 2));

const worker = spawn(process.execPath, [path.join(REPO, 'apps/node-worker/index.js')], {
  env: { ...process.env, CONCLAVE_CONFIG: NODE_JSON },
  stdio: ['ignore', 'pipe', 'pipe'],
});
worker.stdout.on('data', (b) => process.stdout.write(`[worker] ${b}`));
worker.stderr.on('data', (b) => process.stderr.write(`[worker] ${b}`));

// Give the worker a moment to connect + say hello.
await new Promise((r) => setTimeout(r, 1500));

// 5. Dispatch a real alpine echo. The container exits immediately so this is
//    a tight test of the full path: image pull (if needed), create, start,
//    multiplexed log stream, /wait, volume cleanup (no volume needed here).
console.log('[e2e] dispatching alpine echo...');
const dispatchPromise = dispatchToNode({
  runtime: 'docker',
  labels: ['e2e'],
  payload: {
    image: 'alpine:latest',
    containerName: `conclave-e2e-${Date.now()}`,
    env: [],
    cmd: ['echo', 'hello from conclave'],
    hostConfig: {},
  },
  jobKind: 'interactive',
  jobKey: 'e2e-1',
});

// Hard timeout in case anything hangs.
const timeout = new Promise((_, rej) =>
  setTimeout(() => rej(new Error('dispatch timeout 60s')), 60_000));

let result;
try {
  result = await Promise.race([dispatchPromise, timeout]);
} catch (e) {
  console.error('[e2e] FAIL:', e.message);
  worker.kill();
  server.close();
  process.exit(1);
}

console.log(`[e2e] result exitCode=${result.exitCode} logs=${result.logs.length}`);
for (const l of result.logs) {
  process.stdout.write(`  ${l.stream}: ${l.text}`);
}

const got = result.logs.map((l) => l.text).join('');
const ok = result.exitCode === 0 && got.includes('hello from conclave');

worker.kill();
await new Promise((r) => setTimeout(r, 200));
server.close();

if (ok) {
  console.log('[e2e] PASS');
  process.exit(0);
} else {
  console.error('[e2e] FAIL');
  process.exit(1);
}
