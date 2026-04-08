// Conclave WebSocket hub.
//
// Remote node-workers dial OUT to the central server and connect here. Each
// connection authenticates with a (nodeId, token) pair, then exchanges JSON
// frames over a long-lived socket.
//
// Frame protocol (one JSON object per ws message):
//
//   Worker → Hub:
//     { type: 'hello',     nodeId, token, os, runtimes, labels, capacity }
//     { type: 'heartbeat', running }
//     { type: 'job.log',   jobId, stream: 'stdout'|'stderr', text }
//     { type: 'job.result', jobId, exitCode, error? }
//
//   Hub → Worker:
//     { type: 'hello.ok' }
//     { type: 'hello.err', error }
//     { type: 'job.dispatch', jobId, runtime, payload }
//     { type: 'job.cancel',   jobId }
//
// The hub exposes attachHub(httpServer) to mount onto the existing Next.js
// custom server (see web/server.js), and dispatchToNode({runtime, labels?,
// payload, jobKind, jobKey}) to send a job to a selected node and resolve
// when its job.result frame comes back.

import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import {
  authenticateNode,
  markNodeOnline,
  markNodeOffline,
  touchNodeHeartbeat,
  createAssignment,
  updateAssignment,
} from '../db/nodes.js';
import { selectNode } from '../dispatch/select.js';

const HUB_PATH = '/conclave/ws';
const HEARTBEAT_TIMEOUT_MS = 45_000;

// Connected nodes, keyed by nodeId. There is at most one live socket per node.
// connections.set(nodeId, { ws, node, runtimes, labels, capacity, running, pending: Map<jobId, {resolve,reject,logs}> })
const connections = new Map();

let _wss = null;

/**
 * Mount the WS hub onto an http.Server. Idempotent.
 */
export function attachHub(httpServer) {
  if (_wss) return _wss;

  _wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return; }
    if (url.pathname !== HUB_PATH) return;
    _wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws));
  });

  // Reaper: drop connections that haven't said hello+heartbeat recently.
  setInterval(() => {
    const now = Date.now();
    for (const [nodeId, conn] of connections) {
      if (now - conn.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        try { conn.ws.close(4000, 'heartbeat timeout'); } catch {}
        cleanupConnection(nodeId, new Error('heartbeat timeout'));
      }
    }
  }, 15_000).unref?.();

  return _wss;
}

function handleConnection(ws) {
  let bound = null; // becomes { nodeId, ... } after successful hello

  ws.on('message', (raw) => {
    let frame;
    try { frame = JSON.parse(raw.toString()); } catch { return; }

    if (!bound) {
      if (frame.type !== 'hello') {
        send(ws, { type: 'hello.err', error: 'expected hello' });
        ws.close(4001, 'expected hello');
        return;
      }
      const node = authenticateNode(frame.nodeId, frame.token);
      if (!node) {
        send(ws, { type: 'hello.err', error: 'auth failed' });
        ws.close(4002, 'auth failed');
        return;
      }
      // Replace any prior connection for this node.
      const prior = connections.get(node.id);
      if (prior) { try { prior.ws.close(4003, 'replaced'); } catch {} }

      bound = {
        nodeId: node.id,
        ws,
        runtimes: Array.isArray(frame.runtimes) && frame.runtimes.length ? frame.runtimes : node.runtimes,
        labels: Array.isArray(frame.labels) && frame.labels.length ? frame.labels : node.labels,
        capacity: Number.isFinite(frame.capacity) ? frame.capacity : node.capacity,
        os: frame.os || node.os,
        running: 0,
        pending: new Map(),
        lastSeen: Date.now(),
      };
      connections.set(node.id, bound);
      markNodeOnline(node.id);
      send(ws, { type: 'hello.ok' });
      return;
    }

    bound.lastSeen = Date.now();

    switch (frame.type) {
      case 'heartbeat':
        if (Number.isFinite(frame.running)) bound.running = frame.running;
        touchNodeHeartbeat(bound.nodeId);
        break;

      case 'job.log': {
        const job = bound.pending.get(frame.jobId);
        if (job) job.logs.push({ stream: frame.stream, text: frame.text });
        break;
      }

      case 'job.result': {
        const job = bound.pending.get(frame.jobId);
        if (!job) break;
        bound.pending.delete(frame.jobId);
        bound.running = Math.max(0, bound.running - 1);
        updateAssignment(job.assignmentId, {
          status: frame.error ? 'failed' : (frame.exitCode === 0 ? 'succeeded' : 'failed'),
          exitCode: frame.exitCode ?? null,
          error: frame.error || null,
          finishedAt: Date.now(),
        });
        if (frame.error) job.reject(new Error(frame.error));
        else job.resolve({ exitCode: frame.exitCode, logs: job.logs });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (bound) cleanupConnection(bound.nodeId, new Error('socket closed'));
  });

  ws.on('error', () => { /* close handler will run */ });
}

function cleanupConnection(nodeId, err) {
  const conn = connections.get(nodeId);
  if (!conn) return;
  for (const [, job] of conn.pending) {
    try {
      updateAssignment(job.assignmentId, {
        status: 'failed', error: err.message, finishedAt: Date.now(),
      });
      job.reject(err);
    } catch {}
  }
  connections.delete(nodeId);
  markNodeOffline(nodeId);
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

/**
 * Snapshot of currently connected nodes — used by the dispatch selector.
 * @returns {Array<{nodeId,runtimes,labels,capacity,running}>}
 */
export function listLiveConnections() {
  const out = [];
  for (const [nodeId, c] of connections) {
    out.push({
      nodeId, runtimes: c.runtimes, labels: c.labels,
      capacity: c.capacity, running: c.running,
    });
  }
  return out;
}

/**
 * Dispatch a job to a remote node.
 *
 * @param {object} spec
 * @param {string} spec.runtime    - 'claude-cli' | 'openclaw' | 'docker'
 * @param {string[]} [spec.labels] - required label match
 * @param {object} spec.payload    - runtime-specific payload (see node-worker adapters)
 * @param {string} spec.jobKind    - 'agent-job' | 'cluster-role' | 'command' | 'interactive'
 * @param {string} spec.jobKey     - foreign key for job_assignments (e.g. agentJobId)
 * @returns {Promise<{exitCode,logs}>}
 */
export function dispatchToNode(spec) {
  const live = listLiveConnections();
  const nodeId = selectNode(spec, live);
  if (!nodeId) {
    return Promise.reject(new Error(`no eligible node for runtime=${spec.runtime} labels=${(spec.labels||[]).join(',')}`));
  }
  const conn = connections.get(nodeId);
  if (!conn) return Promise.reject(new Error('selected node disconnected'));

  const jobId = crypto.randomUUID();
  const assignmentId = createAssignment({
    jobKey: spec.jobKey,
    jobKind: spec.jobKind,
    nodeId,
    runtime: spec.runtime,
  });
  updateAssignment(assignmentId, { status: 'running', startedAt: Date.now() });
  conn.running += 1;

  return new Promise((resolve, reject) => {
    conn.pending.set(jobId, { resolve, reject, logs: [], assignmentId });
    send(conn.ws, {
      type: 'job.dispatch',
      jobId,
      runtime: spec.runtime,
      payload: spec.payload || {},
    });
  });
}
