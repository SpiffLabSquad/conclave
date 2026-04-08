'use client';

// Read-only fleet view for /admin/nodes. The CLI handles add/revoke (see
// `npx thepopebot node add|list|revoke`); this page is "what's currently
// registered and which workers are connected right now."

import { useState, useEffect } from 'react';
import { EmptyState, timeAgo } from './settings-shared.js';
import { listNodesAction } from '../../conclave/actions.js';

export function NodesPage() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  async function refresh() {
    const r = await listNodesAction();
    if (r.error) setError(r.error);
    else { setRows(r.nodes); setError(null); }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  if (rows === null && !error) {
    return (
      <div className="space-y-3">
        <div className="h-16 bg-border/50 rounded-md animate-pulse" />
        <div className="h-16 bg-border/50 rounded-md animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="mb-4">
        <h2 className="text-base font-medium">Nodes</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Remote worker machines registered with this conclave server. Add new ones with{' '}
          <code className="px-1 py-0.5 bg-muted rounded">npx thepopebot node add &lt;name&gt;</code>.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {rows && rows.length === 0 ? (
        <EmptyState message="No nodes registered yet." />
      ) : (
        <div className="space-y-3">
          {rows && rows.map((n) => <NodeRow key={n.id} node={n} />)}
        </div>
      )}
    </div>
  );
}

function NodeRow({ node }) {
  const connected = node.live?.connected;
  const running = node.live?.running ?? 0;
  const dot = connected
    ? 'bg-green-500'
    : (node.status === 'draining' ? 'bg-yellow-500' : 'bg-muted-foreground');
  const statusText = connected ? 'Connected' : (node.status === 'draining' ? 'Draining' : 'Offline');

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
            <span className="font-medium text-sm">{node.name}</span>
            <span className="text-xs text-muted-foreground">{statusText}</span>
            {connected && (
              <span className="text-xs text-muted-foreground">· {running}/{node.capacity} running</span>
            )}
          </div>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <Field label="ID"        value={<code className="text-[11px]">{node.id}</code>} />
            <Field label="OS"        value={node.os || '-'} />
            <Field label="Runtimes"  value={(node.runtimes || []).join(', ') || '-'} />
            <Field label="Labels"    value={(node.labels || []).join(', ') || '-'} />
            <Field label="Capacity"  value={String(node.capacity)} />
            <Field label="Last seen" value={node.lastSeen ? timeAgo(node.lastSeen) : '-'} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <span className="text-muted-foreground">{label}:</span>{' '}
      <span className="text-foreground">{value}</span>
    </div>
  );
}
