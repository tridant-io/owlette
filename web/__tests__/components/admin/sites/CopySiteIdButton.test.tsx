/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the site ID button the site list and a site's settings page share: named for
 * its site, showing the ID unless the caller passes what to show, the caller's
 * classes beside its own, and the copy with its two toasts.
 */

import type { ComponentProps } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from '@/lib/toast';
import { CopySiteIdButton } from '@/components/admin/sites/CopySiteIdButton';

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

function renderButton(props: Partial<ComponentProps<typeof CopySiteIdButton>> = {}) {
  const user = userEvent.setup();
  render(<CopySiteIdButton siteId="site-a" {...props} />);
  return user;
}

const button = () => screen.getByRole('button', { name: 'copy site ID site-a' });

describe('CopySiteIdButton', () => {
  it('is named for its site and shows the ID', () => {
    renderButton();

    expect(button()).toHaveTextContent(/^site-a$/);
  });

  it('shows what the caller passes in place of the ID, and keeps its name', () => {
    renderButton({ children: <mark>site</mark> });

    expect(button()).toHaveTextContent(/^site$/);
    expect(screen.getByText('site', { selector: 'mark' })).toBeInTheDocument();
  });

  it("takes the caller's classes beside its own", () => {
    renderButton({ className: 'truncate' });

    expect(button()).toHaveClass('font-mono', 'truncate');
  });

  it('copies the ID and says so', async () => {
    const user = renderButton();

    await user.click(button());

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('site ID copied'));
    expect(await navigator.clipboard.readText()).toBe('site-a');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says when the clipboard refuses', async () => {
    const user = renderButton();
    jest
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValue(new DOMException('clipboard refused', 'NotAllowedError'));

    await user.click(button());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('could not copy the site ID'));
    expect(toast.success).not.toHaveBeenCalled();
  });
});
