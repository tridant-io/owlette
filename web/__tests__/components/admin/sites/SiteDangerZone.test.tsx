/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the site settings page's danger zone. the delete waits for the server inside
 * its own dialog, which stays open when it fails, and the copy says what the
 * cascade takes without claiming any data is left behind.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SiteDangerZone } from '@/components/admin/sites/SiteDangerZone';
import { toast } from '@/lib/toast';

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

const SITE = { id: 'elm-gate', name: 'LIVE NATION' };

function renderZone(onDelete: (siteId: string) => Promise<void> = jest.fn(() => Promise.resolve())) {
  const user = userEvent.setup();
  const onDeleted = jest.fn();
  render(<SiteDangerZone site={SITE} onDelete={onDelete} onDeleted={onDeleted} />);
  return { user, onDelete, onDeleted };
}

async function openConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'delete site' }));
  return screen.getByRole('dialog', { name: 'delete site' });
}

describe('SiteDangerZone', () => {
  it('names the site and its ID, says what the delete takes, and never says data may remain', async () => {
    const { user } = renderZone();

    const zone = screen.getByRole('region', { name: 'danger zone' });
    expect(within(zone).getByRole('heading', { level: 2 })).toHaveAttribute('id', 'site-section-danger');
    expect(zone).toHaveTextContent('delete this site');
    expect(zone).toHaveTextContent(
      "removes its machines and their history, its roosts, talons and webhooks, and everyone's access to it.",
    );

    const dialog = await openConfirm(user);
    expect(dialog).toHaveAccessibleDescription("delete LIVE NATION? this can't be undone.");
    expect(dialog).toHaveTextContent(
      "its machines lose their agent tokens and stop reporting until someone pairs them to another site. the site ID elm-gate is retired and can't be used again.",
    );
    expect(document.body).not.toHaveTextContent(/may remain/i);
  });

  it('calls onDelete, then toasts, then calls onDeleted, and holds the dialog while the delete runs', async () => {
    let finish!: () => void;
    const onDelete = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { user, onDeleted } = renderZone(onDelete);

    const dialog = await openConfirm(user);
    await user.click(within(dialog).getByRole('button', { name: 'delete site' }));

    expect(onDelete).toHaveBeenCalledWith('elm-gate');
    expect(within(dialog).getByRole('button', { name: 'deleting…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'delete site' })).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();

    await act(async () => finish());

    expect(toast.success).toHaveBeenCalledWith('site deleted', {
      description: 'LIVE NATION and everything on it are gone.',
    });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    const [deleteAt] = onDelete.mock.invocationCallOrder;
    const [toastAt] = jest.mocked(toast.success).mock.invocationCallOrder;
    const [deletedAt] = onDeleted.mock.invocationCallOrder;
    expect(deleteAt).toBeLessThan(toastAt);
    expect(toastAt).toBeLessThan(deletedAt);
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cancel closes the dialog and calls neither onDelete nor onDeleted', async () => {
    const { user, onDelete, onDeleted } = renderZone();

    const dialog = await openConfirm(user);
    await user.click(within(dialog).getByRole('button', { name: 'cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('toasts the server detail on a failure and leaves the dialog open to try again', async () => {
    const onDelete = jest.fn(() => Promise.reject(new Error('capability not granted')));
    const { user, onDeleted } = renderZone(onDelete);

    const dialog = await openConfirm(user);
    await user.click(within(dialog).getByRole('button', { name: 'delete site' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('could not delete the site', { description: 'capability not granted' }),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'delete site' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'delete site' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'cancel' })).toBeEnabled();
  });
});
