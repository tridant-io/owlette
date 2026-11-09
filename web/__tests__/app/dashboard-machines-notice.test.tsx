/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * What the dashboard shows in place of the getting-started card when there
 * are no machines to list: a refused machines listener, or a scoped member
 * whose scope holds nothing they can see yet.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import {
  machinesNotice,
  NoMachinesForYou,
  MachinesLoadError,
} from '@/app/dashboard/components/MachinesNotice';

describe('machinesNotice', () => {
  const base = { scoped: false, loading: false, count: 0, error: null };

  it.each([
    // [scoped, loading, count, error, expected]
    [false, false, 0, null, null],
    [false, false, 3, null, null],
    [false, true, 0, null, null],
    [true, false, 0, null, 'none_for_you'],
    [true, true, 0, null, null],
    [true, false, 2, null, null],
    [true, true, 2, null, null],
    [false, false, 0, 'Missing or insufficient permissions.', 'load_error'],
    [false, true, 0, 'boom', 'load_error'],
    [true, false, 0, 'boom', 'load_error'],
    [true, true, 0, 'boom', 'load_error'],
    [false, false, 4, 'boom', 'load_error'],
  ] as const)(
    'scoped=%s loading=%s count=%s error=%s gives %s',
    (scoped, loading, count, error, expected) => {
      expect(machinesNotice({ scoped, loading, count, error })).toBe(expected);
    },
  );

  it('treats an empty error string as no error', () => {
    expect(machinesNotice({ ...base, error: '' })).toBeNull();
    expect(machinesNotice({ ...base, scoped: true, error: '' })).toBe('none_for_you');
  });
});

describe('NoMachinesForYou', () => {
  it('renders its title and line', () => {
    const { container } = render(<NoMachinesForYou />);
    expect(screen.getByText('no machines here for you yet')).toBeInTheDocument();
    expect(screen.getByText('a site admin chooses which machines you can reach.')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('uses theme classes only', () => {
    const { container } = render(<NoMachinesForYou />);
    expectThemeClassesOnly(container);
  });
});

describe('MachinesLoadError', () => {
  it('renders the error inside its copy', () => {
    const { container } = render(<MachinesLoadError error="the listener was refused" />);
    expect(container.textContent).toBe(
      "machines couldn't load: the listener was refused. reload, or ask a site admin if it keeps happening.",
    );
  });

  it('does not double the full stop after an error that ends in one', () => {
    const { container } = render(<MachinesLoadError error="Missing or insufficient permissions." />);
    expect(container.textContent).toBe(
      "machines couldn't load: Missing or insufficient permissions. reload, or ask a site admin if it keeps happening.",
    );
  });

  it('sits in the danger box', () => {
    const { container } = render(<MachinesLoadError error="boom" />);
    const box = container.firstElementChild as HTMLElement;
    expect(box.tagName).toBe('DIV');
    for (const cls of ['bg-danger-surface', 'border', 'border-danger-border', 'rounded-lg', 'p-4', 'text-danger']) {
      expect(box).toHaveClass(cls);
    }
    expectThemeClassesOnly(container);
  });
});

// no inline colours and no raw palette utilities: every colour comes from a theme token
function expectThemeClassesOnly(container: HTMLElement) {
  const palette = /(^|:)(bg|text|border|fill|stroke|ring)-(red|green|blue|yellow|gray|grey|slate|zinc|neutral|stone|orange|amber|lime|emerald|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose|black|white)(-|$)/;
  for (const el of Array.from(container.querySelectorAll('*'))) {
    expect(el.getAttribute('style') ?? '').not.toMatch(/colou?r|background|#[0-9a-f]{3,8}|rgb|hsl|oklch/i);
    for (const cls of Array.from(el.classList)) {
      expect(cls).not.toMatch(palette);
      expect(cls).not.toMatch(/\[#|\[rgb|\[hsl|\[oklch/);
    }
  }
}
