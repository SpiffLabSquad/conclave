// CRUD helpers for the conclave nodes + job_assignments tables.
// Follows the patterns in lib/db/CLAUDE.md (synchronous, randomUUID, Date.now()).

import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { getDb } from './index.js';
import { nodes, jobAssignments } from './schema.js';

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Register a new node. Returns the raw bearer token ONCE — only the hash is stored.
 * The caller (CLI / admin UI) must surface the token to the operator.
 */
export function createNode({ name, os, runtimes = [], labels = [], capacity = 1 }) {
  const id = crypto.randomUUID();
  const rawToken = `cncl_${crypto.randomBytes(24).toString('base64url')}`;
  const now = Date.now();

  getDb().insert(nodes).values({
    id,
    name,
    tokenHash: hashToken(rawToken),
    os: os || null,
    runtimes: JSON.stringify(runtimes),
    labels: JSON.stringify(labels),
    capacity,
    status: 'offline',
    lastSeen: null,
    createdAt: now,
    updatedAt: now,
  }).run();

  return { id, name, token: rawToken };
}

export function listNodes() {
  return getDb().select().from(nodes).all().map(decodeNode);
}

export function getNodeById(id) {
  const row = getDb().select().from(nodes).where(eq(nodes.id, id)).get();
  return row ? decodeNode(row) : null;
}

/**
 * Verify a (nodeId, token) pair presented by a connecting worker. Returns the
 * decoded node row on success, null on failure. Uses constant-time comparison.
 */
export function authenticateNode(nodeId, rawToken) {
  if (!nodeId || !rawToken) return null;
  const row = getDb().select().from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!row) return null;
  const presented = Buffer.from(hashToken(rawToken));
  const stored = Buffer.from(row.tokenHash);
  if (presented.length !== stored.length) return null;
  if (!crypto.timingSafeEqual(presented, stored)) return null;
  return decodeNode(row);
}

export function markNodeOnline(id) {
  getDb().update(nodes).set({
    status: 'online',
    lastSeen: Date.now(),
    updatedAt: Date.now(),
  }).where(eq(nodes.id, id)).run();
}

export function touchNodeHeartbeat(id) {
  getDb().update(nodes).set({ lastSeen: Date.now() }).where(eq(nodes.id, id)).run();
}

export function markNodeOffline(id) {
  getDb().update(nodes).set({
    status: 'offline',
    updatedAt: Date.now(),
  }).where(eq(nodes.id, id)).run();
}

export function deleteNode(id) {
  getDb().delete(nodes).where(eq(nodes.id, id)).run();
}

function decodeNode(row) {
  return {
    ...row,
    runtimes: safeJsonArray(row.runtimes),
    labels: safeJsonArray(row.labels),
  };
}

function safeJsonArray(s) {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

// --- job_assignments ---

export function createAssignment({ jobKey, jobKind, nodeId, runtime }) {
  const id = crypto.randomUUID();
  const now = Date.now();
  getDb().insert(jobAssignments).values({
    id, jobKey, jobKind, nodeId, runtime,
    status: 'pending', createdAt: now,
  }).run();
  return id;
}

export function updateAssignment(id, patch) {
  getDb().update(jobAssignments).set(patch).where(eq(jobAssignments.id, id)).run();
}
