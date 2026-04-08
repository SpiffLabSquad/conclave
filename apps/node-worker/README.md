# conclave-node-worker

Tiny daemon that lets a Mac, Windows, or Linux machine register itself as a remote worker for a [conclave](../../README.md) control plane.

The worker dials **outbound** to the central conclave server over a single WebSocket — no inbound ports, no Docker, no NAT punching. When the central server dispatches a job, the worker runs it locally via one of its registered runtime adapters and streams stdout/stderr back over the same socket.

## Runtimes

| Runtime | What it does | Requires |
|---|---|---|
| `claude-cli` | `spawn('claude', ['-p', prompt])` in a per-job working dir | `claude` CLI installed and authenticated on the host |
| `openclaw`   | POSTs to a local OpenClaw gateway (`/dispatch`)             | OpenClaw gateway running on the host (default `http://127.0.0.1:18789`) |

More adapters drop into `runtimes/` and get listed in `index.js`'s `RUNNERS` map.

## Install

On the worker machine:

```sh
git clone https://github.com/SpiffLabSquad/conclave.git
cd conclave/apps/node-worker
npm install
```

Then ask the conclave admin to register this machine and give you a `nodeId` + `token` (forthcoming `conclave node add` CLI; for now insert directly via `lib/db/nodes.js#createNode`).

Drop the config at `~/.conclave/node.json`:

```json
{
  "centralUrl": "ws://central.example.com:3000/conclave/ws",
  "nodeId":     "<uuid from createNode>",
  "token":      "cncl_xxxxxxxxxxxxx",
  "runtimes":   ["claude-cli", "openclaw"],
  "labels":     ["mac", "mission-digital"],
  "capacity":   2,
  "openclawUrl":   "http://127.0.0.1:18789",
  "openclawToken": "..."
}
```

Run it:

```sh
node index.js
```

You should see `[conclave] connected, sending hello` followed by `[conclave] hello accepted`.

## Autostart

### macOS — launchd

Save as `~/Library/LaunchAgents/com.spifflabsquad.conclave-node-worker.plist`, edit the `/PATH/TO/conclave/apps/node-worker/index.js` placeholder, then `launchctl load` it. (Sample plist coming with the v0.2 packaging task.)

### Windows — Service

Use [`node-windows`](https://github.com/coreybutler/node-windows) to wrap `index.js` as a Windows service. (Sample script coming with v0.2.)

## Status

v0.1 — first working slice. The worker can connect, authenticate, accept dispatched jobs, run them via `claude-cli` or `openclaw`, and stream results back. The central server's UI for managing nodes and the CLI for `conclave node add` are not yet built — bootstrap manually for now.
