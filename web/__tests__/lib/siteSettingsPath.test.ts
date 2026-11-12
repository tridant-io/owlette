/** @jest-environment node */

import { SITE_SECTIONS, parseSiteSection, siteSettingsPath } from '@/lib/siteSettingsPath';

describe('siteSettingsPath', () => {
  it('links general with no query, named or not', () => {
    expect(siteSettingsPath('elm-gate')).toBe('/admin/sites/elm-gate');
    expect(siteSettingsPath('elm-gate', 'general')).toBe('/admin/sites/elm-gate');
  });

  it('names every other section in the query', () => {
    expect(siteSettingsPath('elm-gate', 'members')).toBe('/admin/sites/elm-gate?section=members');
    expect(siteSettingsPath('elm-gate', 'machines')).toBe('/admin/sites/elm-gate?section=machines');
    expect(siteSettingsPath('elm-gate', 'swoop')).toBe('/admin/sites/elm-gate?section=swoop');
    expect(siteSettingsPath('elm-gate', 'billing')).toBe('/admin/sites/elm-gate?section=billing');
    expect(siteSettingsPath('elm-gate', 'danger')).toBe('/admin/sites/elm-gate?section=danger');
  });

  it('encodes the site id', () => {
    expect(siteSettingsPath('elm gate', 'swoop')).toBe('/admin/sites/elm%20gate?section=swoop');
  });
});

describe('parseSiteSection', () => {
  it('reads every section back from the link that names it', () => {
    for (const section of SITE_SECTIONS) {
      const url = new URL(siteSettingsPath('elm-gate', section), 'https://owlette.app');
      expect(parseSiteSection(url.searchParams.get('section'))).toBe(section);
    }
  });

  it('falls back to general for a missing or unknown section', () => {
    for (const raw of [null, '', 'plan', 'SWOOP', 'constructor']) {
      expect(parseSiteSection(raw)).toBe('general');
    }
  });
});
