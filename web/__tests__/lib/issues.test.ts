/** @jest-environment node */

/**
 * issues.server — splitting the agent's combined description, number versus id
 * lookup, and the issue JSON a `bug_reports` doc serializes to.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import {
  findIssue,
  hostFromPageUrl,
  issuePageUrl,
  parseIssueDescription,
  serializeIssue,
  agentVersionFromUA,
} from '@/lib/issues.server';
import { ISSUE_STATUSES, issueAttachmentsSummary } from '@/lib/issues';

const SYSTEM_INFO = '  hostname: kiosk-1\n  os: Windows 11';
const LOG_TAIL = '2026-10-15 10:00:00 INFO started\n2026-10-15 10:00:05 ERROR boom';

// the description exactly as agent/src/configure_site.py submit_report builds it, server-trimmed
function agentDescription(text: string, extra: string[] = []): string {
  let d = text;
  for (const line of extra) d += `\n\n${line}`;
  d += `\n\n--- system info ---\n${SYSTEM_INFO}`;
  d += `\n\n--- recent logs (last ~100 lines) ---\n${LOG_TAIL}`;
  return d.trim();
}

describe('ISSUE_STATUSES', () => {
  it('pins the four statuses', () => {
    expect(ISSUE_STATUSES).toEqual(['new', 'triaged', 'fixed', 'wontfix']);
  });
});

describe('issueAttachmentsSummary', () => {
  it('lists what is attached in one phrase', () => {
    expect(issueAttachmentsSummary({ logs: true, screenshots: 3, videos: 1 })).toBe('logs, 3 screenshots and 1 video');
    expect(issueAttachmentsSummary({ logs: false, screenshots: 1, videos: 2 })).toBe('1 screenshot and 2 videos');
    expect(issueAttachmentsSummary({ logs: true, screenshots: 0, videos: 0 })).toBe('logs');
  });

  it('is empty when nothing is attached', () => {
    expect(issueAttachmentsSummary({ logs: false, screenshots: 0, videos: 0 })).toBe('');
  });
});

describe('parseIssueDescription', () => {
  it('splits system info and the log tail from the text', () => {
    expect(parseIssueDescription(agentDescription('the screen froze\n\nthen it went black'))).toEqual({
      text: 'the screen froze\n\nthen it went black',
      systemInfo: SYSTEM_INFO,
      logTail: LOG_TAIL,
      notes: [],
    });
  });

  it('takes every note line, in order', () => {
    const notes = [
      'attachments could not be sent: the upload timed out',
      'attachments could not be sent: the server refused them (400)',
      'screenshots attached: 2',
      'videos attached: 1',
    ];
    const parsed = parseIssueDescription(agentDescription('it broke', notes));
    expect(parsed.text).toBe('it broke');
    expect(parsed.notes).toEqual(notes);
    expect(parsed.systemInfo).toBe(SYSTEM_INFO);
    expect(parsed.logTail).toBe(LOG_TAIL);
  });

  it('handles system info without a log tail, and a log tail without system info', () => {
    expect(parseIssueDescription(`hi\n\n--- system info ---\n${SYSTEM_INFO}`)).toEqual({
      text: 'hi', systemInfo: SYSTEM_INFO, logTail: '', notes: [],
    });
    expect(parseIssueDescription(`hi\n\n--- recent logs (last ~100 lines) ---\n${LOG_TAIL}`)).toEqual({
      text: 'hi', systemInfo: '', logTail: LOG_TAIL, notes: [],
    });
  });

  it('finds a marker that opens a trimmed description with no user text', () => {
    expect(parseIssueDescription(agentDescription('', ['screenshots attached: 1']))).toEqual({
      text: '', systemInfo: SYSTEM_INFO, logTail: LOG_TAIL, notes: ['screenshots attached: 1'],
    });
    expect(parseIssueDescription(agentDescription(''))).toEqual({
      text: '', systemInfo: SYSTEM_INFO, logTail: LOG_TAIL, notes: [],
    });
  });

  it('leaves a system-info marker inside the log tail alone', () => {
    const tail = 'line\n\n--- system info ---\nnot really';
    const parsed = parseIssueDescription(`x\n\n--- recent logs (last ~100 lines) ---\n${tail}`);
    expect(parsed.logTail).toBe(tail);
    expect(parsed.systemInfo).toBe('');
  });

  it('keeps a note-like line that is not trailing as text', () => {
    const parsed = parseIssueDescription('screenshots attached: 3\n\nbut the real problem is this');
    expect(parsed.text).toBe('screenshots attached: 3\n\nbut the real problem is this');
    expect(parsed.notes).toEqual([]);
  });

  it('returns a web issue as text only', () => {
    expect(parseIssueDescription('the dashboard shows the wrong time\n- step one\n- step two')).toEqual({
      text: 'the dashboard shows the wrong time\n- step one\n- step two',
      systemInfo: '',
      logTail: '',
      notes: [],
    });
  });

  it.each([[''], [undefined], [null], [42], [{ text: 'x' }], [['a']]])('never throws on %p', (input) => {
    expect(parseIssueDescription(input)).toEqual({ text: '', systemInfo: '', logTail: '', notes: [] });
  });

  it('survives garbage text', () => {
    const parsed = parseIssueDescription('---\n\n--- system info\n\u0000￿ --- recent logs ---');
    expect(parsed.text).toBe('---\n\n--- system info\n\u0000￿ --- recent logs ---');
    expect(parsed.systemInfo).toBe('');
    expect(parsed.logTail).toBe('');
  });
});

describe('hostFromPageUrl', () => {
  it('reads the agent host and ignores anything else', () => {
    expect(hostFromPageUrl('agent://kiosk-1')).toBe('kiosk-1');
    expect(hostFromPageUrl('https://owlette.app/dashboard')).toBe('');
    expect(hostFromPageUrl(undefined)).toBe('');
    expect(hostFromPageUrl(7)).toBe('');
  });
});

describe('findIssue', () => {
  function fakeDb(opts: { byNumber?: unknown[]; byId?: { exists: boolean } }) {
    const get = jest.fn(async () => ({ empty: !opts.byNumber?.length, docs: opts.byNumber ?? [] }));
    const limit = jest.fn(() => ({ get }));
    const where = jest.fn(() => ({ limit }));
    const docGet = jest.fn(async () => opts.byId ?? { exists: false });
    const doc = jest.fn(() => ({ get: docGet }));
    const collection = jest.fn(() => ({ where, doc }));
    return { db: { collection } as unknown as Firestore, collection, where, limit, doc };
  }

  it('queries by number for 1-9 digits', async () => {
    const hit = { id: 'abc' };
    const { db, collection, where, limit, doc } = fakeDb({ byNumber: [hit] });
    await expect(findIssue(db, '42')).resolves.toBe(hit);
    expect(collection).toHaveBeenCalledWith('bug_reports');
    expect(where).toHaveBeenCalledWith('number', '==', 42);
    expect(limit).toHaveBeenCalledWith(1);
    expect(doc).not.toHaveBeenCalled();
  });

  it('returns null when no issue has the number', async () => {
    const { db } = fakeDb({ byNumber: [] });
    await expect(findIssue(db, '7')).resolves.toBeNull();
  });

  it('reads a doc id directly, including a 10-digit one', async () => {
    const snap = { exists: true, id: 'Xy_9-abc' };
    const { db, doc, where } = fakeDb({ byId: snap });
    await expect(findIssue(db, 'Xy_9-abc')).resolves.toBe(snap);
    expect(doc).toHaveBeenCalledWith('Xy_9-abc');
    await findIssue(db, '1234567890');
    expect(doc).toHaveBeenCalledWith('1234567890');
    expect(where).not.toHaveBeenCalled();
  });

  it('returns null for a missing doc', async () => {
    const { db } = fakeDb({ byId: { exists: false } });
    await expect(findIssue(db, 'nope')).resolves.toBeNull();
  });

  it.each([[''], ['a/b'], ['../x'], ['x'.repeat(129)], ['has space'], ['#42']])(
    'returns null without a read for %p',
    async (input) => {
      const { db, where, doc } = fakeDb({});
      await expect(findIssue(db, input)).resolves.toBeNull();
      expect(where).not.toHaveBeenCalled();
      expect(doc).not.toHaveBeenCalled();
    },
  );
});

describe('agentVersionFromUA', () => {
  it('reads the version an agent sends', () => {
    expect(agentVersionFromUA('Owlette Agent v4.1.17 / Windows 11')).toBe('4.1.17');
  });

  it.each([['Mozilla/5.0'], [''], [null], [42]])('is null for %p', (ua) => {
    expect(agentVersionFromUA(ua)).toBeNull();
  });
});

describe('serializeIssue', () => {
  const created = Timestamp.fromMillis(Date.parse('2026-10-15T09:00:00.000Z'));
  const snap = (id: string, data: Record<string, unknown> | undefined) =>
    ({ id, data: () => data }) as unknown as DocumentSnapshot;

  it('serializes a web issue without logs', () => {
    expect(
      serializeIssue(
        snap('web1', {
          source: 'web',
          category: 'bug',
          title: 'wrong time',
          description: 'the clock is off',
          status: 'new',
          createdAt: created,
          userId: 'u1',
          userEmail: 'a@example.com',
          browserUA: 'Mozilla',
          pageUrl: 'https://owlette.app/dashboard',
          appVersion: '4.1.13',
          siteId: null,
          machineId: null,
          number: 41,
        }),
      ),
    ).toEqual({
      id: 'web1',
      number: 41,
      status: 'new',
      category: 'bug',
      title: 'wrong time',
      source: 'web',
      createdAt: '2026-10-15T09:00:00.000Z',
      appVersion: '4.1.13',
      siteId: null,
      machineId: null,
      from: 'a@example.com',
      host: null,
      description: { text: 'the clock is off', systemInfo: '', logTail: '', notes: [] },
      triageNote: null,
      statusUpdatedAt: null,
      statusUpdatedBy: null,
      attachments: { available: false, size: null, expiresAt: null, screenshots: 0, videos: 0, logs: false },
    });
  });

  it('serializes a triaged agent issue with live logs', () => {
    const expires = Timestamp.fromMillis(Date.now() + 86_400_000);
    const updated = Timestamp.fromMillis(Date.parse('2026-10-15T10:00:00.000Z'));
    const issue = serializeIssue(
      snap('agent1', {
        source: 'agent',
        category: 'other',
        title: 'agent feedback',
        description: agentDescription('froze', ['screenshots attached: 2']),
        status: 'triaged',
        createdAt: created,
        userEmail: '',
        browserUA: 'Owlette Agent v4.1.12 / Windows 11',
        pageUrl: 'agent://kiosk-1',
        appVersion: '4.1.13',
        siteId: 's1',
        machineId: 'm1',
        number: 42,
        triageNote: 'fixed on fix/froze',
        statusUpdatedAt: updated,
        statusUpdatedBy: 'u9',
        logs: { key: 'issues/s1/m1/abc.zip', size: 2048, expiresAt: expires, screenshots: 2 },
      }),
    );
    expect(issue).toMatchObject({
      // the agent's own version, not the stored web server's
      appVersion: '4.1.12',
      number: 42,
      status: 'triaged',
      from: '',
      host: 'kiosk-1',
      siteId: 's1',
      machineId: 'm1',
      triageNote: 'fixed on fix/froze',
      statusUpdatedAt: '2026-10-15T10:00:00.000Z',
      statusUpdatedBy: 'u9',
      description: { text: 'froze', systemInfo: SYSTEM_INFO, logTail: LOG_TAIL, notes: ['screenshots attached: 2'] },
      attachments: {
        available: true,
        size: 2048,
        expiresAt: new Date(expires.toMillis()).toISOString(),
        screenshots: 2,
        videos: 0,
        logs: false,
      },
    });
  });

  it('reads a logs-only zip as holding logs, and an expired one as unavailable', () => {
    const issue = serializeIssue(
      snap('agent2', {
        status: 'new',
        logs: { key: 'issues/s1/m1/def.zip', size: 10, expiresAt: Timestamp.fromMillis(Date.now() - 1000) },
      }),
    );
    expect(issue.attachments).toEqual({
      available: false,
      size: 10,
      expiresAt: expect.any(String),
      screenshots: 0,
      videos: 0,
      logs: true,
    });
  });

  it.each([
    [true, 2, true],
    [false, 0, false],
  ])('reads a stored hasLogs %s beside %i screenshots over the fallback', (hasLogs, screenshots, expected) => {
    const issue = serializeIssue(
      snap('agent3', {
        status: 'new',
        logs: { key: 'issues/s1/m1/ghi.zip', size: 10, expiresAt: Timestamp.fromMillis(Date.now() + 1000), screenshots, hasLogs },
      }),
    );
    expect(issue.attachments.logs).toBe(expected);
  });

  it('ignores a hasLogs without a zip', () => {
    const issue = serializeIssue(snap('agent4', { status: 'new', logs: { hasLogs: true } }));
    expect(issue.attachments.logs).toBe(false);
  });

  it('falls back safely on an old or malformed doc', () => {
    const issue = serializeIssue(
      snap('old', { status: 'bogus', number: '7', title: 3, logs: { size: 5, screenshots: 4 } }),
    );
    expect(issue).toMatchObject({
      id: 'old',
      number: null,
      status: 'new',
      title: '',
      createdAt: null,
      attachments: { available: false, size: null, expiresAt: null, screenshots: 0, videos: 0, logs: false },
    });
    expect(serializeIssue(snap('gone', undefined)).description.text).toBe('');
  });
});

describe('issuePageUrl', () => {
  const saved = process.env.NEXT_PUBLIC_BASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = saved;
  });

  it('links the superadmin page by number', () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://dev.owlette.app';
    expect(issuePageUrl(42)).toBe('https://dev.owlette.app/admin/issues/42');
  });
});
