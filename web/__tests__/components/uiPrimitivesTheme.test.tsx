/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The ui primitives in both themes (light mode, task 2.2). Every raw palette
 * class in them was tuned for dark and renders the same in light, so one is
 * allowed only behind `dark:`, where it holds the old dark look. Those pairs
 * must also stay off the state and focus variants: tailwind emits `dark:`
 * utilities after `data-[state=*]:` and `focus-visible:` ones, so a bare
 * `dark:border-*` would override the checked or focus border in dark.
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { toast } from 'sonner';

import { AdminButton } from '@/components/admin/AdminButton';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Toaster } from '@/components/ui/sonner';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// Radix positions the tooltip with a ResizeObserver that jsdom does not have.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// the same patterns the planned lint guardrail bans (task 5.2)
const RAW_PALETTE =
  /\b(?:[a-z-]+:)*(?:text|bg|border|ring|fill|stroke|from|to|via|outline|divide|shadow|decoration|placeholder|caret|accent)-(?:red|green|emerald|amber|yellow|orange|blue|sky|cyan|teal|violet|purple|pink|rose|slate|gray|zinc|neutral|stone|lime|indigo|fuchsia)-\d{2,3}\b/;
const RAW_TEXT = /\btext-(?:white|gray-900)\b/;

function classesOf(el: Element): string[] {
  return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

// primitives draw from theme tokens only; a raw palette class looks right in one theme
function rawClasses(el: Element): string[] {
  return classesOf(el).filter((c) => RAW_PALETTE.test(c) || RAW_TEXT.test(c));
}

const MOUNTS: Record<string, () => Element> = {
  checkbox: () => {
    render(<Checkbox aria-label="pick" />);
    return screen.getByRole('checkbox');
  },
  switch: () => {
    render(<Switch aria-label="toggle" />);
    return screen.getByRole('switch');
  },
  input: () => {
    render(<Input aria-label="name" />);
    return screen.getByRole('textbox');
  },
  'destructive alert': () => {
    render(<Alert variant="destructive">failed</Alert>);
    return screen.getByRole('alert');
  },
  'destructive badge': () => {
    render(<Badge variant="destructive">offline</Badge>);
    return screen.getByText('offline');
  },
  'danger admin button': () => {
    render(<AdminButton adminVariant="danger">delete</AdminButton>);
    return screen.getByRole('button');
  },
  'primary admin button': () => {
    render(<AdminButton adminVariant="primary">save</AdminButton>);
    return screen.getByRole('button');
  },
  tooltip: () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>info</TooltipTrigger>
          <TooltipContent data-testid="tip">details</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    return screen.getByTestId('tip');
  },
};

describe('ui primitives across themes', () => {
  it.each(Object.keys(MOUNTS))('the %s uses no raw palette class in either theme', (name) => {
    expect(rawClasses(MOUNTS[name]())).toEqual([]);
  });

  it.each([
    ['checkbox', ['bg-checkbox', 'border-checkbox-border']],
    ['switch', ['data-[state=unchecked]:bg-switch-off', 'border-switch-off-border']],
    ['tooltip', ['bg-tooltip', 'text-tooltip-foreground', 'border-tooltip-border']],
    ['input', ['selection:bg-selection', 'selection:text-selection-foreground']],
  ] as const)('the %s draws from its control tokens', (name, tokens) => {
    expect(classesOf(MOUNTS[name]())).toEqual(expect.arrayContaining([...tokens]));
  });

  it('the light toaster takes its colours from the theme tokens', async () => {
    render(<Toaster theme="light" />);
    act(() => {
      toast('saved');
    });
    await screen.findByText('saved');

    const toaster = document.querySelector('[data-sonner-toaster]');
    expect(toaster).toHaveAttribute('data-sonner-theme', 'light');
    // sonner's own css outranks tailwind's layered utilities, so colour has to
    // arrive through its --normal-* variables
    expect(classesOf(toaster!)).toEqual(
      expect.arrayContaining([
        'data-[sonner-theme=light]:[--normal-bg:var(--popover)]!',
        'data-[sonner-theme=light]:[--normal-border:var(--border)]!',
        'data-[sonner-theme=light]:[--normal-text:var(--popover-foreground)]!',
      ]),
    );

    const toastEl = document.querySelector('[data-sonner-toast]');
    expect(toastEl).not.toBeNull();
    expect(rawClasses(toastEl!)).toEqual([]);
  });
});
