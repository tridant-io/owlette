/**
 * tier 0 — what the agent's own token may do to `commands/pending`.
 *
 * the service executes what lands in that document, so the token it holds may only
 * take entries out. the forged writes go over the agent's REST surface in the shape
 * its client sends; the command flow is the real agent, moving a real command to
 * `commands/completed` through the real rules.
 *
 * the forged command is a harmless `check_path`: were the rule ever to let it through,
 * the sandboxed agent would answer it, and nothing else would happen.
 */

import { Timestamp } from 'firebase-admin/firestore'
import { EMULATOR_PROJECT_ID, FIRESTORE_EMULATOR_URL, getAdminDb } from '../helpers/emulator'
import { mintAgentToken } from './agentToken'
import { agentLogTail, expect, test } from './fixtures'

test.describe.configure({ mode: 'serial' })

/** the agent polls commands every few seconds and answers inside three. */
const ANSWER_MS = 30_000

/** no agent runs as this machine, so nothing races these specs for its entries. */
const QUIET_MACHINE = 'tier0-no-agent'

interface Machine {
  siteId: string
  machineId: string
}

function commands({ siteId, machineId }: Machine, doc: 'pending' | 'completed') {
  return getAdminDb()
    .collection('sites').doc(siteId)
    .collection('machines').doc(machineId)
    .collection('commands').doc(doc)
}

async function pendingKeys(machine: Machine): Promise<string[]> {
  return Object.keys((await commands(machine, 'pending').get()).data() ?? {})
}

/** `update_document`'s wire shape: PATCH, an update mask, and the fields being set. */
async function agentPatch(
  { siteId, machineId }: Machine,
  token: string,
  mask: string[],
  fields: Record<string, unknown>,
): Promise<number> {
  const query = mask.map((path) => `updateMask.fieldPaths=${encodeURIComponent(path)}`).join('&')
  const res = await fetch(
    `${FIRESTORE_EMULATOR_URL}/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents` +
      `/sites/${siteId}/machines/${machineId}/commands/pending?${query}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    },
  )
  return res.status
}

function forged({ siteId, machineId }: Machine, value: string) {
  return {
    mapValue: {
      fields: {
        type: { stringValue: 'check_path' },
        field: { stringValue: 'cwd' },
        value: { stringValue: value },
        siteId: { stringValue: siteId },
        machineId: { stringValue: machineId },
        status: { stringValue: 'pending' },
        queuedBy: { stringValue: 'user:forged' },
      },
    },
  }
}

test('an agent token cannot add a command for the real agent to run', async ({ sync }) => {
  const { idToken } = await mintAgentToken(sync.siteId, sync.machineId)
  const id = `cmd_forged_${Date.now().toString(36)}`

  const status = await agentPatch(sync, idToken, [id], { [id]: forged(sync, sync.programData) })

  expect(status).toBe(403)
  expect(await pendingKeys(sync)).not.toContain(id)
})

test('an agent token removes an entry, and nothing else gets through', async ({ sync }) => {
  const machine = { siteId: sync.siteId, machineId: QUIET_MACHINE }
  const { idToken } = await mintAgentToken(machine.siteId, machine.machineId)
  const queued = { type: 'check_path', status: 'pending', timestamp: Timestamp.now() }
  await commands(machine, 'pending').set({ cmd_a: queued, cmd_b: queued })
  const entry = forged(machine, sync.programData)

  expect(await agentPatch(machine, idToken, ['cmd_a'], { cmd_a: entry }), 'change').toBe(403)
  expect(
    await agentPatch(machine, idToken, ['cmd_a', 'cmd_new'], { cmd_new: entry }),
    'remove one and add another',
  ).toBe(403)
  expect((await pendingKeys(machine)).sort()).toEqual(['cmd_a', 'cmd_b'])

  expect(await agentPatch(machine, idToken, ['cmd_a'], {}), 'remove').toBe(200)
  expect(await pendingKeys(machine)).toEqual(['cmd_b'])

  expect(await agentPatch(machine, idToken, ['cmd_a'], {}), 'remove what is gone').toBe(200)
  expect(await pendingKeys(machine)).toEqual(['cmd_b'])
})

test('the real agent takes a command from pending to completed through the rules', async ({ sync }) => {
  const id = `cmd_tier0_flow_${Date.now().toString(36)}`
  await commands(sync, 'pending').set(
    {
      [id]: {
        type: 'check_path', field: 'cwd', value: sync.programData,
        siteId: sync.siteId, machineId: sync.machineId,
        status: 'pending', queuedBy: 'user:tier0', timestamp: Timestamp.now(),
      },
    },
    { merge: true },
  )

  await expect
    .poll(async () => (await commands(sync, 'completed').get()).data()?.[id]?.status, {
      message: `the agent never finished the command.\n${agentLogTail(sync.dataRoot)}`,
      timeout: ANSWER_MS,
      intervals: [200],
    })
    .toBe('completed')

  // the removal is the second of the agent's two writes, and the one the rule restricts.
  await expect
    .poll(() => pendingKeys(sync), {
      message: `the agent never removed the command from pending.\n${agentLogTail(sync.dataRoot)}`,
      timeout: ANSWER_MS,
      intervals: [200],
    })
    .not.toContain(id)
})
