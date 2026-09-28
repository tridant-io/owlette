/** @jest-environment node */

/**
 * Tests for installerPlatform.ts: the user-agent and `?os=` mapping the
 * download route uses, the extension mapping the upload route derives a
 * platform from, browser detection with and without client hints, and the
 * record normaliser the client hook and the server builder share.
 */

import {
  INSTALLER_PLATFORMS,
  detectBrowserPlatform,
  installerFileName,
  normalizeInstallerFiles,
  platformFromExtension,
  platformFromOsParam,
  platformFromUserAgent,
} from '@/lib/installerPlatform';

const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const LINUX_FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const CURL = 'curl/8.7.1';

describe('platformFromUserAgent', () => {
  it('maps each desktop browser to its platform', () => {
    expect(platformFromUserAgent(WINDOWS_CHROME)).toBe('windows_x64');
    expect(platformFromUserAgent(MAC_SAFARI)).toBe('macos_arm64');
    expect(platformFromUserAgent(MAC_CHROME)).toBe('macos_arm64');
    expect(platformFromUserAgent(LINUX_FIREFOX)).toBe('linux_x64');
  });

  it('sends android, curl and an absent header to windows', () => {
    expect(platformFromUserAgent(ANDROID_CHROME)).toBe('windows_x64');
    expect(platformFromUserAgent(CURL)).toBe('windows_x64');
    expect(platformFromUserAgent(null)).toBe('windows_x64');
    expect(platformFromUserAgent('')).toBe('windows_x64');
  });
});

describe('platformFromOsParam', () => {
  it('maps the three os names to their platform key', () => {
    expect(platformFromOsParam('windows')).toBe('windows_x64');
    expect(platformFromOsParam('macos')).toBe('macos_arm64');
    expect(platformFromOsParam('linux')).toBe('linux_x64');
  });

  it('rejects anything else', () => {
    expect(platformFromOsParam('ios')).toBeNull();
    expect(platformFromOsParam('')).toBeNull();
    expect(platformFromOsParam(null)).toBeNull();
  });
});

describe('platformFromExtension', () => {
  it('maps exe, pkg and deb, ignoring case', () => {
    expect(platformFromExtension('Owlette-Installer-v3.4.0.exe')).toBe('windows_x64');
    expect(platformFromExtension('Owlette-Installer-v3.4.0.pkg')).toBe('macos_arm64');
    expect(platformFromExtension('Owlette-Installer-v3.4.0.deb')).toBe('linux_x64');
    expect(platformFromExtension('OWLETTE-INSTALLER.EXE')).toBe('windows_x64');
    expect(platformFromExtension('installer.Pkg')).toBe('macos_arm64');
    expect(platformFromExtension('installer.DEB')).toBe('linux_x64');
  });

  it('returns null for any other name', () => {
    expect(platformFromExtension('Owlette-Installer-v3.4.0.msi')).toBeNull();
    expect(platformFromExtension('Owlette-Installer-v3.4.0.tar.gz')).toBeNull();
    expect(platformFromExtension('exe')).toBeNull();
    expect(platformFromExtension('')).toBeNull();
  });
});

describe('installerFileName', () => {
  it('names the file by version and platform extension', () => {
    expect(installerFileName('3.4.0', 'windows_x64')).toBe('Owlette-Installer-v3.4.0.exe');
    expect(installerFileName('3.4.0', 'macos_arm64')).toBe('Owlette-Installer-v3.4.0.pkg');
    expect(installerFileName('3.4.0', 'linux_x64')).toBe('Owlette-Installer-v3.4.0.deb');
  });

  it('round-trips through platformFromExtension for every platform', () => {
    for (const platform of INSTALLER_PLATFORMS) {
      expect(platformFromExtension(installerFileName('3.4.0', platform))).toBe(platform);
    }
  });
});

describe('detectBrowserPlatform', () => {
  it('reads the platform from client hints and does not ask a windows box for its architecture', async () => {
    const getHighEntropyValues = jest.fn();
    await expect(
      detectBrowserPlatform({
        userAgent: WINDOWS_CHROME,
        userAgentData: { platform: 'Windows', getHighEntropyValues },
      }),
    ).resolves.toEqual({ platform: 'windows_x64', intelMac: false });
    expect(getHighEntropyValues).not.toHaveBeenCalled();
  });

  it('falls back to the user agent when there are no client hints', async () => {
    await expect(detectBrowserPlatform({ userAgent: MAC_SAFARI })).resolves.toEqual({
      platform: 'macos_arm64',
      intelMac: false,
    });
    await expect(detectBrowserPlatform({ userAgent: LINUX_FIREFOX })).resolves.toEqual({
      platform: 'linux_x64',
      intelMac: false,
    });
  });

  it('keeps an apple silicon mac as a supported download', async () => {
    await expect(
      detectBrowserPlatform({
        userAgent: MAC_CHROME,
        userAgentData: {
          platform: 'macOS',
          getHighEntropyValues: async () => ({ architecture: 'arm' }),
        },
      }),
    ).resolves.toEqual({ platform: 'macos_arm64', intelMac: false });
  });

  it('flags an intel mac from the architecture hint', async () => {
    await expect(
      detectBrowserPlatform({
        userAgent: MAC_CHROME,
        userAgentData: {
          platform: 'macOS',
          getHighEntropyValues: async () => ({ architecture: 'x86' }),
        },
      }),
    ).resolves.toEqual({ platform: 'macos_arm64', intelMac: true });
  });

  it('treats a refused or missing architecture hint as not intel', async () => {
    await expect(
      detectBrowserPlatform({
        userAgent: MAC_CHROME,
        userAgentData: {
          platform: 'macOS',
          getHighEntropyValues: () => Promise.reject(new Error('NotAllowedError')),
        },
      }),
    ).resolves.toEqual({ platform: 'macos_arm64', intelMac: false });
    await expect(
      detectBrowserPlatform({ userAgent: MAC_CHROME, userAgentData: { platform: 'macOS' } }),
    ).resolves.toEqual({ platform: 'macos_arm64', intelMac: false });
  });

  it('maps a linux hint to linux and any other hint to windows', async () => {
    await expect(
      detectBrowserPlatform({ userAgent: LINUX_FIREFOX, userAgentData: { platform: 'Linux' } }),
    ).resolves.toEqual({ platform: 'linux_x64', intelMac: false });
    await expect(
      detectBrowserPlatform({ userAgent: ANDROID_CHROME, userAgentData: { platform: 'Android' } }),
    ).resolves.toEqual({ platform: 'windows_x64', intelMac: false });
  });
});

