import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runAgent = vi.fn()
const toastSuccess = vi.fn()
const toastWarning = vi.fn()
const pickFiles = vi.fn()
const stageFromPath = vi.fn()
const stageFromBytes = vi.fn()
const discard = vi.fn()

vi.mock('@/lib/agentCli', () => ({ runAgent: (...args: unknown[]) => runAgent(...args) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...args: unknown[]) => pickFiles(...args) }))
vi.mock('@/lib/issueScreenshots', () => ({
  MAX_SCREENSHOTS: 5,
  stageScreenshotFromPath: (...args: unknown[]) => stageFromPath(...args),
  stageScreenshotFromBytes: (...args: unknown[]) => stageFromBytes(...args),
  discardScreenshots: (...args: unknown[]) => discard(...args),
}))
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
  },
}))

const { MAX_DESCRIPTION, ReportIssueDialog } = await import('./ReportIssueDialog')

function open(props: Partial<Parameters<typeof ReportIssueDialog>[0]> = {}) {
  const all = { open: true, onClose: vi.fn(), ...props }
  render(<ReportIssueDialog {...all} />)
  return all
}

function describeIssue(text: string) {
  fireEvent.change(screen.getByTestId('report-description'), { target: { value: text } })
}

function attachLogs() {
  return screen.getByRole('checkbox', { name: 'attach logs' })
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function doneWith(value: Record<string, unknown>) {
  return { code: 0, terminal: { event: 'done', value }, stderr: '' }
}

function staged(id: string) {
  return { id, size: 3, kind: 'png', preview: `data:image/png;base64,${id}` }
}

// the mocked host names a staged file after the picked one, so tests can follow it
function idFor(path: string) {
  return `id-${path.split('/').pop()}`
}

// settles the picker, the staging and the state they land in
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function pick(paths: string[]) {
  pickFiles.mockResolvedValueOnce(paths)
  fireEvent.click(screen.getByRole('button', { name: 'add screenshots' }))
  await settle()
}

function pasteImage(bytes = [1, 2, 3]) {
  fireEvent.paste(screen.getByTestId('report-issue-dialog'), {
    clipboardData: {
      items: [
        {
          type: 'image/png',
          getAsFile: () => ({ arrayBuffer: async () => new Uint8Array(bytes).buffer }),
        },
      ],
    },
  })
}

function thumbnails() {
  return screen.queryAllByRole('img', { name: /^screenshot \d$/ })
}

function screenshotCount() {
  return screen.getByTestId('report-screenshot-count').textContent
}

async function submitIssue(withLogs: boolean) {
  describeIssue('swoop froze on the lobby wall')
  if (withLogs) fireEvent.click(attachLogs())
  fireEvent.click(screen.getByRole('button', { name: 'submit' }))
  await flush()
}

beforeEach(() => {
  runAgent.mockReset().mockResolvedValue({ code: 0, terminal: null, stderr: '' })
  toastSuccess.mockReset()
  toastWarning.mockReset()
  pickFiles.mockReset().mockResolvedValue(null)
  stageFromPath.mockReset().mockImplementation(async (path: string) => staged(idFor(path)))
  stageFromBytes.mockReset().mockResolvedValue(staged('pasted.png'))
  discard.mockReset().mockResolvedValue(0)
})

describe('ReportIssueDialog', () => {
  it('cannot be submitted empty', () => {
    open()
    const submit = screen.getByRole('button', { name: 'submit' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    describeIssue('   ')
    expect((screen.getByRole('button', { name: 'submit' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends the category and description to the agent, trimmed', async () => {
    const props = open()
    describeIssue('  touchdesigner keeps dying overnight  ')

    fireEvent.click(screen.getByRole('button', { name: 'submit' }))
    await flush()

    expect(runAgent).toHaveBeenCalledExactlyOnceWith('report-issue', {
      payload: {
        category: 'bug',
        description: 'touchdesigner keeps dying overnight',
        attachLogs: false,
        screenshots: [],
      },
      onEvent: expect.any(Function),
    })
    expect(toastSuccess).toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('leaves attach logs unticked until the operator opts in', () => {
    // consent must be an act: a pre-ticked box is not valid consent under gdpr
    open()
    expect(attachLogs().getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(/kept 30 days, seen only by owlette support\./)).toBeTruthy()
  })

  it('asks for the log zip when attach logs is ticked', async () => {
    open()
    describeIssue('swoop froze on the lobby wall')
    fireEvent.click(attachLogs())
    expect(attachLogs().getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'submit' }))
    await flush()

    expect(runAgent).toHaveBeenCalledExactlyOnceWith('report-issue', {
      payload: {
        category: 'bug',
        description: 'swoop froze on the lobby wall',
        attachLogs: true,
        screenshots: [],
      },
      onEvent: expect.any(Function),
    })
  })

  it('does not claim logs go automatically', () => {
    open()
    const description = screen.getByText(/help us improve owlette/)
    expect(description.textContent).not.toMatch(/recent logs|automatically/)
    expect(description.textContent).toContain('the last lines of the service log')
  })

  it('confirms a plain issue without mentioning the log zip', async () => {
    runAgent.mockResolvedValue(doneWith({ category: 'bug' }))
    const props = open()
    await submitIssue(false)

    expect(toastSuccess).toHaveBeenCalledExactlyOnceWith('thanks — your issue was sent', {
      description: 'system info and the last lines of the service log went with it.',
    })
    expect(toastWarning).not.toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('confirms the logs went when the agent attached them', async () => {
    runAgent.mockResolvedValue(doneWith({ category: 'bug', logsAttached: true }))
    const props = open()
    await submitIssue(true)

    expect(toastSuccess).toHaveBeenCalledExactlyOnceWith('thanks — your issue was sent', {
      description: 'system info and the logs went with it.',
    })
    expect(toastWarning).not.toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('warns when the issue went but the logs could not be attached', async () => {
    runAgent.mockResolvedValue(doneWith({ category: 'bug', logsAttached: false }))
    const props = open()
    await submitIssue(true)

    expect(toastWarning).toHaveBeenCalledExactlyOnceWith(
      'your issue was sent, but the logs could not be attached',
      { description: 'try again, or send the logs folder another way.' },
    )
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('counts down to the legacy dialog\'s limit and holds the line there', () => {
    open()
    expect(screen.getByTestId('report-remaining').textContent).toBe(
      `${MAX_DESCRIPTION} characters left`,
    )

    describeIssue('x'.repeat(MAX_DESCRIPTION + 500))
    expect(screen.getByTestId('report-remaining').textContent).toBe('0 characters left')
    expect(MAX_DESCRIPTION).toBe(1000)
  })

  it('keeps the operator\'s text when the submission fails', async () => {
    const props = open()
    runAgent.mockRejectedValue(new Error('owlette is not connected to a site'))

    describeIssue('the wall is black')
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))
    await flush()

    expect(screen.getByTestId('report-error').textContent).toContain('not connected to a site')
    expect(props.onClose).not.toHaveBeenCalled()
    expect((screen.getByTestId('report-description') as HTMLTextAreaElement).value).toBe(
      'the wall is black',
    )
  })

  it('starts clean every time it opens', () => {
    // The app keeps this mounted and flips `open`, so a second visit must not
    // show the last report's text.
    const onClose = vi.fn()
    const view = render(<ReportIssueDialog open onClose={onClose} />)
    describeIssue('first attempt')
    fireEvent.click(attachLogs())

    view.rerender(<ReportIssueDialog open={false} onClose={onClose} />)
    view.rerender(<ReportIssueDialog open onClose={onClose} />)

    expect((screen.getByTestId('report-description') as HTMLTextAreaElement).value).toBe('')
    expect(screen.getByTestId('report-remaining').textContent).toBe(
      `${MAX_DESCRIPTION} characters left`,
    )
    expect(attachLogs().getAttribute('aria-checked')).toBe('false')
  })
})

describe('ReportIssueDialog progress', () => {
  // a run that stays in flight until the test finishes it, with its event sink
  function holdRun() {
    const run: { emit: (value: string) => void; finish: () => void } = {
      emit: () => {},
      finish: () => {},
    }
    runAgent.mockImplementation(
      (_mode: string, options: { onEvent: (event: { event: string; value: string }) => void }) =>
        new Promise((resolve) => {
          run.emit = (value) => act(() => options.onEvent({ event: 'status', value }))
          run.finish = () => resolve(doneWith({ category: 'bug' }))
        }),
    )
    return run
  }

  it('spins in the submit button while sending', async () => {
    holdRun()
    open()
    expect(screen.queryByTestId('report-spinner')).toBeNull()

    await submitIssue(true)

    const button = screen.getByRole('button', { name: 'sending…' })
    expect(button.contains(screen.getByTestId('report-spinner'))).toBe(true)
  })

  it('shows the step the agent is on, as the agent words it', async () => {
    const run = holdRun()
    open()
    await submitIssue(true)

    run.emit('zipping logs')
    expect(screen.getByTestId('report-status').textContent).toBe('zipping logs')
    expect(screen.getByTestId('report-status').getAttribute('aria-live')).toBe('polite')
    // in the button row, so it reads beside cancel and sending…
    expect(screen.getByTestId('report-status').parentElement?.getAttribute('data-slot')).toBe('dialog-footer')

    run.emit('uploading logs')
    expect(screen.getByTestId('report-status').textContent).toBe('uploading logs')

    run.finish()
    await flush()
    expect(screen.queryByTestId('report-status')).toBeNull()
    expect(screen.queryByTestId('report-spinner')).toBeNull()
  })

  it('drops the last step when it opens again', async () => {
    const onClose = vi.fn()
    const run = holdRun()
    const view = render(<ReportIssueDialog open onClose={onClose} />)
    await submitIssue(false)
    run.emit('submitting')
    expect(screen.getByTestId('report-status').textContent).toBe('submitting')

    view.rerender(<ReportIssueDialog open={false} onClose={onClose} />)
    view.rerender(<ReportIssueDialog open onClose={onClose} />)

    expect(screen.queryByTestId('report-status')).toBeNull()
    expect(screen.queryByTestId('report-spinner')).toBeNull()

    // the next send starts with no step until the agent names one
    await submitIssue(false)
    expect(screen.getByTestId('report-status').textContent).toBe('')
  })
})

describe('ReportIssueDialog screenshots', () => {
  it('stages what the operator picks and shows a thumbnail of each', async () => {
    open()
    expect(screenshotCount()).toBe('0 of 5')
    expect(screen.getByText('or paste an image')).toBeTruthy()

    await pick(['/shots/wall.png', '/shots/lobby.jpg'])

    expect(pickFiles).toHaveBeenCalledExactlyOnceWith({
      multiple: true,
      filters: [{ name: 'images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    })
    expect(stageFromPath.mock.calls).toEqual([['/shots/wall.png'], ['/shots/lobby.jpg']])
    expect(thumbnails().map((img) => img.getAttribute('src'))).toEqual([
      'data:image/png;base64,id-wall.png',
      'data:image/png;base64,id-lobby.jpg',
    ])
    expect(screenshotCount()).toBe('2 of 5')
  })

  it('stages nothing when the picker is dismissed', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'add screenshots' }))
    await settle()

    expect(stageFromPath).not.toHaveBeenCalled()
    expect(thumbnails()).toHaveLength(0)
  })

  it('discards a screenshot the operator removes', async () => {
    open()
    await pick(['/shots/wall.png', '/shots/lobby.jpg'])

    fireEvent.click(screen.getAllByRole('button', { name: 'remove screenshot' })[0])

    expect(discard).toHaveBeenCalledExactlyOnceWith(['id-wall.png'])
    expect(thumbnails().map((img) => img.getAttribute('src'))).toEqual([
      'data:image/png;base64,id-lobby.jpg',
    ])
    expect(screenshotCount()).toBe('1 of 5')
  })

  it('stops at five and says so', async () => {
    open()
    await pick(['/s/1.png', '/s/2.png', '/s/3.png'])
    await pick(['/s/4.png', '/s/5.png', '/s/6.png', '/s/7.png'])

    expect(stageFromPath).toHaveBeenCalledTimes(5)
    expect(stageFromPath).not.toHaveBeenCalledWith('/s/6.png')
    expect(thumbnails()).toHaveLength(5)
    expect(screenshotCount()).toBe('5 of 5')
    expect(screen.getByTestId('report-screenshot-notice').textContent).toBe(
      'up to 5 screenshots per issue',
    )
    expect(
      (screen.getByRole('button', { name: 'add screenshots' }) as HTMLButtonElement).disabled,
    ).toBe(true)

    // a paste at the limit is refused the same way, without staging
    pasteImage()
    await settle()
    expect(stageFromBytes).not.toHaveBeenCalled()
    expect(thumbnails()).toHaveLength(5)
  })

  it('names a refused file and keeps the rest', async () => {
    stageFromPath.mockImplementation(async (path: string) => {
      if (path.endsWith('.txt')) throw 'only png, jpeg or webp images'
      return staged(idFor(path))
    })
    open()
    await pick(['/shots/wall.png', '/shots/notes.txt', '/shots/lobby.jpg'])

    expect(thumbnails()).toHaveLength(2)
    expect(screenshotCount()).toBe('2 of 5')
    expect(screen.getByTestId('report-screenshot-notice').textContent).toBe(
      'notes.txt: only png, jpeg or webp images',
    )
  })

  it('names a picked windows path by its file name', async () => {
    stageFromPath.mockRejectedValue('images must be 8 MB or smaller')
    open()
    await pick(['C:\\Users\\op\\Pictures\\huge.png'])

    expect(screen.getByTestId('report-screenshot-notice').textContent).toBe(
      'huge.png: images must be 8 MB or smaller',
    )
  })

  it('stages a pasted image', async () => {
    open()
    pasteImage([7, 8, 9])
    await settle()

    expect(stageFromBytes).toHaveBeenCalledOnce()
    expect(Array.from(stageFromBytes.mock.calls[0][0] as Uint8Array)).toEqual([7, 8, 9])
    expect(thumbnails()).toHaveLength(1)
  })

  it('leaves a paste with no image to the text box', async () => {
    open()
    const event = fireEvent.paste(screen.getByTestId('report-description'), {
      clipboardData: { items: [{ type: 'text/plain', getAsFile: () => null }] },
    })
    await settle()

    // fireEvent returns false only when the default was prevented
    expect(event).toBe(true)
    expect(stageFromBytes).not.toHaveBeenCalled()
  })

  it('leaves a paste of text with an image beside it to the text box', async () => {
    open()
    const event = fireEvent.paste(screen.getByTestId('report-description'), {
      clipboardData: {
        items: [
          { type: 'text/html', getAsFile: () => null },
          { type: 'text/plain', getAsFile: () => null },
          {
            type: 'image/png',
            getAsFile: () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }),
          },
        ],
      },
    })
    await settle()

    expect(event).toBe(true)
    expect(stageFromBytes).not.toHaveBeenCalled()
    expect(thumbnails()).toHaveLength(0)
  })

  it('sends the staged ids in display order', async () => {
    open()
    await pick(['/shots/wall.png', '/shots/lobby.jpg'])
    pasteImage()
    await settle()
    await submitIssue(false)

    expect(runAgent).toHaveBeenCalledExactlyOnceWith('report-issue', {
      payload: {
        category: 'bug',
        description: 'swoop froze on the lobby wall',
        attachLogs: false,
        screenshots: ['id-wall.png', 'id-lobby.jpg', 'pasted.png'],
      },
      onEvent: expect.any(Function),
    })
  })

  it('leaves sent screenshots to the agent', async () => {
    runAgent.mockResolvedValue(doneWith({ category: 'bug', screenshotsAttached: 1 }))
    const onClose = vi.fn()
    const view = render(<ReportIssueDialog open onClose={onClose} />)
    await pick(['/shots/wall.png'])
    await submitIssue(false)
    view.rerender(<ReportIssueDialog open={false} onClose={onClose} />)

    expect(onClose).toHaveBeenCalledOnce()
    expect(toastSuccess).toHaveBeenCalledExactlyOnceWith('thanks — your issue was sent', {
      description: 'system info, the last lines of the service log and 1 screenshot went with it.',
    })
    expect(toastWarning).not.toHaveBeenCalled()
    expect(discard).not.toHaveBeenCalled()
  })

  it('names the logs and every screenshot that went', async () => {
    runAgent.mockResolvedValue(doneWith({ category: 'bug', logsAttached: true, screenshotsAttached: 2 }))
    render(<ReportIssueDialog open onClose={vi.fn()} />)
    await pick(['/shots/wall.png', '/shots/lobby.jpg'])
    await submitIssue(true)

    expect(toastSuccess).toHaveBeenCalledExactlyOnceWith('thanks — your issue was sent', {
      description: 'system info, the logs and 2 screenshots went with it.',
    })
  })

  it('discards staged screenshots on cancel', async () => {
    const onClose = vi.fn()
    const view = render(<ReportIssueDialog open onClose={onClose} />)
    await pick(['/shots/wall.png', '/shots/lobby.jpg'])

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(onClose).toHaveBeenCalledOnce()
    view.rerender(<ReportIssueDialog open={false} onClose={onClose} />)

    expect(discard).toHaveBeenCalledExactlyOnceWith(['id-wall.png', 'id-lobby.jpg'])

    // reopening starts empty, and does not discard again
    view.rerender(<ReportIssueDialog open onClose={onClose} />)
    expect(thumbnails()).toHaveLength(0)
    expect(screenshotCount()).toBe('0 of 5')
    expect(discard).toHaveBeenCalledOnce()
  })

  it('discards staged screenshots when it unmounts', async () => {
    const view = render(<ReportIssueDialog open onClose={vi.fn()} />)
    await pick(['/shots/wall.png'])

    view.unmount()

    expect(discard).toHaveBeenCalledExactlyOnceWith(['id-wall.png'])
  })

  it('discards a staging that lands after the dialog closed', async () => {
    let land: (value: unknown) => void = () => {}
    stageFromPath.mockReturnValue(new Promise((resolve) => (land = resolve)))
    const onClose = vi.fn()
    const view = render(<ReportIssueDialog open onClose={onClose} />)
    await pick(['/shots/wall.png'])

    view.rerender(<ReportIssueDialog open={false} onClose={onClose} />)
    land(staged('id-late.png'))
    await settle()
    view.rerender(<ReportIssueDialog open onClose={onClose} />)

    expect(discard).toHaveBeenCalledExactlyOnceWith(['id-late.png'])
    expect(thumbnails()).toHaveLength(0)
  })

  it('warns when the issue went but the screenshots could not be attached', async () => {
    runAgent.mockResolvedValue(doneWith({ category: 'bug', screenshotsAttached: 0 }))
    const props = open()
    await pick(['/shots/wall.png'])
    await submitIssue(false)

    expect(toastWarning).toHaveBeenCalledExactlyOnceWith(
      'your issue was sent, but the screenshots could not be attached',
      { description: 'try again, or send them another way.' },
    )
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('warns once, naming both, when neither the logs nor the screenshots went', async () => {
    runAgent.mockResolvedValue(
      doneWith({ category: 'bug', logsAttached: false, screenshotsAttached: 0 }),
    )
    open()
    await pick(['/shots/wall.png'])
    await submitIssue(true)

    expect(toastWarning).toHaveBeenCalledExactlyOnceWith(
      'your issue was sent, but the logs and screenshots could not be attached',
      { description: 'try again, or send them another way.' },
    )
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('locks the screenshots while sending', async () => {
    runAgent.mockReturnValue(new Promise(() => {}))
    open()
    await pick(['/shots/wall.png'])
    await submitIssue(false)

    expect(
      (screen.getByRole('button', { name: 'add screenshots' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'remove screenshot' }) as HTMLButtonElement).disabled,
    ).toBe(true)

    pasteImage()
    await settle()
    expect(stageFromBytes).not.toHaveBeenCalled()
  })

  it('keeps the screenshots when the send fails, so a retry sends them', async () => {
    runAgent.mockRejectedValueOnce(new Error('owlette is not connected to a site'))
    const onClose = vi.fn()
    const view = render(<ReportIssueDialog open onClose={onClose} />)
    await pick(['/shots/wall.png'])
    await submitIssue(false)

    expect(screen.getByTestId('report-error')).toBeTruthy()
    expect(thumbnails()).toHaveLength(1)
    expect(discard).not.toHaveBeenCalled()

    runAgent.mockResolvedValueOnce(doneWith({ category: 'bug', screenshotsAttached: 1 }))
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))
    await flush()

    expect(runAgent).toHaveBeenCalledTimes(2)
    expect(runAgent.mock.calls[1][1].payload.screenshots).toEqual(['id-wall.png'])
    expect(onClose).toHaveBeenCalledOnce()
    view.rerender(<ReportIssueDialog open={false} onClose={onClose} />)
    // sent the second time, so the agent owns them now
    expect(discard).not.toHaveBeenCalled()
  })

  it('discards the screenshots kept from a failed send when it is cancelled', async () => {
    runAgent.mockRejectedValueOnce(new Error('owlette is not connected to a site'))
    const onClose = vi.fn()
    const view = render(<ReportIssueDialog open onClose={onClose} />)
    await pick(['/shots/wall.png'])
    await submitIssue(false)

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    view.rerender(<ReportIssueDialog open={false} onClose={onClose} />)

    expect(discard).toHaveBeenCalledExactlyOnceWith(['id-wall.png'])
  })

  it('warns when only some of the screenshots could be attached', async () => {
    runAgent.mockResolvedValue(doneWith({ category: 'bug', screenshotsAttached: 1 }))
    const props = open()
    await pick(['/shots/wall.png', '/shots/lobby.jpg', '/shots/desk.png'])
    await submitIssue(false)

    expect(toastWarning).toHaveBeenCalledExactlyOnceWith(
      'your issue was sent, but only 1 of 3 screenshots could be attached',
      { description: 'try again, or send them another way.' },
    )
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalledOnce()
  })
})
