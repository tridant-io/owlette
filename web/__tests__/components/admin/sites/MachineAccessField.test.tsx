/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * MachineAccessField, the machines half of a person's access. null is the whole
 * site, and "some machines" is its own choice, because MultiSelect reads an empty
 * selection as everything: here empty means none picked, and it never widens.
 */
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MachineAccessField,
  accessLabel,
  isAccessValid,
  liveMachineIds,
} from '@/components/admin/sites/MachineAccessField';

// radix positions the popover with a ResizeObserver that jsdom does not have.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;

type User = ReturnType<typeof userEvent.setup>;

const MACHINES = [
  { id: 'm1', name: 'lobby wall' },
  { id: 'm2', name: 'kiosk' },
];

const WHOLE_SITE_HINT =
  'every machine, and the site-wide pages their role allows: settings, members, deployments, roost and talons.';
const SOME_MACHINES_HINT =
  'only the machines you pick: their role and swoop apply there. nothing site-wide, whatever their role.';
const PICK_ONE = 'pick at least one machine';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);

function renderField(value: string[] | null, disabled?: boolean) {
  const onChange = jest.fn();
  const user = userEvent.setup();
  render(
    <MachineAccessField
      machines={MACHINES}
      value={value}
      onChange={onChange}
      disabled={disabled}
      idPrefix="change-access"
    />,
  );
  return { user, onChange };
}

// holds the value the way the dialogs do, so a test sees what the field shows after each change
function Controlled({ initial, onChange }: { initial: string[] | null; onChange: jest.Mock }) {
  const [value, setValue] = useState(initial);
  return (
    <MachineAccessField
      machines={MACHINES}
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
      idPrefix="change-access"
    />
  );
}

const choice = () => screen.getByRole('group', { name: 'access' });
const picker = () => screen.queryByTestId('change-access-machines');

async function openPicker(user: User) {
  await user.click(screen.getByTestId('change-access-machines'));
  await screen.findByPlaceholderText('search machines…');
}

