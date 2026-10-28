/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * ToolCallCard — the inline card for one hoot tool call. Its expand toggle is a
 * Radix Collapsible trigger, so the input/output panel slides open and shut in
 * every state and tier. What is on trial here is the toggle contract: it says
 * whether it is open (aria-expanded + data-state), a collapsed card keeps the
 * payload out of the DOM, and nothing the card already did — approve/deny, the
 * cancel button beside the toggle, the screenshot — moved behind the collapse.
 *
 * Also who an approval prompt names: the turn's own machines win over the header
 * label, and a set is spelled out up to a cap and counted past it.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ToolCallCard } from '@/app/hoot/components/ToolCallCard';

type CardProps = React.ComponentProps<typeof ToolCallCard>;

const INPUT_MARKER = 'C:/shows/lobby-wall.toe';

function renderCard(props: CardProps) {
  const user = userEvent.setup();
  // The input/output headers carry CopyButtons, whose tooltips need the
  // provider the app mounts once at the layout level.
  const view = render(
    <TooltipProvider>
      <ToolCallCard {...props} />
    </TooltipProvider>,
  );
  return { user, ...view };
}

/** The expand toggle — the only control whose name carries the tool name. */
function toggleFor(toolName: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(toolName) });
}

/** The panel the toggle controls, found the way assistive tech finds it. */
function panelOf(toggle: HTMLElement): HTMLElement {
  const id = toggle.getAttribute('aria-controls');
  if (!id) throw new Error('toggle has no aria-controls');
  const panel = document.getElementById(id);
  if (!panel) throw new Error(`no element with id ${id}`);
  return panel;
}

function expectCollapsed(toggle: HTMLElement) {
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(toggle).toHaveAttribute('data-state', 'closed');
  expect(screen.queryByText('input')).toBeNull();
  expect(screen.queryByText(new RegExp(INPUT_MARKER))).toBeNull();
}

const STATES: [string, CardProps][] = [
  [
    'a running tier-2 call',
    { toolName: 'restart_process', args: { path: INPUT_MARKER }, isLoading: true },
  ],
  [
    'a completed tier-1 call',
    {
      toolName: 'get_system_info',
      args: { path: INPUT_MARKER },
      result: { hostname: 'STUDIO-01', os: 'Windows 11 Pro' },
    },
  ],
  [
    'a failed call',
    { toolName: 'get_system_info', args: { path: INPUT_MARKER }, result: { error: 'agent timed out' } },
  ],
  [
    'a denied tier-3 call',
    { toolName: 'run_powershell', args: { path: INPUT_MARKER }, approvalState: 'denied' },
  ],
  [
    'a tier-3 call awaiting approval',
    {
      toolName: 'run_powershell',
      args: { path: INPUT_MARKER },
      approvalState: 'requested',
      onApprove: () => {},
      onDeny: () => {},
    },
  ],
];

