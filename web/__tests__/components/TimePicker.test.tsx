/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Schedule editing by keyboard and screen reader: the ±15 steppers were
 * mousedown-only (Enter/Space did nothing) and every icon-only control in the
 * schedule editors was unnamed. Day pills ignored the keyboard on mouse devices.
 */
import React, { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TimePicker, ScheduleBlocksEditor } from '@/components/ScheduleEditor';
import DayPillSelector from '@/components/DayPillSelector';
import type { ScheduleBlock } from '@/hooks/useFirestore';

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ userPreferences: { timeFormat: '24h' } }),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

// `matches` drives DayPillSelector's drag wiring: true = a mouse (fine pointer)
function setFinePointer(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: jest.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
}

function ControlledTimePicker({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <TimePicker label="start time" value={value} onChange={setValue} />;
}

function ControlledDays({ initial }: { initial: string[] }) {
  const [days, setDays] = useState(initial);
  return <DayPillSelector value={days} onChange={setDays} variant="pill" />;
}

function ControlledBlocks({ initial }: { initial: ScheduleBlock[] }) {
  const [blocks, setBlocks] = useState(initial);
  return (
    <TooltipProvider>
      <ScheduleBlocksEditor blocks={blocks} onChange={setBlocks} />
    </TooltipProvider>
  );
}

describe('TimePicker', () => {
  beforeEach(() => setFinePointer(false));

  it('names the field and its steppers after the label', () => {
    render(<ControlledTimePicker initial="09:00" />);

    expect(screen.getByRole('textbox', { name: 'start time' })).toHaveValue('09:00');
    expect(screen.getByRole('button', { name: 'start time, 15 minutes later' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'start time, 15 minutes earlier' })).toBeInTheDocument();
  });

  it('steps by 15 minutes from the keyboard', async () => {
    render(<ControlledTimePicker initial="09:00" />);

    screen.getByRole('button', { name: 'start time, 15 minutes later' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('textbox', { name: 'start time' })).toHaveValue('09:15');

    screen.getByRole('button', { name: 'start time, 15 minutes earlier' }).focus();
    await userEvent.keyboard(' ');
    await userEvent.keyboard(' ');
    expect(screen.getByRole('textbox', { name: 'start time' })).toHaveValue('08:45');
  });

  it('steps by 15 minutes on a pointer click', async () => {
    render(<ControlledTimePicker initial="23:50" />);

    await userEvent.click(screen.getByRole('button', { name: 'start time, 15 minutes later' }));

    expect(screen.getByRole('textbox', { name: 'start time' })).toHaveValue('00:05');
  });
});

describe('ScheduleBlocksEditor', () => {
  beforeEach(() => setFinePointer(false));

  it('names its icon-only controls', () => {
    render(
      <ControlledBlocks
        initial={[
          { colorIndex: 0, days: ['mon'], ranges: [{ start: '09:00', stop: '12:00' }, { start: '13:00', stop: '17:00' }] },
          { colorIndex: 1, days: ['sat'], ranges: [{ start: '10:00', stop: '14:00' }] },
        ]}
      />,
    );

    expect(screen.getAllByRole('button', { name: 'remove block' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'remove time range' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'add time range' })).toHaveLength(2);
    expect(screen.getAllByRole('textbox', { name: 'block name' })).toHaveLength(2);
    expect(screen.getAllByRole('textbox', { name: 'stop time' })).toHaveLength(3);
  });
});

describe('DayPillSelector', () => {
  it('toggles a day from the keyboard on a mouse device and reports it as pressed', async () => {
    setFinePointer(true);
    render(<ControlledDays initial={['mon']} />);

    const tuesday = screen.getByRole('button', { name: 'tuesday' });
    expect(tuesday).toHaveAttribute('aria-pressed', 'false');

    tuesday.focus();
    await userEvent.keyboard(' ');
    expect(tuesday).toHaveAttribute('aria-pressed', 'true');

    await userEvent.keyboard('{Enter}');
    expect(tuesday).toHaveAttribute('aria-pressed', 'false');
  });

  it('toggles once per mouse click on a mouse device', async () => {
    setFinePointer(true);
    render(<ControlledDays initial={[]} />);

    await userEvent.click(screen.getByRole('button', { name: 'friday' }));

    expect(screen.getByRole('button', { name: 'friday' })).toHaveAttribute('aria-pressed', 'true');
  });
});
