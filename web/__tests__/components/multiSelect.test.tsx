/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * `MultiSelect` — the searchable, multi-pick filter behind the logs action type.
 *
 * Requested 2026-09-15: the action catalogue is 47 entries deep, so picking one
 * meant scrolling a list with no search, and picking two was impossible.
 *
 * EMPTY MEANS ALL is the contract the callers lean on (query, in-memory
 * fallback, and the clear-logs payload), so the `[]` cases are asserted as
 * behaviour, not as an implementation detail.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MultiSelect, type MultiSelectGroup } from '@/components/ui/multi-select';

// Radix positions the popover with a ResizeObserver that jsdom does not have.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;

const GROUPS: MultiSelectGroup[] = [
  {
    group: 'agent',
    options: [
      { value: 'agent_started', label: 'agent started' },
      { value: 'agent_stopped', label: 'agent stopped' },
    ],
  },
  {
    group: 'processes',
    options: [{ value: 'process_crash', label: 'process crash' }],
  },
];

function renderMultiSelect(selected: string[] = [], onChange = jest.fn()) {
  render(
    <MultiSelect
      groups={GROUPS}
      selected={selected}
      onChange={onChange}
      allLabel="all actions"
      itemNoun="actions"
      searchPlaceholder="search actions"
      data-testid="filter"
    />,
  );
  return { onChange, trigger: screen.getByTestId('filter') };
}

async function open(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement) {
  await user.click(trigger);
  await screen.findByPlaceholderText('search actions');
}

describe('MultiSelect — trigger label', () => {
  it('reads as "all" when nothing is selected', () => {
    const { trigger } = renderMultiSelect([]);
    expect(trigger).toHaveTextContent('all actions');
  });

  it('names the one selected option', () => {
    const { trigger } = renderMultiSelect(['process_crash']);
    expect(trigger).toHaveTextContent('process crash');
  });

  it('counts several', () => {
    const { trigger } = renderMultiSelect(['agent_started', 'process_crash']);
    expect(trigger).toHaveTextContent('2 actions');
  });
});

describe('MultiSelect — search', () => {
  it('lists every option, grouped, before searching', async () => {
    const user = userEvent.setup();
    const { trigger } = renderMultiSelect();
    await open(user, trigger);

    expect(screen.getByText('agent')).toBeInTheDocument();
    expect(screen.getByText('processes')).toBeInTheDocument();
    expect(screen.getByText('agent started')).toBeInTheDocument();
    expect(screen.getByText('process crash')).toBeInTheDocument();
  });

  it('filters by label', async () => {
    const user = userEvent.setup();
    const { trigger } = renderMultiSelect();
    await open(user, trigger);

    await user.type(screen.getByPlaceholderText('search actions'), 'crash');

    expect(screen.getByText('process crash')).toBeInTheDocument();
    expect(screen.queryByText('agent started')).not.toBeInTheDocument();
    // A group with no matches goes with its options.
    expect(screen.queryByText('agent')).not.toBeInTheDocument();
  });

  it('filters by the wire value, not just the label', async () => {
    const user = userEvent.setup();
    const { trigger } = renderMultiSelect();
    await open(user, trigger);

    // Someone reading `action: agent_stopped` in a log should find it by that.
    await user.type(screen.getByPlaceholderText('search actions'), 'agent_stop');

    expect(screen.getByText('agent stopped')).toBeInTheDocument();
    expect(screen.queryByText('agent started')).not.toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    const user = userEvent.setup();
    const { trigger } = renderMultiSelect();
    await open(user, trigger);

    await user.type(screen.getByPlaceholderText('search actions'), 'zzz');

    expect(screen.getByText('no matches')).toBeInTheDocument();
  });
});

describe('MultiSelect — picking', () => {
  it('adds an option', async () => {
    const user = userEvent.setup();
    const { trigger, onChange } = renderMultiSelect([]);
    await open(user, trigger);

    await user.click(screen.getByRole('checkbox', { name: 'agent started' }));

    expect(onChange).toHaveBeenCalledWith(['agent_started']);
  });

  it('removes an option that was selected', async () => {
    const user = userEvent.setup();
    const { trigger, onChange } = renderMultiSelect(['agent_started', 'process_crash']);
    await open(user, trigger);

    await user.click(screen.getByRole('checkbox', { name: 'agent started' }));

    expect(onChange).toHaveBeenCalledWith(['process_crash']);
  });

  it('stays open across picks', async () => {
    const user = userEvent.setup();
    const { trigger } = renderMultiSelect([]);
    await open(user, trigger);

    await user.click(screen.getByRole('checkbox', { name: 'agent started' }));

    // A Select would have closed here, which is why this is a Popover.
    expect(screen.getByPlaceholderText('search actions')).toBeInTheDocument();
  });

  it('selects everything', async () => {
    const user = userEvent.setup();
    const { trigger, onChange } = renderMultiSelect([]);
    await open(user, trigger);

    await user.click(screen.getByTestId('filter-select-all'));

    expect(onChange).toHaveBeenCalledWith(['agent_started', 'agent_stopped', 'process_crash']);
  });

  it('selects only the matches while searching, keeping earlier picks', async () => {
    const user = userEvent.setup();
    const { trigger, onChange } = renderMultiSelect(['process_crash']);
    await open(user, trigger);

    await user.type(screen.getByPlaceholderText('search actions'), 'agent');
    expect(screen.getByTestId('filter-select-all')).toHaveTextContent('select matches');
    await user.click(screen.getByTestId('filter-select-all'));

    expect(onChange).toHaveBeenCalledWith(['process_crash', 'agent_started', 'agent_stopped']);
  });

  it('clears back to "all" with none', async () => {
    const user = userEvent.setup();
    const { trigger, onChange } = renderMultiSelect(['agent_started']);
    await open(user, trigger);

    await user.click(screen.getByTestId('filter-select-none'));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('disables none when nothing is selected', async () => {
    const user = userEvent.setup();
    const { trigger } = renderMultiSelect([]);
    await open(user, trigger);

    expect(screen.getByTestId('filter-select-none')).toBeDisabled();
  });
});
