import { isViewerApp, viewerAppHasNativeKeys, viewerAppLink, viewerAppPlatform } from '@/lib/swoop/viewerApp';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
const APP = `${CHROME} owlette-swoop-viewer/4.1.8`;
// base64url, as the app-link route mints them
const CODE = 'Zm9vYmFyYmF6cXV4-_0123456789abcdefABCDEF';

describe('viewerApp', () => {
  afterEach(() => jest.restoreAllMocks());

  it('tells the app from a browser by its ua token', () => {
    expect(isViewerApp(CHROME)).toBe(false);
    expect(isViewerApp(APP)).toBe(true);
    expect(isViewerApp('')).toBe(false);
  });

  it('reads navigator.userAgent when no ua is given', () => {
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP);
    expect(isViewerApp()).toBe(true);
    expect(viewerAppPlatform()).toBe('windows');
  });

  it("names the app's platform from the ua it builds on each, and nothing in a browser", () => {
    const token = ' owlette-swoop-viewer/4.1.8';
    // desktop/viewer/src/windows.rs `engine_user_agent`
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
    const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1.15';
    expect(viewerAppPlatform(APP)).toBe('windows');
    expect(viewerAppPlatform(mac + token)).toBe('mac');
    expect(viewerAppPlatform(linux + token)).toBe('linux');
    expect(viewerAppPlatform(CHROME)).toBeNull();
    expect(viewerAppPlatform(mac)).toBeNull();
    expect(viewerAppPlatform('')).toBeNull();
  });

  it('knows the app captures os shortcuts by the ` (keys)` after its version', () => {
    // desktop/viewer/src/windows.rs: the macos build ends its ua so
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
    expect(viewerAppHasNativeKeys(`${mac} owlette-swoop-viewer/4.1.8 (keys)`)).toBe(true);
    expect(viewerAppPlatform(`${mac} owlette-swoop-viewer/4.1.8 (keys)`)).toBe('mac');
    expect(viewerAppHasNativeKeys(`${mac} owlette-swoop-viewer/4.1.8`)).toBe(false);
    expect(viewerAppHasNativeKeys(APP)).toBe(false);
    expect(viewerAppHasNativeKeys(`${CHROME} (keys)`)).toBe(false);
    expect(viewerAppHasNativeKeys('')).toBe(false);

    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(`${APP} (keys)`);
    expect(viewerAppHasNativeKeys()).toBe(true);
  });

  it('links to the app-link page with the session as next', () => {
    const link = viewerAppLink('site-A', 'kiosk.local', { host: 'owlette.app', code: CODE });
    expect(link).toBe(
      `owlette-swoop://owlette.app/app-link?code=${CODE}&next=%2Fswoop%2Fsite-A%2Fkiosk.local`,
    );
    // what the app reads back out of it
    const url = new URL(link.replace(/^owlette-swoop:/, 'https:'));
    expect(url.pathname).toBe('/app-link');
    expect(url.searchParams.get('code')).toBe(CODE);
    expect(url.searchParams.get('next')).toBe('/swoop/site-A/kiosk.local');
    expect(viewerAppLink('s1', 'm1', { host: 'dev.owlette.app:3000', code: CODE })).toBe(
      `owlette-swoop://dev.owlette.app:3000/app-link?code=${CODE}&next=%2Fswoop%2Fs1%2Fm1`,
    );
  });

  it('takes the page host when none is given', () => {
    expect(viewerAppLink('s1', 'm1', { code: CODE })).toBe(
      `owlette-swoop://${location.host}/app-link?code=${CODE}&next=%2Fswoop%2Fs1%2Fm1`,
    );
  });

  it('throws on a code that is not base64url', () => {
    const host = 'owlette.app';
    expect(() => viewerAppLink('s1', 'm1', { host, code: '' })).toThrow('invalid app-link code');
    expect(() => viewerAppLink('s1', 'm1', { host, code: 'tooshort_123' })).toThrow('invalid app-link code');
    expect(() => viewerAppLink('s1', 'm1', { host, code: 'abcdefghijklmnop&next=/x' })).toThrow(
      'invalid app-link code',
    );
    expect(() => viewerAppLink('s1', 'm1', { host, code: 'abcdefghijklmnop+/=' })).toThrow(
      'invalid app-link code',
    );
  });

  it('throws on an id that is not one', () => {
    const opts = { host: 'owlette.app', code: CODE };
    expect(() => viewerAppLink('site/A', 'm1', opts)).toThrow('invalid site id');
    expect(() => viewerAppLink('site.A', 'm1', opts)).toThrow('invalid site id');
    expect(() => viewerAppLink('', 'm1', opts)).toThrow('invalid site id');
    expect(() => viewerAppLink('s1', 'm 1', opts)).toThrow('invalid machine id');
    expect(() => viewerAppLink('s1', 'm1?x=1', opts)).toThrow('invalid machine id');
    expect(() => viewerAppLink('s1', 'm1&next=x', opts)).toThrow('invalid machine id');
    expect(() => viewerAppLink('s1', '', opts)).toThrow('invalid machine id');
  });

  it('throws without a host', () => {
    expect(() => viewerAppLink('s1', 'm1', { host: '', code: CODE })).toThrow('no host');
  });
});
