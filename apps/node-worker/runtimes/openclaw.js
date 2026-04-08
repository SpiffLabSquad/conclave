// Runtime adapter: forward a job to a local OpenClaw gateway.
//
// Payload schema:
//   {
//     agent:  string,         // required, e.g. "main" | "ops" | "intel" | "finance" | "browser"
//     prompt: string,         // required
//     timeoutMs?: number
//   }
//
// Sends a single POST to the gateway and surfaces the response body via onLog,
// then resolves with { exitCode }. exitCode = 0 on 2xx, 1 on 4xx/5xx.
//
// Gateway URL + token come from the worker's node.json (centralUrl-style fields):
//   { "openclawUrl": "http://127.0.0.1:18789", "openclawToken": "..." }

export async function runOpenclaw(payload, onLog, config) {
  if (!payload || typeof payload.agent !== 'string' || typeof payload.prompt !== 'string') {
    throw new Error('openclaw payload requires { agent: string, prompt: string }');
  }
  const url = (config.openclawUrl || 'http://127.0.0.1:18789').replace(/\/$/, '');
  const token = config.openclawToken || process.env.OPENCLAW_GATEWAY_TOKEN;

  const controller = new AbortController();
  const timer = payload.timeoutMs
    ? setTimeout(() => controller.abort(), payload.timeoutMs)
    : null;

  let res;
  try {
    res = await fetch(`${url}/dispatch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ agent: payload.agent, prompt: payload.prompt }),
      signal: controller.signal,
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    throw new Error(`openclaw fetch failed: ${e.message}`);
  }
  if (timer) clearTimeout(timer);

  const body = await res.text();
  onLog(res.ok ? 'stdout' : 'stderr', body);
  return { exitCode: res.ok ? 0 : 1 };
}
