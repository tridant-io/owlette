/**
 * Canonical GitHub coordinates for this repository.
 *
 * The owner/repo pair is owned by the root package.json `repository.url`;
 * `scripts/sync-repo-refs.mjs` propagates it here and into every file that
 * can't import TypeScript (Cargo.toml, the Inno Setup script, docs MDX,
 * the published workflow examples).
 *
 * Nothing else in `web/` should spell the owner out — import from here so a
 * repository transfer is a one-line change plus one script run, and so the
 * landing components and the e2e specs that assert their hrefs can never
 * drift apart.
 */

// -- synced from root package.json by scripts/sync-repo-refs.mjs --
export const GITHUB_OWNER = 'tridant-io';
export const GITHUB_REPO = 'owlette';
// -- end synced block --

/** Branch that permalinks resolve against. */
export const GITHUB_DEFAULT_BRANCH = 'main';

export const GITHUB_REPO_SLUG = `${GITHUB_OWNER}/${GITHUB_REPO}`;
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO_SLUG}`;
export const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;
export const GITHUB_RELEASES_URL = `${GITHUB_REPO_URL}/releases`;

/** Permalink to a file at the default branch, e.g. `LICENSE`. */
export function githubBlobUrl(path: string): string {
  return `${GITHUB_REPO_URL}/blob/${GITHUB_DEFAULT_BRANCH}/${path}`;
}

/** Permalink to a directory at the default branch, e.g. `cli`. */
export function githubTreeUrl(path: string): string {
  return `${GITHUB_REPO_URL}/tree/${GITHUB_DEFAULT_BRANCH}/${path}`;
}

export const LICENSE_URL = githubBlobUrl('LICENSE');
export const CLI_DIR_URL = githubTreeUrl('cli');

/**
 * `uses:` reference for the published roost deploy composite action. Customer
 * workflows pin this string, so it also appears verbatim in the docs and in
 * `examples/github-actions/` — the sync script keeps those in step.
 */
export const ROOST_DEPLOY_ACTION_REF = `${GITHUB_REPO_SLUG}/.github/actions/owlette-roost-deploy@${GITHUB_DEFAULT_BRANCH}`;
