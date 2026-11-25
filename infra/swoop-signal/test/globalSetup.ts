// boots one `wrangler dev` for the run and hands the tests its address and the
// throwaway ring secret. no key here is real: the public keys are the published
// test-only pair from the golden vectors and the ring secret is generated per run,
// so nothing ever reaches .dev.vars or the repository.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

import { currentKey, previousKey, rawPublicKey } from './vectors';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8790;

declare module 'vitest' {
  interface ProvidedContext {
    baseUrl: string;
    wsUrl: string;
    port: number;
    ringSecret: string;
  }
}

// wrangler's node process is only the front end: workerd and esbuild are separate
// binaries under this project's node_modules, and killing the tree still leaves one
// behind often enough to matter. the sweep is scoped to command lines under THIS
// directory — other projects on this machine run their own wrangler.
function sweepStrays(): void {
  if (process.platform !== 'win32') return;
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*${ROOT}\\node_modules\\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { stdio: 'ignore' }
  );
}

async function stopWorker(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
    setTimeout(resolve, 5000).unref();
  });
  sweepStrays();
}

export default async function setup(project: TestProject) {
  const ringSecret = randomBytes(32).toString('hex');
  const vars: Record<string, string> = {
    SWOOP_JWT_KID: currentKey.kid,
    SWOOP_JWT_PUBLIC_KEY: rawPublicKey(currentKey),
    SWOOP_JWT_KID_PREV: previousKey.kid,
    SWOOP_JWT_PUBLIC_KEY_PREV: rawPublicKey(previousKey),
    SWOOP_SIGNAL_RING_SECRET: ringSecret,
    // a viewer is stale after 1.5 s here rather than 90 s, so the eviction test is short.
    SWOOP_VIEWER_STALE_MS: '1500',
  };

  // the bin script is run through node directly: since the CVE-2024-27980 fix,
  // spawning a .cmd shim on windows without a shell fails with EINVAL.
  const child = spawn(
    process.execPath,
    [
      join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
      'dev',
      '--ip',
      '127.0.0.1',
      '--port',
      String(PORT),
      '--log-level',
      'warn',
      ...Object.entries(vars).flatMap(([name, value]) => ['--var', `${name}:${value}`]),
    ],
    { cwd: ROOT, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }, stdio: 'ignore' }
  );

  const baseUrl = `http://127.0.0.1:${PORT}`;
  const deadline = Date.now() + 90000;
  for (;;) {
    if (Date.now() > deadline) {
      await stopWorker(child);
      throw new Error('wrangler dev did not become ready within 90s');
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  project.provide('baseUrl', baseUrl);
  project.provide('wsUrl', `ws://127.0.0.1:${PORT}`);
  project.provide('port', PORT);
  project.provide('ringSecret', ringSecret);

  return async () => {
    await stopWorker(child);
  };
}
