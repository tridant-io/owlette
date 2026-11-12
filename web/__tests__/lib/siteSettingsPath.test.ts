/** @jest-environment node */

import {
  SITE_SECTIONS,
  movedSiteSectionPath,
  parseSiteSection,
  siteSettingsPath,
} from '@/lib/siteSettingsPath';

describe('siteSettingsPath', () => {
  it('links general with no query, named or not', () => {
    expect(siteSettingsPath('elm-gate')).toBe('/admin/sites/elm-gate');
    expect(siteSettingsPath('elm-gate', 'general')).toBe('/admin/sites/elm-gate');
  });

  it('names every other section in the query', () => {
    expect(siteSettingsPath('elm-gate', 'members')).toBe('/admin/sites/elm-gate?section=members');
    expect(siteSettingsPath('elm-gate', 'machines')).toBe('/admin/sites/elm-gate?section=machines');
    expect(siteSettingsPath('elm-gate', 'danger')).toBe('/admin/sites/elm-gate?section=danger');
  });

  it('encodes the site id', () => {
    expect(siteSettingsPath('elm gate', 'machines')).toBe('/admin/sites/elm%20gate?section=machines');
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
    for (const raw of [null, '', 'billing', 'SWOOP', 'constructor']) {
      expect(parseSiteSection(raw)).toBe('general');
    }
  });
});

describe('movedSiteSectionPath', () => {
  it('sends the old swoop section to swoop settings', () => {
    expect(movedSiteSectionPath('swoop')).toBe('/admin/swoop');
  });

  it('leaves every section still on the page, and anything unknown, where it is', () => {
    for (const raw of [null, '', ...SITE_SECTIONS, 'SWOOP', 'billing']) {
      expect(movedSiteSectionPath(raw)).toBeNull();
    }
  });
});
