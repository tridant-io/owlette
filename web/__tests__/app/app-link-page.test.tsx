/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * `/app-link` only ever opens inside owlette swoop, so it wears owlette swoop's
 * small eye, never owlette's full one.
 */

import React from 'react';
import { render } from '@testing-library/react';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams('code=pending'),
}));

jest.mock('@/contexts/AuthContext', () => ({
  // still resolving, so the page holds on its loading shell and calls nothing
  useAuth: () => ({ user: null, loading: true }),
}));

import AppLinkPage from '@/app/app-link/page';

describe('/app-link', () => {
  it("carries owlette swoop's own small eye", () => {
    render(<AppLinkPage />);
    expect(document.querySelector('img[src*="owlette-swoop-icon.png"]')).toBeInTheDocument();
  });
});
