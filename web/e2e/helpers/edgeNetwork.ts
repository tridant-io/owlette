/**
 * the edge's half of swoop's network binding, for specs that play cloudflare.
 *
 * both e2e servers hold this as `EDGE_SHARED_SECRET`; the second one, on the
 * port after the suite's, runs with `SWOOP_NETWORK_BINDING=enforce`
 * (playwright.config.ts) while the suite's own server keeps the default, `log`.
 */

export const E2E_EDGE_SECRET = 'e2e-edge-shared-secret-for-playwright-only';

export const E2E_ENFORCE_PORT = (Number(process.env.E2E_PORT) || 3100) + 1;

/** what the edge adds to a request from `asn`. */
export function edgeHeaders(asn: string): Record<string, string> {
  return { 'x-owlette-edge': E2E_EDGE_SECRET, 'x-owlette-asn': asn };
}
