/** @jest-environment node */

/**
 * Unit tests for `web/lib/actions/createSystemPreset.server.ts`
 * (security-boundary-migration wave 3.11).
 */

const mockSet = jest.fn().mockResolvedValue(undefined);
const mockDoc = jest.fn(() => ({ set: mockSet }));
const mockCollection = jest.fn(() => ({ doc: mockDoc }));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: mockCollection }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__server_timestamp__' },
}));

import {
  createSystemPreset,
  SystemPresetValidationError,
} from '@/lib/actions/createSystemPreset.server';
import type { UserActor } from '@/lib/capabilities';

const actor: UserActor = {
  type: 'user',
  userId: 'user-admin',
  role: 'superadmin',
  siteRoles: {},
};

const validInput = {
  name: 'TouchDesigner 2025.31550',
  software_name: 'TouchDesigner',
  category: 'Creative Software',
  installer_name: 'TouchDesigner.exe',
  installer_url: 'https://example.com/td.exe',
  silent_flags: '/VERYSILENT /NORESTART',
  is_owlette_agent: false,
  order: 2,
};

beforeEach(() => {
  mockSet.mockClear();
  mockDoc.mockClear();
  mockCollection.mockClear();
});

describe('createSystemPreset — validation', () => {
  it.each([
    ['name empty', { ...validInput, name: '' }, 'name'],
    ['software_name empty', { ...validInput, software_name: '   ' }, 'software_name'],
    ['category empty', { ...validInput, category: '' }, 'category'],
    ['installer_name empty', { ...validInput, installer_name: '' }, 'installer_name'],
    [
      'silent_flags wrong type',
      { ...validInput, silent_flags: 123 as unknown as string },
      'silent_flags',
    ],
    [
      'is_owlette_agent missing',
      { ...validInput, is_owlette_agent: 'yes' as unknown as boolean },
      'is_owlette_agent',
    ],
    ['order non-finite', { ...validInput, order: NaN }, 'order'],
    [
      'description wrong type',
      { ...validInput, description: 5 as unknown as string },
      'description',
    ],
    [
      'close_processes mixed',
      {
        ...validInput,
        close_processes: ['ok', 5 as unknown as string],
      },
      'close_processes',
    ],
    [
      'parallel_install wrong type',
      { ...validInput, parallel_install: 'yes' as unknown as boolean },
      'parallel_install',
    ],
    [
      'timeout_seconds non-finite',
      { ...validInput, timeout_seconds: Infinity },
      'timeout_seconds',
    ],
    [
      'sha256_checksum malformed',
      { ...validInput, sha256_checksum: 'not-a-hash' },
      'sha256_checksum',
    ],
  ])('throws on %s', async (_label, input, field) => {
    await expect(createSystemPreset({ actor }, input)).rejects.toMatchObject({
      name: 'SystemPresetValidationError',
      field,
    });
  });

  it('rejects software_name with only special characters (slug empty)', async () => {
    await expect(
      createSystemPreset(
        { actor },
        { ...validInput, software_name: '!!!---' },
      ),
    ).rejects.toThrow(SystemPresetValidationError);
  });
});

describe('createSystemPreset — firestore write', () => {
  it('writes to system_presets/{presetId} with createdBy + serverTimestamp', async () => {
    const result = await createSystemPreset({ actor }, validInput);

    expect(mockCollection).toHaveBeenCalledWith('system_presets');
    expect(result.presetId).toMatch(/^preset-touchdesigner-\d+$/);
    expect(mockDoc).toHaveBeenCalledWith(result.presetId);

    const written = mockSet.mock.calls[0][0];
    expect(written).toMatchObject({
      name: 'TouchDesigner 2025.31550',
      software_name: 'TouchDesigner',
      category: 'Creative Software',
      installer_name: 'TouchDesigner.exe',
      installer_url: 'https://example.com/td.exe',
      silent_flags: '/VERYSILENT /NORESTART',
      is_owlette_agent: false,
      order: 2,
      createdBy: 'user-admin',
      createdAt: '__server_timestamp__',
    });
  });

  it('mints an id the update and delete actions accept, however long the software name', async () => {
    const result = await createSystemPreset(
      { actor },
      { ...validInput, software_name: 'TouchDesigner Commercial Edition '.repeat(6) },
    );
    // the PRESET_ID_RE in updateSystemPreset and deleteSystemPreset
    expect(result.presetId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });

  it('strips undefined optional fields before writing', async () => {
    await createSystemPreset(
      { actor },
      {
        ...validInput,
        description: undefined,
        icon: undefined,
        verify_path: undefined,
        close_processes: undefined,
        parallel_install: undefined,
        timeout_seconds: undefined,
      },
    );
    const written = mockSet.mock.calls[0][0];
    expect(Object.keys(written)).not.toContain('description');
    expect(Object.keys(written)).not.toContain('icon');
    expect(Object.keys(written)).not.toContain('verify_path');
    expect(Object.keys(written)).not.toContain('close_processes');
    expect(Object.keys(written)).not.toContain('parallel_install');
    expect(Object.keys(written)).not.toContain('timeout_seconds');
  });

  it('preserves optional fields when provided', async () => {
    await createSystemPreset(
      { actor },
      {
        ...validInput,
        description: 'desc',
        icon: '🦉',
        verify_path: 'C:/Program Files/TD',
        close_processes: ['TD.exe'],
        parallel_install: true,
        timeout_seconds: 900,
      },
    );
    const written = mockSet.mock.calls[0][0];
    expect(written).toMatchObject({
      description: 'desc',
      icon: '🦉',
      verify_path: 'C:/Program Files/TD',
      close_processes: ['TD.exe'],
      parallel_install: true,
      timeout_seconds: 900,
    });
  });

  it('stores a normalized (lowercased) sha256_checksum', async () => {
    const digest = 'A'.repeat(32) + 'b'.repeat(32);
    await createSystemPreset({ actor }, { ...validInput, sha256_checksum: digest });
    const written = mockSet.mock.calls[0][0];
    expect(written.sha256_checksum).toBe(digest.toLowerCase());
  });

  it('trims whitespace from required string fields', async () => {
    await createSystemPreset(
      { actor },
      {
        ...validInput,
        name: '  td  ',
        software_name: '  TouchDesigner  ',
        category: '  Creative  ',
        installer_name: '  td.exe  ',
      },
    );
    const written = mockSet.mock.calls[0][0];
    expect(written.name).toBe('td');
    expect(written.software_name).toBe('TouchDesigner');
    expect(written.category).toBe('Creative');
    expect(written.installer_name).toBe('td.exe');
  });
});
