/**
 * `owlette key list | create` — drives GET/POST /api/account/api-keys.
 *
 * Deliberately NOT /api/keys (which the docs used to claim): that route accepts only a
 * session or Firebase ID token (`requireSessionOrIdToken`), so a CLI holding an `owk_*`
 * key gets a flat 401. `/api/account/api-keys` is the api-key-compatible surface.
 *
 * Consequences worth stating plainly:
 *   - No custom scopes. POST clones the calling key's scopes verbatim
 *     (`cloneScopes(ctx.auth.keyContext?.scopes)`) — anti-escalation, so the CLI can't
 *     mint a platform-scoped (`user`, `installer`) key unless the caller already has it.
 *   - No rotate or revoke: those verbs live on session-authenticated /api/keys/{keyId}.
 *   - Superadmin only: the route is wrapped in `authorizedPlatformHandler({ capability:
 *     'GLOBAL_SETTINGS_WRITE' })`, so the calling key needs `user=*:admin`; anything less
 *     gets 403 `scope_insufficient`.
 *
 * `create` prints the raw `owk_*` value exactly once — the server never returns it again.
 * In table mode it is the last line (`owlette key create --name ci | tail -1`); `--json`
 * round-trips the whole response.
 */

import { Command } from 'commander';
import { loadConfig } from '../config';
import { fetchWithTimeout } from '../lib/http';
import { isJson, printJson, printLine, renderTable } from '../lib/output';

interface Scope {
  resource: string;
  id: string;
  permissions: string[];
}

interface KeyRow {
  id: string;
  name: string | null;
  keyPrefix: string | null;
  scopes: Scope[] | null;
  createdAt: unknown;
  lastUsedAt: unknown;
  expiresAt: unknown;
}

// the account route returns stored firestore timestamps, which serialise as
// {_seconds,_nanoseconds} rather than epoch ms; anything that is not a date prints a dash
function formatDate(value: unknown): string {
  if (!value) return '—';
  const seconds = (value as { _seconds?: unknown })._seconds;
  const date =
    typeof seconds === 'number'
      ? new Date(seconds * 1000)
      : typeof value === 'number' || typeof value === 'string'
        ? new Date(value)
        : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '—';
}

function describeScopes(scopes: Scope[] | null): string {
  if (!scopes || scopes.length === 0) return 'legacy (full access)';
  return scopes.map((s) => `${s.resource}=${s.id}:${s.permissions.join(',')}`).join(' ');
}

export function registerKeyCommand(program: Command): void {
  const key = program
    .command('key')
    .description('manage your own api keys (inherits the calling key\'s scopes)');

  /* list */

  key
    .command('list')
    .description('list your api keys — never shows raw key values')
    .action(async (_opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetchWithTimeout(`${apiUrl}/api/account/api-keys`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as {
        keys?: KeyRow[];
        detail?: string;
        code?: string;
      };
      if (!res.ok) {
        fatal(
          `GET /api/account/api-keys failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        printJson(data);
        return;
      }
      const keys = data.keys ?? [];
      if (keys.length === 0) {
        printLine('no api keys');
        return;
      }
      printLine(
        renderTable(
          ['id', 'name', 'prefix', 'created', 'last used', 'expires', 'scopes'],
          keys.map((k) => [
            k.id,
            k.name ?? '—',
            k.keyPrefix ?? '—',
            formatDate(k.createdAt),
            formatDate(k.lastUsedAt),
            formatDate(k.expiresAt),
            describeScopes(k.scopes),
          ]),
        ),
      );
    });

  /* create */

  key
    .command('create')
    .description(
      'mint a key with the same scopes as the calling key — the raw value prints once',
    )
    .option('--name <name>', 'human-readable label', 'API Key')
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetchWithTimeout(`${apiUrl}/api/account/api-keys`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: opts.name }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        detail?: string;
        code?: string;
      };
      if (!res.ok) {
        fatal(
          `POST /api/account/api-keys failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        printJson(data);
        return;
      }
      printLine(`created ${String(data.name ?? opts.name)} (${String(data.keyId ?? '')})`);
      printLine('scopes inherited from the calling key — widen them in the dashboard');
      printLine('copy this now — it is not shown again:');
      printLine(String(data.key ?? ''));
    });
}

function resolveAuth(cmd: Command): { apiUrl: string; token: string | null; json: boolean } {
  const { apiUrl, token } = loadConfig({ profile: cmd.optsWithGlobals().profile });
  if (!token) {
    process.stderr.write(
      'owlette: no token configured. run `owlette auth login` or set OWLETTE_TOKEN.\n',
    );
    process.exitCode = 2;
    return { apiUrl, token: null, json: isJson(cmd) };
  }
  return { apiUrl, token, json: isJson(cmd) };
}

function fatal(msg: string, exitCode = 1): void {
  process.stderr.write(`owlette: ${msg}\n`);
  process.exitCode = exitCode;
}
