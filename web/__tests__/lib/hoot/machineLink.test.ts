import { hootMachineHref, readHootMachineLink } from '@/lib/hoot/machineLink';

describe('hoot machine link', () => {
  it('round-trips a site and machine, escaping what a url needs escaped', () => {
    const href = hootMachineHref('site A', 'render&01');
    expect(href).toBe('/hoot?site=site+A&machine=render%2601');
    expect(readHootMachineLink(href.slice(href.indexOf('?')))).toEqual({ siteId: 'site A', machineId: 'render&01' });
  });

  it('is no link unless both halves are there', () => {
    expect(readHootMachineLink('')).toBeNull();
    expect(readHootMachineLink('?site=site-A')).toBeNull();
    expect(readHootMachineLink('?machine=render-01')).toBeNull();
    expect(readHootMachineLink('?site=&machine=render-01')).toBeNull();
  });
});
