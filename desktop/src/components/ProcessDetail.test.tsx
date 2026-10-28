import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProcessDetail } from '@/components/ProcessDetail'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DetailSections } from '@/lib/ipc'
import type { ProcessEntry } from '@/lib/owletteConfig'
import type { ProcessStatus } from '@/lib/processStatus'

vi.mock('@/lib/pickers', () => ({
  pickExecutable: vi.fn(),
  pickFile: vi.fn(),
  pickDirectory: vi.fn(),
}))

const base: ProcessEntry = {
  id: 'a',
  name: 'player',
  exe_path: 'C:/apps/player.exe',
  file_path: '',
  cwd: '',
  priority: 'Normal',
  visibility: 'Normal',
  time_delay: '0',
  time_to_init: '10',
  relaunch_attempts: '5',
  launch_mode: 'off',
}

interface Options {
  status?: ProcessStatus
  startedAt?: number | null
  sections?: Partial<DetailSections>
  scheduleTimezone?: string
}

function setup(process: ProcessEntry = base, options: Options = {}) {
  const onSave = vi.fn()
  const onLaunchMode = vi.fn()
  const onSchedules = vi.fn()
  const onRestart = vi.fn()
  const onKill = vi.fn()
  const onSectionToggle = vi.fn()

  function ui(entry: ProcessEntry) {
    return (
      <TooltipProvider>
        <ProcessDetail
          process={entry}
          status={options.status ?? 'INACTIVE'}
          startedAt={options.startedAt ?? null}
          sections={{ whatToRun: true, whenToRun: true, howToRun: true, ...options.sections }}
          onSectionToggle={onSectionToggle}
          onSave={onSave}
          onLaunchMode={onLaunchMode}
          onSchedules={onSchedules}
          scheduleTimezone={options.scheduleTimezone}
          onPriority={vi.fn()}
          onVisibility={vi.fn()}
          onRestart={onRestart}
          onKill={onKill}
        />
      </TooltipProvider>
    )
  }

  const view = render(ui(process))

  return {
    onSave,
    onLaunchMode,
    onSchedules,
    onRestart,
    onKill,
    onSectionToggle,
    rerender: (next: ProcessEntry) => view.rerender(ui(next)),
  }
}

function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement
}

/** Focus, type, blur — one operator edit. */
function edit(input: HTMLInputElement, value: string) {
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

beforeEach(() => {
  vi.useRealTimers()
})

describe('auto-save', () => {
  it('writes a changed field on blur', () => {
    const { onSave } = setup()

    edit(field('name'), 'media player')

    expect(onSave).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'media player', exe_path: 'C:/apps/player.exe' }),
    )
  })

  it('writes nothing when focus passes through a field untouched', () => {
    const { onSave } = setup()

    fireEvent.focus(field('name'))
    fireEvent.blur(field('name'))

    expect(onSave).not.toHaveBeenCalled()
  })

  it('writes nothing when the typed value is what is already on disk', () => {
    const { onSave } = setup()

    edit(field('name'), 'player')

    expect(onSave).not.toHaveBeenCalled()
  })

  it('folds the enter key and the blur it causes into one write', () => {
    const { onSave } = setup()
    const input = field('name')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'media player' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)

    expect(onSave).toHaveBeenCalledOnce()
  })

  it('applies the service’s floors to a nonsense number rather than nagging', () => {
    const { onSave } = setup({ ...base, time_to_init: '30' })

    edit(field('wait (sec)'), '2')

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ time_to_init: '10' }))
    expect(field('wait (sec)').value).toBe('10')
  })

  it('stops showing a value the file will never hold', () => {
    const { onSave } = setup()

    // Floored to the ten seconds already stored, so there is nothing to write —
    // and nothing on screen should suggest otherwise.
    edit(field('wait (sec)'), '2')

    expect(onSave).not.toHaveBeenCalled()
    expect(field('wait (sec)').value).toBe('10')
  })

  it('refuses to save a nameless entry, and keeps what was typed', () => {
    const { onSave } = setup()

    edit(field('name'), '')

    expect(onSave).not.toHaveBeenCalled()
    expect(field('name').value).toBe('')
  })
})

