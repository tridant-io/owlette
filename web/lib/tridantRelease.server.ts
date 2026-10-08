/**
 * Keeps tridant id's owlette release log in step with the installer versions.
 * A version is listed when it is active and not newer than `latest`; a deleted
 * version, or one above `latest` after a rollback, is yanked. Only files on
 * this environment's download host are registered (tridant id refuses any
 * other url), so a version still on firebase storage is skipped.
 *
 * The outcome is stored on the version doc as `tridant`. A sync never throws:
 * a promote or delete must not fail because tridant id is down.
 */

import 'server-only';
import { FieldValue, type DocumentSnapshot } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import { isInstallerPublicUrl } from '@/lib/installerStorage.server';
import { INSTALLER_PLATFORMS, installerFileName, normalizeInstallerFiles, type InstallerPlatform } from '@/lib/installerPlatform';
import { tridantApiUrl, tridantFetch, type TridantFailure } from '@/lib/tridant.server';
import { compareVersions } from '@/lib/versionUtils';

const PRODUCT_ID = 'prd_owlette_core';

const ARTIFACT_TARGET: Record<InstallerPlatform, { os: string; arch: string }> = {
  windows_x64: { os: 'win', arch: 'x64' },
  macos_arm64: { os: 'mac', arch: 'arm64' },
  linux_x64: { os: 'linux', arch: 'x64' },
};

export type TridantReleaseStatus = 'registered' | 'yanked' | 'failed';

/** stored on `installer_metadata/data/versions/{version}.tridant`. */
export interface TridantReleaseState {
  status: TridantReleaseStatus;
  release_id: string | null;
  yanked: boolean;
  error: string | null;
  at: number;
}

/** `skipped`: nothing for tridant id to hold (no file on the download host, or never registered). */
export type TridantSync =
  | { status: TridantReleaseStatus; error: string | null }
  | { status: 'not_configured' | 'skipped'; error: null };

/** the stored state, or null before any sync. */
export function tridantReleaseState(value: unknown): TridantReleaseState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  return {
    status: state.status === 'registered' || state.status === 'yanked' ? state.status : 'failed',
    release_id: typeof state.release_id === 'string' ? state.release_id : null,
    yanked: state.yanked === true,
    error: typeof state.error === 'string' ? state.error : null,
    at: typeof state.at === 'number' ? state.at : 0,
  };
}

function failureText(failure: TridantFailure): string {
  const code = (failure.json as { error?: unknown } | null | undefined)?.error;
  return [failure.status, typeof code === 'string' ? code : failure.reason].filter(Boolean).join(' ');
}

function importBody(version: string, data: Record<string, unknown>) {
  const files = normalizeInstallerFiles({ ...data, version });
  const artifacts = INSTALLER_PLATFORMS.flatMap((platform) => {
    const file = files[platform];
    if (!file?.checksum_sha256 || !isInstallerPublicUrl(file.download_url)) return [];
    return [{
      kind: 'app',
      ...ARTIFACT_TARGET[platform],
      filename: file.file_name ?? installerFileName(version, platform),
      size_bytes: file.file_size ?? 0,
      sha256: file.checksum_sha256,
      download_url: file.download_url,
    }];
  });
  if (artifacts.length === 0) return null;
  const notes = typeof data.release_notes === 'string' ? data.release_notes.trim() : '';
  return {
    releases: [{
      version,
      channel: 'stable',
      published_at: typeof data.uploaded_at === 'number' ? data.uploaded_at : Date.now(),
      ...(notes ? { notes_md: notes } : {}),
      artifacts,
    }],
  };
}

/** the import answers with every release in the group; this version's id is needed to yank it later. */
function releaseIdFrom(json: unknown, version: string): string | null {
  const list = Array.isArray(json) ? json : (json as { releases?: unknown } | null)?.releases;
  if (!Array.isArray(list)) return null;
  const hit = list.find((r) => (r as { version?: unknown } | null)?.version === version) as { id?: unknown } | undefined;
  return typeof hit?.id === 'string' ? hit.id : null;
}

function setYanked(key: string, releaseId: string, yanked: boolean, reason: string) {
  return tridantFetch(`/v1/admin/releases/${encodeURIComponent(releaseId)}`, {
    key,
    method: 'PATCH',
    body: yanked ? { yanked: true, yanked_reason: reason } : { yanked: false },
  });
}

