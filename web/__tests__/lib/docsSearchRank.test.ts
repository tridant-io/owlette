import { titleFirst, type SearchRow } from '@/lib/docsSearchRank';

const page = (url: string, title: string): SearchRow => ({ type: 'page', url, content: title });
const text = (url: string, content: string): SearchRow => ({ type: 'text', url: `${url}#s`, content });

// the engine's order for "roost" before the fix: pages that repeat the word in
// short code blocks first, the page titled "roost" past the cut.
const engineOrder: SearchRow[] = [
  page('/docs/cli/readiness', 'cli readiness matrix'),
  text('/docs/cli/readiness', '`owlette roost get <roostId>`'),
  text('/docs/cli/readiness', '`owlette roost diff <roostId>`'),
  page('/docs/api/examples/nightly-sync', 'nightly directory sync'),
  text('/docs/api/examples/nightly-sync', 'roost=<roost-id>:write'),
  page('/docs/cli/reference/roost', 'roost'),
  text('/docs/cli/reference/roost', '`roost list` — list roosts'),
  page('/docs/dashboard/roost', 'roost'),
  text('/docs/dashboard/roost', 'Click `new roost`.'),
];

describe('titleFirst', () => {
  it('moves pages whose title carries every query word to the front, shallowest url first', () => {
    const urls = titleFirst(engineOrder, 'roost', 24).map((r) => r.url);
    expect(urls).toEqual([
      '/docs/dashboard/roost',
      '/docs/dashboard/roost#s',
      '/docs/cli/reference/roost',
      '/docs/cli/reference/roost#s',
      '/docs/cli/readiness',
      '/docs/cli/readiness#s',
      '/docs/cli/readiness#s',
      '/docs/api/examples/nightly-sync',
      '/docs/api/examples/nightly-sync#s',
    ]);
  });

  it('keeps a page with its sections when the cut falls inside the reordered list', () => {
    const rows = titleFirst(engineOrder, 'roost', 3);
    expect(rows.map((r) => r.url)).toEqual([
      '/docs/dashboard/roost',
      '/docs/dashboard/roost#s',
      '/docs/cli/reference/roost',
    ]);
  });

  it('needs every word of a multi-word query in the title, ignoring case and one-letter words', () => {
    const rows: SearchRow[] = [
      page('/docs/api/examples/auto-rollback', 'auto rollback'),
      page('/docs/cli/reference/rollback', 'Rollback a Deploy'),
    ];
    expect(titleFirst(rows, 'rollback a deploy', 24).map((r) => r.url)).toEqual([
      '/docs/cli/reference/rollback',
      '/docs/api/examples/auto-rollback',
    ]);
  });

  it('leaves the engine order alone when no title matches, and for an empty query', () => {
    const rows: SearchRow[] = [
      page('/docs/a', 'alpha'),
      text('/docs/a', 'npx owlette'),
      page('/docs/b', 'beta'),
    ];
    expect(titleFirst(rows, 'npx', 24)).toEqual(rows);
    expect(titleFirst(rows, ' ', 2)).toEqual(rows.slice(0, 2));
  });

  it('keeps leading section rows that arrive without a page row', () => {
    const rows: SearchRow[] = [text('/docs/x', 'stray'), page('/docs/roost', 'roost')];
    expect(titleFirst(rows, 'roost', 24).map((r) => r.url)).toEqual(['/docs/roost', '/docs/x#s']);
  });
});