describe('external changes', () => {
  it('takes a change made elsewhere when nothing is focused', () => {
    const { rerender } = setup()

    rerender({ ...base, name: 'renamed by the web app' })

    expect(field('name').value).toBe('renamed by the web app')
  })

  it('holds a change back while the operator is typing in that field', () => {
    const { rerender } = setup()
    const input = field('name')

    fireEvent.focus(input)
    rerender({ ...base, name: 'renamed by the web app' })

    expect(input.value).toBe('player')

    // …and applies it the moment focus leaves.
    fireEvent.blur(input)
    expect(field('name').value).toBe('renamed by the web app')
  })

  it('lets the operator’s own edit win over the change it raced', () => {
    const { onSave, rerender } = setup()
    const input = field('name')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'mine' } })
    rerender({ ...base, name: 'theirs' })
    fireEvent.blur(input)

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'mine' }))
    expect(field('name').value).toBe('mine')
  })

  it('adopts a different process wholesale, focus or not', () => {
    const { rerender } = setup()

    fireEvent.focus(field('name'))
    rerender({ ...base, id: 'b', name: 'other', exe_path: 'C:/apps/other.exe' })

    expect(field('name').value).toBe('other')
    expect(field('exe').value).toBe('C:/apps/other.exe')
  })
})

describe('the launch mode control', () => {
  function segment(label: string): HTMLButtonElement {
    return screen.getByRole('radio', { name: label }) as HTMLButtonElement
  }

  it('shows all three modes at once, with the current one checked', () => {
    setup()

    expect(screen.getByTestId('launch-mode').getAttribute('role')).toBe('radiogroup')
    expect(segment('off').getAttribute('aria-checked')).toBe('true')
    expect(segment('always on').getAttribute('aria-checked')).toBe('false')
    expect(segment('scheduled').getAttribute('aria-checked')).toBe('false')
  })

  it('asks for the mode of the segment that was clicked', () => {
    const { onLaunchMode } = setup()

    fireEvent.click(segment('always on'))

    expect(onLaunchMode).toHaveBeenCalledExactlyOnceWith('always')
  })

  it('does not ask again for the mode it is already in', () => {
    const { onLaunchMode } = setup({ ...base, launch_mode: 'scheduled' })

    fireEvent.click(segment('scheduled'))

    // Every call rewrites config.json, and an identical rewrite makes the
    // service re-read and re-upload for nothing.
    expect(onLaunchMode).not.toHaveBeenCalled()
  })

  it('slides the fill to the segment the mode names', () => {
    const { rerender } = setup()
    const indicator = screen.getByTestId('launch-mode-indicator')

    expect(indicator.style.transform).toBe('translateX(0%)')

    rerender({ ...base, launch_mode: 'always' })
    expect(indicator.style.transform).toBe('translateX(100%)')
    expect(indicator.className).toContain('bg-success-solid')

    rerender({ ...base, launch_mode: 'scheduled' })
    expect(indicator.style.transform).toBe('translateX(200%)')
    expect(indicator.className).toContain('bg-info-solid')
  })

  it('hangs the schedule pencil off the group, flush and outside the grid', () => {
    setup()

    const group = screen.getByTestId('launch-mode')
    const pencil = screen.getByTestId('edit-schedule')
    const shell = group.parentElement

    // One bordered shell holds both, so the pencil reads as a fourth segment
    // rather than a detached icon button a gap away.
    expect(pencil.parentElement).toBe(shell)
    expect(shell?.className).toContain('border-border')

    // Outside the grid on purpose: the indicator is a third of the group and
    // translates in whole multiples of itself — a fourth cell makes it a
    // quarter wide and lands it short of every segment.
    expect(group.className).toContain('grid-cols-3')
    expect(group.contains(pencil)).toBe(false)
  })

  it('reads the legacy autolaunch flag when there is no launch mode', () => {
    setup({ ...base, launch_mode: undefined, autolaunch: true })

    expect(segment('always on').getAttribute('aria-checked')).toBe('true')
  })
})

