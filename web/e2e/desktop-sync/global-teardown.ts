/**
 * Give the machine back, in the reverse of setup's order and with every step
 * wrapped so an earlier failure cannot strand a later one.
 *
 * Desktop first (it holds a WebView2 profile and a window), then the agent (a
 * live process writing to Firestore), and only then the sandbox — removing the
 * tree under a running agent produces a stream of unreadable-path errors and
 * leaves the process alive anyway.
 *
 * The one thing that MUST happen is the agent stop. Everything else is cleanup.
 */

import { stopAgent } from './agentProcess'
import { killSandboxHelpers, stopDesktopSession } from './desktopSession'
import { clearSession, readSession, removeSandbox } from './sandbox'
import type { SyncSession } from './sandbox'

export default async function globalTeardown(): Promise<void> {
  let session: SyncSession | null = null
  try {
    session = readSession()
  } catch {
    // Setup failed before it wrote one; there is nothing recorded to stop.
    return
  }

  try {
    await stopDesktopSession()
  } catch (err) {
    console.warn(`[desktop-sync] desktop teardown failed (continuing): ${String(err)}`)
  }

  try {
    // The app is stopped with taskkill /F, so its own cleanup never runs: any
    // pairing helper it spawned into the sandbox would outlive it and hold a
    // handle on the tree we are about to delete.
    killSandboxHelpers(session.programData)
  } catch (err) {
    console.warn(`[desktop-sync] sandbox helper sweep failed (continuing): ${String(err)}`)
  }

  try {
    const how = await stopAgent(session.programData, session.agentPid)
    console.log(`[desktop-sync] agent pid ${session.agentPid} stopped (${how})`)
  } catch (err) {
    console.error(`[desktop-sync] agent teardown FAILED: ${String(err)}`)
  }

  try {
    clearSession()
  } catch {
    // Best effort.
  }

  try {
    removeSandbox(session.programData)
  } catch (err) {
    // A locked log handle is the usual cause and the OS reclaims the temp dir.
    console.warn(`[desktop-sync] sandbox removal failed (continuing): ${String(err)}`)
  }
}
