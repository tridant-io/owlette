/** @jest-environment node */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { UserActor } from '@/lib/capabilities';

const mockDocs = new Map<string, Record<string, unknown>>();
const mockUpdates: Array<Record<string, unknown>> = [];

function mockSnap(id: string) {
  const ref = {
    get: async () => mockSnap(id),
    update: async (data: Record<string, unknown>) => {
      mockUpdates.push(data);
      const resolved = Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, v instanceof FieldValue ? Timestamp.now() : v]),
      );
      mockDocs.set(id, { ...mockDocs.get(id), ...resolved });
    },
  };
  return { id, ref, exists: mockDocs.has(id), data: () => mockDocs.get(id) };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: (id: string) => ({ get: async () => mockSnap(id) }),
      where: (field: string, _op: string, value: unknown) => ({
        limit: () => ({
          get: async () => {
            const docs = [...mockDocs.entries()].filter(([, d]) => d[field] === value).map(([id]) => mockSnap(id));
            return { empty: docs.length === 0, docs };
          },
        }),
      }),
    }),
  }),
}));

import { setIssueStatus } from '@/lib/actions/setIssueStatus.server';

const ACTOR: UserActor = { type: 'user', userId: 'staff-1', role: 'superadmin', siteRoles: {} };

beforeEach(() => {
  mockDocs.clear();
  mockUpdates.length = 0;
  mockDocs.set('report-1', { number: 42, title: 'it broke', status: 'new', triageNote: 'see #12' });
});

describe('setIssueStatus', () => {
  it('sets the status by number and records who and when', async () => {
    const issue = await setIssueStatus({ actor: ACTOR, idOrNumber: '42', status: 'fixed' });

    expect(mockUpdates).toEqual([
      { status: 'fixed', statusUpdatedAt: expect.any(FieldValue), statusUpdatedBy: 'staff-1' },
    ]);
    expect(issue).toMatchObject({ id: 'report-1', number: 42, status: 'fixed', statusUpdatedBy: 'staff-1' });
    expect(typeof issue?.statusUpdatedAt).toBe('string');
  });

  it('leaves the stored note alone without a note, and replaces it with one', async () => {
    expect((await setIssueStatus({ actor: ACTOR, idOrNumber: 'report-1', status: 'triaged' }))?.triageNote).toBe(
      'see #12',
    );
    const issue = await setIssueStatus({ actor: ACTOR, idOrNumber: 'report-1', status: 'fixed', note: 'in 4.1.14' });
    expect(issue?.triageNote).toBe('in 4.1.14');
  });

  it('returns null and writes nothing for an issue that does not exist', async () => {
    await expect(setIssueStatus({ actor: ACTOR, idOrNumber: '43', status: 'fixed' })).resolves.toBeNull();
    await expect(setIssueStatus({ actor: ACTOR, idOrNumber: 'missing', status: 'fixed' })).resolves.toBeNull();
    expect(mockUpdates).toHaveLength(0);
  });
});
