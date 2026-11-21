/** @jest-environment node */

import { loadUserLabels } from '@/lib/activity/labels.server';

const snap = (id: string, data: Record<string, string> | null) => ({
  id,
  exists: data !== null,
  get: (field: string) => data?.[field],
});

describe('loadUserLabels', () => {
  const getAll = jest.fn();
  const db = { getAll, doc: (path: string) => ({ path }) } as unknown as FirebaseFirestore.Firestore;

  beforeEach(() => jest.clearAllMocks());

  it('reads nothing when there are no uids', async () => {
    expect(await loadUserLabels(db, [])).toEqual({});
    expect(getAll).not.toHaveBeenCalled();
  });

  it('prefers the email, falls back to the display name and leaves out a uid with neither', async () => {
    getAll.mockResolvedValue([
      snap('u1', { email: 'ann@example.test', displayName: 'Ann' }),
      snap('u2', { displayName: 'Bob' }),
      snap('u3', {}),
      snap('u4', null),
    ]);

    expect(await loadUserLabels(db, ['u1', 'u2', 'u3', 'u4'])).toEqual({
      u1: 'ann@example.test',
      u2: 'Bob',
    });
  });

  it('reads each uid once', async () => {
    getAll.mockResolvedValue([]);
    await loadUserLabels(db, new Set(['u1', 'u2']));
    await loadUserLabels(db, ['u1', 'u1']);
    expect(getAll.mock.calls[0]).toHaveLength(2);
    expect(getAll.mock.calls[1]).toHaveLength(1);
  });
});
