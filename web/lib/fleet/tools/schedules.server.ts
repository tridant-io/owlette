/** the reboot schedule of a machine, as the dashboard shows and sets it. */

import { setRestartSchedule, type RestartScheduleInput } from '@/lib/actions/setRestartSchedule.server';
import { ActionInputError } from '@/lib/actions/createProcess.server';
import { machineAuditActor } from '@/lib/actions/auditActor.server';
import type { FleetServerTool } from '@/lib/fleet/context';

const GET_TOOL = 'get_reboot_schedule';
const SET_TOOL = 'set_reboot_schedule';

const getRebootScheduleTool: FleetServerTool = {
  target: 'machine',
  definition: {
    name: GET_TOOL,
    description: 'Get the reboot schedule of a machine: whether it is on and its entries, each with an id, the days it runs and a time of day on the machine\'s own clock. A machine with no schedule comes back with `schedule: null`.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  async run(ctx, machine) {
    // the config doc holds it, as the dashboard reads it; `rebootSchedule` is the agent's field name
    const snap = await ctx.db.collection('config').doc(ctx.siteId).collection('machines').doc(machine).get();
    const schedule = snap.exists ? (snap.data()?.rebootSchedule ?? null) : null;
    return { status: 'completed', content: [{ type: 'text', text: JSON.stringify({ machine, schedule }, null, 2) }] };
  },
};

const setRebootScheduleTool: FleetServerTool = {
  target: 'machine',
  definition: {
    name: SET_TOOL,
    description: 'Set or clear the reboot schedule of a machine, replacing the whole schedule: the machine reboots at each entry\'s time on its listed days, on its own clock, and a reboot the agent finds more than five minutes late (it was offline or restarting) is skipped for that day. The agent\'s active-hours guard does not hold a scheduled reboot back, so an entry inside the machine\'s active hours still restarts it. To clear the schedule pass `enabled: false` and `entries: []`. Read the current one first with get_reboot_schedule if you only mean to change part of it.',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        enabled: {
          type: 'boolean',
          description: 'true to run the schedule, false to keep the entries but never fire them.',
        },
        entries: {
          type: 'array',
          description: 'Every reboot the schedule holds; this list replaces the current one. An empty list clears the schedule.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'A unique, non-empty id for the entry. Keep the id of an entry you are changing.' },
              days: {
                type: 'array',
                description: 'The days the entry runs, at least one.',
                items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
              },
              time: { type: 'string', description: 'Time of day in 24-hour HH:MM on the machine\'s own clock, for example "03:00".' },
            },
            required: ['id', 'days', 'time'],
          },
        },
      },
      required: ['enabled', 'entries'],
    },
  },
  async run(ctx, machine, params) {
    try {
      await setRestartSchedule(
        { siteId: ctx.siteId, actor: ctx.actor, auditActor: machineAuditActor(ctx.machineId) },
        // the core validates the shape
        { machineId: machine, schedule: { enabled: params.enabled, entries: params.entries } as RestartScheduleInput },
      );
    } catch (error) {
      if (error instanceof ActionInputError) return { status: 'failed', error: error.message };
      throw error;
    }
    return { status: 'completed', content: [{ type: 'text', text: JSON.stringify({ machine, ok: true }, null, 2) }] };
  },
};

export const scheduleTools: readonly FleetServerTool[] = [getRebootScheduleTool, setRebootScheduleTool];
