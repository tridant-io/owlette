/**
 * @jest-environment jsdom
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SwoopQualityMenu } from '@/components/swoop/SwoopQualityMenu';
import type { SwoopSession } from '@/lib/swoop/features';
import { readCodecChoice, writeCodecChoice } from '@/lib/swoop/codecStore';

// jsdom ships no ResizeObserver; Radix's menu positioning constructs one.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// Radix menus drive the trigger with pointer capture and scroll the focused item.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

jest.mock('@/lib/swoop/clientCaps', () => ({
  probeClientCaps: () => Promise.resolve({ codecs: ['hevc', 'h264'] }),
}));

afterEach(cleanup);
beforeEach(() => sessionStorage.clear());

const SITE = 'site-1';
const MACHINE = 'machine-1';

function liveSession() {
  return { siteId: SITE, machineId: MACHINE, send: jest.fn(() => true), restart: jest.fn() };
}

/** open the codec row's options by keyboard: jsdom has no layout for a pointer to cross. */
async function openCodec(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'quality ceiling' }));
  await screen.findByRole('menu');
  await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowRight}');
  await screen.findAllByRole('menuitemradio');
}

const row = (name: RegExp) => screen.getByRole('menuitem', { name });

describe('SwoopQualityMenu', () => {
  it('shows one row per axis with what is chosen, and no option until a row is opened', async () => {
    const user = userEvent.setup();
    const session = { send: jest.fn(() => true) } as unknown as SwoopSession;
    render(<SwoopQualityMenu session={session} />, { wrapper: TooltipProvider });
    await user.click(screen.getByRole('button', { name: 'quality ceiling' }));
    await screen.findByRole('menu');

    expect(screen.getAllByRole('menuitem')).toHaveLength(4);
    expect(row(/^bandwidth/)).toHaveTextContent('bandwidthauto');
    expect(row(/^resolution/)).toHaveTextContent('resolutionnative');
    expect(row(/^frame rate/)).toHaveTextContent('frame rate60 fps');
    expect(row(/^codec/)).toHaveTextContent('codecauto');
    expect(screen.queryByRole('menuitemradio')).toBeNull();
  });

  it('sends the ceiling chosen in a submenu, and the row then says it', async () => {
    const user = userEvent.setup();
    const send = jest.fn(() => true);
    render(<SwoopQualityMenu session={{ send } as unknown as SwoopSession} />, { wrapper: TooltipProvider });
    const trigger = screen.getByRole('button', { name: 'quality ceiling' });
    await user.click(trigger);
    await screen.findByRole('menu');
    // by keyboard: jsdom has no layout, and a pointer crossing from the row to
    // its submenu there reads as leaving both.
    await user.keyboard('{ArrowDown}{ArrowRight}');
    expect(await screen.findByRole('menuitemradio', { name: 'auto' })).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('menuitemradio', { name: '20 mbps' })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('swoop-control', expect.any(String));
    expect(JSON.parse(send.mock.calls[0][1] as string)).toEqual({
      t: 'quality',
      preset: 'native',
      maxBitrateKbps: 20_000,
      maxFps: 60,
    });

    await user.click(trigger);
    expect(await screen.findByRole('menuitem', { name: /^bandwidth/ })).toHaveTextContent('bandwidth20 mbps');
  });

  it('offers the codecs the browser can receive, and says when the choice applies', async () => {
    const user = userEvent.setup();
    render(<SwoopQualityMenu session={{ send: jest.fn() } as unknown as SwoopSession} />, { wrapper: TooltipProvider });
    await user.click(screen.getByRole('button', { name: 'quality ceiling' }));
    await user.click(row(/^codec/));

    const options = await screen.findAllByRole('menuitemradio');
    expect(options.map((option) => option.textContent)).toEqual(['auto', 'hevc', 'h264']);
    expect(screen.getByText('reconnects to apply.')).toBeInTheDocument();
  });

  it('shows the codec this tab chose for the machine, the stall fallback included', async () => {
    const user = userEvent.setup();
    writeCodecChoice(SITE, MACHINE, 'h264');
    render(<SwoopQualityMenu session={liveSession() as unknown as SwoopSession} />, { wrapper: TooltipProvider });
    await user.click(screen.getByRole('button', { name: 'quality ceiling' }));
    expect(await screen.findByRole('menuitem', { name: /^codec/ })).toHaveTextContent('codech264');
  });

  it('stores a codec choice for the machine and starts a new session to apply it', async () => {
    const user = userEvent.setup();
    const session = liveSession();
    render(<SwoopQualityMenu session={session as unknown as SwoopSession} />, { wrapper: TooltipProvider });
    await openCodec(user);
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(readCodecChoice(SITE, MACHINE)).toBe('h264');
    expect(session.restart).toHaveBeenCalledTimes(1);
    // a codec is an offer, never a control message.
    expect(session.send).not.toHaveBeenCalled();
  });

  it('auto clears the h.264 a frozen picture fell back to', async () => {
    const user = userEvent.setup();
    writeCodecChoice(SITE, MACHINE, 'h264');
    const session = liveSession();
    render(<SwoopQualityMenu session={session as unknown as SwoopSession} />, { wrapper: TooltipProvider });
    await openCodec(user);
    await user.click(screen.getByRole('menuitemradio', { name: 'auto' }));

    expect(sessionStorage.getItem(`owlette.swoop.codec/${SITE}/${MACHINE}`)).toBeNull();
    expect(session.restart).toHaveBeenCalledTimes(1);
  });

  it('starts nothing when the codec chosen is the one in use', async () => {
    const user = userEvent.setup();
    const session = liveSession();
    render(<SwoopQualityMenu session={session as unknown as SwoopSession} />, { wrapper: TooltipProvider });
    await openCodec(user);
    await user.click(screen.getByRole('menuitemradio', { name: 'auto' }));

    expect(session.restart).not.toHaveBeenCalled();
  });
});
