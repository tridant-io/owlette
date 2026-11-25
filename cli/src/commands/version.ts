/**
 * `owlette version` — GET /api/version. Prints the cli package version, the
 * server's current API date, and every supported date; `--json` for scripts.
 * The endpoint is unauthenticated, so a missing token is not fatal.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { Command } from 'commander';
import { loadConfig } from '../config';
import { fetchWithTimeout } from '../lib/http';
import { isJson } from '../lib/output';

/** Walks up to `cli/package.json` — same ancestor from `src/` and `dist/`. */
let cachedCliVersion: string | null = null;
export function readCliVersion(): string {
  if (cachedCliVersion !== null) return cachedCliVersion;
  let dir = __dirname;
  // Depth cap: `dirname('/')` returns itself, so an odd install could loop.
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'package.json');
    try {
      const raw = readFileSync(candidate, 'utf-8');
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === '@owlette/cli' && typeof parsed.version === 'string') {
        cachedCliVersion = parsed.version;
        return cachedCliVersion;
      }
    } catch {
      // not this directory; keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedCliVersion = 'unknown';
  return cachedCliVersion;
}

interface VersionResponse {
  current: string;
  supported: string[];
}

export function registerVersionCommand(program: Command): void {
  program
    .command('version')
    .description('print cli + server versions')
    .action(async (_opts, cmd) => {
      const json = isJson(cmd);
      const { apiUrl, token } = loadConfig({ profile: cmd.optsWithGlobals().profile });

      const headers: Record<string, string> = { Accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;

      let res: Response;
      try {
        res = await fetchWithTimeout(`${apiUrl}/api/version`, { headers });
      } catch (err) {
        fatal(`GET /api/version failed: ${(err as Error).message}`);
        return;
      }

      const data = (await res.json().catch(() => ({}))) as Partial<VersionResponse> & {
        detail?: string;
      };
      if (!res.ok) {
        fatal(`GET /api/version failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`);
        return;
      }

      const serverCurrent = typeof data.current === 'string' ? data.current : '';
      const supported = Array.isArray(data.supported)
        ? data.supported.filter((v): v is string => typeof v === 'string')
        : [];

      if (!serverCurrent || supported.length === 0) {
        fatal('GET /api/version returned an unexpected shape');
        return;
      }

      // Lex order on YYYY-MM-DD == chronological order, so min == oldest.
      const minimumVersion = [...supported].sort()[0] ?? serverCurrent;

      if (json) {
        process.stdout.write(
          JSON.stringify(
            {
              cli: readCliVersion(),
              server: serverCurrent,
              supportedVersions: supported,
              minimumVersion,
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }

      process.stdout.write(
        `cli ${readCliVersion()}  |  server ${serverCurrent}  |  ` +
          `supported versions: ${supported.join(', ')}\n`,
      );
    });
}

function fatal(msg: string): void {
  process.stderr.write(`owlette: ${msg}\n`);
  process.exitCode = 1;
}
