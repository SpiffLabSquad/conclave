// Runtime adapter: run a Docker container locally on this node.
//
// This is the workhorse for conclave Option 3 — the central server hands the
// worker the same {image, env, hostConfig} spec it would have used to launch
// the container locally, the worker pulls the image, creates the container,
// streams its multiplexed log output back as job.log frames, and reports the
// exit code on container exit.
//
// Payload schema (built by lib/tools/docker.js#buildAgentJobContainerSpec on
// the central server, sent verbatim over the wire):
//
//   {
//     image:         string,                // e.g. stephengpope/thepopebot:coding-agent-claude-code-1.2.75
//     containerName: string,                // e.g. thepopebot-agent-job-abcd1234
//     env:           string[],              // ["KEY=val", ...]
//     hostConfig:    object,                // Docker HostConfig (AutoRemove, Binds, ...)
//     volumeName?:   string,                // create + cleanup target (auto-derived from Binds[0] if absent)
//   }
//
// Talks to the local Docker daemon via /var/run/docker.sock. Windows nodes
// will need Docker Desktop with the Linux engine — named-pipe support TBD.

import http from 'node:http';

// Resolve the local Docker daemon socket. Honors (in order):
//   1. config.dockerSocket from ~/.conclave/node.json
//   2. DOCKER_HOST env var (e.g. unix:///Users/x/.colima/default/docker.sock)
//   3. /var/run/docker.sock (Docker Desktop / OrbStack default symlink)
function resolveSocketPath(config) {
  if (config?.dockerSocket) return config.dockerSocket;
  const env = process.env.DOCKER_HOST;
  if (env && env.startsWith('unix://')) return env.slice('unix://'.length);
  return '/var/run/docker.sock';
}

// Set lazily on the first runDocker() call so the module load is side-effect free.
let SOCKET_PATH = null;

// --- Docker API helpers (intentionally a small re-implementation, not a
//     dependency on the central server's lib/tools/docker.js — the worker
//     stays self-contained and shippable as a tiny standalone package). ---

function dockerJson(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: SOCKET_PATH,
      method,
      path,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : {} });
        } catch {
          resolve({ status: res.statusCode, data: { message: data } });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function dockerStream(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET_PATH, method, path }, resolve);
    req.on('error', reject);
    req.end();
  });
}

// Docker multiplexed-stream frame parser. Each frame is:
//   [type(1B) + 0 + 0 + 0 + size(4B BE)] + payload
// type 1 = stdout, type 2 = stderr.
function makeFrameParser() {
  let buf = Buffer.alloc(0);
  return function push(chunk) {
    buf = Buffer.concat([buf, chunk]);
    const out = [];
    while (buf.length >= 8) {
      const size = buf.readUInt32BE(4);
      if (buf.length < 8 + size) break;
      out.push({
        stream: buf[0] === 2 ? 'stderr' : 'stdout',
        text: buf.slice(8, 8 + size).toString('utf8'),
      });
      buf = buf.slice(8 + size);
    }
    return out;
  };
}

async function ensureImage(image, onLog) {
  const inspect = await dockerJson('GET', `/images/${encodeURIComponent(image)}/json`);
  if (inspect.status === 200) return;

  const [fromImage, tag] = image.includes(':') ? image.split(':') : [image, 'latest'];
  onLog('stdout', `[conclave/docker] pulling ${image}\n`);
  const pull = await dockerJson(
    'POST',
    `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`,
  );
  if (pull.status !== 200) {
    throw new Error(`docker pull failed (${pull.status}): ${pull.data?.message || JSON.stringify(pull.data)}`);
  }
  // Pull responses stream NDJSON; errors appear inside the stream, not the HTTP status.
  const raw = pull.data?.message || (typeof pull.data === 'string' ? pull.data : '');
  if (raw) {
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.error) throw new Error(`docker pull failed: ${obj.error}`);
      } catch (e) {
        if (String(e.message).startsWith('docker pull failed')) throw e;
      }
    }
  }
}

async function ensureVolume(name) {
  if (!name) return;
  const res = await dockerJson('POST', '/volumes/create', { Name: name });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`docker volume create failed (${res.status}): ${res.data?.message || ''}`);
  }
}

