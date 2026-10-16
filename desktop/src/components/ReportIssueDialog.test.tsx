import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runAgent = vi.fn()
const toastSuccess = vi.fn()
const toastWarning = vi.fn()
const pickFiles = vi.fn()
const stageFromPath = vi.fn()
const stageFromBytes = vi.fn()
const stageVideo = vi.fn()
const discard = vi.fn()

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

vi.mock('@/lib/agentCli', () => ({ runAgent: (...args: unknown[]) => runAgent(...args) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...args: unknown[]) => pickFiles(...args) }))
vi.mock('@/lib/issueAttachments', () => ({
  MAX_SCREENSHOTS: 10,
  MAX_VIDEOS: 20,
  MAX_ATTACHMENT_BYTES: 100 * 1024 * 1024,
  IMAGE_EXTENSIONS: ['png', 'jpg', 'jpeg', 'webp'],
  VIDEO_EXTENSIONS: ['mp4', 'mov', 'webm'],
  isVideo: (attachment: object) => 'name' in attachment,
  usedBytes: (attachments: { size: number }[]) => attachments.reduce((sum, a) => sum + a.size, 0),
  stageScreenshotFromPath: (...args: unknown[]) => stageFromPath(...args),
  stageScreenshotFromBytes: (...args: unknown[]) => stageFromBytes(...args),
  stageVideoFromPath: (...args: unknown[]) => stageVideo(...args),
  discardAttachments: (...args: unknown[]) => discard(...args),
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

function staged(id: string, size = 3) {
  return { id, size, kind: 'png', preview: `data:image/png;base64,${id}` }
}

// the mocked host names a staged file after the picked one, so tests can follow it
function idFor(path: string) {
  return `id-${path.split('/').pop()}`
}

// 5.3 MB, named as the host names it: the picked file's own name
function stagedVideo(path: string, size = 5_557_453) {
  return { id: idFor(path), size, kind: 'mp4', name: path.split('/').pop() }
}

// settles the picker, the staging and the state they land in
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function addButton() {
  return screen.getByRole('button', { name: 'add screenshots or video' }) as HTMLButtonElement
}

async function pick(paths: string[] | string | null) {
  pickFiles.mockResolvedValueOnce(paths)
  fireEvent.click(addButton())
  await settle()
}

function videoTiles() {
  return screen.queryAllByTestId('report-video')
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
  return screen.queryAllByRole('img', { name: /^screenshot \d+$/ })
}

function limitText() {
  return screen.getByTestId('report-attachment-limit').textContent
}

function notice() {
  return screen.getByTestId('report-attachment-notice').textContent
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
  stageVideo.mockReset().mockImplementation(async (path: string) => stagedVideo(path))
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
        videos: [],
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
        videos: [],
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

  it('shows the upload progress line, the latest one only', async () => {
    const run = holdRun()
    open()
    await submitIssue(true)

    run.emit('uploading attachments')
    run.emit('uploading attachments (42%)')
    expect(screen.getByTestId('report-status').textContent).toBe('uploading attachments (42%)')

    run.emit('uploading attachments (47%)')
    expect(screen.getByTestId('report-status').textContent).toBe('uploading attachments (47%)')
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

describe('ReportIssueDialog attachments', () => {
  it('takes screenshots and videos from one button, beside its limit', async () => {
    open()
    expect(limitText()).toBe('up to 100 MB, or paste an image')

    await pick(['/shots/wall.png', '/clips/glitch.mp4', '/shots/lobby.JPG'])

    expect(pickFiles).toHaveBeenCalledExactlyOnceWith({
      multiple: true,
      filters: [
        { name: 'screenshots and videos', extensions: ['png', 'jpg', 'jpeg', 'webp', 'mp4', 'mov', 'webm'] },
      ],
    })
    expect(stageFromPath.mock.calls).toEqual([['/shots/wall.png'], ['/shots/lobby.JPG']])
    expect(stageVideo).toHaveBeenCalledExactlyOnceWith('/clips/glitch.mp4', MAX_ATTACHMENT_BYTES - 3)
    expect(thumbnails().map((img) => img.getAttribute('src'))).toEqual([
      'data:image/png;base64,id-wall.png',
      'data:image/png;base64,id-lobby.JPG',
    ])
    // screenshots are numbered on their own, past the video between them
    expect(thumbnails().map((img) => img.getAttribute('alt'))).toEqual(['screenshot 1', 'screenshot 2'])
    expect(videoTiles().map((tile) => tile.textContent)).toEqual(['5.3 MB'])
    expect(videoTiles()[0].querySelector('[title="glitch.mp4"]')).toBeTruthy()
    expect(limitText()).toBe('5.3 of 100 MB used')
    expect(addButton().disabled).toBe(false)
  })

  it('stages nothing when the picker is dismissed', async () => {
    open()
    await pick(null)

    expect(stageFromPath).not.toHaveBeenCalled()
    expect(stageVideo).not.toHaveBeenCalled()
    expect(thumbnails()).toHaveLength(0)
  })

  it('discards what the operator removes', async () => {
    open()
    await pick(['/shots/wall.png', '/shots/lobby.jpg', '/clips/glitch.mp4'])

    fireEvent.click(screen.getAllByRole('button', { name: 'remove screenshot' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'remove glitch.mp4' }))

    expect(discard.mock.calls).toEqual([[['id-wall.png']], [['id-glitch.mp4']]])
    expect(thumbnails().map((img) => img.getAttribute('src'))).toEqual([
      'data:image/png;base64,id-lobby.jpg',
    ])
    expect(videoTiles()).toHaveLength(0)
    expect(limitText()).toBe('0.1 of 100 MB used')
  })

  it('stops at ten screenshots and says so, and still takes videos', async () => {
    open()
    await pick(Array.from({ length: 6 }, (_, i) => `/s/${i + 1}.png`))
    await pick([...Array.from({ length: 6 }, (_, i) => `/s/${i + 7}.png`), '/clips/glitch.mp4'])

    expect(stageFromPath).toHaveBeenCalledTimes(10)
    expect(stageFromPath).not.toHaveBeenCalledWith('/s/11.png')
    expect(thumbnails()).toHaveLength(10)
    expect(videoTiles()).toHaveLength(1)
    expect(notice()).toBe('up to 10 screenshots per issue')
    expect(addButton().disabled).toBe(false)

    // a paste at the limit is refused the same way, without staging
    pasteImage()
    await settle()
    expect(stageFromBytes).not.toHaveBeenCalled()
    expect(thumbnails()).toHaveLength(10)
  })

  it('stops at twenty videos', async () => {
    stageVideo.mockImplementation(async (path: string) => stagedVideo(path, 1000))
    open()
    await pick(Array.from({ length: 21 }, (_, i) => `/clips/${i + 1}.mov`))

    expect(stageVideo).toHaveBeenCalledTimes(20)
    expect(videoTiles()).toHaveLength(20)
    expect(notice()).toBe('up to 20 videos per issue')
  })

  it('gives each video the room the attachments before it left', async () => {
    open()
    await pick(['/shots/wall.png', '/clips/a.mp4', '/clips/b.webm'])

    expect(stageVideo.mock.calls).toEqual([
      ['/clips/a.mp4', MAX_ATTACHMENT_BYTES - 3],
      ['/clips/b.webm', MAX_ATTACHMENT_BYTES - 3 - 5_557_453],
    ])
  })

  it('names a video the host refuses for want of room, and keeps the rest', async () => {
    stageVideo.mockImplementation(async (path: string) => {
      if (path.endsWith('huge.mp4')) throw 'attachments must total 100 MB or less'
      return stagedVideo(path)
    })
    open()
    await pick(['/clips/huge.mp4', '/clips/glitch.mp4'])

    expect(notice()).toBe('huge.mp4: attachments must total 100 MB or less')
    expect(videoTiles()).toHaveLength(1)
  })

  it('discards a screenshot that lands past the room left', async () => {
    stageVideo.mockImplementation(async (path: string) => stagedVideo(path, MAX_ATTACHMENT_BYTES - 2))
    open()
    await pick(['/clips/long.mp4', '/shots/wall.png'])

    expect(discard).toHaveBeenCalledExactlyOnceWith(['id-wall.png'])
    expect(thumbnails()).toHaveLength(0)
    expect(notice()).toBe('wall.png: attachments must total 100 MB or less')
  })

  it('names a refused file and keeps the rest', async () => {
    stageFromPath.mockImplementation(async (path: string) => {
      if (path.endsWith('.txt')) throw 'only png, jpeg or webp images'
      return staged(idFor(path))
    })
    open()
    await pick(['/shots/wall.png', '/shots/notes.txt', '/shots/lobby.jpg'])

    expect(thumbnails()).toHaveLength(2)
    expect(notice()).toBe('notes.txt: only png, jpeg or webp images')
  })

  it('names a picked windows path by its file name', async () => {
    stageVideo.mockRejectedValue('only mp4, mov or webm videos')
    open()
    await pick(['C:\\Users\\op\\Videos\\wall.mp4'])

    expect(stageVideo).toHaveBeenCalledWith('C:\\Users\\op\\Videos\\wall.mp4', MAX_ATTACHMENT_BYTES)
    expect(notice()).toBe('wall.mp4: only mp4, mov or webm videos')
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

  it('spins in the add button while files stage, and holds the submit', async () => {
    let land: (value: unknown) => void = () => {}
    stageVideo.mockReturnValue(new Promise((resolve) => (land = resolve)))
    open()
    describeIssue('swoop froze on the lobby wall')
    await pick(['/clips/glitch.mp4'])

    expect(addButton().disabled).toBe(true)
    expect(addButton().contains(screen.getByTestId('report-attachment-spinner'))).toBe(true)
    expect((screen.getByRole('button', { name: 'submit' }) as HTMLButtonElement).disabled).toBe(true)

    land(stagedVideo('/clips/glitch.mp4'))
    await settle()

    expect(screen.queryByTestId('report-attachment-spinner')).toBeNull()
    expect(videoTiles()).toHaveLength(1)
    expect((screen.getByRole('button', { name: 'submit' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('sends the staged ids by kind, in the order they were added', async () => {
    open()
    await pick(['/shots/wall.png', '/clips/a.mp4', '/shots/lobby.jpg', '/clips/b.mov'])
    pasteImage()
    await settle()
    await submitIssue(false)

    expect(runAgent).toHaveBeenCalledExactlyOnceWith('report-issue', {
      payload: {
        category: 'bug',
        description: 'swoop froze on the lobby wall',
        attachLogs: false,
        screenshots: ['id-wall.png', 'id-lobby.jpg', 'pasted.png'],
        videos: ['id-a.mp4', 'id-b.mov'],
      },
      onEvent: expect.any(Function),
    })
  })

  it('leaves sent attachments to the agent', async () => {
    runAgent.mockResolvedValue(doneWith({ category: 'bug', screenshotsAttached: 1, videosAttached: 1 }))
    const onClose = vi.fn()
    const view = render(<ReportIssueDialog open onClose={onClose} />)
    await pick(['/shots/wall.png', '/clips/glitch.mp4'])
    await submitIssue(false)
    view.rerender(<ReportIssueDialog open={false} onClose={onClose} />)

    expect(onClose).toHaveBeenCalledOnce()
    expect(toastSuccess).toHaveBeenCalledExactlyOnceWith('thanks — your issue was sent', {
      description: 'system info, the last lines of the service log, 1 screenshot and 1 video went with it.',
    })
    expect(toastWarning).not.toHaveBeenCalled()
    expect(discard).not.toHaveBeenCalled()
  })

  it('names the logs and every attachment that went', async () => {
    runAgent.mockResolvedValue(
      doneWith({ category: 'bug', logsAttached: true, screenshotsAttached: 2, videosAttached: 2 }),
    )
    render(<ReportIssueDialog open onClose={vi.fn()} />)
    await pick(['/shots/wall.png', '/shots/lobby.jpg', '/clips/a.mp4', '/clips/b.mp4'])
    await submitIssue(true)

    expect(toastSuccess).toHaveBeenCalledExactlyOnceWith('thanks — your issue was sent', {
      description: 'system info, the logs, 2 screenshots and 2 videos went with it.',
    })
  })

  it('discards staged attachments on cancel', async () => {
    const onClose = vi.fn()
    const view = render(<ReportIssueDialog open onClose={onClose} />)
    await pick(['/shots/wall.png', '/clips/glitch.mp4'])

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(onClose).toHaveBeenCalledOnce()
    view.rerender(<ReportIssueDialog open={false} onClose={onClose} />)

    expect(discard).toHaveBeenCalledExactlyOnceWith(['id-wall.png', 'id-glitch.mp4'])

    // reopening starts empty, and does not discard again
    view.rerender(<ReportIssueDialog open onClose={onClose} />)
    expect(thumbnails()).toHaveLength(0)
    expect(videoTiles()).toHaveLength(0)
    expect(limitText()).toBe('up to 100 MB, or paste an image')
    expect(discard).toHaveBeenCalledOnce()
  })

  it('discards staged attachments when it unmounts', async () => {
    const view = render(<ReportIssueDialog open onClose={vi.fn()} />)
    await pick(['/shots/wall.png', '/clips/glitch.mp4'])

    view.unmount()

    expect(discard).toHaveBeenCalledExactlyOnceWith(['id-wall.png', 'id-glitch.mp4'])
  })

  it('discards a staging that lands after the dialog closed, and stages no more', async () => {
    let land: (value: unknown) => void = () => {}
    stageVideo.mockReturnValueOnce(new Promise((resolve) => (land = resolve)))
    const onClose = vi.fn()
    const view = render(<ReportIssueDialog open onClose={onClose} />)
    await pick(['/clips/glitch.mp4', '/shots/wall.png'])

    view.rerender(<ReportIssueDialog open={false} onClose={onClose} />)
    land(stagedVideo('/clips/late.mp4'))
    await settle()
    view.rerender(<ReportIssueDialog open onClose={onClose} />)

    expect(discard).toHaveBeenCalledExactlyOnceWith(['id-late.mp4'])
    expect(stageFromPath).not.toHaveBeenCalled()
    expect(videoTiles()).toHaveLength(0)
    expect(screen.queryByTestId('report-attachment-spinner')).toBeNull()
  })

  it('locks the attachments while sending', async () => {
    runAgent.mockReturnValue(new Promise(() => {}))
    open()
    await pick(['/shots/wall.png', '/clips/glitch.mp4'])
    await submitIssue(false)

    expect(addButton().disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'remove screenshot' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: 'remove glitch.mp4' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    pasteImage()
    await settle()
    expect(stageFromBytes).not.toHaveBeenCalled()
  })

  it('keeps the attachments when the send fails, so a retry sends them', async () => {
    runAgent.mockRejectedValueOnce(new Error('owlette is not connected to a site'))
    const onClose = vi.fn()
    const view = render(<ReportIssueDialog open onClose={onClose} />)
    await pick(['/shots/wall.png', '/clips/glitch.mp4'])
    await submitIssue(false)

    expect(screen.getByTestId('report-error')).toBeTruthy()
    expect(thumbnails()).toHaveLength(1)
    expect(videoTiles()).toHaveLength(1)
    expect(discard).not.toHaveBeenCalled()

    runAgent.mockResolvedValueOnce(doneWith({ category: 'bug', screenshotsAttached: 1, videosAttached: 1 }))
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))
    await flush()

    expect(runAgent).toHaveBeenCalledTimes(2)
    expect(runAgent.mock.calls[1][1].payload.screenshots).toEqual(['id-wall.png'])
    expect(runAgent.mock.calls[1][1].payload.videos).toEqual(['id-glitch.mp4'])
    expect(onClose).toHaveBeenCalledOnce()
    view.rerender(<ReportIssueDialog open={false} onClose={onClose} />)
    // sent the second time, so the agent owns them now
    expect(discard).not.toHaveBeenCalled()
  })

  it('discards the attachments kept from a failed send when it is cancelled', async () => {
    runAgent.mockRejectedValueOnce(new Error('owlette is not connected to a site'))
    const onClose = vi.fn()
    const view = render(<ReportIssueDialog open onClose={onClose} />)
    await pick(['/shots/wall.png'])
    await submitIssue(false)

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    view.rerender(<ReportIssueDialog open={false} onClose={onClose} />)

    expect(discard).toHaveBeenCalledExactlyOnceWith(['id-wall.png'])
  })
})

describe('ReportIssueDialog attachments that did not go', () => {
  async function sendWith(paths: string[], done: Record<string, unknown>, withLogs = false) {
    runAgent.mockResolvedValue(doneWith({ category: 'bug', ...done }))
    const props = open()
    await pick(paths)
    await submitIssue(withLogs)
    return props
  }

  it('names the one screenshot that could not be attached', async () => {
    const props = await sendWith(['/shots/wall.png'], { screenshotsAttached: 0 })

    expect(toastWarning).toHaveBeenCalledExactlyOnceWith(
      'your issue was sent, but the screenshot could not be attached',
      { description: 'try again, or send it another way.' },
    )
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('counts the screenshots that could not be attached', async () => {
    await sendWith(['/s/1.png', '/s/2.png', '/s/3.png'], { screenshotsAttached: 1 })

    expect(toastWarning).toHaveBeenCalledExactlyOnceWith(
      'your issue was sent, but 2 of 3 screenshots could not be attached',
      { description: 'try again, or send them another way.' },
    )
  })

  it('says it when one of several videos could not be attached', async () => {
    await sendWith(['/clips/a.mp4', '/clips/b.mp4'], { videosAttached: 1 })

    expect(toastWarning).toHaveBeenCalledExactlyOnceWith(
      'your issue was sent, but 1 of 2 videos could not be attached',
      { description: 'try again, or send it another way.' },
    )
  })

  it('names every video when none could be attached', async () => {
    await sendWith(['/clips/a.mp4', '/clips/b.mp4'], { videosAttached: 0 })

    expect(toastWarning).toHaveBeenCalledExactlyOnceWith(
      'your issue was sent, but the 2 videos could not be attached',
      { description: 'try again, or send them another way.' },
    )
  })

  it('warns once, naming the logs and the attachments', async () => {
    await sendWith(
      ['/shots/wall.png', '/clips/glitch.mp4'],
      { logsAttached: false, screenshotsAttached: 0, videosAttached: 0 },
      true,
    )

    expect(toastWarning).toHaveBeenCalledExactlyOnceWith(
      'your issue was sent, but the logs, the screenshot and the video could not be attached',
      { description: 'try again, or send them another way.' },
    )
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('names the missing screenshots beside a video that did not go', async () => {
    await sendWith(['/s/1.png', '/s/2.png', '/s/3.png', '/clips/glitch.mp4'], {
      screenshotsAttached: 1,
      videosAttached: 0,
    })

    expect(toastWarning).toHaveBeenCalledExactlyOnceWith(
      'your issue was sent, but 2 of 3 screenshots and the video could not be attached',
      { description: 'try again, or send them another way.' },
    )
  })
})
