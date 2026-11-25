/** the fleet's own tool: the machines a grant covers. */

import { timestampToMs } from '@/lib/firestoreTime.server';
import { grantCovers } from '@/lib/fleet/policy.server';
import type { FleetServerTool } from '@/lib/fleet/context';

export const LIST_MACHINES_TOOL = 'list_machines';

export const listMachinesTool: FleetServerTool = {
  target: 'site',
  definition: {
    name: LIST_MACHINES_TOOL,
    description: 'List the machines you may act on, each with its id, whether it is online, seconds since its last heartbeat, its OS (windows, macos or linux) and OS version, agent version and whether hoot is on. Pass an id as `machine` to any other tool.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  async run(ctx) {
    const snap = await ctx.db.collection('sites').doc(ctx.siteId).collection('machines').get();
    const now = Date.now();
    const machines = snap.docs
      .filter((doc) => grantCovers(ctx.grant, doc.id))
      .map((doc) => {
        const data = doc.data();
        // read as the public machines list route reads them
        const heartbeatMs = timestampToMs(data.lastHeartbeat ?? data.presence?.lastHeartbeat ?? null);
        return {
          id: doc.id,
          online: data.online === true,
          lastHeartbeatAgeSeconds: heartbeatMs === null ? null : Math.max(0, Math.floor((now - heartbeatMs) / 1000)),
          // no agent writes `os`. an absent osFamily is a pre-3.4 agent, and those are all windows
          os: data.osFamily ?? 'windows',
          osVersion: data.osVersion ?? null,
          agentVersion: data.agent_version ?? data.presence?.agent_version ?? null,
          // as isHootEnabled reads it: absent means on
          hootEnabled: data.cortexEnabled !== false,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    return { status: 'completed', content: [{ type: 'text', text: JSON.stringify(machines, null, 2) }] };
  },
};
