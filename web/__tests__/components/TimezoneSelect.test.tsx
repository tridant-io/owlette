/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The chosen zone was marked only by an aria-hidden check icon and a fill, so a
 * screen reader heard every option the same; the search box was named by its
 * placeholder alone; and the trigger, search and options all set outline-none,
 * so keyboard focus vanished inside the picker.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TimezoneSelect } from '@/components/TimezoneSelect';

// jsdom ships no ResizeObserver; radix's popover positioning constructs one.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

async function openPicker(value = 'Europe/Berlin') {
  const user = userEvent.setup();
  render(<TimezoneSelect value={value} onValueChange={() => {}} />);
  await user.click(screen.getByRole('combobox'));
  return user;
}

describe('TimezoneSelect', () => {
  it('marks the chosen zone as current, not only with an icon', async () => {
    const user = await openPicker();
    await user.type(screen.getByRole('textbox', { name: 'search timezones' }), 'Berlin');

    const berlin = await screen.findByRole('button', { name: /Berlin/ });
    expect(berlin).toHaveAttribute('aria-current', 'true');

    await user.clear(screen.getByRole('textbox', { name: 'search timezones' }));
    await user.type(screen.getByRole('textbox', { name: 'search timezones' }), 'Tokyo');
    expect(await screen.findByRole('button', { name: /Tokyo/ })).not.toHaveAttribute('aria-current');
  });

  it('keeps keyboard focus visible on the trigger, the search box and the options', async () => {
    await openPicker();

    expect(screen.getByRole('combobox')).not.toHaveClass('outline-none');
    const search = screen.getByRole('textbox', { name: 'search timezones' });
    expect(search).not.toHaveClass('outline-none');
    // 16px below md, so ios safari does not zoom the page on focus
    expect(search).toHaveClass('text-base', 'md:text-sm');
    for (const option of screen.getAllByRole('button')) {
      expect(option).not.toHaveClass('outline-none');
    }
  });
});
