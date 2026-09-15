import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { createMDX } from "fumadocs-mdx/next";
import { version } from "./package.json";

const e2eDistDir = process.env.OWLETTE_NEXT_DIST_DIR;
const allowedDevOrigins = (process.env.NEXT_ALLOWED_DEV_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  reactStrictMode: false,
  // `ai` 7.x and the @ai-sdk/* providers are ESM-only (no CommonJS entry).
  // This is also what makes them testable: next/jest builds its own
  // transformIgnorePatterns and, in its words, "custom config can append to
  // transformIgnorePatterns but not modify it" — a negated pattern in
  // jest.config.js is inert. transpilePackages is the only lever that lets
  // Jest transform them, so removing an entry here breaks 15 suites at load
  // with "Cannot use import statement outside a module".
  transpilePackages: ['ai', '@ai-sdk/react', '@ai-sdk/openai', '@ai-sdk/anthropic', '@ai-sdk/provider-utils', '@ai-sdk/provider', '@ai-sdk/gateway', '@ai-sdk/mcp', '@workflow/serde'],
  ...(e2eDistDir ? { distDir: e2eDistDir } : {}),
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },
  allowedDevOrigins,
  images: {
    formats: ['image/avif', 'image/webp'],
  },
  async redirects() {
    return [
      // cortex -> hoot (3.0.0). Linked from outside the repo.
      {
        source: '/docs/dashboard/cortex',
        destination: '/docs/dashboard/hoot',
        permanent: true,
      },
      {
        source: '/docs/api/cortex',
        destination: '/docs/api/hoot',
        permanent: true,
      },
      {
        source: '/docs/reference/cortex-tools',
        destination: '/docs/reference/hoot-tools',
        permanent: true,
      },
      {
        source: '/owlette/api/developer-preview-checklist',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/owlette/api/status-uptime',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/owlette/api/load-testing',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/owlette/api/launch-assets',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/owlette/api/launch-runbook',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/docs/api/developer-preview-checklist',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/docs/api/status-uptime',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/docs/api/load-testing',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/docs/api/launch-assets',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/docs/api/launch-runbook',
        destination: '/docs/api',
        permanent: true,
      },
      // `/hoot` is canonical; these keep bookmarks and shared links alive. The
      // API keeps its own aliases under `app/api/cortex/*` (hoot/WIRE_NAMES.md).
      {
        source: '/cortex',
        destination: '/hoot',
        permanent: true,
      },
      {
        source: '/cortex/:chatId',
        destination: '/hoot/:chatId',
        permanent: true,
      },
      {
        source: '/owlette',
        destination: '/docs',
        permanent: true,
      },
      {
        source: '/owlette/:path*',
        destination: '/docs/:path*',
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      // Do NOT add a wildcard CORS rule here. One existed for the (now
      // removed, 644c57f) `/api/admin/:path*` namespace and would have silently
      // covered any future route under it. The public API is consumed
      // server-side, so CORS is not needed; scope any browser client explicitly.
      {
        // Static security headers only. CSP lives in proxy.ts because it needs
        // a fresh per-request nonce.
        source: '/:path*',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            // Full URL same-origin, origin only cross-origin.
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          {
            // Legacy, harmless.
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
        ],
      },
    ];
  },
};

const withMDX = createMDX();

export default withSentryConfig(withMDX(nextConfig), {
  silent: true,
  // Bypasses ad-blockers.
  tunnelRoute: "/api/sentry-tunnel",
  // Source maps must not stay publicly reachable after upload.
  sourcemaps: {
    filesToDeleteAfterUpload: [".next/static/**/*.map"],
  },
});