async function removeVolume(name) {
  if (!name) return;
  const res = await dockerJson('DELETE', `/volumes/${encodeURIComponent(name)}`);
  if (res.status !== 204 && res.status !== 404) {
    throw new Error(`docker volume rm failed (${res.status}): ${res.data?.message || ''}`);
  }
}

export async function runDocker(payload, onLog, config) {
  if (!payload || typeof payload.image !== 'string' || typeof payload.containerName !== 'string') {
    throw new Error('docker payload requires { image, containerName, env, hostConfig }');
  }
  if (!SOCKET_PATH) {
    SOCKET_PATH = resolveSocketPath(config);
    onLog('stdout', `[conclave/docker] using socket ${SOCKET_PATH}\n`);
  }

  const env = Array.isArray(payload.env) ? payload.env : [];
  // Force AutoRemove off — we own removal so we can read logs after exit.
  const hostConfig = { ...(payload.hostConfig || {}), AutoRemove: false };
  const volumeName = payload.volumeName
    || (Array.isArray(hostConfig.Binds) && hostConfig.Binds[0]
      ? hostConfig.Binds[0].split(':')[0]
      : null);

  // 1. Make sure the image is on this host.
  await ensureImage(payload.image, onLog);

  // 2. Create the workspace volume locally if the spec asks for one.
  await ensureVolume(volumeName);

  // 3. Create the container.
  const createBody = {
    Image: payload.image,
    Env: env,
    HostConfig: hostConfig,
    Tty: false,
  };
  if (Array.isArray(payload.cmd)) createBody.Cmd = payload.cmd;
  if (payload.workingDir) createBody.WorkingDir = payload.workingDir;
  const create = await dockerJson(
    'POST',
    `/containers/create?name=${encodeURIComponent(payload.containerName)}`,
    createBody,
  );
  if (create.status !== 201) {
    await removeVolume(volumeName).catch(() => {});
    throw new Error(`docker create failed (${create.status}): ${create.data?.message || JSON.stringify(create.data)}`);
  }
  const containerId = create.data.Id;

  // 4. Start it.
  const start = await dockerJson('POST', `/containers/${containerId}/start`);
  if (start.status !== 204 && start.status !== 304) {
    await removeContainer(containerId).catch(() => {});
    await removeVolume(volumeName).catch(() => {});
    throw new Error(`docker start failed (${start.status}): ${start.data?.message || JSON.stringify(start.data)}`);
  }
  onLog('stdout', `[conclave/docker] started ${payload.containerName} (${containerId.slice(0, 12)})\n`);

  // 5. Wait for exit BEFORE pulling logs. For short-lived containers this is
  //    near-instant; for long ones it blocks correctly. We forced AutoRemove
  //    off above so the container is still readable after /wait returns.
  const wait = await dockerJson('POST', `/containers/${containerId}/wait`);
  const exitCode = (wait.status === 200 && typeof wait.data?.StatusCode === 'number')
    ? wait.data.StatusCode
    : null;

  // 6. Pull the full log backlog in one shot (no follow). Multiplexed frames
  //    parsed the same way as if we were streaming.
  const logsRes = await dockerStream(
    'GET',
    `/containers/${containerId}/logs?stdout=true&stderr=true&timestamps=false`,
  );
  await new Promise((resolve) => {
    const parse = makeFrameParser();
    logsRes.on('data', (chunk) => {
      for (const f of parse(chunk)) onLog(f.stream, f.text);
    });
    logsRes.on('end', resolve);
    logsRes.on('close', resolve);
    logsRes.on('error', resolve);
  });

  // 7. Cleanup container, then volume.
  await removeContainer(containerId).catch((e) => {
    onLog('stderr', `[conclave/docker] container cleanup failed: ${e.message}\n`);
  });
  await removeVolume(volumeName).catch((e) => {
    onLog('stderr', `[conclave/docker] volume cleanup failed: ${e.message}\n`);
  });

  return { exitCode };
}

async function removeContainer(id) {
  const res = await dockerJson('DELETE', `/containers/${id}?force=true&v=false`);
  if (res.status !== 204 && res.status !== 404) {
    throw new Error(`docker rm failed (${res.status}): ${res.data?.message || ''}`);
  }
}
