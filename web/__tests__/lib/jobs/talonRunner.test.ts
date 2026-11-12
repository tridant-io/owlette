/** @jest-environment node */

/**
 * `pollTalonCommandResult` waits for the machine's answer. the agent writes
 * `running` when it picks a command up and, for installs and updates, progress
 * statuses after it; none of those is the answer.
 */

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => '__delete__' },
}));
jest.mock('@/lib/systemInvoker.server', () => ({ invokeAsSystem: jest.fn() }));
jest.mock('@/lib/actions/executeMachineCommand.server', () => ({ executeMachineCommand: jest.fn() }));
jest.mock('@/lib/hoot-utils.server', () => ({
  COMMAND_POLL_INTERVAL_MS: 0,
  COMMAND_TIMEOUT_MS: 30000,
}));

import type { Firestore } from 'firebase-admin/firestore';
import { pollTalonCommandResult } from '@/lib/jobs/talonRunner.server';

const CMD = 'talon_cmd_1';

/** Answers each read of `commands/completed` with the next entry in `entries`. */
function fakeDb(entries: Array<Record<string, unknown>>): Firestore {
  const get = jest.fn(async () => {
    const entry = entries.length > 1 ? entries.shift() : entries[0];
    return { exists: true, data: () => ({ [CMD]: entry }) };
  });
  const doc = () => ({ get, update: jest.fn(async () => undefined) });
  const commands = { doc };
  const machine = { collection: () => commands };
  const site = { collection: () => ({ doc: () => machine }) };
  return { collection: () => ({ doc: () => site }) } as unknown as Firestore;
}

describe('pollTalonCommandResult', () => {
  it.each(['running', 'closing_processes', 'downloading', 'installing'])(
    'keeps waiting past %s for the answer',
    async (status) => {
      const db = fakeDb([{ status }, { status: 'completed', result: 'done' }]);
      await expect(pollTalonCommandResult(db, 'site-a', 'm-1', CMD, 1000)).resolves.toEqual({
        status: 'completed',
        result: 'done',
      });
    },
  );
});
