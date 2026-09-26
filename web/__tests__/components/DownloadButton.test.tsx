/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * DownloadButton — the visitor's own platform is the primary action, the menu
 * lists every platform and says why one cannot be had (no build in this
 * version, intel mac), copy takes the primary's link.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import DownloadButton from '@/components/DownloadButton';
import type { InstallerFiles } from '@/lib/installerPlatform';

// jsdom ships no ResizeObserver; Radix's dropdown positioning constructs one.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Radix drives the trigger with pointer capture — absent in jsdom.
window.HTMLElement.prototype.scrollIntoView = jest.fn();
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.setPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

let files: InstallerFiles = {};
jest.mock('@/hooks/useInstallerVersion', () => ({
  useInstallerVersion: () => ({
    version: '3.4.0',
    files,
    downloadUrl: files.windows_x64?.download_url ?? null,
    isLoading: false,
    error: null,
  }),
}));

const file = (ext: string) => ({
  download_url: `https://cdn.example/Owlette-Installer-v3.4.0.${ext}`,
  checksum_sha256: null,
  file_size: null,
  file_name: null,
  uploaded_at: null,
});

const ALL_FILES: InstallerFiles = {
  windows_x64: file('exe'),
  macos_arm64: file('pkg'),
  linux_x64: file('deb'),
};

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) Safari/605.1.15';

function setNavigator(userAgent: string, userAgentData?: object) {
  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
  Object.defineProperty(window.navigator, 'userAgentData', { value: userAgentData, configurable: true });
}

// asserts the primary first: the open menu hides the rest of the page from role queries
async function openMenu(primaryLabel: string) {
  const user = userEvent.setup();
  render(
    <TooltipProvider delayDuration={0}>
      <DownloadButton variant="card" />
    </TooltipProvider>,
  );
  expect(await screen.findByRole('button', { name: primaryLabel })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'choose installer platform' }));
  await screen.findByRole('menu');
  return user;
}

const menuItem = (name: string) => screen.getByRole('menuitem', { name });

describe('DownloadButton', () => {
  beforeEach(() => {
    files = ALL_FILES;
  });

  it('offers a windows visitor the exe and every platform in the menu', async () => {
    setNavigator(WINDOWS_UA);
    await openMenu('download v3.4.0 for windows');

    for (const name of ['windows', 'macos (apple silicon)', 'linux (.deb)']) {
      expect(menuItem(name)).not.toHaveAttribute('aria-disabled');
    }
  });

  it('offers a mac the pkg', async () => {
    setNavigator(MAC_UA);
    render(
      <TooltipProvider>
        <DownloadButton variant="card" />
      </TooltipProvider>,
    );

    expect(await screen.findByRole('button', { name: 'download v3.4.0 for macos' })).toBeEnabled();
  });

  it('falls back to windows on an intel mac and says why', async () => {
    setNavigator(MAC_UA, {
      platform: 'macOS',
      getHighEntropyValues: async () => ({ architecture: 'x86' }),
    });
    const user = await openMenu('download v3.4.0 for windows (intel macs are not supported)');

    const mac = menuItem('macos (apple silicon)');
    expect(mac).toHaveAttribute('aria-disabled', 'true');
    await user.hover(mac);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('intel macs are not supported');
  });

  it('disables a platform the version has no build for', async () => {
    files = { windows_x64: ALL_FILES.windows_x64, macos_arm64: ALL_FILES.macos_arm64 };
    setNavigator(WINDOWS_UA);
    const user = await openMenu('download v3.4.0 for windows');

    const linux = menuItem('linux (.deb)');
    expect(linux).toHaveAttribute('aria-disabled', 'true');
    await user.hover(linux);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('no linux build in this version');
  });

  it('keeps the header labels the e2e specs hover', async () => {
    setNavigator(WINDOWS_UA);
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <DownloadButton />
      </TooltipProvider>,
    );

    const download = screen.getByLabelText('download owlette agent');
    expect(screen.getByLabelText('copy owlette agent download link')).toBeEnabled();
    await user.hover(download);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('download v3.4.0 for windows');
  });
});
