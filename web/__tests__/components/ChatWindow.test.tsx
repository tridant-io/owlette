/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * ChatWindow — "edit & resend" on a user message: the pencil opens a box holding
 * the message, the caret waits after the text, Enter, Shift+Enter and Escape keep
 * their meanings, and the box grows with its text. jsdom lays nothing out, so the
 * growth runs against modelled metrics, and that the box's column spans the whole
 * row is not asserted at all.
 *
 * Also how a Claude 5 reply renders: "thinking..." while it holds only thinking, a
 * notice when it finishes empty, and a note (not a tool card) for an advisor call.
 *
 * And the OWL-47 approval gate: a live turn disarms approve/deny, because the
 * persisted `approval-requested` part outlives the resume that is already running.
 *
 * And per-turn targets: each assistant turn is labelled from its own stamped
 * `metadata.hoot`, not from the header selector, and a turn that moved to other
 * machines says so.
 *
 * And what a screen reader hears — "thinking" and an awaited approval in a status
 * region, a reply once its turn ends — and the pasted-image lightbox's focus.
 *
 * And the empty chat's suggestions, which fill the composer, so they go when the
 * plan leaves hoot out and there is no composer.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChatWindow } from '@/app/hoot/components/ChatWindow';
import { MAX_TARGET_MACHINES } from '@/lib/hoot/target';

// react-markdown 10 is ESM-only and jest leaves node_modules untransformed, so
// the real renderer cannot load under this runtime. Markdown is not on trial.
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: string }) => children ?? null,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'op-uid', email: 'op@example.com', displayName: 'op' } }),
}));

// The window keeps itself scrolled to the newest message; jsdom has no layout.
window.HTMLElement.prototype.scrollIntoView = jest.fn();

const USER_TEXT = 'Run the PowerShell command hostname on this machine using the run_powershell tool.';

type Part = UIMessage['parts'][number];

function msg(id: string, role: UIMessage['role'], parts: unknown[]): UIMessage {
  return { id, role, parts: parts as Part[] } as UIMessage;
}

const MESSAGES: UIMessage[] = [
  msg('u1', 'user', [{ type: 'text', text: USER_TEXT }]),
  msg('a1', 'assistant', [{ type: 'text', text: 'the hostname is STUDIO-01.' }]),
];

function renderChat(overrides: Partial<React.ComponentProps<typeof ChatWindow>> = {}) {
  const onEditMessage = jest.fn();
  const user = userEvent.setup();
  const view = render(
    <TooltipProvider>
      <ChatWindow messages={MESSAGES} isLoading={false} onEditMessage={onEditMessage} {...overrides} />
    </TooltipProvider>,
  );
  return { user, onEditMessage, ...view };
}

async function openEdit() {
  const rendered = renderChat();
  await rendered.user.click(screen.getByRole('button', { name: 'edit message' }));
  const box = screen.getByRole('textbox', { name: 'edit message' }) as HTMLTextAreaElement;
  return { ...rendered, box };
}

