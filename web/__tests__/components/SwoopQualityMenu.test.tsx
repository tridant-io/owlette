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
import { readSize, readSmooth, setSmooth } from '@/lib/swoop/viewStore';
import { smoothCanDraw } from '@/hooks/useSwoopView';

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
// jsdom has no webgl2 or rvfc, so whether smooth scaling can draw is the test's to say.
jest.mock('@/hooks/useSwoopView', () => ({ smoothCanDraw: jest.fn() }));

afterEach(cleanup);
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  jest.mocked(smoothCanDraw).mockReturnValue(true);
});

const SITE = 'site-1';
const MACHINE = 'machine-1';

function liveSession() {
  return { siteId: SITE, machineId: MACHINE, send: jest.fn(() => true), restart: jest.fn() };
}

const BANDWIDTH_ROW = 0;
const CODEC_ROW = 3;
const SIZE_ROW = 4;

/** open a row's options by keyboard: jsdom has no layout for a pointer to cross. */
async function openRow(user: ReturnType<typeof userEvent.setup>, index: number) {
  await user.click(screen.getByRole('button', { name: 'quality and display' }));
  await screen.findByRole('menu');
  await user.keyboard(`${'{ArrowDown}'.repeat(index + 1)}{ArrowRight}`);
  await screen.findAllByRole('menuitemradio');
}

const row = (name: RegExp) => screen.getByRole('menuitem', { name });

