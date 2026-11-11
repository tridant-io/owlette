/**
 * Streams an installer from a user-supplied https URL and returns its SHA-256, so
 * the dashboard can pin a checksum at authoring time. Agents since 9dccd12 refuse
 * `install_software` without `sha256_checksum`, so every UI-authored
 * deployment/template/preset goes through here.
 *
 * SSRF: the URL runs through `validateWebhookUrl` (https-only, private/loopback/
 * metadata IPs rejected, DNS-resolved addresses re-checked) and redirects are
 * followed manually with every hop re-validated, so a public URL cannot bounce
 * the fetch inward. The body is hashed in-stream — never buffered or written to
 * disk — and capped at `MAX_INSTALLER_BYTES`.
 *
 * Pure action; route shims are POST /api/sites/{siteId}/deployments/checksum
 * (DEPLOYMENT_MANAGE) and POST /api/platform/installer-checksum
 * (SYSTEM_PRESET_MANAGE). The retry route self-heals with it, and hoot's
 * `deploy_software` pins with it inside a tool call, which has no `maxDuration`.
 */

import { createHash } from 'node:crypto';
import { validateWebhookUrl } from '@/lib/webhookUrl';

/** hard cap on the streamed download — largest media-server installers are ~5 GB. */
export const MAX_INSTALLER_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB

const MAX_REDIRECTS = 5;

/** overall deadline; kept under the routes' `maxDuration = 300`, and the most a hoot deploy waits. */
const COMPUTE_DEADLINE_MS = 270_000;

export type InstallerChecksumErrorCode =
  | 'invalid_url'
  | 'fetch_failed'
  | 'too_many_redirects'
  | 'too_large'
  | 'timeout'
  | 'cancelled';

export class InstallerChecksumError extends Error {
  code: InstallerChecksumErrorCode;
  constructor(code: InstallerChecksumErrorCode, message: string) {
    super(message);
    this.name = 'InstallerChecksumError';
    this.code = code;
  }
}

export interface InstallerChecksumResult {
  sha256_checksum: string;
  size_bytes: number;
}

export async function computeInstallerChecksum(
  rawUrl: unknown,
  opts: { signal?: AbortSignal } = {},
): Promise<InstallerChecksumResult> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), COMPUTE_DEADLINE_MS);
  const onCallerAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onCallerAbort, { once: true });

  const abortError = (): InstallerChecksumError =>
    opts.signal?.aborted
      ? new InstallerChecksumError('cancelled', 'checksum computation cancelled by client')
      : new InstallerChecksumError(
          'timeout',
          `checksum computation exceeded ${Math.round(COMPUTE_DEADLINE_MS / 1000)}s`,
        );

  try {
    // Resolve redirects manually, SSRF-validating every hop.
    let currentUrl = typeof rawUrl === 'string' ? rawUrl : '';
    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const validation = await validateWebhookUrl(currentUrl);
      if (!validation.ok) {
        throw new InstallerChecksumError(
          'invalid_url',
          validation.detail ?? validation.reason,
        );
      }

      let resp: Response;
      try {
        resp = await fetch(validation.url, {
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw abortError();
        const message = err instanceof Error ? err.message : String(err);
        throw new InstallerChecksumError('fetch_failed', `download failed: ${message}`);
      }

      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        void resp.body?.cancel().catch(() => {});
        if (!location) {
          throw new InstallerChecksumError(
            'fetch_failed',
            `redirect (http ${resp.status}) without a location header`,
          );
        }
        currentUrl = new URL(location, validation.url).toString();
        continue;
      }

      if (!resp.ok) {
        void resp.body?.cancel().catch(() => {});
        throw new InstallerChecksumError('fetch_failed', `download failed with http ${resp.status}`);
      }

      response = resp;
      break;
    }
    if (!response) {
      throw new InstallerChecksumError(
        'too_many_redirects',
        `more than ${MAX_REDIRECTS} redirects`,
      );
    }

    // Refuse early when the server already declares an oversized body.
    const declaredLength = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_INSTALLER_BYTES) {
      void response.body?.cancel().catch(() => {});
      throw new InstallerChecksumError(
        'too_large',
        `installer exceeds the ${MAX_INSTALLER_BYTES} byte limit`,
      );
    }

    if (!response.body) {
      throw new InstallerChecksumError('fetch_failed', 'response has no body');
    }

    const hash = createHash('sha256');
    let sizeBytes = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (err) {
          if (controller.signal.aborted) throw abortError();
          const message = err instanceof Error ? err.message : String(err);
          throw new InstallerChecksumError('fetch_failed', `download interrupted: ${message}`);
        }
        if (result.done) break;
        sizeBytes += result.value.byteLength;
        if (sizeBytes > MAX_INSTALLER_BYTES) {
          throw new InstallerChecksumError(
            'too_large',
            `installer exceeds the ${MAX_INSTALLER_BYTES} byte limit`,
          );
        }
        hash.update(result.value);
      }
    } finally {
      void reader.cancel().catch(() => {});
    }

    if (sizeBytes === 0) {
      throw new InstallerChecksumError('fetch_failed', 'downloaded file is empty');
    }

    return { sha256_checksum: hash.digest('hex'), size_bytes: sizeBytes };
  } finally {
    clearTimeout(deadline);
    opts.signal?.removeEventListener('abort', onCallerAbort);
  }
}
