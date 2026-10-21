/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * EmptyStateUpload: the first-run roost card. Without a new-roost handler (the
 * plan leaves roost out, and the page header says so) it offers no new roost,
 * but still points a site with no machines at the agent.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { EmptyStateUpload } from '@/components/EmptyStateUpload';

describe('EmptyStateUpload', () => {
  it('offers a new roost once a machine is paired', () => {
    render(<EmptyStateUpload machineCount={2} onNewRoost={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'new roost' })).toBeInTheDocument();
  });

  it('leads with the agent while no machine is paired', () => {
    render(<EmptyStateUpload machineCount={0} onNewRoost={jest.fn()} onAddMachine={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'install agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'new roost' })).toBeInTheDocument();
  });

  it('offers no new roost without a handler', () => {
    render(<EmptyStateUpload machineCount={2} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'how roost works' })).toBeInTheDocument();
  });

  it('still points at the agent without a handler', () => {
    render(<EmptyStateUpload machineCount={0} onAddMachine={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'install agent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'new roost' })).not.toBeInTheDocument();
  });
});
