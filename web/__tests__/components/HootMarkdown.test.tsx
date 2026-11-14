/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * HootMarkdown — a gfm table scrolls inside its own box instead of widening the
 * chat column past a phone screen. react-markdown is ESM-only and cannot load
 * under jest, so the stand-in renders a table through whatever `components.table`
 * the message hands it: the override is what is on trial, not markdown parsing.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { HootMarkdown } from '@/components/hoot/HootMarkdown';

jest.mock('react-markdown', () => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: ({ components }: { components?: { table?: React.ElementType } }) => {
      const Table = components?.table ?? 'table';
      const row = createElement('tr', null, createElement('td', null, 'a-very-long-cell'));
      return createElement(Table, { node: {} }, createElement('tbody', null, row));
    },
  };
});
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

describe('HootMarkdown', () => {
  it('wraps a table in a horizontal scroller', () => {
    render(<HootMarkdown text={'| a |\n|---|\n| b |'} />);

    const table = screen.getByRole('table');
    expect(table.parentElement).toHaveClass('overflow-x-auto');
    // react-markdown's hast node is a prop, never a DOM attribute.
    expect(table).not.toHaveAttribute('node');
  });

  it('inverts its prose in the dark theme only', () => {
    render(<HootMarkdown text="hello" />);

    const body = screen.getByRole('table').closest('.hoot-markdown');
    expect(body).toHaveClass('dark:prose-invert');
    expect(body).not.toHaveClass('prose-invert');
  });
});