describe('schedules', () => {
  it('says what an empty schedule actually does when the mode is scheduled', () => {
    setup({ ...base, launch_mode: 'scheduled' })

    // The service reads no windows as "always in window", so the note must not
    // suggest the process is being held back.
    expect(screen.getByTestId('schedule-note').textContent).toBe(
      '(no schedule set — runs at all times)',
    )
  })

  it('summarises the windows on the entry', () => {
    setup({
      ...base,
      launch_mode: 'scheduled',
      schedules: [{ days: ['mon', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] }],
    })

    expect(screen.getByTestId('schedule-note').textContent).toBe('mon, fri: 09:00-17:00')
  })

  it('says nothing about schedules for an always-on entry', () => {
    setup({ ...base, launch_mode: 'always' })

    expect(screen.queryByTestId('schedule-note')).toBeNull()
  })

  it('offers the editor in every launch mode', () => {
    // The editor used to appear only once the entry was already scheduled,
    // which put the windows behind the mode they configure.
    const { rerender } = setup({ ...base, launch_mode: 'off' })
    expect(screen.getByTestId('edit-schedule')).toBeTruthy()

    rerender({ ...base, launch_mode: 'always' })
    expect(screen.getByTestId('edit-schedule')).toBeTruthy()

    rerender({ ...base, launch_mode: 'scheduled' })
    expect(screen.getByTestId('edit-schedule')).toBeTruthy()
  })

  it('hands the editor the clock the service published for this site', () => {
    // The pane is where the zone arrives from App; dropping it here would leave
    // an opted-in site reading "this machine's own clock" in the one dialog
    // that authors the windows.
    setup({ ...base, launch_mode: 'scheduled' }, { scheduleTimezone: 'Europe/Berlin' })

    fireEvent.click(screen.getByTestId('edit-schedule'))

    expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toBe(
      "the service runs this process during these windows and stops it outside them. times run on the site's clock (Berlin).",
    )
  })

  it('leaves the editor on the machine clock when no site clock was published', () => {
    setup({ ...base, launch_mode: 'scheduled' })

    fireEvent.click(screen.getByTestId('edit-schedule'))

    expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toBe(
      "the service runs this process during these windows and stops it outside them. times run on this machine's own clock.",
    )
  })

  it('stores the windows authored from an unscheduled entry without switching mode', () => {
    const { onSchedules, onLaunchMode } = setup({ ...base, launch_mode: 'off' })

    fireEvent.click(screen.getByTestId('edit-schedule'))
    fireEvent.click(screen.getByRole('button', { name: 'save schedule' }))

    expect(onSchedules).toHaveBeenCalledExactlyOnceWith([
      { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] },
    ])
    // Pre-configuring is not the same as switching on: the segmented control is
    // the only thing that changes the launch mode.
    expect(onLaunchMode).not.toHaveBeenCalled()
  })

  it('opens the editor on the windows the entry holds, and saves them back', () => {
    const { onSchedules } = setup({
      ...base,
      launch_mode: 'scheduled',
      schedules: [{ days: ['sat'], ranges: [{ start: '10:00', stop: '18:00' }] }],
    })

    fireEvent.click(screen.getByTestId('edit-schedule'))
    expect(screen.getByTestId('schedule-editor')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'save schedule' }))

    expect(onSchedules).toHaveBeenCalledExactlyOnceWith([
      { days: ['sat'], ranges: [{ start: '10:00', stop: '18:00' }] },
    ])
    expect(screen.queryByTestId('schedule-editor')).toBeNull()
  })

  it('prefills the default schedule for an entry that has none', () => {
    const { onSchedules } = setup({ ...base, launch_mode: 'scheduled' })

    fireEvent.click(screen.getByTestId('edit-schedule'))
    fireEvent.click(screen.getByRole('button', { name: 'save schedule' }))

    expect(onSchedules).toHaveBeenCalledExactlyOnceWith([
      { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] },
    ])
  })

  it('writes nothing when the editor is cancelled', () => {
    const { onSchedules } = setup({ ...base, launch_mode: 'scheduled' })

    fireEvent.click(screen.getByTestId('edit-schedule'))
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))

    expect(onSchedules).not.toHaveBeenCalled()
    expect(screen.queryByTestId('schedule-editor')).toBeNull()
  })

  it('groups the form into what to run, when to run, and how to run', () => {
    setup()

    // The order an entry is filled in, and the order it is read back in.
    const labels = [...document.querySelectorAll('[data-testid$="-toggle"]')].map(
      (element) => element.textContent?.trim() ?? '',
    )
    expect(labels[0]).toBe('what to run')
    expect(labels[1]).toBe('when to run')
    expect(labels[2]).toMatch(/^how to run/)

    // …and every row still shares one label gutter, so the sections do not
    // break the alignment they were added to.
    const fieldFor = (label: string) => screen.getByLabelText(label)
    expect(fieldFor('name').id).toBe('name')
    expect(fieldFor('delay (sec)').id).toBe('time_delay')
  })
})

