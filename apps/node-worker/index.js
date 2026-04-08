#!/usr/bin/env node
// Conclave node-worker.
//
// Dials out to a central conclave server over WebSocket and runs jobs
// locally. Designed to be installable on a Mac mini, Windows box, or Linux
// host with `node` available — no Docker required.
//
// Config: ~/.conclave/node.json (override with CONCLAVE_CONFIG):
//   {
//     "centralUrl":  "ws://central.example:3000/conclave/ws",
//     "nodeId":      "<uuid from `conclave node add` output>",
//     "token":       "cncl_xxx (also from `conclave node add`)",
//     "runtimes":    ["claude-cli", "openclaw"],
//     "labels":      ["mac", "mission-digital"],
//     "capacity":    2,
//     "openclawUrl": "http://127.0.0.1:18789",
//     "openclawToken": "..."
//   }
//
// Runtime adapters live in ./runtimes/.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { WebSocket } from 'ws';
import { runClaudeCli } from './runtimes/claude-cli.js';
import { runOpenclaw } from './runtimes/openclaw.js';

const CONFIG_PATH = process.env.CONCLAVE_CONFIG
  || path.join(os.homedir(), '.conclave', 'node.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[conclave] config not found at ${CONFIG_PATH}`);
    process.exit(2);
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(`[conclave] failed to parse ${CONFIG_PATH}: ${e.message}`);
    process.exit(2);
  }
}

const config = loadConfig();
if (!config.centralUrl || !config.nodeId || !config.token) {
  console.error('[conclave] config missing centralUrl, nodeId, or token');
  process.exit(2);
}

const RUNTIMES = config.runtimes || ['claude-cli'];
const LABELS = config.labels || [];
const CAPACITY = Number.isFinite(config.capacity) ? config.capacity : 1;

const RUNNERS = {
  'claude-cli': (payload, onLog) => runClaudeCli(payload, onLog, config),
  'openclaw':   (payload, onLog) => runOpenclaw(payload, onLog, config),
};

let ws = null;
let running = 0;
let heartbeatTimer = null;
let reconnectDelay = 1000;

function connect() {
  console.log(`[conclave] connecting to ${config.centralUrl}`);
  ws = new WebSocket(config.centralUrl);

  ws.on('open', () => {
    console.log('[conclave] connected, sending hello');
    send({
      type: 'hello',
      nodeId: config.nodeId,
      token: config.token,
      os: process.platform,
      runtimes: RUNTIMES,
      labels: LABELS,
      capacity: CAPACITY,
    });
  });

  ws.on('message', (raw) => {
    let frame;
    try { frame = JSON.parse(raw.toString()); } catch { return; }
    handleFrame(frame);
  });

  ws.on('close', (code, reason) => {
    console.log(`[conclave] socket closed code=${code} reason=${reason}`);
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });

  ws.on('error', (e) => {
    console.error(`[conclave] socket error: ${e.message}`);
  });
}

function handleFrame(frame) {
  switch (frame.type) {
    case 'hello.ok':
      console.log('[conclave] hello accepted');
      reconnectDelay = 1000;
      heartbeatTimer = setInterval(sendHeartbeat, 15_000);
      heartbeatTimer.unref?.();
      sendHeartbeat();
      break;

    case 'hello.err':
      console.error(`[conclave] hello rejected: ${frame.error}`);
      try { ws.close(); } catch {}
      break;

    case 'job.dispatch':
      runJob(frame).catch((e) => {
        send({ type: 'job.result', jobId: frame.jobId, exitCode: null, error: e.message });
      });
      break;
  }
}

async function runJob(frame) {
  const { jobId, runtime, payload } = frame;
  const runner = RUNNERS[runtime];
  if (!runner) {
    send({ type: 'job.result', jobId, exitCode: null, error: `unknown runtime: ${runtime}` });
    return;
  }
  running += 1;
  const onLog = (stream, text) => send({ type: 'job.log', jobId, stream, text });
  try {
    const { exitCode } = await runner(payload, onLog);
    send({ type: 'job.result', jobId, exitCode });
  } catch (e) {
    send({ type: 'job.result', jobId, exitCode: null, error: e.message });
  } finally {
    running = Math.max(0, running - 1);
  }
}

function sendHeartbeat() {
  send({ type: 'heartbeat', running });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}

connect();
