/** @jest-environment node */

/** the screenshot history tool over an in-memory fake of the machine's `screenshots` collection. */

import { Timestamp, type Firestore } from 'firebase-admin/firestore';

const mockIssueReadUrl = jest.fn(async (path: string | null | undefined) =>
  path ? { url: `https://signed.example/${path}`, expiresAt: '2026-11-11T13:00:00.000Z' } : null,
);
jest.mock('@/lib/screenshotStorage.server', () => ({
  issueScreenshotReadUrl: (path: string | null | undefined) => mockIssueReadUrl(path),
}));

import type { FleetContext } from '@/lib/fleet/context';
import { listRecentScreenshotsTool, screenshotTools } from '@/lib/fleet/tools/screenshots.server';

type Data = Record<string, unknown>;

const SITE = 'site-a';
const M1 = 'kiosk-1';

let history: Data[];
let queried: { path: string; order: [string, string] | null; max: number | null };

const db = {
  collection: (name: string) => ({
    doc: (id: string) => docAt(`${name}/${id}`),
  }),
} as unknown as Firestore;

function docAt(path: string) {
  return {
    collection: (name: string) => {
      const col = `${path}/${name}`;
      return {
        doc: (id: string) => docAt(`${col}/${id}`),
        orderBy: (field: string, dir: string) => ({
          limit: (max: number) => ({
            get: async () => {
              queried = { path: col, order: [field, dir], max };
              return { docs: history.slice(0, max).map((data) => ({ data: () => data })) };
            },
          }),
        }),
      };
    },
  };
}

const ctx: FleetContext = {
  actor: { type: 'machine', siteId: SITE, machineId: 'sender-1', maxTier: 1, machineIds: [M1] },
  siteId: SITE,
  machineId: 'sender-1',
  grant: { maxTier: 1, machineIds: [M1] },
  correlationId: 'corr-1',
  db,
};

function shot(n: number, overrides: Data = {}): Data {
  return {
    url: `https://storage.googleapis.com/bucket/screenshots/${SITE}/${M1}/${n}-ab.jpg?t=${n}`,
    timestamp: Timestamp.fromMillis(Date.UTC(2026, 10, 11, 12, 0, 0) - n * 60_000),
    sizeKB: 80 + n,
    monitor: 0,
    ...overrides,
  };
}

function textOf(answer: Awaited<ReturnType<typeof listRecentScreenshotsTool.run>>) {
  if (answer.status !== 'completed') throw new Error(`expected a completed answer, got ${JSON.stringify(answer)}`);
  return answer;
}

async function run(params: Data = {}) {
  if (listRecentScreenshotsTool.target !== 'machine') throw new Error('expected a machine tool');
  return textOf(await listRecentScreenshotsTool.run(ctx, M1, params));
}

beforeEach(() => {
  jest.clearAllMocks();
  history = [];
});

describe('list_recent_screenshots', () => {
  it('is a tier 1 machine tool, exported once, with no machine parameter of its own', () => {
    expect(screenshotTools).toEqual([listRecentScreenshotsTool]);
    expect(listRecentScreenshotsTool.target).toBe('machine');
    expect(listRecentScreenshotsTool.definition.tier).toBe(1);
    expect(listRecentScreenshotsTool.definition.parameters.properties).not.toHaveProperty('machine');
  });

  it('lists the machine\'s history newest first, each with its time and a signed url, plus the newest as an image', async () => {
    history = [shot(1), shot(2)];
    const { content } = await run();
    expect(queried).toEqual({ path: `sites/${SITE}/machines/${M1}/screenshots`, order: ['timestamp', 'desc'], max: 5 });
    expect(content).toHaveLength(2);
    const listed = JSON.parse((content[0] as { text: string }).text);
    expect(listed).toEqual([
      {
        takenAt: '2026-11-11T11:59:00.000Z',
        sizeKB: 81,
        monitor: 0,
        url: `https://signed.example/screenshots/${SITE}/${M1}/1-ab.jpg`,
      },
      {
        takenAt: '2026-11-11T11:58:00.000Z',
        sizeKB: 82,
        monitor: 0,
        url: `https://signed.example/screenshots/${SITE}/${M1}/2-ab.jpg`,
      },
    ]);
    expect(content[1]).toEqual({
      type: 'image_url',
      url: `https://signed.example/screenshots/${SITE}/${M1}/1-ab.jpg`,
      text: 'newest screenshot, taken 2026-11-11T11:59:00.000Z',
    });
    expect(content.filter((item) => item.type === 'image_url')).toHaveLength(1);
  });

  it.each([
    ['nothing', {}, 5],
    ['a limit of 3', { limit: 3 }, 3],
    ['a fraction', { limit: 2.7 }, 2],
    ['a limit under one', { limit: 0.4 }, 1],
    ['a limit past the history kept', { limit: 500 }, 20],
    ['zero', { limit: 0 }, 5],
    ['a negative limit', { limit: -4 }, 5],
    ['a limit that is no number', { limit: '9' }, 5],
    ['an infinite limit', { limit: Infinity }, 5],
  ])('reads %s as a cap of %s', async (_label, params, max) => {
    await run(params);
    expect(queried.max).toBe(max);
  });

  it('caps the list at the limit even when the history holds more', async () => {
    history = Array.from({ length: 20 }, (_, i) => shot(i + 1));
    const { content } = await run({ limit: 4 });
    expect(JSON.parse((content[0] as { text: string }).text)).toHaveLength(4);
    expect(mockIssueReadUrl).toHaveBeenCalledTimes(4);
  });

  it('answers an empty list and no image for a machine with no screenshots', async () => {
    const { content } = await run();
    expect(content).toEqual([{ type: 'text', text: '[]' }]);
    expect(mockIssueReadUrl).not.toHaveBeenCalled();
  });

  it('leaves out a row whose url does not name a picture of this machine, and signs nothing for it', async () => {
    history = [
      shot(1, { url: `https://storage.googleapis.com/bucket/screenshots/other-site/${M1}/x.jpg` }),
      shot(2, { url: `https://storage.googleapis.com/bucket/screenshots/${SITE}/kiosk-2/x.jpg` }),
      shot(3, { url: `https://storage.googleapis.com/bucket/screenshots/${SITE}/${M1}/../kiosk-2/x.jpg` }),
      shot(4, { url: 42 }),
      shot(5),
    ];
    const { content } = await run({ limit: 20 });
    const listed = JSON.parse((content[0] as { text: string }).text);
    expect(listed).toHaveLength(1);
    expect(listed[0].url).toBe(`https://signed.example/screenshots/${SITE}/${M1}/5-ab.jpg`);
    expect(mockIssueReadUrl).toHaveBeenCalledTimes(1);
    expect(content[1]).toMatchObject({ type: 'image_url', url: listed[0].url });
  });

  it('keeps a row with no readable time or size, with nulls', async () => {
    history = [shot(1, { timestamp: undefined, sizeKB: undefined, monitor: undefined })];
    const { content } = await run();
    expect(JSON.parse((content[0] as { text: string }).text)[0]).toMatchObject({ takenAt: null, sizeKB: null, monitor: null });
    expect(content[1]).toMatchObject({ type: 'image_url', text: 'newest screenshot' });
  });
});
