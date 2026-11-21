/** @jest-environment node */

/**
 * GET /api/sites/{siteId}/machines/{machineId}/commands/{commandId} for a
 * cancelled command. the public status has no `cancelled`, so it reads
 * `failed`. a cancelled hoot tool carries its reason in `error` (covered in
 * sites-machines-commands.test.ts); every other command the agent cancels
 * (`_mark_command_cancelled`) carries it in `result`.
 */

import { createMockRequest } from './helpers/utils';

const mockGet = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            collection: () => ({ doc: (id: string) => ({ get: () => mockGet(id) }) }),
          }),
        }),
      }),
    }),
  }),
}));
jest.mock('@/app/api/_shared', () => ({
  applyAuthDeprecations: (res: Response) => res,
  requireMachineAuthAndScope: async () => ({ ok: true, scopeCheck: { isLegacy: false } }),
}));
jest.mock('@/lib/screenshotStorage.server', () => ({ issueScreenshotReadUrl: jest.fn() }));

import { GET } from '@/app/api/sites/[siteId]/machines/[machineId]/commands/[commandId]/route';

const CID = 'cmd_cancel_1';

it('reports a cancelled command as failed, with the reason the agent gave', async () => {
  mockGet.mockImplementation(async (id: string) =>
    id === 'completed'
      ? {
          exists: true,
          data: () => ({
            [CID]: { type: 'install_software', status: 'cancelled', result: 'installation cancelled' },
          }),
        }
      : { exists: false, data: () => undefined },
  );

  const res = await GET(
    createMockRequest(`http://localhost/api/sites/site-a/machines/m-1/commands/${CID}`),
    { params: Promise.resolve({ siteId: 'site-a', machineId: 'm-1', commandId: CID }) },
  );

  expect(res.status).toBe(200);
  expect((await res.json()).data).toMatchObject({ status: 'failed', error: 'installation cancelled' });
});
