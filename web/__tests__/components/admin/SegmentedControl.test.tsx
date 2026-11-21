/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the admin pages' one-of-several switch: toggle buttons in a named group,
 * exactly one of them pressed.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SegmentedControl } from '@/components/admin/SegmentedControl';

const SECTIONS = [
  { value: 'general', label: 'general' },
  { value: 'members', label: 'members' },
  { value: 'swoop', label: 'swoop & screens' },
] as const;

type Section = (typeof SECTIONS)[number]['value'];

function renderControl(value: Section) {
  const onChange = jest.fn();
  render(<SegmentedControl label="section" options={SECTIONS} value={value} onChange={onChange} />);
  return { onChange };
}

describe('SegmentedControl', () => {
  it('is a group named by its label, with a button per option', () => {
    renderControl('members');
    const group = screen.getByRole('group', { name: 'section' });
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'general',
      'members',
      'swoop & screens',
    ]);
  });

  it('presses only the chosen option', () => {
    renderControl('members');
    const pressed = screen.getAllByRole('button', { pressed: true });
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toHaveAccessibleName('members');
    expect(screen.getByRole('button', { name: 'general' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'swoop & screens' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls onChange with the value of the option clicked, not its label', async () => {
    const { onChange } = renderControl('members');
    await userEvent.click(screen.getByRole('button', { name: 'swoop & screens' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('swoop');
  });
});
