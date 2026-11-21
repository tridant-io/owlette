/** @jest-environment node */

/**
 * next.config's response headers: dev.owlette.app tells every search engine
 * not to list it, and owlette.app never does. crawlers were reading dev's
 * /register, and cloudflare's managed robots.txt allows them ahead of the
 * app's own rules, so the header is what keeps dev out of results.
 */

jest.mock('@sentry/nextjs', () => ({ withSentryConfig: (config: unknown) => config }));
jest.mock('fumadocs-mdx/next', () => ({ createMDX: () => (config: unknown) => config }));

import type { NextConfig } from 'next';
import nextConfig from '../next.config';

const original = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  else process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = original;
});

async function robotsTags(): Promise<string[]> {
  const rules = await (nextConfig as NextConfig).headers!();
  return rules.flatMap((rule) =>
    rule.headers
      .filter((header) => header.key.toLowerCase() === 'x-robots-tag')
      .map((header) => `${rule.source} ${header.value}`),
  );
}

describe('next.config headers', () => {
  it('tells every search engine to leave dev out, on every path', async () => {
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'owlette-dev-3838a';
    expect(await robotsTags()).toEqual(['/:path* noindex, nofollow']);
  });

  it('never sends noindex from owlette.app', async () => {
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'owlette-prod-90a12';
    expect(await robotsTags()).toEqual([]);
  });

  it('never sends noindex from a deploy that names no project', async () => {
    delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    expect(await robotsTags()).toEqual([]);
  });
});
