/**
 * /sitemap.xml lists every page worth indexing (/for-ai calls it "every
 * indexable page"): the docs and the legal pages too, and never a redirect.
 */
jest.mock('@/lib/source', () => ({
  source: { getPages: () => [{ url: '/docs' }, { url: '/docs/getting-started' }] },
}));

import sitemap from '@/app/sitemap';

const urls = () => sitemap().map((entry) => entry.url);

it('lists every docs page', () => {
  expect(urls()).toEqual(
    expect.arrayContaining(['https://owlette.app/docs', 'https://owlette.app/docs/getting-started']),
  );
});

it('lists the legal pages', () => {
  expect(urls()).toEqual(
    expect.arrayContaining([
      'https://owlette.app/privacy',
      'https://owlette.app/terms',
      'https://owlette.app/legal/dmca',
    ]),
  );
});

it('leaves out /download, a redirect to a file or to sign-in', () => {
  expect(urls()).not.toContain('https://owlette.app/download');
});
