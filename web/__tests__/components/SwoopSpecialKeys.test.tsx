/**
 * @jest-environment jsdom
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SwoopSpecialKeys } from '@/components/swoop/SwoopSpecialKeys';
import type { SwoopSession } from '@/lib/swoop/features';

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

afterEach(cleanup);

// a session with control and nothing attached: the menu reads the setting and
// the legend from the systems alone.
const session = { ctl: true, send: () => true, onChannelMessage: () => () => {} } as unknown as SwoopSession;

async function open(osFamily: 'macos' | 'windows') {
  const user = userEvent.setup();
  render(<SwoopSpecialKeys session={session} osFamily={osFamily} />);
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
    expect(legend()).toBe('ctrlcmdwindows keycmdaltoption');

    await user.click(screen.getByRole('menuitemradio', { name: 'keys match: ctrl is control' }));
    await user.click(trigger);
    await screen.findByRole('menu');

    expect(screen.getByRole('menuitemradio', { name: 'keys match: ctrl is control' })).toBeChecked();
    expect(legend()).toBe('ctrlcontrolwindows keycmdaltoption');
  });

  it('offers to hold the super key outside fullscreen, and says where the key reaches the machine', async () => {
    await open('windows');
    expect(screen.getByRole('menuitem', { name: /hold the windows key for the next key/ })).toBeInTheDocument();
    expect(screen.getByTestId('super-key-note').textContent).toMatch(/the windows key/);
    expect(screen.queryByRole('menuitemradio')).toBeNull();
    expect(legend()).toBe('ctrlctrlwindows keywindows keyaltalt');
  });
});
