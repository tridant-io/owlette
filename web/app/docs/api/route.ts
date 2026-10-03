import { ApiReference } from '@scalar/nextjs-api-reference';
import type { NextRequest } from 'next/server';
import { FALLBACK_THEME, THEME_STORAGE_KEY } from '@/lib/theme';

/**
 * owlette branding layered onto the Scalar theme. Selectors were verified
 * against the rendered Scalar DOM, not guessed:
 *  - `.t-doc__sidebar` is a column flex container, so `::before` becomes its
 *    first item and pins the wordmark above the search row.
 *  - The `.scalar-app` prefix on `.section-header` is needed to outrank
 *    Scalar's own `.section-header[data-v-…]` rule.
 *  - Scalar renders headings and body copy at the same `--scalar-color-1`.
 *    Its markdown headings/paragraphs set no `color`, so dimming `.markdown`
 *    to `--scalar-color-2` and re-asserting `-1` on headings restores contrast.
 */
const CUSTOM_CSS = `
/* the app palette for each scalar mode. this page sits outside the root layout,
   so globals.css never loads here: the values are copied from its .dark and
   :root tokens (background, secondary, accent, foreground, muted-foreground,
   accent-cyan, border), and a unit test keeps them equal. unlayered, so they
   outrank the kepler theme scalar injects inside @layer scalar-theme */
.dark-mode {
  --scalar-background-1: oklch(0.145 0.03 250);
  --scalar-background-2: oklch(0.269 0.05 250);
  --scalar-background-3: oklch(0.35 0.08 250);
  --scalar-color-1: oklch(0.985 0.01 250);
  --scalar-color-2: oklch(0.708 0.05 250);
  --scalar-color-accent: oklch(0.75 0.18 195);
  --scalar-border-color: oklch(0.35 0.08 250);
}
.light-mode {
  --scalar-background-1: oklch(0.975 0.006 250);
  --scalar-background-2: oklch(0.94 0.012 250);
  --scalar-background-3: oklch(0.92 0.02 250);
  --scalar-color-1: oklch(0.21 0.03 258);
  --scalar-color-2: oklch(0.42 0.032 256);
  --scalar-color-accent: oklch(0.48 0.105 218);
  --scalar-border-color: oklch(0.88 0.016 250);
}
.dark-mode,
.light-mode {
  --scalar-color-3: color-mix(in oklab, var(--scalar-color-2) 70%, transparent);
  --scalar-background-accent: color-mix(in oklab, var(--scalar-color-accent) 12%, transparent);
}

/* paints the page in its mode while the scalar bundle is still loading */
body {
  background-color: var(--scalar-background-1);
}

/* owl mark + wordmark, pinned to the top-left of the sidebar */
.t-doc__sidebar::before {
  content: 'owlette api';
  display: block;
  margin: 14px 12px 8px;
  padding-left: 30px;
  min-height: 24px;
  line-height: 24px;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--scalar-color-1);
  background: url('/owlette-eye.svg') left center / 22px 22px no-repeat;
}

/* margin-top opens a gap from the badge row above, which has none of its own */
.scalar-app .introduction-section .section-header {
  font-size: 36px;
  line-height: 1.15;
  margin-top: 12px;
}

/* headings at full strength, body copy dimmed */
.scalar-app .markdown {
  color: var(--scalar-color-2);
}
.scalar-app .markdown :is(h1, h2, h3, h4, h5, h6) {
  color: var(--scalar-color-1);
}
`;

/**
 * the page follows the app's theme choice, applied at the top of <body> so the
 * first frame is already in the right mode, ahead of scalar's deferred script.
 *  - scalar takes its mode from `localStorage.colorMode` ('dark' | 'light' |
 *    'system'), ranked after `forceDarkModeState` and before `darkMode`
 *    (@scalar/use-hooks useColorMode). handing it 'system' lets scalar's own
 *    matchMedia listener follow a live os change.
 *  - the body class is scalar's own ('dark-mode' / 'light-mode'), so its mount
 *    swaps the same classes instead of fighting a second set.
 *  - 'system' resolves through prefers-color-scheme as next-themes does, and
 *    falls back to dark without matchMedia, as the app does.
 */
const THEME_BOOTSTRAP = `(function () {
  var choice = null;
  try { choice = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}); } catch (e) {}
  if (choice !== "dark" && choice !== "light") choice = "system";
  try { localStorage.setItem("colorMode", choice); } catch (e) {}
  var mode = choice;
  if (mode === "system") {
    var media = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
    mode = media ? (media.matches ? "dark" : "light") : ${JSON.stringify(FALLBACK_THEME)};
  }
  document.body.classList.add(mode + "-mode");
})();`;

/**
 * GET /docs/api — interactive Scalar API reference.
 *
 * Scalar emits two un-nonced <script> tags, and our `strict-dynamic` CSP runs
 * ONLY nonce-bearing scripts (the host allowlist is ignored), so the page
 * rendered blank. Scalar v0.10.x has no nonce option, so we stamp the
 * per-request nonce from the proxy's `x-nonce` header onto every <script>,
 * the theme bootstrap included; strict-dynamic then covers dynamically-loaded
 * chunks too.
 *
 * Reading that header forces the route dynamic, which is what keeps the stamped
 * nonce matching the CSP header of the same request.
 */
const renderReference = ApiReference({
  url: '/api/openapi',
  title: 'owlette API Reference',
  theme: 'kepler',
  // the mode is the app's theme choice (THEME_BOOTSTRAP), never scalar's own toggle
  hideDarkModeToggle: true,
  hideDownloadButton: false,
  favicon: '/owlette-eye.svg',
  customCss: CUSTOM_CSS,
  metaData: {
    title: 'owlette API Reference',
    description: 'Interactive API documentation for the owlette fleet management platform',
  },
});

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const nonce = request.headers.get('x-nonce');
  const html = (await renderReference().text()).replace(
    '<body>',
    `<body>\n    <script>${THEME_BOOTSTRAP}</script>`,
  );
  const body = nonce
    ? html.replace(/<script\b/g, `<script nonce="${nonce}"`)
    : html;

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