describe('a launch mode of off', () => {
  it('dims the how-to-run fields without taking them away', () => {
    const { onSave } = setup({ ...base, launch_mode: 'off' })

    const fields = screen.getByTestId('how-to-run-fields')
    expect(fields.dataset.dimmed).toBe('true')
    expect(screen.getByTestId('when-to-run-timing').dataset.dimmed).toBe('true')
    expect(screen.getByText(/applies once a launch mode is set/)).toBeTruthy()

    // Dimmed is a statement about when they apply, not a lock: filling these in
    // before switching the mode on is how an entry is set up.
    const attempts = screen.getByLabelText('attempts') as HTMLInputElement
    expect(attempts.disabled).toBe(false)
    edit(attempts, '9')
    expect(onSave).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ relaunch_attempts: '9' }),
    )
  })

  it('leaves them at full weight for an entry owlette manages', () => {
    setup({ ...base, launch_mode: 'always' })

    expect(screen.getByTestId('how-to-run-fields').dataset.dimmed).toBeUndefined()
    expect(screen.getByTestId('when-to-run-timing').dataset.dimmed).toBeUndefined()
    expect(screen.queryByText(/applies once a launch mode is set/)).toBeNull()
  })
})

describe('the status row', () => {
  it('carries the name, the status and both actions on one line', () => {
    setup(base, { status: 'RUNNING' })

    const header = screen.getByTestId('detail-header')
    // The name field used to have a full-width row of its own below this one.
    expect(header.contains(screen.getByLabelText('name'))).toBe(true)
    expect(header.contains(screen.getByTestId('detail-status'))).toBe(true)
    expect(header.contains(screen.getByRole('button', { name: 'restart process' }))).toBe(true)
    expect(header.contains(screen.getByRole('button', { name: 'kill process' }))).toBe(true)
    expect(screen.getByTestId('detail-status').textContent).toBe('running')
  })

  it('keeps the name field a full member of the auto-saving form', () => {
    // The move was markup-only: the auto-save suite above addresses this same
    // field by label, and this asserts it is the header's copy doing the work.
    const { onSave } = setup()
    const name = screen.getByLabelText('name') as HTMLInputElement

    expect(screen.getByTestId('detail-header').contains(name)).toBe(true)
    expect(screen.getAllByLabelText('name')).toHaveLength(1)

    edit(name, 'media player')
    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'media player' }))
  })

  it('asks the caller for a restart and a kill', () => {
    const { onRestart, onKill } = setup(base, { status: 'RUNNING' })

    fireEvent.click(screen.getByRole('button', { name: 'restart process' }))
    fireEvent.click(screen.getByRole('button', { name: 'kill process' }))

    expect(onRestart).toHaveBeenCalledOnce()
    expect(onKill).toHaveBeenCalledOnce()
  })

  it('disables both actions when there is nothing running to act on', () => {
    const { onKill, onRestart } = setup(base, { status: 'STOPPED' })

    const kill = screen.getByRole('button', { name: 'kill process' }) as HTMLButtonElement
    expect(kill.disabled).toBe(true)
    fireEvent.click(kill)
    expect(onKill).not.toHaveBeenCalled()

    // Restart too: bringing a dead process back is the launch mode's job.
    const restart = screen.getByRole('button', { name: 'restart process' }) as HTMLButtonElement
    expect(restart.disabled).toBe(true)
    fireEvent.click(restart)
    expect(onRestart).not.toHaveBeenCalled()
  })

  it('offers both actions on a running process whose launch mode is off', () => {
    // Liveness, not launch mode, decides: switching a running process to off
    // must not take the controls away.
    setup({ ...base, launch_mode: 'off' }, { status: 'RUNNING' })

    for (const name of ['restart process', 'kill process']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false)
    }
  })

  it('offers kill for every status that has a live generation behind it', () => {
    for (const status of ['RUNNING', 'LAUNCHING', 'RESTARTING'] as const) {
      const { unmount } = render(
        <TooltipProvider>
          <ProcessDetail
            process={base}
            status={status}
            onSave={vi.fn()}
            onLaunchMode={vi.fn()}
            onSchedules={vi.fn()}
            onPriority={vi.fn()}
            onVisibility={vi.fn()}
            onRestart={vi.fn()}
            onKill={vi.fn()}
          />
        </TooltipProvider>,
      )
      expect(
        (screen.getByRole('button', { name: 'kill process' }) as HTMLButtonElement).disabled,
      ).toBe(false)
      unmount()
    }
  })

  it('says when a running process was started', () => {
    const started = Date.now() - 2 * 60 * 60 * 1000
    setup(base, { status: 'RUNNING', startedAt: started })

    const since = screen.getByTestId('detail-started')
    expect(since.textContent).toBe('started 2 hours ago')
    expect(since.dataset.startedAt).toBe(String(started))
  })

  it('says nothing about time when the file has none to give', () => {
    setup(base, { status: 'RUNNING', startedAt: null })

    expect(screen.queryByTestId('detail-started')).toBeNull()
  })

  it('does not claim a launch time describes a status it does not', () => {
    // `timestamp` is written at launch and never updated, so beside `killed` it
    // would read as a "started" that isn't when this state began.
    setup(base, { status: 'KILLED', startedAt: Date.now() - 60_000 })

    expect(screen.queryByTestId('detail-started')).toBeNull()
  })
})

