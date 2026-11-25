/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the titled card the admin pages share: its h2 names the section, and the
 * danger tone marks the one that cannot be taken back.
 */
import { render, screen, within } from '@testing-library/react';
import { Panel } from '@/components/admin/Panel';

describe('Panel', () => {
  it('is a section labelled by its h2', () => {
    render(
      <Panel id="issue-text-heading" title="description" className="order-1">
        <p>touchdesigner restarts every few minutes</p>
      </Panel>,
    );
    const section = screen.getByRole('region', { name: 'description' });
    const heading = within(section).getByRole('heading', { level: 2, name: 'description' });
    expect(heading).toHaveAttribute('id', 'issue-text-heading');
    expect(section).toHaveAttribute('aria-labelledby', 'issue-text-heading');
    expect(heading).toHaveClass('text-foreground');
    expect(section).toHaveClass('border-border', 'order-1');
    expect(within(section).getByText('touchdesigner restarts every few minutes')).toBeInTheDocument();
  });

  it('turns the heading and the border to danger in the danger tone', () => {
    render(
      <Panel id="site-danger-heading" title="danger zone" tone="danger">
        <p>delete this site</p>
      </Panel>,
    );
    const section = screen.getByRole('region', { name: 'danger zone' });
    const heading = within(section).getByRole('heading', { level: 2 });
    expect(heading).toHaveClass('text-danger');
    expect(heading).not.toHaveClass('text-foreground');
    expect(section).toHaveClass('border-danger-border');
    expect(section).not.toHaveClass('border-border');
  });

  it('renders the description and the actions, and only the title names it', () => {
    render(
      <Panel
        id="site-members-heading"
        title="members"
        description="who can reach this site"
        actions={<button type="button">add member</button>}
      >
        <p>no members yet</p>
      </Panel>,
    );
    const section = screen.getByRole('region', { name: 'members' });
    expect(within(section).getByText('who can reach this site')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'add member' })).toBeInTheDocument();
  });
});
