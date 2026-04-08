// Runtime adapter: spawn the local `claude` CLI in non-interactive mode.
//
// Payload schema (sent from central server):
//   {
//     prompt:   string,            // required
//     cwd?:     string,            // optional working directory; defaults to a fresh ~/.conclave/jobs/<uuid>/
//     model?:   string,            // optional --model override
//     env?:     { [k]: string },   // optional env overlay
//     timeoutMs?: number           // optional kill timeout
//   }
//
// Streams stdout/stderr back via onLog. Resolves with { exitCode } when claude exits.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export async function runClaudeCli(payload, onLog) {
  if (!payload || typeof payload.prompt !== 'string') {
    throw new Error('claude-cli payload requires { prompt: string }');
  }

  const jobsDir = path.join(os.homedir(), '.conclave', 'jobs');
  if (!fs.existsSync(jobsDir)) fs.mkdirSync(jobsDir, { recursive: true });

  const cwd = payload.cwd || path.join(jobsDir, crypto.randomUUID());
  if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });

  const args = ['-p', payload.prompt];
  if (payload.model) args.push('--model', payload.model);

  const child = spawn('claude', args, {
    cwd,
    env: { ...process.env, ...(payload.env || {}) },
  });

  child.stdout.on('data', (chunk) => onLog('stdout', chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => onLog('stderr', chunk.toString('utf8')));

  let timer = null;
  if (payload.timeoutMs) {
    timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
    }, payload.timeoutMs);
  }

  return new Promise((resolve, reject) => {
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`claude spawn failed: ${e.message}`));
    });
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code });
    });
  });
}
