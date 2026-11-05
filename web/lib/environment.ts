/**
 * Which owlette server the browser is currently talking to, derived from the
 * request host.
 *
 * Deliberately separate from `RoostEnv` / `currentEnv()` in `r2Client.server.ts`
 * (and from the four other `process.env`-based environment resolvers in `web/`):
 * those answer "which environment is this *deployment*", which is by definition
 * always self-consistent. These two answer "which environment is the operator
 * *looking at*" — the only input that can catch a dev/prod mismatch in the
 * browser, e.g. a pairing phrase minted on dev being pasted into a prod install.
 *
 * Pure functions: no React, no Firebase, no `process.env`, no `window`. Callers
 * pass the host in (`window.location.host`) so this stays testable and
 * SSR-safe.
 */

/** Production dashboard host — the one environment that gets no badge and no flag. */
const PROD_HOST = 'owlette.app';

/** Development dashboard host. */
const DEV_HOST = 'dev.owlette.app';

/**
 * `'dev'` for dev.owlette.app, `null` for owlette.app, the bare host otherwise.
 *
 * The `null` is not an oversight and must not be "aligned" with `RoostEnv`'s
 * `'prod'`: the consumer is a badge that has to render *nothing* on production.
 * An empty/unknown host is also `null` — a badge reading "" is a visual artifact,
 * not information.
 */
export function environmentToken(host: string): string | null {
  const normalized = (host ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === DEV_HOST) return 'dev';
  if (normalized === PROD_HOST) return null;
  return normalized;
}

/**
 * The `/SERVER=` flag the silent-install command needs for this dashboard host.
 *
 * `' /SERVER=dev'` on dev.owlette.app; `''` on owlette.app (the installer already
 * defaults to prod) and on any host the installer cannot target — localhost,
 * preview deploys — because the flag accepts only `dev|prod`.
 *
 * Includes its own leading space so callers can concatenate unconditionally.
 */
export function serverFlagFor(host: string): string {
  return isDevHost(host) ? ' /SERVER=dev' : '';
}

/**
 * The `config/pairing.json` preseed that spends `phrase` on macOS and Linux —
 * their only way to use a generated phrase unattended.
 *
 * Names the dev server exactly when `serverFlagFor` does; without it a machine
 * that was never paired pairs with owlette.app. Spaced like the installation
 * docs so the two read the same.
 */
export function pairingPreseedFor(phrase: string, host: string): string {
  const server = isDevHost(host) ? ', "server": "dev"' : '';
  return `{"phrase": ${JSON.stringify(phrase)}${server}}`;
}

/** The one rule both install commands use to decide they must name dev. */
function isDevHost(host: string): boolean {
  return environmentToken(host) === 'dev';
}