describe('ChatWindow edit & resend', () => {
  it('opens a focused box holding the message, with the caret after the text', async () => {
    const { box } = await openEdit();

    expect(box).toHaveValue(USER_TEXT);
    expect(box).toHaveFocus();
    expect(box.selectionStart).toBe(USER_TEXT.length);
    expect(box.selectionEnd).toBe(USER_TEXT.length);
    // The pencil steps aside while its message is being edited.
    expect(screen.queryByRole('button', { name: 'edit message' })).toBeNull();
  });

  it('types where the caret waits — after the text, not before it', async () => {
    const { user, box } = await openEdit();

    await user.keyboard(' now');
    expect(box).toHaveValue(`${USER_TEXT} now`);
  });

  it('sends the trimmed text on Enter and closes the box', async () => {
    const { user, box, onEditMessage } = await openEdit();

    await user.clear(box);
    await user.type(box, '  run hostname again  ');
    await user.keyboard('{Enter}');

    expect(onEditMessage).toHaveBeenCalledTimes(1);
    expect(onEditMessage).toHaveBeenCalledWith('u1', 'run hostname again');
    expect(screen.queryByRole('textbox', { name: 'edit message' })).toBeNull();
  });

  it('inserts a newline on Shift+Enter instead of sending', async () => {
    const { user, box, onEditMessage } = await openEdit();

    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(onEditMessage).not.toHaveBeenCalled();
    expect(box).toBeInTheDocument();
    expect(box).toHaveValue(`${USER_TEXT}\n`);
  });

  it('cancels on Escape without sending, and puts the message back', async () => {
    const { user, onEditMessage } = await openEdit();

    await user.keyboard('{Escape}');

    expect(onEditMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'edit message' })).toBeNull();
    expect(screen.getByText(USER_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'edit message' })).toBeInTheDocument();
  });

  it('cancels from the cancel button without sending', async () => {
    const { user, onEditMessage } = await openEdit();

    await user.click(screen.getByRole('button', { name: 'cancel' }));

    expect(onEditMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'edit message' })).toBeNull();
  });

  it('sends the trimmed text from the save & resend button', async () => {
    const { user, box, onEditMessage } = await openEdit();

    await user.type(box, '   ');
    await user.click(screen.getByRole('button', { name: 'save & resend' }));

    expect(onEditMessage).toHaveBeenCalledWith('u1', USER_TEXT);
  });

  it('will not send whitespace-only text, by button or by Enter', async () => {
    const { user, box, onEditMessage } = await openEdit();
    const save = screen.getByRole('button', { name: 'save & resend' });
    expect(save).toBeEnabled();

    await user.clear(box);
    await user.type(box, '   ');
    expect(save).toBeDisabled();

    await user.keyboard('{Enter}');
    expect(onEditMessage).not.toHaveBeenCalled();
    expect(box).toBeInTheDocument();

    await user.type(box, 'x');
    expect(save).toBeEnabled();
  });

  describe('the box height', () => {
    // A 24px line, 12px of padding above and below, a 3-row floor, and a 1px
    // border that offsetHeight counts and clientHeight does not.
    const LINE_PX = 24;
    const PAD_PX = 24;
    const BORDER_PX = 2;
    const heightFor = (lines: number) => `${Math.max(3, lines) * LINE_PX + PAD_PX + BORDER_PX}px`;

    // Runs on a measuring read taken with the box collapsed, which is when a
    // browser lays the conversation out one box-growth shorter.
    let onCollapsedMeasure: (() => void) | undefined;

    beforeEach(() => {
      Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
        configurable: true,
        get(this: HTMLTextAreaElement) {
          const content = Math.max(3, this.value.split('\n').length) * LINE_PX + PAD_PX;
          const height = parseFloat(this.style.height);
          if (Number.isNaN(height)) {
            onCollapsedMeasure?.();
            return content;
          }
          // A box already taller than its text measures its own inner height,
          // so one that is not collapsed first can never shrink.
          return Math.max(content, height - BORDER_PX);
        },
      });
      Object.defineProperty(HTMLTextAreaElement.prototype, 'offsetHeight', {
        configurable: true,
        get(this: HTMLTextAreaElement) {
          return this.clientHeight + BORDER_PX;
        },
      });
    });

    afterEach(() => {
      onCollapsedMeasure = undefined;
      Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'scrollHeight');
      Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'offsetHeight');
    });

    it('opens at its text height, borders included', async () => {
      const { box } = await openEdit();
      expect(box.style.height).toBe(heightFor(1));
    });

    it('grows with each new line and shrinks when they go', async () => {
      const { user, box } = await openEdit();

      await user.keyboard('{Shift>}{Enter}{Enter}{Enter}{Enter}{/Shift}');
      expect(box.style.height).toBe(heightFor(5));

      await user.keyboard('{Backspace}{Backspace}{Backspace}{Backspace}');
      expect(box.style.height).toBe(heightFor(1));
    });

    it('leaves the conversation where it was while it measures', async () => {
      const { user, box } = await openEdit();
      // The chat's scroll container, resting at its bottom: the collapse
      // costs it two rows of travel for that layout.
      const scroller = box.closest('.overflow-y-auto') as HTMLElement;
      scroller.scrollTop = 600;
      onCollapsedMeasure = () => {
        scroller.scrollTop = Math.min(scroller.scrollTop, 600 - 2 * LINE_PX);
      };

      await user.keyboard('x');

      expect(scroller.scrollTop).toBe(600);
    });
  });

  describe('the pencil', () => {
    it('is offered on user messages only', () => {
      renderChat();
      expect(screen.getAllByRole('button', { name: 'edit message' })).toHaveLength(1);
    });

    it('is hidden while a response streams', () => {
      renderChat({ isLoading: true });
      expect(screen.queryByRole('button', { name: 'edit message' })).toBeNull();
    });

    it('is hidden when the view cannot edit', () => {
      renderChat({ onEditMessage: undefined });
      expect(screen.queryByRole('button', { name: 'edit message' })).toBeNull();
    });
  });
});

