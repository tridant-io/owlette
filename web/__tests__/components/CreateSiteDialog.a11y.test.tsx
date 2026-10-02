/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The site ID check spoke only in icons: "available" was a green check with no
 * text, and "taken" was a plain red <p> that no screen reader announced and no
 * field pointed at.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CreateSiteDialog } from '@/components/CreateSiteDialog';

let siteExists = false;

// jest.setup mocks `db` to null, which would short-circuit the check.
jest.mock('@/lib/firebase', () => ({ app: null, auth: null, db: {}, isConfigured: true }));
jest.mock('firebase/firestore', () => ({
  doc: jest.fn(() => ({})),
  getDoc: jest.fn(async () => ({ exists: () => siteExists })),
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'creator-uid' } }),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

function renderDialog() {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <CreateSiteDialog open onOpenChange={() => {}} onCreateSite={jest.fn()} />
    </TooltipProvider>,
  );
  return user;
}

describe('CreateSiteDialog — site ID availability', () => {
  it('says the generated ID is available in words, through a status region', async () => {
    siteExists = false;
    renderDialog();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('site ID available'), {
      timeout: 3_000,
    });
  });

  it('announces a taken ID and ties the message to the field', async () => {
    siteExists = true;
    const user = renderDialog();

    await user.click(screen.getByRole('button', { name: /customize site ID/ }));
    const field = screen.getByRole('textbox', { name: 'site ID' });

    const alert = await screen.findByRole('alert', {}, { timeout: 3_000 });
    expect(alert).toHaveTextContent('this site ID is already taken');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('this site ID is already taken');
  });

  it('names the regenerate control and exposes the disclosures as expandable', async () => {
    siteExists = false;
    const user = renderDialog();

    expect(screen.getByRole('button', { name: 'generate new site ID' })).toBeInTheDocument();
    const customize = screen.getByRole('button', { name: /customize site ID/ });
    expect(customize).toHaveAttribute('aria-expanded', 'false');
    await user.click(customize);
    expect(customize).toHaveAttribute('aria-expanded', 'true');
  });
});