describe('the choice', () => {
  it('is a group named access, with an aria-pressed button for each choice', () => {
    renderField(null);

    const buttons = within(choice()).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['whole site', 'some machines']);
    expect(within(choice()).getByRole('button', { name: 'whole site' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(choice()).getByRole('button', { name: 'some machines' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('presses some machines for any list, the empty one included', () => {
    renderField([]);

    expect(within(choice()).getByRole('button', { name: 'some machines' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(choice()).getByRole('button', { name: 'whole site' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('gives null for whole site', async () => {
    const { user, onChange } = renderField(['m1']);

    await user.click(screen.getByRole('button', { name: 'whole site' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('gives [] for some machines, never the whole site', async () => {
    const { user, onChange } = renderField(null);

    await user.click(screen.getByRole('button', { name: 'some machines' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('keeps the picks when some machines is clicked again', async () => {
    const { user, onChange } = renderField(['m1']);

    await user.click(screen.getByRole('button', { name: 'some machines' }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('says what each choice gives under it', () => {
    const { unmount } = render(
      <MachineAccessField machines={MACHINES} value={null} onChange={jest.fn()} idPrefix="change-access" />,
    );
    expect(screen.getByText(WHOLE_SITE_HINT)).toBeInTheDocument();
    expect(screen.queryByText(SOME_MACHINES_HINT)).not.toBeInTheDocument();
    unmount();

    renderField(['m1']);
    expect(screen.getByText(SOME_MACHINES_HINT)).toBeInTheDocument();
    expect(screen.queryByText(WHOLE_SITE_HINT)).not.toBeInTheDocument();
  });
});

describe('the picker', () => {
  it('is hidden for the whole site', () => {
    renderField(null);

    expect(picker()).not.toBeInTheDocument();
    expect(screen.queryByText(PICK_ONE)).not.toBeInTheDocument();
  });

  it('lists the site machines by name, and gives the ids picked', async () => {
    const { user, onChange } = renderField([]);
    expect(picker()).toHaveTextContent('pick machines');

    await openPicker(user);
    expect(screen.getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual([
      'lobby wall',
      'kiosk',
    ]);

    await user.click(screen.getByRole('checkbox', { name: 'lobby wall' }));
    expect(onChange).toHaveBeenLastCalledWith(['m1']);
  });

  it('counts several picks in machines', () => {
    renderField(['m1', 'm2']);

    expect(picker()).toHaveTextContent('2 machines');
  });

  it('asks for at least one machine while none is picked', () => {
    renderField([]);

    expect(screen.getByText(PICK_ONE)).toHaveClass('text-danger');
  });

  it('caps the list at 30 machines', () => {
    renderField(ids(31));

    expect(screen.getByText('at most 30 machines')).toHaveClass('text-danger');
    expect(screen.queryByText(PICK_ONE)).not.toBeInTheDocument();
  });

  it('shows no problem for a valid pick', () => {
    renderField(['m1']);

    expect(screen.queryByText(PICK_ONE)).not.toBeInTheDocument();
    expect(screen.queryByText('at most 30 machines')).not.toBeInTheDocument();
  });

  it("leaves [] after MultiSelect's none, asks for a machine, and never widens", async () => {
    const onChange = jest.fn();
    const user = userEvent.setup();
    render(<Controlled initial={['m1']} onChange={onChange} />);

    await openPicker(user);
    await user.click(screen.getByTestId('change-access-machines-select-none'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([]);
    expect(screen.getByText(PICK_ONE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'some machines' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(WHOLE_SITE_HINT)).not.toBeInTheDocument();
  });

  it('goes from the whole site to one machine through the choice and the picker', async () => {
    const onChange = jest.fn();
    const user = userEvent.setup();
    render(<Controlled initial={null} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'some machines' }));
    expect(screen.getByText(PICK_ONE)).toBeInTheDocument();

    await openPicker(user);
    await user.click(screen.getByRole('checkbox', { name: 'kiosk' }));

    expect(onChange.mock.calls).toEqual([[[]], [['m2']]]);
    expect(screen.queryByText(PICK_ONE)).not.toBeInTheDocument();
  });

  it('disables the choice and the picker when disabled', () => {
    renderField(['m1'], true);

    expect(screen.getByRole('button', { name: 'whole site' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'some machines' })).toBeDisabled();
    expect(picker()).toBeDisabled();
  });
});

describe('isAccessValid', () => {
  it.each<[string, boolean, string[] | null]>([
    ['the whole site', true, null],
    ['no machines', false, []],
    ['one machine', true, ['m1']],
    ['30 machines', true, ids(30)],
    ['31 machines', false, ids(31)],
  ])('%s is valid: %s', (_name, valid, value) => {
    expect(isAccessValid(value)).toBe(valid);
  });
});

describe('accessLabel', () => {
  it.each<[string, string[] | null]>([
    ['whole site', null],
    ['no machines', []],
    ['1 machine', ['m1']],
    ['2 machines', ['m1', 'm2']],
    ['30 machines', ids(30)],
  ])('reads %s', (label, machineIds) => {
    expect(accessLabel(machineIds)).toBe(label);
  });
});

describe('liveMachineIds', () => {
  it('drops ids that are no longer machines of the site, in order', () => {
    expect(liveMachineIds(['m2', 'gone', 'm1'], MACHINES)).toEqual(['m2', 'm1']);
  });

  it('keeps every id that is still a machine', () => {
    expect(liveMachineIds(['m1', 'm2'], MACHINES)).toEqual(['m1', 'm2']);
  });

  it('gives [] when every picked machine has gone', () => {
    expect(liveMachineIds(['gone'], MACHINES)).toEqual([]);
    expect(liveMachineIds(['m1'], [])).toEqual([]);
  });
});
