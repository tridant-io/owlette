/**
 * @jest-environment jsdom
 */
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SwoopSpecialKeys } from '@/components/swoop/SwoopSpecialKeys';
import { swoopInputCapture, type SwoopSession } from '@/lib/swoop/features';
import type { InputCapture } from '@/lib/swoop/input';

// the menu finds the input capture on a live session, which these tests do not
// have: null is a session with nothing attached, and two tests hand it one.
jest.mock('@/lib/swoop/features', () => ({ swoopInputCapture: jest.fn(() => null) }));

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

afterEach(() => {
  cleanup();
  jest.mocked(swoopInputCapture).mockReturnValue(null);
  document.body.innerHTML = '';
});

// a session with control and nothing attached: the menu reads the setting and
// the legend from the systems alone.
const session = { ctl: true, send: () => true, onChannelMessage: () => () => {} } as unknown as SwoopSession;

async function open(osFamily: 'macos' | 'windows') {
  const user = userEvent.setup();
  render(<SwoopSpecialKeys session={session} osFamily={osFamily} />, { wrapper: TooltipProvider });
  const trigger = screen.getByRole('button', { name: 'send a key combination' });
  await user.click(trigger);
  await screen.findByRole('menu');
  return { user, trigger };
}

const legend = () => screen.getByTestId('modifier-legend').textContent;

describe('SwoopSpecialKeys', () => {
  it('names the two settings and shows what the keys do, for a pc viewer on a mac', async () => {
    const { user, trigger } = await open('macos');
    expect(screen.getByRole('menuitemradio', { name: 'shortcuts match: ctrl acts as cmd' })).toBeChecked();
    expect(legend()).toBe('ctrl→cmdwindows key→cmdalt→option');

    await user.click(screen.getByRole('menuitemradio', { name: 'keys match: ctrl is control' }));
    await user.click(trigger);
    await screen.findByRole('menu');

    expect(screen.getByRole('menuitemradio', { name: 'keys match: ctrl is control' })).toBeChecked();
    expect(legend()).toBe('ctrl→controlwindows key→cmdalt→option');
  });

  it('offers to hold the super key outside fullscreen, says what to do, and shows no legend where nothing is converted', async () => {
    await open('windows');
    expect(screen.getByRole('menuitem', { name: /hold the windows key for the next key/ })).toBeInTheDocument();
    // jsdom has no keyboard lock api, which is what firefox and safari show.
    expect(screen.getByTestId('super-key-note').textContent).toBe(
      'this browser never hands the windows key to a page. use "hold the windows key for the next key" below.',
    );
    expect(screen.queryByRole('menuitemradio')).toBeNull();
    expect(screen.queryByTestId('modifier-legend')).toBeNull();
    expect(screen.getByTestId('special-keys-footer').textContent).toBe(
      'these are the shortcuts your browser or your own windows keeps. in fullscreen most others reach the machine directly.',
    );
  });

  describe('in the mac app, which hands the machine the shortcuts it captures itself', () => {
    const MAC_KEYS_APP =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) owlette-swoop-viewer/4.1.8 (keys)';

    beforeEach(() => {
      jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(MAC_KEYS_APP);
    });

    afterEach(() => {
      jest.restoreAllMocks();
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
    });

    it('says so, and that cmd+tab stays on the mac; outside fullscreen cmd+q is still on the menu', async () => {
      await open('macos');
      expect(screen.getByTestId('super-key-note').textContent).toBe(
        'outside fullscreen your own mac keeps cmd. go fullscreen, or use "hold cmd for the next key" below.',
      );
      expect(screen.getByTestId('special-keys-footer').textContent).toBe(
        'in fullscreen the app hands every shortcut it can to the machine; hold esc to come back. cmd+tab stays on this mac.',
      );
      expect(screen.getByRole('menuitem', { name: /^cmd \+ q/ })).toBeInTheDocument();
    });

    it('leaves cmd+q off the menu in fullscreen, and keeps cmd+tab and the screen lock', async () => {
      Object.defineProperty(document, 'fullscreenElement', { value: document.body, configurable: true });
      await open('macos');
      expect(screen.queryByRole('menuitem', { name: /^cmd \+ q/ })).toBeNull();
      expect(screen.getByRole('menuitem', { name: /^cmd \+ tab/ })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /^cmd \+ ctrl \+ q/ })).toBeInTheDocument();
      expect(screen.queryByTestId('super-key-note')).toBeNull();
    });
  });

  describe('where the keyboard goes when the menu closes', () => {
    const attached = () => {
      const stage = document.createElement('div');
      stage.tabIndex = -1;
      document.body.appendChild(stage);
      const capture = { holdNextKey: jest.fn(), pressChord: jest.fn(), setModifierMapping: jest.fn() };
      jest.mocked(swoopInputCapture).mockReturnValue(capture as unknown as InputCapture);
      const user = userEvent.setup();
      render(<SwoopSpecialKeys session={{ ...session, stage } as SwoopSession} osFamily="macos" />, { wrapper: TooltipProvider });
      const trigger = screen.getByRole('button', { name: 'send a key combination' });
      return { stage, capture, user, trigger };
    };

    it('goes to the picture after a hold, so the next key reaches the machine', async () => {
      const { stage, capture, user, trigger } = attached();
      await user.click(trigger);
      await user.click(await screen.findByRole('menuitem', { name: 'hold cmd for the next key' }));

      expect(capture.holdNextKey).toHaveBeenCalledWith('MetaLeft');
      await waitFor(() => expect(stage).toHaveFocus());
    });

    it('goes to the picture after a sent chord', async () => {
      const { stage, capture, user, trigger } = attached();
      await user.click(trigger);
      await user.click(await screen.findByRole('menuitem', { name: /cmd \+ tab/ }));

      expect(capture.pressChord).toHaveBeenCalledWith(['MetaLeft', 'Tab']);
      await waitFor(() => expect(stage).toHaveFocus());
    });

    it('stays on the menu button when nothing was sent', async () => {
      const { stage, user, trigger } = attached();
      await user.click(trigger);
      await screen.findByRole('menu');
      await user.keyboard('{Escape}');

      await waitFor(() => expect(trigger).toHaveFocus());
      expect(stage).not.toHaveFocus();
    });
  });
});
