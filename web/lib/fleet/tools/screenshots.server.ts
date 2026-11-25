/** the fleet's own screenshot tool: a machine's recent pictures, read from its history. */

import { timestampToMs } from '@/lib/firestoreTime.server';
import { issueScreenshotReadUrl } from '@/lib/screenshotStorage.server';
import type { FleetContentItem, FleetServerTool } from '@/lib/fleet/context';

export const LIST_SCREENSHOTS_TOOL = 'list_recent_screenshots';

// the dashboard's gallery reads 20, and finalize prunes the history to 20
const SCREENSHOTS_MAX = 20;
const SCREENSHOTS_DEFAULT = 5;

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * the bucket path inside a history doc's public url, or null when the url does
 * not name a picture of this site's machine: the signer is handed nothing else.
 */
function storagePathOf(url: unknown, siteId: string, machine: string): string | null {
  if (typeof url !== 'string') return null;
  const path = /\/(screenshots\/[^?#]+)/.exec(url)?.[1];
  if (!path || path.includes('..')) return null;
  const [, site, owner, name] = path.split('/');
  return site === siteId && owner === machine && name ? path : null;
}

export const listRecentScreenshotsTool: FleetServerTool = {
  target: 'machine',
  definition: {
    name: LIST_SCREENSHOTS_TOOL,
    description: `List the screenshots already taken of a machine, newest first, each with when it was taken, its size, the monitor and a link that stays valid for one hour. The newest comes back as an image as well. Up to ${SCREENSHOTS_MAX} are kept, and nothing new is captured: use capture_screenshot to see the screen now.`,
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: `How many screenshots to list, newest first (default ${SCREENSHOTS_DEFAULT}, at most ${SCREENSHOTS_MAX}).`,
          default: SCREENSHOTS_DEFAULT,
        },
      },
    },
  },
  async run(ctx, machine, params) {
    const { limit: asked } = params;
    const limit = isPositive(asked) ? Math.min(Math.floor(asked) || 1, SCREENSHOTS_MAX) : SCREENSHOTS_DEFAULT;

    const snap = await ctx.db
      .collection('sites')
      .doc(ctx.siteId)
      .collection('machines')
      .doc(machine)
      .collection('screenshots')
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    const screenshots: Array<{ takenAt: string | null; sizeKB: number | null; monitor: number | null; url: string }> = [];
    for (const doc of snap.docs) {
      const data = doc.data();
      const path = storagePathOf(data.url, ctx.siteId, machine);
      const signed = path ? await issueScreenshotReadUrl(path) : null;
      if (!signed) continue;
      const takenMs = timestampToMs(data.timestamp);
      screenshots.push({
        takenAt: takenMs === null ? null : new Date(takenMs).toISOString(),
        sizeKB: typeof data.sizeKB === 'number' ? data.sizeKB : null,
        monitor: typeof data.monitor === 'number' ? data.monitor : null,
        url: signed.url,
      });
    }

    const content: FleetContentItem[] = [{ type: 'text', text: JSON.stringify(screenshots, null, 2) }];
    // one picture, not one per row: the rest are links to fetch on purpose
    if (screenshots.length > 0) {
      content.push({
        type: 'image_url',
        url: screenshots[0].url,
        text: `newest screenshot${screenshots[0].takenAt ? `, taken ${screenshots[0].takenAt}` : ''}`,
      });
    }
    return { status: 'completed', content };
  },
};

export const screenshotTools: readonly FleetServerTool[] = [listRecentScreenshotsTool];
