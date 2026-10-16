/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the site footer (docs, privacy, terms, for AI, source) has no place inside owlette swoop: the
 * app's window is not a web page, so it renders nothing there on any route. a browser keeps it.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

let platform: 'windows' | 'mac' | null = null;
jest.mock('@/lib/swoop/viewerApp', () => ({
  viewerAppPlatform: () => platform,
}));

let pathname = '/login';
jest.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

import { Footer } from '@/components/Footer';

describe('Footer', () => {
  it.each([
    ['windows', '/login'],
    ['windows', '/register'],
    ['mac', '/app-link/approve'],
    ['mac', '/dashboard'],
  ] as const)('renders nothing inside owlette swoop on %s at %s', (app, path) => {
    platform = app;
    pathname = path;
    const { container } = render(<Footer />);

    expect(container).toBeEmptyDOMElement();
  });

  it('carries the site links in a browser', () => {
    platform = null;
    pathname = '/login';
    render(<Footer />);

    expect(screen.getByRole('link', { name: 'privacy' })).toHaveAttribute('href', '/privacy');
    expect(screen.getByRole('link', { name: 'docs' })).toBeInTheDocument();
  });
});