describe('ChatWindow — the tier-3 approval gate (OWL-47)', () => {
  const ASK = msg('u1', 'user', [{ type: 'text', text: 'restart the render node' }]);
  const PENDING = {
    type: 'tool-run_powershell',
    toolCallId: 'tc1',
    state: 'approval-requested',
    input: { command: 'hostname' },
    approval: { id: 'ap1' },
  };
  const waiting = [ASK, msg('a1', 'assistant', [PENDING])];

  it('arms approve/deny while no turn is running', () => {
    renderChat({ onToolApproval: jest.fn(), messages: waiting });

    expect(screen.getByRole('button', { name: 'approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'deny' })).toBeInTheDocument();
  });

  it('disarms them while the turn runs on, and still draws the card', () => {
    // A reload mid-resume: the persisted part still reads approval-requested
    // although the approved tool is already executing server-side, so re-arming
    // the buttons would let the same call be approved twice.
    renderChat({ onToolApproval: jest.fn(), turnRunning: true, messages: waiting });

    expect(screen.queryByRole('button', { name: 'approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'deny' })).toBeNull();
    expect(screen.queryByText(/approve to continue/)).toBeNull();
    expect(screen.getByRole('button', { name: /run_powershell/ })).toBeInTheDocument();
  });
});

describe('ChatWindow — per-turn target labels', () => {
  const ASK = msg('u1', 'user', [{ type: 'text', text: 'restart the render node' }]);
  const ASK_AGAIN = msg('u2', 'user', [{ type: 'text', text: 'and again' }]);
  const PENDING = {
    type: 'tool-run_powershell',
    toolCallId: 'tc1',
    state: 'approval-requested',
    input: { command: 'hostname' },
    approval: { id: 'ap1' },
  };
  const REPLIED = { type: 'text', text: 'done.' };

  /** An assistant turn the server stamped with the machines it resolved to. */
  function turn(
    id: string,
    machineIds: unknown,
    opts: { via?: string; parts?: unknown[] } = {},
  ): UIMessage {
    return {
      ...msg(id, 'assistant', opts.parts ?? [PENDING]),
      metadata: {
        hoot: {
          turnId: `turn-${id}`,
          machineIds,
          via: opts.via ?? 'chat',
          skipped: { offline: [], disabled: [] },
        },
      },
    } as UIMessage;
  }

  function approvalLine() {
    return screen.getByText(/hoot wants to run the privileged/);
  }

  it("names the turn's machines, not the machine the header is showing", () => {
    // The pre-existing bug: a site-wide chat reopened with one machine ticked
    // asked to approve "on kiosk-09", the selector's machine.
    renderChat({
      onToolApproval: jest.fn(),
      approvalTargetLabel: 'kiosk-09',
      messages: [ASK, turn('a1', ['kiosk-01', 'kiosk-02', 'kiosk-03'])],
    });

    expect(approvalLine()).toHaveTextContent('on 3 machines: kiosk-01, kiosk-02, kiosk-03.');
    expect(screen.queryByText(/kiosk-09/)).toBeNull();
  });

  it('names the mentioned machine on a turn an @mention narrowed', () => {
    renderChat({
      onToolApproval: jest.fn(),
      approvalTargetLabel: 'all machines',
      messages: [ASK, turn('a1', ['kiosk-07'], { via: 'mention' })],
    });

    expect(approvalLine()).toHaveTextContent('on kiosk-07.');
    expect(screen.queryByText(/all machines/)).toBeNull();
  });

  it('falls back to the header label on a chat written before per-turn targeting', () => {
    renderChat({
      onToolApproval: jest.fn(),
      approvalTargetLabel: 'all machines',
      messages: [ASK, msg('a1', 'assistant', [PENDING])],
    });

    expect(approvalLine()).toHaveTextContent('on all machines.');
  });

  it('names nothing, not the header label, when a stamp does not validate', () => {
    // The client re-sends assistant messages verbatim, so this blob is untrusted:
    // a machine id that could not be a document id reads as no metadata at all.
    // The header label is NOT the answer — it follows the live selector, which a
    // loaded chat can have pointed anywhere.
    renderChat({
      onToolApproval: jest.fn(),
      approvalTargetLabel: 'all machines',
      messages: [ASK, turn('a1', ['kiosk-01/../secrets'])],
    });

    expect(approvalLine()).toHaveTextContent('hoot wants to run the privileged run_powershell tool.');
    expect(screen.queryByText(/all machines/)).toBeNull();
  });

  it('names nothing on a site-wide turn whose list is past the reader cap', () => {
    // `readHootTurnMetadata` rejects a list longer than MAX_TARGET_MACHINES, and
    // a site-wide turn on a site that big stamps one — the biggest blast radius
    // there is, so borrowing "kiosk-09" from the header would be at its worst.
    const wholeFleet = Array.from({ length: MAX_TARGET_MACHINES + 1 }, (_, i) => `kiosk-${i + 1}`);
    renderChat({
      onToolApproval: jest.fn(),
      approvalTargetLabel: 'kiosk-09',
      messages: [ASK, turn('a1', wholeFleet)],
    });

    expect(approvalLine()).toHaveTextContent('hoot wants to run the privileged run_powershell tool.');
    expect(screen.queryByText(/kiosk-09/)).toBeNull();
  });

  it('keeps approve/deny disarmed while the turn runs on (OWL-47)', () => {
    renderChat({
      onToolApproval: jest.fn(),
      turnRunning: true,
      approvalTargetLabel: 'kiosk-09',
      messages: [ASK, turn('a1', ['kiosk-01'])],
    });

    expect(screen.queryByRole('button', { name: 'approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'deny' })).toBeNull();
  });

  describe('the retarget caption', () => {
    it('notes a turn that moved, and leaves the first one alone', () => {
      renderChat({
        messages: [
          ASK,
          turn('a1', ['kiosk-01'], { parts: [REPLIED] }),
          ASK_AGAIN,
          turn('a2', ['kiosk-02'], { parts: [REPLIED] }),
        ],
      });

      const captions = screen.getAllByText(/targets changed/);
      expect(captions).toHaveLength(1);
      expect(captions[0]).toHaveTextContent('targets changed — kiosk-02');
    });

    it('says nothing while the target holds steady', () => {
      renderChat({
        messages: [
          ASK,
          turn('a1', ['kiosk-01'], { parts: [REPLIED] }),
          ASK_AGAIN,
          turn('a2', ['kiosk-01'], { parts: [REPLIED] }),
        ],
      });

      expect(screen.queryByText(/targets changed/)).toBeNull();
    });

    it('is not fooled by the resolver returning the same set in another order', () => {
      renderChat({
        messages: [
          ASK,
          turn('a1', ['kiosk-01', 'kiosk-02'], { parts: [REPLIED] }),
          ASK_AGAIN,
          turn('a2', ['kiosk-02', 'kiosk-01'], { parts: [REPLIED] }),
        ],
      });

      expect(screen.queryByText(/targets changed/)).toBeNull();
    });

    it('stays quiet on a chat with nothing stamped', () => {
      renderChat({ messages: MESSAGES });

      expect(screen.queryByText(/targets changed/)).toBeNull();
    });
  });
});

describe('ChatWindow — a Claude 5 reply', () => {
  const ASK = msg('u1', 'user', [{ type: 'text', text: 'why is the render node slow?' }]);
  // Sonnet 5 and Opus 5 omit thinking text by default: the part holds only a signature.
  const THINKING = { type: 'reasoning', text: '', state: 'done' };
  const ANSWER = { type: 'text', text: 'the gpu is pinned at 100%.' };

  it('keeps "thinking..." up while the reply holds only thinking', () => {
    renderChat({ isLoading: true, messages: [ASK, msg('a1', 'assistant', [{ type: 'step-start' }, THINKING])] });

    expect(screen.getByText('thinking...')).toBeInTheDocument();
    expect(screen.queryByText(/no reply came back/)).toBeNull();
  });

  it('drops "thinking..." once the reply has text', () => {
    renderChat({ isLoading: true, messages: [ASK, msg('a1', 'assistant', [THINKING, ANSWER])] });

    expect(screen.queryByText('thinking...')).toBeNull();
    expect(screen.getByText(ANSWER.text)).toBeInTheDocument();
  });

  it('says so when a finished reply came back empty', () => {
    renderChat({ messages: [ASK, msg('a1', 'assistant', [{ type: 'step-start' }, THINKING])] });

    expect(screen.getByText(/no reply came back/)).toBeInTheDocument();
    expect(screen.queryByText('thinking...')).toBeNull();
  });

  it('keeps "thinking..." up after a reload while the turn is still live', () => {
    // A reloaded tab isn't streaming; the stream doc says the turn runs on.
    renderChat({ turnRunning: true, messages: [ASK, msg('a1', 'assistant', [THINKING])] });

    expect(screen.getByText('thinking...')).toBeInTheDocument();
    expect(screen.queryByText(/no reply came back/)).toBeNull();
  });

  it('leaves an interrupted empty reply to the interrupted notice', () => {
    // As useHoot reports a dead runner: the stream doc still says running, gone stale.
    renderChat({ turnRunning: true, turnStale: true, messages: [ASK, msg('a1', 'assistant', [THINKING])] });

    expect(screen.getByText(/this turn was interrupted/)).toBeInTheDocument();
    expect(screen.queryByText('thinking...')).toBeNull();
    expect(screen.queryByText(/no reply came back/)).toBeNull();
  });

  it('leaves a failed turn to the error banner', () => {
    // The provider call failed after the reply began, leaving an empty assistant message.
    renderChat({ turnErrored: true, messages: [ASK, msg('a1', 'assistant', [{ type: 'step-start' }])] });

    expect(screen.queryByText(/no reply came back/)).toBeNull();
    expect(screen.queryByText('thinking...')).toBeNull();
  });

  it('notes an advisor consultation instead of drawing a tool card', () => {
    const advisor = {
      type: 'tool-advisor',
      toolCallId: 'adv1',
      state: 'output-available',
      input: {},
      output: { type: 'advisor_redacted_result', encryptedContent: 'opaque' },
      providerExecuted: true,
    };
    renderChat({ messages: [ASK, msg('a1', 'assistant', [advisor, ANSWER])] });

    expect(screen.getByText('consulted Claude Opus 5')).toBeInTheDocument();
    expect(screen.queryByText(/advisor/i)).toBeNull();
  });

  it('notes a consultation that failed', () => {
    const advisor = {
      type: 'tool-advisor',
      toolCallId: 'adv1',
      state: 'output-error',
      input: {},
      errorText: JSON.stringify({ type: 'advisor_tool_result_error', errorCode: 'overloaded' }),
      providerExecuted: true,
    };
    renderChat({ messages: [ASK, msg('a1', 'assistant', [advisor, ANSWER])] });

    expect(screen.getByText("couldn't consult Claude Opus 5")).toBeInTheDocument();
  });

  it('marks a consultation cut off before its result', () => {
    // A stop or a provider error ended the turn while Opus 5 was still being consulted.
    const advisor = {
      type: 'tool-advisor',
      toolCallId: 'adv1',
      state: 'input-available',
      input: {},
      providerExecuted: true,
    };
    renderChat({ messages: [ASK, msg('a1', 'assistant', [advisor])] });

    expect(screen.getByText("couldn't consult Claude Opus 5")).toBeInTheDocument();
    expect(screen.queryByText(/consulting/)).toBeNull();
  });

  it('shows a consultation in progress in place of "thinking..."', () => {
    const advisor = {
      type: 'tool-advisor',
      toolCallId: 'adv1',
      state: 'input-available',
      input: {},
      providerExecuted: true,
    };
    renderChat({ isLoading: true, messages: [ASK, msg('a1', 'assistant', [advisor])] });

    expect(screen.getByText('consulting Claude Opus 5...')).toBeInTheDocument();
    expect(screen.queryByText('thinking...')).toBeNull();
  });
});

describe('ChatWindow — what a screen reader hears', () => {
  const ASK = msg('u1', 'user', [{ type: 'text', text: 'why is the render node slow?' }]);
  const PARTIAL = msg('a1', 'assistant', [{ type: 'text', text: 'the gpu' }]);
  const DONE = msg('a1', 'assistant', [{ type: 'text', text: 'the gpu is pinned at 100%.' }]);

  function rerenderChat(view: ReturnType<typeof renderChat>, props: Partial<React.ComponentProps<typeof ChatWindow>>) {
    view.rerender(
      <TooltipProvider>
        <ChatWindow messages={MESSAGES} isLoading={false} {...props} />
      </TooltipProvider>,
    );
  }

  it('says hoot is thinking in a status region while the reply has nothing to show', () => {
    renderChat({ isLoading: true, messages: [ASK] });

    expect(screen.getByRole('status')).toHaveTextContent('hoot is thinking');
  });

  it('keeps the regions mounted through the empty state, so the first turn is heard', () => {
    const view = renderChat({ messages: [] });
    const status = screen.getByRole('status');
    const log = screen.getByRole('log', { name: 'hoot replies' });

    rerenderChat(view, { isLoading: true, messages: [ASK] });

    // the same nodes: a live region that arrives with its text is not announced.
    expect(screen.getByRole('status')).toBe(status);
    expect(screen.getByRole('log', { name: 'hoot replies' })).toBe(log);
    expect(status).toHaveTextContent('hoot is thinking');
  });

  it('reads the reply out once its turn ends, not token by token', () => {
    const view = renderChat({ isLoading: true, messages: [ASK, PARTIAL] });
    const log = screen.getByRole('log', { name: 'hoot replies' });
    expect(log).toBeEmptyDOMElement();

    rerenderChat(view, { isLoading: false, messages: [ASK, DONE] });

    expect(log).toHaveTextContent('hoot replied: the gpu is pinned at 100%.');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('drops the markdown that only styles the reply, and keeps a command pipe', () => {
    const styled = msg('a1', 'assistant', [
      { type: 'text', text: '## cause\n**the gpu** is pinned:\n```powershell\nGet-Process | Sort-Object CPU\n```' },
    ]);
    const view = renderChat({ isLoading: true, messages: [ASK, PARTIAL] });

    rerenderChat(view, { isLoading: false, messages: [ASK, styled] });

    expect(screen.getByRole('log', { name: 'hoot replies' })).toHaveTextContent(
      'hoot replied: cause the gpu is pinned: Get-Process | Sort-Object CPU',
    );
  });

  it('stays quiet about replies that were already there when the chat opened', () => {
    renderChat({ messages: [ASK, DONE] });

    expect(screen.getByRole('log', { name: 'hoot replies' })).toBeEmptyDOMElement();
  });

  it('does not read out a reply whose turn failed — the error banner speaks for it', () => {
    const view = renderChat({ isLoading: true, messages: [ASK, PARTIAL] });

    rerenderChat(view, { isLoading: false, turnErrored: true, messages: [ASK, PARTIAL] });

    expect(screen.getByRole('log', { name: 'hoot replies' })).toBeEmptyDOMElement();
  });

  it('says when hoot is waiting on an approval', () => {
    const pending = {
      type: 'tool-run_powershell',
      toolCallId: 'tc1',
      state: 'approval-requested',
      input: { command: 'hostname' },
      approval: { id: 'ap1' },
    };
    renderChat({ onToolApproval: jest.fn(), messages: [ASK, msg('a1', 'assistant', [pending])] });

    expect(screen.getByRole('status')).toHaveTextContent('hoot needs your approval to run run_powershell');
  });
});

describe('ChatWindow — a pasted image', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const WITH_IMAGE = [
    msg('u1', 'user', [
      { type: 'text', text: 'what is on this screen?' },
      { type: 'file', mediaType: 'image/png', url: PNG },
    ]),
  ];

  it('opens from a named button into a modal dialog that takes focus', async () => {
    const { user } = renderChat({ messages: WITH_IMAGE });

    await user.click(screen.getByRole('button', { name: 'view pasted image' }));

    const dialog = screen.getByRole('dialog', { name: 'pasted image' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'close image' })).toHaveFocus();
  });

  it('closes on Escape and hands focus back to the thumbnail', async () => {
    const { user } = renderChat({ messages: WITH_IMAGE });
    const thumbnail = screen.getByRole('button', { name: 'view pasted image' });

    await user.click(thumbnail);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(thumbnail).toHaveFocus();
  });

  it('closes from its close button', async () => {
    const { user } = renderChat({ messages: WITH_IMAGE });

    await user.click(screen.getByRole('button', { name: 'view pasted image' }));
    await user.click(screen.getByRole('button', { name: 'close image' }));

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('ChatWindow — the empty chat', () => {
  it('offers suggestions to fill the composer', () => {
    renderChat({ messages: [] });

    expect(screen.getByRole('heading', { name: 'hoot' })).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  it('drops them when there is no composer to fill', () => {
    renderChat({ messages: [], hideSuggestions: true });

    expect(screen.getByRole('heading', { name: 'hoot' })).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
