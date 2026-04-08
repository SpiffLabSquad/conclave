'use server';

// Server actions for the conclave web UI. Read-only first slice — registration
// and revocation live in the CLI (`npx thepopebot node add|revoke`).

import { auth } from '../auth/index.js';
import { listNodes } from '../db/nodes.js';
import { listLiveConnections } from '../transport/ws-hub.js';

/**
 * Return the registered node fleet, joined with live in-memory connection
 * status from the WS hub running in this same process.
 *
 * Each row: {
 *   id, name, os, runtimes, labels, capacity, status, lastSeen,
 *   live: { connected, running } | null,
 * }
 *
 * `status` is the persisted state from the DB (online/offline/draining).
 * `live.connected` is whether a worker is currently holding a socket open
 * to the hub right now (more authoritative for "is it actually here").
 */
export async function listNodesAction() {
  const session = await auth();
  if (!session?.user) return { error: 'unauthenticated' };

  const persisted = listNodes();
  const liveByNode = new Map(listLiveConnections().map((c) => [c.nodeId, c]));

  return {
    nodes: persisted.map((n) => {
      const live = liveByNode.get(n.id) || null;
      return {
        id: n.id,
        name: n.name,
        os: n.os,
        runtimes: n.runtimes,
        labels: n.labels,
        capacity: n.capacity,
        status: n.status,
        lastSeen: n.lastSeen,
        live: live ? { connected: true, running: live.running } : { connected: false, running: 0 },
      };
    }),
  };
}
