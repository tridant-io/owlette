/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * IconButton exists so an icon-only control can't ship without a name: the
 * audit found ~89 that didn't, because a radix tooltip only adds
 * aria-describedby while open and lucide icons are aria-hidden.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Trash2 } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { TooltipProvider } from '@/components/ui/tooltip';

function renderButton(props: Partial<React.ComponentProps<typeof IconButton>> = {}) {
  const onClick = jest.fn();
  render(
    <TooltipProvider delayDuration={0}>
      <IconButton label="delete process" onClick={onClick} {...props}>
        <Trash2 />
      </IconButton>
    </TooltipProvider>,
  );
  return { onClick };
}

describe('IconButton', () => {
  it('is named by its label, closed tooltip or not', () => {
    renderButton();
    expect(screen.getByRole('button', { name: 'delete process' })).toBeInTheDocument();
  });

  it('shows the label as a tooltip on keyboard focus', async () => {
    renderButton();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'delete process' })).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('delete process');
  });

  it('keeps the name when the tooltip is turned off', async () => {
    const { onClick } = renderButton({ tooltip: false });
    await userEvent.click(screen.getByRole('button', { name: 'delete process' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