describe('ToolCallCard', () => {
  describe.each(STATES)('%s', (_label, props) => {
    it('starts collapsed, with the payload out of the DOM', () => {
      renderCard(props);
      expectCollapsed(toggleFor(props.toolName));
    });

    it('opens and closes from the toggle, mounting the input only while open', async () => {
      const { user } = renderCard(props);
      const toggle = toggleFor(props.toolName);

      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(toggle).toHaveAttribute('data-state', 'open');
      const panel = panelOf(toggle);
      expect(within(panel).getByText('input')).toBeInTheDocument();
      expect(panel).toHaveTextContent(INPUT_MARKER);

      await user.click(toggle);
      expectCollapsed(toggle);
    });
  });

  it('shows the output of a completed call only while open', async () => {
    const { user } = renderCard({
      toolName: 'get_system_info',
      args: {},
      result: { hostname: 'STUDIO-01' },
    });
    const toggle = toggleFor('get_system_info');
    // The tier chip rides inside the toggle.
    expect(toggle).toHaveTextContent('tier 1');
    expect(screen.queryByText('output')).toBeNull();

    await user.click(toggle);
    const panel = panelOf(toggle);
    expect(within(panel).getByText('output')).toBeInTheDocument();
    expect(panel).toHaveTextContent('"hostname": "STUDIO-01"');
    // No args, no input block.
    expect(within(panel).queryByText('input')).toBeNull();

    await user.click(toggle);
    expect(screen.queryByText('output')).toBeNull();
    expect(screen.queryByText(/STUDIO-01/)).toBeNull();
  });

  it("shows a failed call's error only while open", async () => {
    const { user } = renderCard({
      toolName: 'get_system_info',
      args: {},
      result: { error: 'agent timed out' },
    });
    const toggle = toggleFor('get_system_info');
    expect(screen.queryByText(/agent timed out/)).toBeNull();

    await user.click(toggle);
    expect(panelOf(toggle)).toHaveTextContent('"error": "agent timed out"');

    await user.click(toggle);
    expect(screen.queryByText(/agent timed out/)).toBeNull();
  });

  describe('a tier-3 call awaiting approval', () => {
    function renderAwaiting() {
      const onApprove = jest.fn();
      const onDeny = jest.fn();
      const view = renderCard({
        toolName: 'run_powershell',
        args: { command: 'hostname' },
        approvalState: 'requested',
        approvalTargetLabel: 'STUDIO-01',
        onApprove,
        onDeny,
      });
      return { onApprove, onDeny, ...view };
    }

    it('keeps the approval banner outside the collapse, open or shut', async () => {
      const { user } = renderAwaiting();
      const toggle = toggleFor('run_powershell');
      expect(toggle).toHaveTextContent('tier 3');
      expect(toggle).toHaveTextContent('awaiting approval');
      expect(screen.getByText(/hoot wants to run the privileged/)).toHaveTextContent(
        'hoot wants to run the privileged run_powershell tool on STUDIO-01.',
      );
      expect(screen.getByRole('button', { name: 'approve' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'deny' })).toBeEnabled();

      await user.click(toggle);
      const panel = panelOf(toggle);
      expect(panel).toHaveTextContent('"command": "hostname"');
      expect(within(panel).queryByRole('button', { name: 'approve' })).toBeNull();
      expect(screen.getByText(/hoot wants to run the privileged/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'approve' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'deny' })).toBeEnabled();
    });

    it('approves once, then locks both buttons', async () => {
      const { user, onApprove, onDeny } = renderAwaiting();
      await user.click(toggleFor('run_powershell'));

      await user.click(screen.getByRole('button', { name: 'approve' }));
      expect(onApprove).toHaveBeenCalledTimes(1);
      expect(onDeny).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'approve' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'deny' })).toBeDisabled();
    });

    it('denies once, then locks both buttons', async () => {
      const { user, onApprove, onDeny } = renderAwaiting();

      await user.click(screen.getByRole('button', { name: 'deny' }));
      expect(onDeny).toHaveBeenCalledTimes(1);
      expect(onApprove).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'approve' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'deny' })).toBeDisabled();
    });
  });

  describe('an approval that overrides active hours', () => {
    function renderOverride(args: Record<string, unknown>) {
      return renderCard({
        toolName: 'reboot_machine',
        args,
        approvalState: 'requested',
        approvalTargetMachineIds: ['kiosk-01'],
        onApprove: () => {},
        onDeny: () => {},
      });
    }

    it('says so, with the reason, without expanding', () => {
      renderOverride({ override_active_hours: true, reason: 'the show ended early' });

      expectCollapsed(toggleFor('reboot_machine'));
      // The label rides in a span, so read the whole line.
      expect(screen.getByText(/override active hours:/).closest('p')).toHaveTextContent(
        'override active hours: the show ended early',
      );
    });

    it('says nothing about active hours for a plain call', () => {
      renderOverride({ when: 'after_active_hours', reason: 'not an override' });

      expect(screen.queryByText(/override active hours/)).toBeNull();
    });
  });

  describe('who an approval prompt names', () => {
    /** The banner sentence; the target rides in a span, so read the whole line. */
    function banner(props: Partial<CardProps>) {
      renderCard({
        toolName: 'run_powershell',
        args: { command: 'hostname' },
        approvalState: 'requested',
        onApprove: () => {},
        onDeny: () => {},
        ...props,
      });
      return screen.getByText(/hoot wants to run the privileged/);
    }

    const TWELVE = Array.from({ length: 12 }, (_, i) => `kiosk-${String(i + 1).padStart(2, '0')}`);

    it.each([
      [['kiosk-01'], 'on kiosk-01.'],
      [['kiosk-01', 'kiosk-02'], 'on kiosk-01 and kiosk-02.'],
      [
        ['kiosk-01', 'kiosk-02', 'kiosk-03', 'kiosk-04', 'kiosk-05'],
        'on 5 machines: kiosk-01, kiosk-02, kiosk-03, kiosk-04, kiosk-05.',
      ],
      [TWELVE, 'on 12 machines: kiosk-01, kiosk-02, kiosk-03, kiosk-04, kiosk-05 and 7 more.'],
    ])('names %j as "%s"', (machineIds, expected) => {
      expect(banner({ approvalTargetMachineIds: machineIds })).toHaveTextContent(expected);
    });

    it.each([
      [['kiosk-01', 'kiosk-02'], 'on every machine in this site (2 reachable).'],
      [TWELVE, 'on every machine in this site (12 reachable).'],
    ])('says the set was everything for a dynamic turn: %j', (machineIds, expected) => {
      // A chosen seven and the whole site resolve to the same shape, and
      // "7 machines" reads like a selection either way. On a prompt authorising
      // a privileged command, the reader has to be able to tell.
      const line = banner({ approvalTargetMachineIds: machineIds, approvalTargetDynamic: true });
      expect(line).toHaveTextContent(expected);
      expect(line).not.toHaveTextContent('machines:');
    });

    it('does not claim the count is every ONLINE machine', () => {
      // The resolved set drops offline machines and online ones with hoot off,
      // so "every online machine (2)" would be false on a site where a third
      // machine is online with hoot switched off. The count is the reachable
      // ones; the scope is the site.
      const line = banner({
        approvalTargetMachineIds: ['kiosk-01', 'kiosk-02'],
        approvalTargetDynamic: true,
      });
      expect(line).not.toHaveTextContent('every online machine');
    });

    it('still names a dynamic turn that resolved to one machine', () => {
      // A one-machine site with "all machines" ticked runs the single-machine
      // path; "every online machine (1)" is a grander way of saying kiosk-01.
      expect(
        banner({ approvalTargetMachineIds: ['kiosk-01'], approvalTargetDynamic: true }),
      ).toHaveTextContent('on kiosk-01.');
    });

    it('names the machines when the turn chose them, not the whole site', () => {
      const line = banner({
        approvalTargetMachineIds: ['kiosk-01', 'kiosk-02'],
        approvalTargetDynamic: false,
      });
      expect(line).toHaveTextContent('on kiosk-01 and kiosk-02.');
      expect(line).not.toHaveTextContent('every machine in this site');
    });

    it("prefers the turn's machines over the header label", () => {
      // The header can be pointed anywhere by the time a loaded chat is read back.
      const line = banner({ approvalTargetLabel: 'all machines', approvalTargetMachineIds: ['kiosk-07'] });
      expect(line).toHaveTextContent('on kiosk-07.');
      expect(line).not.toHaveTextContent('all machines');
    });

    it('falls back to the header label for a turn with no machines recorded', () => {
      expect(banner({ approvalTargetLabel: 'all machines' })).toHaveTextContent('on all machines.');
    });

    it('falls back rather than naming nothing when the list comes back empty', () => {
      expect(banner({ approvalTargetLabel: 'STUDIO-01', approvalTargetMachineIds: [] })).toHaveTextContent(
        'on STUDIO-01.',
      );
    });

    it('names no target at all when neither is given', () => {
      expect(banner({})).toHaveTextContent('hoot wants to run the privileged run_powershell tool.');
    });
  });

  describe('the cancel button on a running call', () => {
    it('sits beside the toggle, never inside it, and cancels without toggling', async () => {
      const onCancel = jest.fn();
      const { user } = renderCard({
        toolName: 'restart_process',
        args: { path: INPUT_MARKER },
        isLoading: true,
        onCancel,
      });
      const toggle = toggleFor('restart_process');
      const cancel = screen.getByRole('button', { name: 'cancel' });

      // Nested interactive controls are an axe violation the hoot pages gate on.
      expect(toggle).not.toContainElement(cancel);
      expect(cancel.parentElement).toBe(toggle.parentElement);

      await user.click(cancel);
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });

    it('is disabled while a cancel is in flight', () => {
      renderCard({
        toolName: 'restart_process',
        args: {},
        isLoading: true,
        onCancel: () => {},
        cancelPending: true,
      });
      expect(screen.getByRole('button', { name: 'cancel' })).toBeDisabled();
    });
  });

  it('keeps the toggle as the first button of the card root the video script finds', () => {
    renderCard({
      toolName: 'restart_process',
      args: {},
      isLoading: true,
      onCancel: () => {},
    });
    const toggle = toggleFor('restart_process');
    // e2e/videos/12-cortex.video.ts locates the card by these classes and
    // clicks its first button to open it.
    const card = toggle.closest('div.rounded-lg.border.overflow-hidden');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getAllByRole('button')[0]).toBe(toggle);
  });

  it('shows a screenshot with the card collapsed, and leaves the base64 out of the output', async () => {
    const { user } = renderCard({
      toolName: 'capture_screenshot',
      args: {},
      result: { url: 'https://storage.example/shot.jpg', base64: 'QkFTRTY0QkxPQg==', width: 1920 },
    });
    const toggle = toggleFor('capture_screenshot');

    const image = screen.getByRole('img', { name: 'Screenshot' });
    expect(image).toHaveAttribute('src', 'https://storage.example/shot.jpg');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    const panel = panelOf(toggle);
    expect(panel).toHaveTextContent('"width": 1920');
    expect(panel).not.toHaveTextContent('QkFTRTY0QkxPQg==');
    expect(screen.getByRole('img', { name: 'Screenshot' })).toBe(image);
  });
});
