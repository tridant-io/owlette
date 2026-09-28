/**
 * @jest-environment jsdom
 *
 * `useOwletteUpdates.updateMachines` picks each machine's installer by its
 * `osFamily_arch` and skips a machine the version has no file for. The command
 * itself is covered in `__tests__/lib/actions/executeMachineCommand.test.ts`.
 */

import { act, renderHook } from '@testing-library/react';

jest.mock('@/lib/firebase', () => ({
  getLatestOwletteVersion: jest.fn(),
  sendOwletteUpdateCommand: jest.fn(),
}));

jest.mock('@/hooks/useInstallerVersion', () => ({
  useInstallerVersion: () => ({ version: '3.4.0', isLoading: false, error: null }),
}));

import { getLatestOwletteVersion, sendOwletteUpdateCommand } from '@/lib/firebase';
import { useOwletteUpdates } from '@/hooks/useOwletteUpdates';
import type { Machine } from '@/hooks/useFirestore';

const mockGetLatest = getLatestOwletteVersion as jest.MockedFunction<typeof getLatestOwletteVersion>;
const mockSend = sendOwletteUpdateCommand as jest.MockedFunction<typeof sendOwletteUpdateCommand>;

const PKG = { download_url: 'https://cdn/v3.4.0.pkg', checksum_sha256: 'pkg-sum' };
const EXE = { download_url: 'https://cdn/v3.4.0.exe', checksum_sha256: 'exe-sum' };

function machine(overrides: Partial<Machine>): Machine {
  return { machineId: 'm', online: true, agent_version: '3.3.0', ...overrides } as Machine;
}

function latestWith(files: Record<string, typeof PKG>) {
  mockGetLatest.mockResolvedValue({
    version: '3.4.0',
    downloadUrl: EXE.download_url,
    sha256Checksum: EXE.checksum_sha256,
    files: Object.fromEntries(
      Object.entries(files).map(([key, file]) => [key, { ...file, file_size: null, file_name: null, uploaded_at: null }]),
    ),
  });
}

beforeEach(() => {
  mockSend.mockResolvedValue('cmd-1');
});

describe('useOwletteUpdates — updateMachines', () => {
  it('sends each machine its own file and skips one without a build', async () => {
    latestWith({ windows_x64: EXE, macos_arm64: PKG });
    const machines = [
      machine({ machineId: 'mac-1', osFamily: 'macos', arch: 'arm64' }),
      machine({ machineId: 'win-1' }),
      machine({ machineId: 'owlette-kiosk', osFamily: 'linux', arch: 'x64' }),
    ];

    const { result } = renderHook(() => useOwletteUpdates(machines));
    let skipped: Awaited<ReturnType<typeof result.current.updateMachines>> = [];
    await act(async () => {
      skipped = await result.current.updateMachines('site-a', ['mac-1', 'win-1', 'owlette-kiosk']);
    });

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledWith('site-a', 'mac-1', PKG.download_url, undefined, '3.4.0', PKG.checksum_sha256);
    expect(mockSend).toHaveBeenCalledWith('site-a', 'win-1', EXE.download_url, undefined, '3.4.0', EXE.checksum_sha256);
    expect(skipped).toEqual([
      { machineId: 'owlette-kiosk', reason: 'no linux (.deb) build in v3.4.0' },
    ]);
    expect(result.current.updatingMachines).toEqual(new Set(['mac-1', 'win-1']));
  });

  it('names a platform the release does not ship at all', async () => {
    latestWith({ windows_x64: EXE });
    const machines = [machine({ machineId: 'pi-1', osFamily: 'linux', arch: 'arm64' })];

    const { result } = renderHook(() => useOwletteUpdates(machines));
    let skipped: Awaited<ReturnType<typeof result.current.updateMachines>> = [];
    await act(async () => {
      skipped = await result.current.updateMachines('site-a', ['pi-1']);
    });

    expect(mockSend).not.toHaveBeenCalled();
    expect(skipped).toEqual([{ machineId: 'pi-1', reason: 'no linux arm64 build in v3.4.0' }]);
  });
});
