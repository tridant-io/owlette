import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runAgent = vi.fn()
const toastSuccess = vi.fn()
const toastWarning = vi.fn()

vi.mock('@/lib/agentCli', () => ({ runAgent: (...args: unknown[]) => runAgent(...args) }))
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
      payload: { category: 'bug', description: 'swoop froze on the lobby wall', attachLogs: true },
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
