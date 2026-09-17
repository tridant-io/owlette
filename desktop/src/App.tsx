import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AppMenu } from '@/components/AppMenu'
import { ConfirmDialog, type ConfirmRequest } from '@/components/ConfirmDialog'
import { DropConfirm } from '@/components/DropConfirm'
import { DropOverlay } from '@/components/DropOverlay'
import { JoinSiteDialog } from '@/components/JoinSiteDialog'
import { OwletteEye } from '@/components/landing/OwletteEye'
import { LeaveSiteDialog } from '@/components/LeaveSiteDialog'
import { ProcessDetail } from '@/components/ProcessDetail'
import { ProcessList, type ProcessAction } from '@/components/ProcessList'
import { ReportIssueDialog } from '@/components/ReportIssueDialog'
import { RestartCountdown } from '@/components/RestartCountdown'
import { SidebarDivider } from '@/components/SidebarDivider'
import { StatusFooter } from '@/components/StatusFooter'
import { WindowControls } from '@/components/WindowControls'
import { InlineNotice } from '@/components/ui/inline-notice'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStates } from '@/hooks/useAppStates'
import { useFileDrop } from '@/hooks/useFileDrop'
import { useLaunchFlag } from '@/hooks/useLaunchFlag'
import { useOwletteConfig } from '@/hooks/useOwletteConfig'
import { useRestartPrompt } from '@/hooks/useRestartPrompt'
import { useServiceHealth } from '@/hooks/useServiceHealth'
import { useSidebarLayout } from '@/hooks/useSidebarLayout'
import { isPaired, siteNameOf } from '@/lib/serviceHealth'
import { classifyDrop, toProcessEntry, type ProcessEntryDraft } from '@/lib/dropClassifier'
import {
  cardBlockedReason,
  dequeueCard,
  enqueueCards,
  triage,
  updateCard,
  type DropCard,
} from '@/lib/dropQueue'
import { classifyOptions, tauriFsProbe } from '@/lib/fsProbe'
import {
  ARG_PAIR,
  hostname,
  serverFromArgs,
  setStartupLink,
  startupLinkEnabled,
  writeOwletteJson,
} from '@/lib/ipc'
import {
  addProcess,
  applyForm,
  createProcessEntry,
  duplicateProcess,
  findProcess,
  launchModeBlockedReason,
  launchModeOf,
  processesOf,
  removeProcess,
  reorderProcess,
  setLaunchMode,
  setPriority,
  setSchedules,
  setVisibility,
  uniqueDefaultName,
  updateProcess,
  type LaunchMode,
  type OwletteConfig,
  type Priority,
  type ProcessEntry,
  type ProcessForm,
  type ScheduleBlock,
  type Visibility,
} from '@/lib/owletteConfig'
import { launchedAtForProcess, livePidForProcess, statusForProcess } from '@/lib/processStatus'
import { NoLiveInstanceError, stopProcess, type StopMode } from '@/lib/processControl'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The dropped file's own name, for a toast that has to fit on one line. */
function fileNameOf(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

/**
 * The owlette configuration window: a view over three files in
 * `%PROGRAMDATA%\Owlette` owned by the python service, edited read-modify-write.
 * No cloud client here on purpose — the service is the only thing that talks to
 * owlette and uploads the config it reads from disk (`owlette_gui.py:2403-2408`).
 */
function App() {
  const config = useOwletteConfig()
  const appStates = useAppStates()
  const health = useServiceHealth()
  const restartPrompt = useRestartPrompt()
  // The installer hands off with `--pair --server <dev|prod>`; both routes in
  // (our own argv, and a forwarded second instance) are watched by the hook.
  const pairLaunch = useLaunchFlag(ARG_PAIR)
  const sidebar = useSidebarLayout()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [dropped, setDropped] = useState<DropCard[]>([])
  const [menuDialog, setMenuDialog] = useState<'join' | 'leave' | 'report' | null>(null)
  const [host, setHost] = useState<string | null>(null)
  const [sidebarDragging, setSidebarDragging] = useState(false)
  // Owned here, not in the pane: the pane remounts per process
  // (`key={selected.id}`), so it would shut itself when comparing two entries.
  // Deliberately not persisted — a within-session reading position.
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Guarded on purpose: closing the dialog calls `pairLaunch.dismiss()`, which
  // flips `armed` back to false and re-runs this effect. Without the `if`, that
  // would reopen the dialog the operator just closed and start a second pairing
  // run — with no `server`, i.e. against the config's environment rather than
  // the installer's.
  useEffect(() => {
    if (pairLaunch.armed) setMenuDialog('join')
  }, [pairLaunch.armed])

  useEffect(() => {
    hostname().then(setHost, () => setHost(null))
  }, [])

  const [startOnLogin, setStartOnLogin] = useState<boolean | null>(null)
  useEffect(() => {
    startupLinkEnabled().then(setStartOnLogin, () => setStartOnLogin(null))
  }, [])

  // The webview's native menu (Back/Refresh/Print/Inspect) is browser chrome, not
  // this app. Suppressed in built apps except on editable fields; `tauri dev` keeps
  // it so Inspect stays reachable.
  useEffect(() => {
    if (import.meta.env.DEV) return
    const suppress = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      event.preventDefault()
    }
    window.addEventListener('contextmenu', suppress)
    return () => window.removeEventListener('contextmenu', suppress)
  }, [])

  // Operator-facing label; logs and config still carry the id.
  const siteLabel = siteNameOf(config.config, health.statusFile)

  /** Drives leave-vs-join in the menu, and the footer's `join site` button. */
  const paired = isPaired(config.config) === true

  const handleJoined = useCallback(() => {
    // The helper restarts the service and the config watcher picks the new site up,
    // so nothing to reload. Unnamed on purpose: pairing yields an id, and the name
    // only lands with the restarted service's first status write.
    toast.success('this machine joined a site')
  }, [])

  const handleLeft = useCallback(() => {
    toast.success('this machine left its site')
  }, [])

  const processes = useMemo(
    () => (config.config ? processesOf(config.config) : []),
    [config.config],
  )
  const selected = selectedId
    ? (processes.find((process) => process.id === selectedId) ?? null)
    : null

  // The selection can vanish — deleted here, or by the web app, while open.
  useEffect(() => {
    if (selectedId && config.config && !findProcess(config.config, selectedId)) {
      setSelectedId(null)
    }
  }, [config.config, selectedId])

  const edit = useCallback(
    async (failure: string, transform: (document: OwletteConfig) => OwletteConfig) => {
      try {
        return await config.mutate(transform)
      } catch (cause) {
        toast.error(failure, { description: message(cause) })
        return null
      }
    },
    [config],
  )

  const editSelected = useCallback(
    (failure: string, update: (process: ProcessEntry) => ProcessEntry) => {
      if (!selectedId) return
      void edit(failure, (document) => updateProcess(document, selectedId, update))
    },
    [edit, selectedId],
  )

  const handleAdd = useCallback(async () => {
    const id = crypto.randomUUID()
    const written = await edit('could not add the process', (document) =>
      addProcess(document, createProcessEntry(id, uniqueDefaultName(processesOf(document)))),
    )
    if (written) setSelectedId(id)
  }, [edit])

  const handleDuplicate = useCallback(
    async (id: string) => {
      const cloneId = crypto.randomUUID()
      const written = await edit('could not duplicate the process', (document) =>
        duplicateProcess(document, id, cloneId),
      )
      if (written) setSelectedId(cloneId)
    },
    [edit],
  )

  /**
   * Files dropped on the window. Classification is read-only (stat + host lookup)
   * so it runs immediately; nothing is written until a card is confirmed.
   * Unclassifiable drops are reported and forgotten — there is nothing to propose.
   */
  const handleDrop = useCallback(async (paths: string[]) => {
    try {
      const results = await classifyDrop(paths, tauriFsProbe, await classifyOptions())
      const { cards, rejected } = triage(results)

      for (const drop of rejected) {
        toast.warning(`${fileNameOf(drop.path)} was not added`, { description: drop.reason })
      }
      if (cards.length) setDropped((queue) => enqueueCards(queue, cards))
    } catch (cause) {
      toast.error('could not read what was dropped', { description: message(cause) })
    }
  }, [])

  const dragOver = useFileDrop((paths) => void handleDrop(paths))

  /** The card being reviewed; the queue is worked from the front. */
  const dropCard = dropped[0] ?? null
  const dropBlockedReason = dropCard
    ? cardBlockedReason(
        dropCard,
        processes.map((process) => String(process.name ?? '')),
      )
    : null

  const handleDropChange = useCallback((patch: Partial<ProcessEntryDraft>) => {
    setDropped((queue) => (queue.length ? updateCard(queue, queue[0].path, patch) : queue))
  }, [])

  /**
   * Add the reviewed card. It leaves the queue BEFORE the write, so a double click
   * on `add process` is a no-op rather than a duplicate entry. Cost: the card is
   * lost if the write fails — but that means config.json is unwritable anyway.
   */
  const handleDropConfirm = useCallback(async () => {
    if (!dropCard) return

    const entry = toProcessEntry(
      {
        ...dropCard.entry,
        name: dropCard.entry.name.trim(),
        exe_path: dropCard.entry.exe_path.trim(),
      },
      crypto.randomUUID(),
    )

    setDropped((queue) => dequeueCard(queue, dropCard.path))
    const written = await edit('could not add the process', (document) =>
      addProcess(document, entry),
    )
    if (!written) return

    setSelectedId(entry.id)
    toast.success(`${entry.name} was added`, {
      description: 'its launch mode is off — nothing will start it until you change that',
    })
  }, [dropCard, edit])

  const handleDropSkip = useCallback(() => {
    setDropped((queue) => queue.slice(1))
  }, [])

  /** One write per drop — the drag itself never touches the file. */
  const handleReorder = useCallback(
    (id: string, toIndex: number) => {
      void edit('could not reorder the processes', (document) =>
        reorderProcess(document, id, toIndex),
      )
    },
    [edit],
  )

  const handleSaveForm = useCallback(
    (form: ProcessForm) => {
      editSelected('could not save the process', (process) => applyForm(process, form))
    },
    [editSelected],
  )

  /**
   * Leaving `off` needs a name and an exe — refuse rather than write a launch mode
   * the service cannot act on. Same wording as the legacy GUI.
   */
  const handleLaunchMode = useCallback(
    (mode: LaunchMode) => {
      if (!selected) return
      const blocked = mode === 'off' ? null : launchModeBlockedReason(selected)
      if (blocked) {
        toast.warning(blocked)
        return
      }

      editSelected('could not change the launch mode', (process) => setLaunchMode(process, mode))

      // An unmanaged process keeps its last live status forever (nothing corrects
      // it), so write the intent alongside the config change — as
      // `owlette_gui.on_launch_mode_change` does.
      const pid = livePidForProcess(appStates.states, selected.id)
      if (pid === null) return
      const intent = mode === 'off' ? 'INACTIVE' : 'QUEUED'
      if (statusForProcess(appStates.states, selected.id) === intent) return

      void appStates
        .mutate((states) => ({
          ...states,
          [String(pid)]: { ...states[String(pid)], status: intent, id: selected.id },
        }))
        .catch(() => {
          // Cosmetic: the service rewrites this file on its next tick anyway.
        })
    },
    [appStates, editSelected, selected],
  )

  const stop = useCallback(
    async (process: ProcessEntry, mode: StopMode) => {
      try {
        const result = await stopProcess(process, mode, {
          readStates: appStates.read,
          mutateStates: appStates.mutate,
        })

        const managed = launchModeOf(process) !== 'off'
        if (mode === 'kill') {
          toast.success(`${process.name} was killed`, {
            description: managed
              ? `pid ${result.pid} — the service will start it again, because its launch mode is not off`
              : `pid ${result.pid} — it stays stopped until you start it again`,
          })
        } else {
          toast.success(`${process.name} was stopped`, {
            description: managed
              ? `pid ${result.pid} — the service relaunches it within a few seconds`
              : `pid ${result.pid} — its launch mode is off, so nothing will start it again`,
          })
        }
      } catch (cause) {
        if (cause instanceof NoLiveInstanceError) toast.warning(cause.message)
        else toast.error(`could not ${mode} ${process.name}`, { description: message(cause) })
      }
    },
    [appStates],
  )

  const handleAction = useCallback(
    (action: ProcessAction, id: string) => {
      const process = processes.find((entry) => entry.id === id)
      if (!process) return
      const name = process.name || 'this process'
      const managed = launchModeOf(process) !== 'off'

      switch (action) {
        case 'duplicate':
          void handleDuplicate(id)
          return
        case 'delete':
          setConfirm({
            title: 'remove process',
            description: `remove ${name} from this machine? owlette will stop managing it. the process itself is left alone.`,
            confirmLabel: 'remove',
            destructive: true,
            onConfirm: () => {
              void edit('could not remove the process', (document) => removeProcess(document, id))
            },
          })
          return
        case 'restart':
          setConfirm({
            title: 'restart process',
            description: managed
              ? `restart ${name}? this will briefly stop the process before the service relaunches it.`
              : `restart ${name}? its launch mode is off, so the service will not start it again — this will only stop it.`,
            confirmLabel: 'restart',
            onConfirm: () => void stop(process, 'restart'),
          })
          return
        case 'kill':
          setConfirm({
            // `KILLED` only marks the exit intentional (no crash alert); the
            // relaunch is decided by the launch mode alone
            // (`owlette_service.py:2486-2534`).
            title: 'kill process',
            description: managed
              ? `kill ${name}? it will be terminated, and because its launch mode is not off the service will start it again within a few seconds. set the launch mode to off first if you want it to stay stopped.`
              : `kill ${name}? it will be terminated and stays stopped until you start it again.`,
            confirmLabel: 'kill',
            destructive: true,
            onConfirm: () => void stop(process, 'kill'),
          })
      }
    },
    [edit, handleDuplicate, processes, stop],
  )

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-screen flex-col bg-background">
        {/*
          The window has no native titlebar (`decorations: false`), so this row
          is it: the drag surface, the one wordmark, and the window controls.
          `data-tauri-drag-region` applies only to the element carrying it, so
          the controls inside stay clickable without opting out.

          Do NOT wire double-click-to-maximise here. Tauri's drag-region handler
          already calls `internal_toggle_maximize` on `mousedown` with `detail === 2`,
          so our own `dblclick` fires a second toggle and the window lands back where
          it started (measured: 3 double-clicks -> 1 state change). Enabled by
          `core:window:allow-internal-toggle-maximize`.
        */}
        <header
          data-tauri-drag-region
          data-titlebar
          // z-[60] lifts the titlebar over dialog overlays (z-50) and
          // pointer-events-auto beats the pointer-events:none Radix puts on <body>
          // during a modal, so the window stays draggable with a dialog up.
          // DialogContent exempts [data-titlebar] from outside-dismiss to match.
          className="pointer-events-auto relative z-[60] flex h-10 shrink-0 select-none items-center gap-2.5 border-b pl-4"
        >
          <OwletteEye size={18} className="pointer-events-none" />
          <span className="pointer-events-none text-sm font-medium tracking-tight">owlette</span>
          <span data-tauri-drag-region className="h-full flex-1" />
          <AppMenu
            paired={paired}
            onJoinSite={() => setMenuDialog('join')}
            onLeaveSite={() => setMenuDialog('leave')}
            onReportIssue={() => setMenuDialog('report')}
            startOnLogin={startOnLogin}
            onStartOnLoginChange={(next) => {
              void setStartupLink(next).then(setStartOnLogin, (cause: unknown) =>
                toast.error('could not change start on login', { description: message(cause) }),
              )
            }}
            onRestartService={() => {
              // The service polls for this file each loop, exits 42, and the host
              // relaunches it. No elevation, no dashboard flap.
              void writeOwletteJson('tmp/restart.flag', {}).then(
                () => toast.success('restarting the owlette service'),
                (cause: unknown) => toast.error('could not restart the service', { description: message(cause) }),
              )
            }}
          />
          <WindowControls />
        </header>

        {config.error && (
          <InlineNotice className="m-3" data-testid="config-error">
            <p className="text-sm">
              could not read config.json — showing the last copy this window read.
            </p>
            <p className="font-mono text-xs text-muted-foreground">{config.error}</p>
          </InlineNotice>
        )}

        <div className="flex min-h-0 flex-1">
          {/*
            The host remembers the width per user, so it lands a tick after mount;
            until then this is the historical default. The divider draws the border,
            not the aside — one line, not two.
          */}
          <aside
            className={
              // Eased slide on toggle/keyboard collapse, never during a drag —
              // easing reads as lag when tracking the pointer.
              sidebarDragging
                ? 'min-w-0 shrink-0'
                : 'min-w-0 shrink-0 transition-[width] duration-200 ease-out motion-reduce:transition-none'
            }
            style={{ width: sidebar.columnWidth }}
          >
            <ProcessList
              processes={processes}
              states={appStates.states}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAdd={() => void handleAdd()}
              onAction={handleAction}
              onReorder={handleReorder}
              dragOver={dragOver}
              collapsed={sidebar.collapsed}
              onCollapsedChange={sidebar.setCollapsed}
            />
          </aside>

          <SidebarDivider
            layout={{ collapsed: sidebar.collapsed, width: sidebar.width }}
            onLayout={sidebar.set}
            onCommit={sidebar.commit}
            onDraggingChange={setSidebarDragging}
          />

          <section className="min-w-0 flex-1">
            {selected ? (
              <ProcessDetail
                key={selected.id}
                process={selected}
                status={statusForProcess(appStates.states, selected.id)}
                startedAt={launchedAtForProcess(appStates.states, selected.id)}
                advancedOpen={advancedOpen}
                onAdvancedOpenChange={setAdvancedOpen}
                onSave={handleSaveForm}
                onLaunchMode={handleLaunchMode}
                onSchedules={(schedules: ScheduleBlock[]) =>
                  editSelected('could not save the schedule', (process) =>
                    setSchedules(process, schedules),
                  )
                }
                onPriority={(priority: Priority) =>
                  editSelected('could not change the priority', (process) =>
                    setPriority(process, priority),
                  )
                }
                onVisibility={(visibility: Visibility) =>
                  editSelected('could not change the visibility', (process) =>
                    setVisibility(process, visibility),
                  )
                }
                onRestart={() => handleAction('restart', selected.id)}
                onKill={() => handleAction('kill', selected.id)}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <p className="text-sm text-muted-foreground">
                  {config.loading ? 'reading config.json…' : 'select a process to view its details'}
                </p>
              </div>
            )}
          </section>
        </div>

        <StatusFooter
          status={health.status}
          statusFile={health.statusFile}
          config={config.config}
          hostname={host}
          starting={health.starting}
          bringingUp={health.bringingUp}
          elevationRequired={health.elevationRequired}
          error={health.error}
          scmError={health.scmError}
          onStart={() => void health.start()}
          onJoin={() => setMenuDialog('join')}
        />

        <JoinSiteDialog
          open={menuDialog === 'join'}
          // Only while the launch flag is armed: `launch_args()` keeps returning
          // the installer's argv forever, so a tray re-open hours later must not
          // inherit its server.
          server={pairLaunch.armed ? (serverFromArgs(pairLaunch.argv) ?? undefined) : undefined}
          // The same flag the footer's "connected" branch reads, so the dialog
          // cannot claim a different service state than the window behind it.
          serviceConnected={health.statusFile?.firebase?.connected === true}
          onClose={() => {
            setMenuDialog(null)
            pairLaunch.dismiss()
          }}
          onJoined={handleJoined}
        />
        <LeaveSiteDialog
          open={menuDialog === 'leave'}
          site={siteLabel}
          onClose={() => setMenuDialog(null)}
          onLeft={handleLeft}
          onHold={health.hold}
        />
        <ReportIssueDialog open={menuDialog === 'report'} onClose={() => setMenuDialog(null)} />
        <RestartCountdown open={restartPrompt.armed} onClose={restartPrompt.dismiss} />

        <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
        <DropConfirm
          card={dropCard}
          remaining={dropped.length}
          blockedReason={dropBlockedReason}
          onChange={handleDropChange}
          onConfirm={() => void handleDropConfirm()}
          onSkip={handleDropSkip}
        />
        {dragOver && <DropOverlay />}
        <Toaster />
      </div>
    </TooltipProvider>
  )
}

export default App
