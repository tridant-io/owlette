/**
 * tier 0 — the real agent answering `check_path`.
 *
 * `e2e/specs/dashboard/missing-path-warning.spec.ts` plays the agent's answer. this
 * one has no stand-in: the command goes into `commands/pending` on the emulator the
 * way the route writes it, and the sandboxed agent polls it, probes the real disk
 * and writes its JSON through the real security rules. the paths are all inside the
 * scratch PROGRAMDATA, and the network path is one the agent must not touch.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Timestamp } from 'firebase-admin/firestore'
import { getAdminDb } from '../helpers/emulator'
import { agentLogTail, expect, test } from './fixtures'

test.describe.configure({ mode: 'serial' })

/** the agent polls commands every few seconds and answers inside three. */
const ANSWER_MS = 30_000

interface Answer {
  status: string
  warning: string | null
  path: string | null
  rest: string
  nearest: string | null
  parent?: string | null
  folders?: string[]
  files?: string[]
}

let nextId = 0

function commands(siteId: string, machineId: string, doc: 'pending' | 'completed') {
  return getAdminDb()
    .collection('sites').doc(siteId)
    .collection('machines').doc(machineId)
    .collection('commands').doc(doc)
}

async function queue(siteId: string, machineId: string, field: string, value: string): Promise<string> {
  nextId += 1
  const id = `cmd_tier0_${Date.now().toString(36)}_${nextId}`
  await commands(siteId, machineId, 'pending').set(
    {
      [id]: {
        type: 'check_path', field, value, siteId, machineId,
        status: 'pending', queuedBy: 'user:tier0', timestamp: Timestamp.now(),
      },
    },
    { merge: true },
  )
  return id
}

async function ask(
  sync: { siteId: string; machineId: string; dataRoot: string },
  field: string,
  value: string,
): Promise<Answer> {
  const id = await queue(sync.siteId, sync.machineId, field, value)
  let entry: { status?: string; result?: unknown; error?: unknown } | undefined
  await expect
    .poll(
      async () => {
        entry = (await commands(sync.siteId, sync.machineId, 'completed').get()).data()?.[id]
        return entry?.status
      },
      {
        message: `the agent never finished check_path ${field}.\n${agentLogTail(sync.dataRoot)}`,
        timeout: ANSWER_MS,
        intervals: [200],
      },
    )
    .toBe('completed')
  expect(typeof entry?.result, JSON.stringify(entry)).toBe('string')
  return JSON.parse(entry?.result as string) as Answer
}

test('the real agent answers for a missing path, with the nearest folder that exists', async ({ sync }) => {
  const missing = path.join(sync.programData, 'not', 'here', 'show.exe')

  const answer = await ask(sync, 'exe_path', missing)

  expect(answer).toMatchObject({ status: 'missing', warning: 'missing', path: missing, rest: '' })
  expect(answer.nearest?.toLowerCase()).toBe(sync.programData.toLowerCase())
})

test('the real agent answers for an existing path, in path / args with arguments after it', async ({ sync }) => {
  const file = path.join(sync.programData, 'show file.toe')
  fs.writeFileSync(file, '')

  expect(await ask(sync, 'exe_path', file)).toMatchObject({ status: 'file', warning: null, path: file })
  expect(await ask(sync, 'file_path', `${file} 8000`)).toMatchObject({
    status: 'file',
    warning: null,
    path: file,
    rest: '8000',
  })
})

test('the real agent says a folder as launch target is one, and browse starts inside it', async ({ sync }) => {
  const answer = await ask(sync, 'exe_path', sync.programData)

  expect(answer).toMatchObject({ status: 'folder', warning: 'folder', path: sync.programData })
  expect(answer.nearest?.toLowerCase()).toBe(sync.programData.toLowerCase())
})

test('the real agent says a file as working directory is one, and browse starts in its folder', async ({ sync }) => {
  const file = path.join(sync.programData, 'not-a-folder.txt')
  fs.writeFileSync(file, '')

  const answer = await ask(sync, 'cwd', file)

  expect(answer).toMatchObject({ status: 'file', warning: 'file', path: file })
  expect(answer.nearest?.toLowerCase()).toBe(sync.programData.toLowerCase())
})

test('the real agent warns about a network path without touching it', async ({ sync }) => {
  // the reserved `.invalid` name: a probe would fail differently and slowly.
  const share = '\\\\nas.invalid\\show\\app.exe'
  const started = Date.now()

  const answer = await ask(sync, 'exe_path', share)

  expect(answer).toMatchObject({ status: 'unknown', warning: 'network', path: share, nearest: null })
  expect(Date.now() - started, 'answered without waiting on a share').toBeLessThan(ANSWER_MS)
})

test('the real agent lists a folder, names and kinds only, and non-latin names stay readable', async ({ sync }) => {
  const folder = path.join(sync.programData, 'listing')
  fs.mkdirSync(path.join(folder, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(folder, 'B.toe'), 'contents')
  fs.writeFileSync(path.join(folder, 'a.toe'), '')
  fs.writeFileSync(path.join(folder, '会場.toe'), '')

  const answer = await ask(sync, 'folder', folder)

  expect(answer).toMatchObject({ status: 'folder', warning: null, folders: ['sub'], files: ['a.toe', 'B.toe', '会場.toe'] })
  expect(answer.parent?.toLowerCase()).toBe(sync.programData.toLowerCase())
})

test('the real agent keeps only the newest answers in the completed doc', async ({ sync }) => {
  for (let i = 0; i < 12; i++) {
    await ask(sync, 'cwd', sync.programData)
  }

  const completed = (await commands(sync.siteId, sync.machineId, 'completed').get()).data() ?? {}
  const answers = Object.values(completed).filter((entry) => entry?.type === 'check_path')
  expect(answers.length).toBeLessThanOrEqual(8)
})