describe('SwoopQualityMenu', () => {
  it('shows one row per axis with what is chosen, and no option until a row is opened', async () => {
    const user = userEvent.setup();
    const session = { send: jest.fn(() => true) } as unknown as SwoopSession;
    render(<SwoopQualityMenu session={session} />, { wrapper: TooltipProvider });
    await user.click(screen.getByRole('button', { name: 'quality and display' }));
    await screen.findByRole('menu');

    expect(screen.getAllByRole('menuitem')).toHaveLength(5);
    expect(row(/^bandwidth/)).toHaveTextContent('bandwidthauto');
    expect(row(/^resolution/)).toHaveTextContent('resolutionnative');
    expect(row(/^frame rate/)).toHaveTextContent('frame rate60 fps');
    expect(row(/^codec/)).toHaveTextContent('codecauto');
    expect(row(/^size/)).toHaveTextContent('sizefit');
    expect(screen.queryByRole('menuitemradio')).toBeNull();
  });

  it('sends the ceiling chosen in a submenu, and the row then says it', async () => {
    const user = userEvent.setup();
    const send = jest.fn(() => true);
    render(<SwoopQualityMenu session={{ send } as unknown as SwoopSession} />, { wrapper: TooltipProvider });
    const trigger = screen.getByRole('button', { name: 'quality and display' });
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
    await user.click(screen.getByRole('button', { name: 'quality and display' }));
    await user.click(row(/^codec/));

    const options = await screen.findAllByRole('menuitemradio');
    expect(options.map((option) => option.textContent)).toEqual(['auto', 'hevc', 'h264']);
    expect(screen.getByText('reconnects to apply.')).toBeInTheDocument();
  });

  it('shows the codec this tab chose for the machine, the stall fallback included', async () => {
    const user = userEvent.setup();
    writeCodecChoice(SITE, MACHINE, 'h264');
    render(<SwoopQualityMenu session={liveSession() as unknown as SwoopSession} />, { wrapper: TooltipProvider });
    await user.click(screen.getByRole('button', { name: 'quality and display' }));
    expect(await screen.findByRole('menuitem', { name: /^codec/ })).toHaveTextContent('codech264');
  });

  it('stores a codec choice for the machine and starts a new session to apply it', async () => {
    const user = userEvent.setup();
    const session = liveSession();
    render(<SwoopQualityMenu session={session as unknown as SwoopSession} />, { wrapper: TooltipProvider });
    await openRow(user, CODEC_ROW);
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
    await openRow(user, CODEC_ROW);
    await user.click(screen.getByRole('menuitemradio', { name: 'auto' }));

    expect(sessionStorage.getItem(`owlette.swoop.codec/${SITE}/${MACHINE}`)).toBeNull();
    expect(session.restart).toHaveBeenCalledTimes(1);
  });

  it('starts nothing when the codec chosen is the one in use', async () => {
    const user = userEvent.setup();
    const session = liveSession();
    render(<SwoopQualityMenu session={session as unknown as SwoopSession} />, { wrapper: TooltipProvider });
    await openRow(user, CODEC_ROW);
    await user.click(screen.getByRole('menuitemradio', { name: 'auto' }));

    expect(session.restart).not.toHaveBeenCalled();
  });

  it('keeps sharp in this browser and the row says it, with nothing sent', async () => {
    const user = userEvent.setup();
    const session = liveSession();
    render(<SwoopQualityMenu session={session as unknown as SwoopSession} />, { wrapper: TooltipProvider });
    await openRow(user, SIZE_ROW);
    const options = screen.getAllByRole('menuitemradio');
    expect(options.map((option) => option.textContent)).toEqual(['fit', 'sharp']);
    await user.click(screen.getByRole('menuitemradio', { name: 'sharp' }));

    expect(readSize()).toBe('sharp');
    expect(session.send).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'quality and display' }));
    expect(await screen.findByRole('menuitem', { name: /^size/ })).toHaveTextContent('sizesharp');
  });

  it('turns smooth scaling off in this browser, with nothing sent', async () => {
    const user = userEvent.setup();
    setSmooth(true);
    const session = liveSession();
    render(<SwoopQualityMenu session={session as unknown as SwoopSession} />, { wrapper: TooltipProvider });
    await user.click(screen.getByRole('button', { name: 'quality and display' }));
    const item = await screen.findByRole('menuitemcheckbox', { name: 'smooth scaling' });
    expect(item).toBeChecked();
    await user.click(item);

    expect(readSmooth()).toBe(false);
    expect(localStorage.getItem('owlette.swoop.smooth')).toBe('off');
    expect(session.send).not.toHaveBeenCalled();
  });

  it('greys smooth scaling out where it cannot draw, and says why', async () => {
    const user = userEvent.setup();
    jest.mocked(smoothCanDraw).mockReturnValue(false);
    render(<SwoopQualityMenu session={liveSession() as unknown as SwoopSession} />, { wrapper: TooltipProvider });
    await user.click(screen.getByRole('button', { name: 'quality and display' }));
    const item = await screen.findByRole('menuitemcheckbox', { name: 'smooth scaling' });

    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('not available in this browser')).toBeInTheDocument();
    await user.click(item);
    expect(localStorage.getItem('owlette.swoop.smooth')).toBeNull();
  });

  it('a new session keeps size and smooth scaling, and resets the ceilings', async () => {
    const user = userEvent.setup();
    setSmooth(true);
    const { rerender } = render(<SwoopQualityMenu session={liveSession() as unknown as SwoopSession} />, {
      wrapper: TooltipProvider,
    });
    await openRow(user, SIZE_ROW);
    await user.click(screen.getByRole('menuitemradio', { name: 'sharp' }));
    const trigger = screen.getByRole('button', { name: 'quality and display' });
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'smooth scaling' }));
    await openRow(user, BANDWIDTH_ROW);
    await user.click(screen.getByRole('menuitemradio', { name: '20 mbps' }));

    rerender(<SwoopQualityMenu session={liveSession() as unknown as SwoopSession} />);
    await user.click(trigger);
    expect(await screen.findByRole('menuitem', { name: /^size/ })).toHaveTextContent('sizesharp');
    expect(screen.getByRole('menuitemcheckbox', { name: 'smooth scaling' })).not.toBeChecked();
    expect(row(/^bandwidth/)).toHaveTextContent('bandwidthauto');
  });
});
