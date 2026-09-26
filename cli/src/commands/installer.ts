/**
 * `owlette installer list | latest | upload | set-latest | delete` — superadmin only.
 *
 * Drives:
 *   list        GET    /api/installer
 *   latest      GET    /api/installer/latest
 *   upload      POST   /api/installer/upload → PUT <signedUrl> → PUT /api/installer/upload (finalize)
 *   set-latest  POST   /api/installer/{version}/set-latest
 *   delete      DELETE /api/installer/{version}
 *
 * Mutations carry an auto-generated `Idempotency-Key`; `upload` reuses the SAME
 * key on POST and finalize so retries replay while the signed URL is still valid.
 *
 * Public API Wave 2.7 CLI route handlers.
 */

import { Command } from 'commander';
import { createHash, randomUUID } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { basename, extname } from 'path';
import { loadConfig } from '../config';
import { fetchWithTimeout } from '../lib/http';
import {
  humanBytes,
  isJson,
  renderTable,
  unconfirmedMutationFatal,
  usageFatal,
} from '../lib/output';

interface InstallerFile {
  download_url: string;
  checksum_sha256: string | null;
  file_size: number | null;
  file_name: string | null;
  uploaded_at: number | null;
}

interface InstallerVersion {
  version: string;
  download_url: string | null;
  checksum_sha256: string | null;
  release_notes: string | null;
  file_size: number | null;
  uploaded_at: number | null;
  uploaded_by: string | null;
  release_date?: string | null;
  deletedAt: number | null;
  files?: Record<string, InstallerFile>;
}

// mirrors web/lib/installerPlatform.ts; the cli cannot import from web/.
const PLATFORM_BY_EXTENSION: Record<string, string> = {
  '.exe': 'windows_x64',
  '.pkg': 'macos_arm64',
  '.deb': 'linux_x64',
};
const INSTALLER_PLATFORMS = Object.values(PLATFORM_BY_EXTENSION);