describe('normalizeInstallerFiles', () => {
  const windowsFile = {
    download_url: 'https://storage.example/v3.4.0/Owlette-Installer-v3.4.0.exe',
    checksum_sha256: 'a'.repeat(64),
    file_size: 123456789,
    file_name: 'Owlette-Installer-v3.4.0.exe',
    uploaded_at: 1758758400000,
  };
  const macFile = {
    download_url: 'https://storage.example/v3.4.0/Owlette-Installer-v3.4.0.pkg',
    checksum_sha256: 'b'.repeat(64),
    file_size: 98765432,
    file_name: 'Owlette-Installer-v3.4.0.pkg',
    uploaded_at: 1758758500000,
  };

  it('synthesises windows_x64 from a legacy record with flat fields only', () => {
    expect(
      normalizeInstallerFiles({
        version: '3.3.15',
        download_url: 'https://storage.example/v3.3.15/Owlette-Installer-v3.3.15.exe',
        checksum_sha256: 'c'.repeat(64),
        file_size: 111,
        uploaded_at: 1758000000000,
        release_notes: 'notes',
      }),
    ).toEqual({
      windows_x64: {
        download_url: 'https://storage.example/v3.3.15/Owlette-Installer-v3.3.15.exe',
        checksum_sha256: 'c'.repeat(64),
        file_size: 111,
        file_name: 'Owlette-Installer-v3.3.15.exe',
        uploaded_at: 1758000000000,
      },
    });
  });

  it('leaves the legacy file name null when the version is not a string', () => {
    const files = normalizeInstallerFiles({ download_url: 'https://storage.example/x.exe', version: 3 });
    expect(files.windows_x64?.file_name).toBeNull();
    expect(files.windows_x64?.checksum_sha256).toBeNull();
    expect(files.windows_x64?.file_size).toBeNull();
    expect(files.windows_x64?.uploaded_at).toBeNull();
  });

  it('prefers files over the flat fields when a record has both', () => {
    expect(
      normalizeInstallerFiles({
        version: '3.4.0',
        download_url: 'https://storage.example/stale.exe',
        checksum_sha256: 'd'.repeat(64),
        file_size: 1,
        files: { windows_x64: windowsFile, macos_arm64: macFile },
      }),
    ).toEqual({ windows_x64: windowsFile, macos_arm64: macFile });
  });

  it('fills windows_x64 from the flat fields when files lacks it', () => {
    expect(
      normalizeInstallerFiles({
        version: '3.4.0',
        download_url: windowsFile.download_url,
        checksum_sha256: windowsFile.checksum_sha256,
        file_size: windowsFile.file_size,
        uploaded_at: windowsFile.uploaded_at,
        files: { macos_arm64: macFile },
      }),
    ).toEqual({ windows_x64: windowsFile, macos_arm64: macFile });
  });

  it('drops a malformed entry and an unknown platform key', () => {
    expect(
      normalizeInstallerFiles({
        files: {
          windows_x64: windowsFile,
          macos_arm64: { checksum_sha256: 'b'.repeat(64), file_size: 1 },
          linux_x64: 'not an object',
          linux_arm64: macFile,
        },
      }),
    ).toEqual({ windows_x64: windowsFile });
  });

  it('nulls a field of the wrong type without dropping the entry', () => {
    expect(
      normalizeInstallerFiles({
        files: {
          linux_x64: {
            download_url: 'https://storage.example/x.deb',
            checksum_sha256: 42,
            file_size: '123',
            file_name: null,
            uploaded_at: Number.NaN,
          },
        },
      }),
    ).toEqual({
      linux_x64: {
        download_url: 'https://storage.example/x.deb',
        checksum_sha256: null,
        file_size: null,
        file_name: null,
        uploaded_at: null,
      },
    });
  });

  it('returns nothing for a record with no usable file anywhere', () => {
    expect(normalizeInstallerFiles({})).toEqual({});
    expect(normalizeInstallerFiles({ files: 'garbage', download_url: 7 })).toEqual({});
    expect(normalizeInstallerFiles({ files: null, version: '3.4.0' })).toEqual({});
  });
});
