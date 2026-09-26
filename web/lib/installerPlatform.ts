/**
 * The platforms a release ships an installer for, keyed the way the fleet
 * reports itself (`osFamily_arch`). Pure — no firestore, no react — so the
 * route handlers, the client hook and the CLI-facing builder share one
 * normaliser and read a record the same way.
 */
import { isMachineOsFamily, type MachineOsFamily } from '@/lib/machineOs';

export const INSTALLER_PLATFORMS = ['windows_x64', 'macos_arm64', 'linux_x64'] as const;

export type InstallerPlatform = (typeof INSTALLER_PLATFORMS)[number];

export const PLATFORM_LABEL: Record<InstallerPlatform, string> = {
  windows_x64: 'windows',
  macos_arm64: 'macos (apple silicon)',
  linux_x64: 'linux (.deb)',
};

export const PLATFORM_EXT: Record<InstallerPlatform, string> = {
  windows_x64: 'exe',
  macos_arm64: 'pkg',
  linux_x64: 'deb',
};

const PLATFORM_BY_OS: Record<MachineOsFamily, InstallerPlatform> = {
  windows: 'windows_x64',
  macos: 'macos_arm64',
  linux: 'linux_x64',
};

export function platformFromExtension(fileName: string): InstallerPlatform | null {
  const match = /\.([^.]+)$/.exec(fileName);
  if (!match) return null;
  const ext = match[1].toLowerCase();
  return INSTALLER_PLATFORMS.find((platform) => PLATFORM_EXT[platform] === ext) ?? null;
}

export function installerFileName(version: string, platform: InstallerPlatform): string {
  return `Owlette-Installer-v${version}.${PLATFORM_EXT[platform]}`;
}

export function platformFromUserAgent(ua: string | null): InstallerPlatform {
  if (!ua) return 'windows_x64';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macos_arm64';
  // android carries a linux token; a phone gets the default like any unknown client
  if (/Linux|X11/.test(ua) && !/Android/.test(ua)) return 'linux_x64';
  return 'windows_x64';
}

export function platformFromOsParam(os: string | null): InstallerPlatform | null {
  return isMachineOsFamily(os) ? PLATFORM_BY_OS[os] : null;
}

// chromium's client hints; the dom lib does not type them
interface NavigatorUAData {
  platform: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
}

interface BrowserNavigator {
  userAgent: string;
  userAgentData?: NavigatorUAData;
}

export interface BrowserPlatform {
  platform: InstallerPlatform;
  intelMac: boolean;
}

const PLATFORM_BY_HINT: Partial<Record<string, InstallerPlatform>> = {
  macOS: 'macos_arm64',
  Linux: 'linux_x64',
};

/**
 * The platform to offer a visitor. Client hints name the os outright and can
 * tell an intel mac apart; safari and firefox have neither, so the user agent
 * decides and `intelMac` stays false — the pkg refuses an intel mac itself.
 */
export async function detectBrowserPlatform(nav: BrowserNavigator): Promise<BrowserPlatform> {
  const hints = nav.userAgentData;
  const platform = hints
    ? (PLATFORM_BY_HINT[hints.platform] ?? 'windows_x64')
    : platformFromUserAgent(nav.userAgent);
  let intelMac = false;
  if (platform === 'macos_arm64' && hints?.getHighEntropyValues) {
    // a permissions policy can refuse the hint; that is the same as not having it
    const values = await hints.getHighEntropyValues(['architecture']).catch(() => null);
    intelMac = values?.architecture === 'x86';
  }
  return { platform, intelMac };
}

export interface InstallerFile {
  download_url: string;
  checksum_sha256: string | null;
  file_size: number | null;
  file_name: string | null;
  uploaded_at: number | null;
}

export type InstallerFiles = Partial<Record<InstallerPlatform, InstallerFile>>;

/**
 * The per-platform files of a version or `latest` record: `files` when it is
 * there, the flat windows fields otherwise. A bad entry is dropped, never
 * thrown on — the client hook reads the record straight from firestore.
 */
export function normalizeInstallerFiles(record: Record<string, unknown>): InstallerFiles {
  const files: InstallerFiles = {};
  const raw = record.files;
  if (raw && typeof raw === 'object') {
    for (const platform of INSTALLER_PLATFORMS) {
      const entry = installerFile((raw as Record<string, unknown>)[platform]);
      if (entry) files[platform] = entry;
    }
  }
  if (!files.windows_x64) {
    // a record written before `files` existed carries the windows file flat
    const legacy = installerFile(record);
    if (legacy) {
      files.windows_x64 = {
        ...legacy,
        file_name:
          typeof record.version === 'string'
            ? installerFileName(record.version, 'windows_x64')
            : null,
      };
    }
  }
  return files;
}

function installerFile(value: unknown): InstallerFile | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.download_url !== 'string') return null;
  return {
    download_url: entry.download_url,
    checksum_sha256: stringOrNull(entry.checksum_sha256),
    file_size: numberOrNull(entry.file_size),
    file_name: stringOrNull(entry.file_name),
    uploaded_at: numberOrNull(entry.uploaded_at),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
