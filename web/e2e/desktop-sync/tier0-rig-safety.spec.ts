/**
 * the rig must not be able to take down a desktop app it did not start. this runs
 * the real launch against a stand-in: a copy of ping under a throwaway image name,
 * so a rig that gets this wrong kills the stand-in, never the operator's app.
 */

import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startDesktopOnSandbox } from './desktopSession'

const IMAGE = path.join(os.tmpdir(), 'owlette-rig-safety-stand-in.exe')
const PROGRAM_DATA = path.join(os.tmpdir(), 'owlette-rig-safety-sandbox')

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('a running process with the exe image name that the rig did not start stops the run, and lives', async () => {
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ping.exe'), IMAGE)
  const standIn = spawn(IMAGE, ['-n', '120', '127.0.0.1'], { stdio: 'ignore', windowsHide: true })
  const before = process.env.OWLETTE_DESKTOP_EXE
  process.env.OWLETTE_DESKTOP_EXE = IMAGE

  try {
    await expect(startDesktopOnSandbox(PROGRAM_DATA)).rejects.toThrow(/did not start/)
    expect(isAlive(standIn.pid as number)).toBe(true)
  } finally {
    if (before === undefined) delete process.env.OWLETTE_DESKTOP_EXE
    else process.env.OWLETTE_DESKTOP_EXE = before
    standIn.kill()
    await new Promise((resolve) => standIn.once('exit', resolve))
    fs.rmSync(IMAGE, { force: true })
  }
})
