// GitHub Copilot Enterprise token resolver — drop-in compatible with OpenClaw.
//
// OpenClaw stores the long-lived `ghu_***` GitHub OAuth user-to-server token
// in `~/openclaw/agents/main/agent/models.json` (under `providers.github-copilot
// .apiKey`). It exchanges that for a short-lived Copilot session token via
//   POST https://api.github.com/copilot_internal/v2/token
// and caches the result at `~/openclaw/credentials/github-copilot.token.json`
// as `{token, expiresAt, updatedAt}`.
//
// Conclave reuses the SAME files: when conclave refreshes, OpenClaw benefits,
// and vice versa. The session token's lifetime is short (~30 min), so we
// proactively refresh when there's < 5 min left. The base URL is derived from
// the `proxy-ep=` field embedded in the session token itself (Copilot
// Enterprise proxy hosts vary per seat).
//
// Env overrides:
//   COPILOT_TOKEN_CACHE — path to the session token cache file
//   COPILOT_GHU_TOKEN_PATH — path to the JSON file containing the long-lived ghu_*** token

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;  // refresh when < 5min remaining
const DEFAULT_COPILOT_API_BASE_URL = 'https://api.individual.githubcopilot.com';

function defaultCachePath() {
  return process.env.COPILOT_TOKEN_CACHE
    || path.join(os.homedir(), 'openclaw/credentials/github-copilot.token.json');
}

function defaultGhuTokenPath() {
  return process.env.COPILOT_GHU_TOKEN_PATH
    || path.join(os.homedir(), 'openclaw/agents/main/agent/models.json');
}

function readGhuToken() {
  const p = defaultGhuTokenPath();
  if (!fs.existsSync(p)) {
    throw new Error(`github-copilot: no ghu_*** token at ${p}. Configure OpenClaw or set COPILOT_GHU_TOKEN_PATH.`);
  }
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  // OpenClaw shape: { providers: { "github-copilot": { apiKey: "ghu_..." } } }
  const token = json?.providers?.['github-copilot']?.apiKey;
  if (!token || !token.startsWith('gh')) {
    throw new Error(`github-copilot: ghu_*** token missing or unexpected format in ${p}`);
  }
  return token;
}

function readCache() {
  const p = defaultCachePath();
  if (!fs.existsSync(p)) return null;
  try {
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (typeof json?.token === 'string' && typeof json?.expiresAt === 'number') {
      return json;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(payload) {
  const p = defaultCachePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(payload, null, 2));
}

function isCacheUsable(cache) {
  if (!cache) return false;
  return cache.expiresAt - Date.now() > REFRESH_BUFFER_MS;
}

// Extract the API base URL from the session token's `proxy-ep=` field.
// Falls back to the public default if absent. Mirrors OpenClaw's
// deriveCopilotApiBaseUrlFromToken().
function deriveBaseUrl(token) {
  const m = token?.match?.(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  if (!m) return DEFAULT_COPILOT_API_BASE_URL;
  const host = m[1].trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^proxy\./, 'api.');
  if (!host) return DEFAULT_COPILOT_API_BASE_URL;
  return `https://${host}`;
}

function parseRefreshResponse(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('github-copilot: unexpected /copilot_internal/v2/token response');
  }
  const token = value.token;
  if (typeof token !== 'string' || !token) {
    throw new Error('github-copilot: token field missing in refresh response');
  }
  const raw = value.expires_at;
  let expiresAtMs;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    expiresAtMs = raw < 1e11 ? raw * 1000 : raw;  // sec→ms heuristic
  } else if (typeof raw === 'string' && raw.trim()) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) throw new Error('github-copilot: invalid expires_at in refresh response');
    expiresAtMs = n < 1e11 ? n * 1000 : n;
  } else {
    throw new Error('github-copilot: expires_at missing in refresh response');
  }
  return { token, expiresAt: expiresAtMs };
}

async function refreshSessionToken() {
  const ghu = readGhuToken();
  const res = await fetch(COPILOT_TOKEN_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${ghu}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`github-copilot: token refresh failed HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const parsed = parseRefreshResponse(await res.json());
  const payload = { token: parsed.token, expiresAt: parsed.expiresAt, updatedAt: Date.now() };
  writeCache(payload);
  return payload;
}

/**
 * Resolve a usable Copilot Enterprise session token, refreshing via the
 * cached `ghu_***` if necessary. Returns `{ token, expiresAt, baseUrl }`.
 *
 * Safe to call concurrently — the cache file is the single source of truth.
 */
export async function resolveCopilotApiToken() {
  let cache = readCache();
  if (!isCacheUsable(cache)) {
    cache = await refreshSessionToken();
  }
  return {
    token: cache.token,
    expiresAt: cache.expiresAt,
    baseUrl: deriveBaseUrl(cache.token),
  };
}
