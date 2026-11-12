/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the no-sites card on a site-scoped page: today's copy for a caller with no
 * sites, and the whole-site copy for one limited to some machines on each.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { NoSitesEmptyState } from '@/components/NoSitesEmptyState';

describe('NoSitesEmptyState', () => {
  it('tells a caller with no sites how to get one', () => {
    render(<NoSitesEmptyState action="manage roosts" />);

    expect(screen.getByText('no sites available')).toBeInTheDocument();
    expect(
      screen.getByText(
        'you need site access to manage roosts. create a site from the dashboard, or ask a site admin to add you.',
      ),
    ).toBeInTheDocument();
  });

  it('tells a caller limited to some machines that the page needs the whole site', () => {
    render(<NoSitesEmptyState action="manage talons" limited />);

    expect(screen.getByText('this page needs whole-site access')).toBeInTheDocument();
    expect(
      screen.getByText(
        'you reach only some machines on your sites. ask a site admin if you need to manage talons.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('no sites available')).toBeNull();
  });
});