describe('the section disclosures', () => {
  it('folds each section away independently', () => {
    setup(base, { sections: { whatToRun: false, whenToRun: false, howToRun: false } })

    expect(screen.getByTestId('what-to-run-toggle')).toBeTruthy()
    expect(screen.queryByLabelText('exe')).toBeNull()
    expect(screen.queryByTestId('launch-mode')).toBeNull()
    expect(screen.queryByLabelText('delay (sec)')).toBeNull()
    expect(screen.queryByTestId('how-to-run-fields')).toBeNull()
  })

  it('keeps launch timing under when to run, not how to run', () => {
    // delay/wait are "whens": they live beside the launch mode, while the
    // tune-once fields stay behind the how-to-run disclosure.
    setup(base, { sections: { whatToRun: true, whenToRun: true, howToRun: false } })

    expect(screen.getByLabelText('delay (sec)')).toBeTruthy()
    expect(screen.getByLabelText('wait (sec)')).toBeTruthy()
    expect(screen.queryByLabelText('attempts')).toBeNull()
    expect(screen.queryByTestId('priority')).toBeNull()
    expect(screen.queryByTestId('visibility')).toBeNull()
  })

  it('hands every toggle to the caller, which outlives this pane', () => {
    // The pane is remounted for every process, so an operator comparing two
    // entries would have the disclosures shut themselves on the second.
    const { onSectionToggle } = setup(base, { sections: { howToRun: false } })

    fireEvent.click(screen.getByTestId('how-to-run-toggle'))
    expect(onSectionToggle).toHaveBeenLastCalledWith('howToRun', true)

    fireEvent.click(screen.getByTestId('what-to-run-toggle'))
    expect(onSectionToggle).toHaveBeenLastCalledWith('whatToRun', false)

    fireEvent.click(screen.getByTestId('when-to-run-toggle'))
    expect(onSectionToggle).toHaveBeenLastCalledWith('whenToRun', false)
  })
})

describe('schedule notes', () => {
  it('updates the note as soon as the saved schedule lands on disk', () => {
    const { rerender } = setup({ ...base, launch_mode: 'scheduled' })

    expect(screen.getByTestId('schedule-note').textContent).toBe(
      '(no schedule set — runs at all times)',
    )

    // What the config watcher hands back after the write.
    rerender({
      ...base,
      launch_mode: 'scheduled',
      schedules: [
        { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] },
      ],
    })

    expect(screen.getByTestId('schedule-note').textContent).toBe(
      'mon, tue, wed, thu, fri: 09:00-17:00',
    )
  })
})