export function registerInstallerCommands(program: Command): void {
  const installer =
    (program.commands.find((c) => c.name() === 'installer') as Command | undefined) ??
    program
      .command('installer')
      .description('agent installer binary management (superadmin)');

  // Overwrite any earlier description so help text stays canonical.
  installer.description('agent installer binary management (superadmin)');

  // Drop any stub verbs left from earlier file-load ordering.
  for (const verb of ['list', 'latest', 'upload', 'set-latest', 'delete'] as const) {
    const existing = installer.commands.find((c) => c.name() === verb);
    if (existing) {
      const list = installer.commands as Command[];
      const idx = list.indexOf(existing);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  installer
    .command('list')
    .description('list uploaded installer versions, newest first (superadmin)')
    .option('--include-deleted', 'include soft-deleted versions in the listing')
    .option('--limit <n>', 'page size (1..100, default 20)')
    .option('--cursor <token>', 'opaque page_token returned by a previous list call')
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const qs = new URLSearchParams();
      if (opts.includeDeleted) qs.set('includeDeleted', 'true');
      if (opts.limit !== undefined) {
        const n = Number(opts.limit);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
          usageFatal('--limit must be a positive integer');
          return;
        }
        qs.set('page_size', String(n));
      }
      if (opts.cursor) qs.set('page_token', String(opts.cursor));

      const url = `${apiUrl}/api/installer` + (qs.toString() ? `?${qs.toString()}` : '');
      const res = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as {
        versions?: InstallerVersion[];
        next_page_token?: string;
        nextPageToken?: string;
        detail?: string;
        code?: string;
      };

      if (!res.ok) {
        if (res.status === 403 && data.code === 'scope_insufficient') {
          fatal(
            `GET /api/installer failed (403, scope_insufficient): ${data.detail ?? 'superadmin scope required'}` +
              `\n  hint: installer commands require an installer=*:read api key (superadmin-only at minting) or a superadmin user session`,
          );
          return;
        }
        fatal(
          `GET /api/installer failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      const versions = data.versions ?? [];
      if (versions.length === 0) {
        process.stdout.write('(no versions)\n');
        return;
      }

      const rows = versions.map((v) => [
        v.version,
        v.file_size != null ? humanBytes(v.file_size) : '',
        v.uploaded_at ? new Date(v.uploaded_at).toISOString().slice(0, 10) : '',
        v.deletedAt ? 'deleted' : 'active',
        (v.checksum_sha256 ?? '').slice(0, 12),
      ]);
      process.stdout.write(
        renderTable(['version', 'size', 'uploaded', 'status', 'sha256 (12)'], rows),
      );
      for (const v of versions) {
        const files = renderFiles(v.files);
        if (files) process.stdout.write(`\n${v.version}\n${files}`);
      }
      const nextPageToken = data.next_page_token ?? data.nextPageToken ?? '';
      if (nextPageToken) {
        process.stdout.write(`\nnext page: --cursor ${nextPageToken}\n`);
      }
    });

  installer
    .command('latest')
    .description('show the current latest installer version (superadmin)')
    .action(async (_opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetchWithTimeout(`${apiUrl}/api/installer/latest`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as InstallerVersion & {
        detail?: string;
        code?: string;
      };

      if (!res.ok) {
        if (res.status === 403 && data.code === 'scope_insufficient') {
          fatal(
            `GET /api/installer/latest failed (403, scope_insufficient): ${data.detail ?? 'superadmin scope required'}` +
              `\n  hint: installer latest requires an installer=*:read api key (superadmin-only at minting) or a superadmin user session`,
          );
          return;
        }
        fatal(
          `GET /api/installer/latest failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        renderTable(
          ['version', 'size', 'uploaded', 'sha256 (12)'],
          [
            [
              data.version,
              data.file_size != null ? humanBytes(data.file_size) : '',
              data.release_date
                ? String(data.release_date).slice(0, 10)
                : data.uploaded_at
                  ? new Date(data.uploaded_at).toISOString().slice(0, 10)
                  : '',
              (data.checksum_sha256 ?? '').slice(0, 12),
            ],
          ],
        ) + renderFiles(data.files),
      );
    });

  installer
    .command('upload <file>')
    .description('upload a new installer binary (3-step: request → upload → finalize)')
    .requiredOption('--version <semver>', 'semver of the installer being uploaded (X.Y.Z)')
    .option(
      '--platform <key>',
      `platform key (${INSTALLER_PLATFORMS.join(' | ')}); derived from the file extension by default`,
    )
    .option('--release-notes <text>', 'release notes shown on the dashboard')
    .option('--set-latest', 'mark this version as the latest after upload (default: true)')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (file: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const fileName = basename(file);
      const platform =
        opts.platform !== undefined
          ? String(opts.platform)
          : PLATFORM_BY_EXTENSION[extname(fileName).toLowerCase()];
      if (platform === undefined) {
        usageFatal(
          `cannot derive a platform from '${fileName}': expected a .exe (windows_x64), .pkg (macos_arm64) or .deb (linux_x64) file, or pass --platform`,
        );
        return;
      }
      if (!INSTALLER_PLATFORMS.includes(platform)) {
        usageFatal(`--platform must be one of ${INSTALLER_PLATFORMS.join(', ')}`);
        return;
      }

      // Sync read: installers are typically <50 MiB, and streaming would force a
      // manual Content-Length while the signed url already has a server-side budget.
      let buffer: Buffer;
      let fileSize: number;
      try {
        buffer = readFileSync(file);
        fileSize = statSync(file).size;
      } catch (err) {
        usageFatal(
          `cannot read installer file '${file}': ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      const checksum = createHash('sha256').update(buffer).digest('hex');

      // Same key on POST and finalize so retries replay while the url is valid.
      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-installer-upload-${randomUUID()}`;

      if (!json) {
        process.stdout.write(
          `owlette: uploading ${fileName} (${platform}, ${humanBytes(fileSize)}) — sha256 ${checksum.slice(0, 12)}…\n`,
        );
      }

      // step 1: request the signed upload url
      const startBody: Record<string, unknown> = {
        version: opts.version,
        fileName,
        platform,
      };
      if (opts.releaseNotes !== undefined) startBody.releaseNotes = opts.releaseNotes;
      if (opts.setLatest !== undefined) startBody.setAsLatest = Boolean(opts.setLatest);

      let startRes: Response;
      try {
        startRes = await fetchWithTimeout(`${apiUrl}/api/installer/upload`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(startBody),
        });
      } catch (err) {
        unconfirmedMutationFatal({
          operation: 'POST /api/installer/upload',
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const startData = (await startRes.json().catch(() => ({}))) as {
        uploadUrl?: string;
        uploadId?: string;
        storagePath?: string;
        expiresAt?: string;
        detail?: string;
        code?: string;
      };

      if (!startRes.ok) {
        if (startRes.status === 403 && startData.code === 'scope_insufficient') {
          fatal(
            `POST /api/installer/upload failed (403, scope_insufficient): ${startData.detail ?? 'superadmin scope required'}` +
              `\n  hint: installer upload requires an installer=*:write api key (superadmin-only at minting) or a superadmin user session`,
          );
          return;
        }
        fatal(
          `POST /api/installer/upload failed (${startRes.status}, ${startData.code ?? 'unknown'}): ${startData.detail ?? JSON.stringify(startData)}`,
        );
        return;
      }

      if (!startData.uploadUrl || !startData.uploadId) {
        fatal('upload response missing uploadUrl or uploadId — server contract violation');
        return;
      }

      // step 2: PUT the binary to the signed url
      if (!json) process.stdout.write('owlette: uploading binary…\n');
      const putRes = await fetch(startData.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(fileSize),
        },
        body: buffer,
      });
      if (!putRes.ok) {
        fatal(
          `PUT <signed url> failed (${putRes.status}): ${await putRes.text().catch(() => '<no body>')}`,
        );
        return;
      }

      // step 3: finalize
      if (!json) process.stdout.write('owlette: finalising…\n');
      let finalizeRes: Response;
      try {
        finalizeRes = await fetchWithTimeout(`${apiUrl}/api/installer/upload`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({ uploadId: startData.uploadId, checksum_sha256: checksum }),
        });
      } catch (err) {
        unconfirmedMutationFatal({
          operation: 'PUT /api/installer/upload (finalize)',
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const finalizeData = (await finalizeRes.json().catch(() => ({}))) as {
        version?: string;
        download_url?: string;
        checksum_sha256?: string;
        file_size?: number;
        platform?: string;
        files?: Record<string, InstallerFile>;
        detail?: string;
        code?: string;
      };

      if (!finalizeRes.ok) {
        fatal(
          `PUT /api/installer/upload (finalize) failed (${finalizeRes.status}, ${finalizeData.code ?? 'unknown'}): ${finalizeData.detail ?? JSON.stringify(finalizeData)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(finalizeData, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        `owlette: installer ${finalizeData.version} uploaded (${finalizeData.platform ?? platform}, ${humanBytes(finalizeData.file_size ?? fileSize)})\n` +
          `  sha256       ${finalizeData.checksum_sha256}\n` +
          `  download url ${finalizeData.download_url}\n`,
      );
    });

  installer
    .command('set-latest <version>')
    .description('mark an uploaded version as the latest installer (superadmin)')
    .option('--yes', 'skip the confirmation prompt')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (version: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      if (!opts.yes && process.stdin.isTTY) {
        const ok = await promptYesNo(
          `mark installer ${version} as the new 'latest'? all new agents will pull this version. [y/N] `,
        );
        if (!ok) {
          process.stdout.write('set-latest aborted\n');
          return;
        }
      } else if (!opts.yes && !process.stdin.isTTY) {
        usageFatal('stdin is not a tty and --yes was not supplied; refusing to set-latest silently');
        return;
      }

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-installer-set-latest-${randomUUID()}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      };

      const url = `${apiUrl}/api/installer/${encodeURIComponent(version)}/set-latest`;
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        });
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `POST /api/installer/${version}/set-latest`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        version?: string;
        latest?: unknown;
        detail?: string;
        code?: string;
      };

      if (!res.ok) {
        if (res.status === 403 && data.code === 'scope_insufficient') {
          fatal(
            `POST /api/installer/${version}/set-latest failed (403, scope_insufficient): ${data.detail ?? 'superadmin scope required'}` +
              `\n  hint: set-latest requires an installer=*:admin api key (superadmin-only at minting) or a superadmin user session`,
          );
          return;
        }
        fatal(
          `POST /api/installer/${version}/set-latest failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(`owlette: installer ${version} is now the latest\n`);
    });

  installer
    .command('delete <version>')
    .description('soft-delete an uploaded installer version (superadmin)')
    .option('--yes', 'skip the confirmation prompt')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (version: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      if (!opts.yes && process.stdin.isTTY) {
        const ok = await promptYesNo(
          `soft-delete installer ${version}? agents that already have it will keep it; new agents will not see it. [y/N] `,
        );
        if (!ok) {
          process.stdout.write('delete aborted\n');
          return;
        }
      } else if (!opts.yes && !process.stdin.isTTY) {
        usageFatal('stdin is not a tty and --yes was not supplied; refusing to delete silently');
        return;
      }

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-installer-delete-${randomUUID()}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': idempotencyKey,
      };

      const url = `${apiUrl}/api/installer/${encodeURIComponent(version)}`;
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'DELETE',
          headers,
        });
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `DELETE /api/installer/${version}`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        version?: string;
        deletedAt?: number | null;
        alreadyDeleted?: boolean;
        detail?: string;
        code?: string;
        minActiveVersions?: number;
        currentActiveCount?: number;
      };

      if (!res.ok) {
        if (res.status === 409 && data.code === 'min_versions_violated') {
          fatal(
            `DELETE /api/installer/${version} failed (409, min_versions_violated): ${data.detail ?? 'too few active versions remain'}` +
              `\n  hint: the platform requires at least ${data.minActiveVersions ?? 2} active version(s); upload a replacement before deleting`,
          );
          return;
        }
        if (res.status === 403 && data.code === 'scope_insufficient') {
          fatal(
            `DELETE /api/installer/${version} failed (403, scope_insufficient): ${data.detail ?? 'superadmin scope required'}` +
              `\n  hint: installer delete requires an installer=*:admin api key (superadmin-only at minting) or a superadmin user session`,
          );
          return;
        }
        fatal(
          `DELETE /api/installer/${version} failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      if (data.alreadyDeleted) {
        process.stdout.write(`owlette: installer ${version} was already deleted (no change)\n`);
      } else {
        process.stdout.write(`owlette: installer ${version} soft-deleted\n`);
      }
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

function fatal(msg: string): void {
  process.stderr.write(`owlette: ${msg}\n`);
  process.exitCode = 1;
}

/** One indented `platform  size  sha256 (12)` line per file; empty when there are none. */
function renderFiles(files: Record<string, InstallerFile> | undefined): string {
  const rows = Object.entries(files ?? {}).map(([platform, f]) => [
    platform,
    f.file_size != null ? humanBytes(f.file_size) : '',
    (f.checksum_sha256 ?? '').slice(0, 12),
  ]);
  if (rows.length === 0) return '';
  const width = (i: number): number => Math.max(...rows.map((r) => (r[i] ?? '').length));
  return (
    rows
      .map((r) =>
        `  ${(r[0] ?? '').padEnd(width(0))}  ${(r[1] ?? '').padEnd(width(1))}  ${r[2]}`.trimEnd(),
      )
      .join('\n') + '\n'
  );
}

async function promptYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import('readline');
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}