/** tridant id should list a version while it is active and not newer than latest. */
function isListed(version: string, data: Record<string, unknown>, latest: string | null): boolean {
  return typeof data.deletedAt !== 'number' && latest !== null && (compareVersions(version, latest) ?? 1) <= 0;
}

async function syncOne(doc: DocumentSnapshot, latest: string | null, key: string): Promise<TridantSync> {
  const version = doc.id;
  const data = doc.data() ?? {};
  const state = tridantReleaseState(data.tridant);
  const deleted = typeof data.deletedAt === 'number';
  const listed = isListed(version, data, latest);
  const at = Date.now();

  let next: TridantReleaseState;
  if (!listed) {
    if (!state?.release_id) {
      // never registered: nothing to pull, and an earlier failure no longer applies
      if (state) await doc.ref.update({ tridant: FieldValue.delete() });
      return { status: 'skipped', error: null };
    }
    if (state.yanked) {
      next = { ...state, status: 'yanked', error: null, at };
    } else {
      const reason = deleted ? 'deleted in owlette' : `latest rolled back to ${latest}`;
      const yank = await setYanked(key, state.release_id, true, reason);
      next = yank.ok
        ? { ...state, status: 'yanked', yanked: true, error: null, at }
        : { ...state, status: 'failed', error: failureText(yank), at };
    }
  } else {
    const body = importBody(version, data);
    if (!body) return { status: 'skipped', error: null };
    const imported = await tridantFetch(`/v1/admin/products/${PRODUCT_ID}/releases/import`, {
      key,
      method: 'POST',
      body,
    });
    const releaseId = imported.ok ? releaseIdFrom(imported.json, version) : null;
    if (!releaseId) {
      next = {
        status: 'failed',
        release_id: state?.release_id ?? null,
        yanked: state?.yanked ?? false,
        error: imported.ok ? 'the import response has no id for this version' : failureText(imported),
        at,
      };
    } else {
      // an import may not lift an earlier yank, so a restored version is un-yanked explicitly
      const unyank = state?.yanked ? await setYanked(key, releaseId, false, '') : null;
      next = unyank && !unyank.ok
        ? { status: 'failed', release_id: releaseId, yanked: true, error: failureText(unyank), at }
        : { status: 'registered', release_id: releaseId, yanked: false, error: null, at };
    }
  }

  await doc.ref.update({ tridant: next });
  return { status: next.status, error: next.error };
}

/**
 * Brings `version` in line with tridant id. When it is `latest`, every other
 * registered release follows: one above it is yanked (a rollback must not leave
 * a newer build on the portal), and an active one at or below it that an
 * earlier rollback yanked is listed again.
 */
export async function syncInstallerRelease(version: string): Promise<TridantSync> {
  const key = process.env.TRIDANT_RELEASE_KEY?.trim();
  if (!tridantApiUrl() || !key) return { status: 'not_configured', error: null };
  try {
    const db = getAdminDb();
    const [latestSnap, versionsSnap] = await Promise.all([
      db.collection('installer_metadata').doc('latest').get(),
      db.collection('installer_metadata').doc('data').collection('versions').get(),
    ]);
    const latestVersion = latestSnap.data()?.version;
    const latest = typeof latestVersion === 'string' ? latestVersion : null;
    const target = versionsSnap.docs.find((d) => d.id === version);
    if (!target) return { status: 'skipped', error: null };

    const result = await syncOne(target, latest, key);
    if (version === latest) {
      for (const doc of versionsSnap.docs) {
        const data = doc.data();
        const state = tridantReleaseState(data.tridant);
        if (doc.id === version || !state?.release_id) continue;
        // listed but yanked, or yanked-worthy but listed
        if (isListed(doc.id, data, latest) === state.yanked) await syncOne(doc, latest, key);
      }
    }
    return result;
  } catch (err) {
    logger.error('[tridant] release sync failed', {
      context: 'tridant',
      data: { version, error: err instanceof Error ? err.message : String(err) },
    });
    return { status: 'failed', error: 'the sync failed before tridant id answered' };
  }
}
