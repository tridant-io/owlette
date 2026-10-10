/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * owlette swoop is told apart on the server, from the request's user agent
 * (the root layout's ViewerAppProvider), so the hooks answer the same in the
 * server render and in hydration: the app's pages are the app's on first paint,
 * with no browser layout to flash first. outside the provider (a bare test
 * render) navigator still decides, after hydration.
 */

import { Profiler, type ReactElement } from 'react';
import { act, render, screen } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server.node';
import { ViewerAppProvider } from '@/contexts/ViewerAppContext';
import { useViewerAppNativeKeys, useViewerAppPlatform } from '@/hooks/useViewerAppPlatform';

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36';
const APP_KEYS = `${CHROME} owlette-swoop-viewer/4.1.8 (keys)`;

function Probe() {
  const platform = useViewerAppPlatform();
  const nativeKeys = useViewerAppNativeKeys();
  return <span data-testid="probe">{`${platform ?? 'browser'} ${nativeKeys ? 'keys' : 'no keys'}`}</span>;
}

/** hydrates the server's html for the tree, as a page load does: the text served, the text after, and the commits. */
async function hydrate(tree: ReactElement) {
  const container = document.createElement('div');
  container.innerHTML = renderToString(tree);
  document.body.appendChild(container);
  const served = container.textContent;
  // a second commit is the page repainting what the server sent
  const onRender = jest.fn();
  const onRecoverableError = jest.fn();
  await act(async () => {
    hydrateRoot(container, <Profiler id="probe" onRender={onRender}>{tree}</Profiler>, { onRecoverableError });
  });
  return { served, text: container.textContent, commits: onRender.mock.calls.length, onRecoverableError };
}

afterEach(() => {
  jest.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('inside the provider', () => {
  it("the server's html is already the app's", () => {
    const html = renderToString(
      <ViewerAppProvider platform="mac" nativeKeys>
        <Probe />
      </ViewerAppProvider>,
    );
    expect(html).toContain('mac keys');
  });

  it('hydrates to the same answer in one render, so nothing flashes', async () => {
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_KEYS);
    const result = await hydrate(
      <ViewerAppProvider platform="windows" nativeKeys>
        <Probe />
      </ViewerAppProvider>,
    );
    expect(result.served).toBe('windows keys');
    expect(result.text).toBe('windows keys');
    expect(result.commits).toBe(1);
    expect(result.onRecoverableError).not.toHaveBeenCalled();
  });

  it("a browser's request stays the browser's page", async () => {
    const result = await hydrate(
      <ViewerAppProvider platform={null} nativeKeys={false}>
        <Probe />
      </ViewerAppProvider>,
    );
    expect(result.served).toBe('browser no keys');
    expect(result.text).toBe('browser no keys');
    expect(result.commits).toBe(1);
  });
});

describe('outside the provider', () => {
  it('the server knows no app and navigator corrects it after hydration', async () => {
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_KEYS);
    const result = await hydrate(<Probe />);
    expect(result.served).toBe('browser no keys');
    expect(result.text).toBe('windows keys');
    expect(result.commits).toBe(2);
  });

  it('a client render reads navigator', () => {
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_KEYS);
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('windows keys');
  });
});
