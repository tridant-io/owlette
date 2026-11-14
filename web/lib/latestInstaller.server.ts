import { getAdminDb } from '@/lib/firebase-admin';
import {
  INSTALLER_PLATFORMS,
  normalizeInstallerFiles,
  type InstallerFiles,
  type InstallerPlatform,
} from '@/lib/installerPlatform';

const VERSION_REGEX = /^\d+\.\d+\.\d+$/;

/**
 * the latest installer as /download serves it: the version doc's files over the
 * latest pointer's, or null when latest names no version or a deleted one.
 */
export async function loadLatestInstaller(): Promise<{ version: string; files: InstallerFiles } | null> {
  const db = getAdminDb();
  const latestDoc = await db.collection('installer_metadata').doc('latest').get();
  const latestData = latestDoc.data();
  const version =
    typeof latestData?.version === 'string' && latestData.version.length > 0
      ? latestData.version
      : null;
  if (!latestDoc.exists || !version) return null;

  const versionDoc = await db
    .collection('installer_metadata')
    .doc('data')
    .collection('versions')
    .doc(version)
    .get();
  const versionData = versionDoc.data();
  if (!versionDoc.exists || typeof versionData?.deletedAt === 'number') return null;

  return {
    version,
    files: { ...normalizeInstallerFiles(latestData ?? {}), ...normalizeInstallerFiles(versionData ?? {}) },
  };
}

/**
 * is this url and hash a file `installer_metadata` publishes? matched against
 * `version`, or the latest version when none is named, and only while that
 * version exists undeleted. latest counts beside the version doc because it is
 * what the dashboard reads the url from.
 */
export async function isPublishedInstaller(
  db: ReturnType<typeof getAdminDb>,
  file: { url: unknown; checksum: unknown; version: unknown },
): Promise<boolean> {
  const { url, checksum, version } = file;
  if (typeof url !== 'string' || url.length === 0) return false;
  if (typeof checksum !== 'string' || checksum.length === 0) return false;

  const metadata = db.collection('installer_metadata');
  const latest = (await metadata.doc('latest').get()).data();
  const target = version ?? latest?.version;
  // the version names a document, so its shape is checked before it reaches a path
  if (typeof target !== 'string' || !VERSION_REGEX.test(target)) return false;

  const versionDoc = await metadata.doc('data').collection('versions').doc(target).get();
  const versionData = versionDoc.data();
  if (!versionDoc.exists || !versionData || typeof versionData.deletedAt === 'number') return false;

  const records = latest?.version === target ? [versionData, latest] : [versionData];
  const hash = checksum.toLowerCase();
  return records.some((record) =>
    Object.values(normalizeInstallerFiles(record)).some(
      (entry) => entry.download_url === url && entry.checksum_sha256?.toLowerCase() === hash,
    ),
  );
}

// the landing page renders per request, so a stalled lookup must not hold it up
const LANDING_LOOKUP_TIMEOUT_MS = 2_000;
// a minute-old list is fine for the menu and spares almost every view the two
// reads; e2e seeds the catalog directly, so it reads every time
const LANDING_CACHE_MS = 60_000;
let landingCache: { platforms: InstallerPlatform[]; at: number } | null = null;

/**
 * the platforms the landing page offers a download for: those the latest
 * release has a build for, and none when there is no release. a failed or slow
 * lookup offers them all: /download answers for itself.
 */
export async function landingDownloadPlatforms(): Promise<InstallerPlatform[]> {
  const cacheable = process.env.OWLETTE_E2E !== '1';
  if (cacheable && landingCache && Date.now() - landingCache.at < LANDING_CACHE_MS) {
    return landingCache.platforms;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), LANDING_LOOKUP_TIMEOUT_MS);
  });
  try {
    const latest = await Promise.race([loadLatestInstaller(), timeout]);
    const platforms = latest ? INSTALLER_PLATFORMS.filter((platform) => latest.files[platform]) : [];
    if (cacheable) landingCache = { platforms, at: Date.now() };
    return platforms;
  } catch (error) {
    // left uncached, so the next view asks again
    console.error('[landing] latest installer lookup failed:', error);
    return [...INSTALLER_PLATFORMS];
  } finally {
    clearTimeout(timer);
  }
}
