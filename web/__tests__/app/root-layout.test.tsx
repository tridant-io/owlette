/** @jest-environment node */

/**
 * the root layout tells owlette swoop apart from the request's user agent and
 * hands the answer to every page, and to the footer, through ViewerAppProvider,
 * so the server's html is already the app's page (no browser layout first).
 */

import { isValidElement, type ReactElement, type ReactNode } from 'react';

let userAgent: string | null = null;
jest.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name === 'user-agent' ? userAgent : null) }),
}));
jest.mock('next/font/google', () => ({
  Geist: () => ({ variable: 'font-geist' }),
  Geist_Mono: () => ({ variable: 'font-geist-mono' }),
}));

import RootLayout from '@/app/layout';
import { Footer } from '@/components/Footer';
import { ViewerAppProvider } from '@/contexts/ViewerAppContext';

const CHROME = 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MAC = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${CHROME}`;
const WINDOWS = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME}`;
const LINUX = `Mozilla/5.0 (X11; Linux x86_64) ${CHROME}`;
const PAGE = 'the page';

/** the first node in the element tree that matches, or null. */
function find(node: ReactNode, match: (node: ReactNode) => boolean): ReactNode {
  if (match(node)) return node;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match);
      if (found != null) return found;
    }
    return null;
  }
  return isValidElement(node) ? find((node.props as { children?: ReactNode }).children, match) : null;
}

const ofType = (type: unknown) => (node: ReactNode) => isValidElement(node) && node.type === type;

async function providerFor(ua: string | null) {
  userAgent = ua;
  const tree = await RootLayout({ children: PAGE });
  const provider = find(tree, ofType(ViewerAppProvider)) as ReactElement | null;
  if (!provider) throw new Error('no ViewerAppProvider in the root layout');
  return provider.props as { platform: unknown; nativeKeys: unknown; children: ReactNode };
}

it.each([
  ['a mac app with its keys', `${MAC} owlette-swoop-viewer/4.1.8 (keys)`, 'mac', true],
  ['a windows app without them', `${WINDOWS} owlette-swoop-viewer/4.1.8`, 'windows', false],
  ['a linux app', `${LINUX} owlette-swoop-viewer/4.1.8 (keys)`, 'linux', true],
  ['a browser', WINDOWS, null, false],
  ['no user agent at all', null, null, false],
])('passes %s from the request header', async (_case, ua, platform, nativeKeys) => {
  const provider = await providerFor(ua);
  expect(provider.platform).toBe(platform);
  expect(provider.nativeKeys).toBe(nativeKeys);
});

it('wraps the page and the footer, which both branch on the app', async () => {
  const provider = await providerFor(WINDOWS);
  expect(find(provider.children, ofType(Footer))).not.toBeNull();
  expect(find(provider.children, (node) => node === PAGE)).toBe(PAGE);
});
