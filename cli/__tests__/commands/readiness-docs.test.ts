import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');

// The CLI docs live in the web app's Fumadocs tree (they were migrated there
// from the old repo-root docs/cli/*.md). Glob the directory instead of
// hard-listing pages so adding or renaming a reference page can never
// silently drop it from these invariants again.
const cliDocsDir = 'web/content/docs/cli';

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf-8');
}

// Paths are joined with forward slashes rather than path.join: they are
// compared against the doc-relative literals below and fed back to
// readRepoFile, and on Windows path.join emitted backslashes that matched
// neither.
function mdxFilesUnder(relativeDir: string): string[] {
  const abs = path.join(repoRoot, relativeDir);
  return readdirSync(abs, { recursive: true, encoding: 'utf-8' })
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => `${relativeDir}/${f.split(path.sep).join('/')}`)
    .sort();
}

describe('CLI readiness docs', () => {
  const docPaths = ['cli/README.md', ...mdxFilesUnder(cliDocsDir)];
  const docs = docPaths.map(readRepoFile).join('\n');

  it('actually found the docs set (guards against the tree moving again)', () => {
    expect(docPaths).toContain(`${cliDocsDir}/overview.mdx`);
    expect(docPaths).toContain(`${cliDocsDir}/readiness.mdx`);
    expect(docPaths.length).toBeGreaterThan(5);
  });

  it('does not point CLI readers at old implementation tracks', () => {
    const staleNeedles = [
      ['dev/active', 'live-view-webrtc'].join('/'),
      ['dev/active', 'owlette-cli'].join('/'),
      ['api', 'sprint'].join('-'),
      ['classic installer', 'stub group'].join(' '),
    ];
    for (const stale of staleNeedles) {
      expect(docs).not.toContain(stale);
    }
    expect(docs).not.toMatch(new RegExp(`${['roost', 'public', 'api'].join('-')} W\\d`, 'i'));
  });

  it('documents rollback as the registered top-level command', () => {
    expect(docs).not.toContain(['owlette roost', 'rollback'].join(' '));
    expect(existsSync(path.join(repoRoot, `${cliDocsDir}/reference/rollback.mdx`))).toBe(true);
    expect(readRepoFile(`${cliDocsDir}/readiness.mdx`)).toContain('owlette rollback <roostId>');
  });

  it('captures the only shipped CLI stub and the planned webhook noun', () => {
    const readiness = readRepoFile(`${cliDocsDir}/readiness.mdx`);
    expect(readiness).toContain('machine live-view');
    expect(readiness).toContain('public-api deferred: swoop');
    expect(readiness).toContain('`owlette webhook` is not registered');
  });
});
