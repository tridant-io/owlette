/**
 * @jest-environment jsdom
 *
 * openViewerApp — a browser hands a machine to owlette swoop, signed in
 * (dev/active/swoop-viewer, task 2.7): one app-link code per open, the link
 * carries it, and "not installed" is said only when the page kept its focus.
 * the dashboard and the swoop picker open it through `openInViewerApp`.
 */

const mockMintAppLink = jest.fn();
jest.mock('@/lib/appLink', () => ({
  mintAppLink: (...args: unknown[]) => mockMintAppLink(...args),
}));
jest.mock('@/lib/toast', () => ({ toast: { info: jest.fn(), error: jest.fn() } }));

import { openInViewerApp, openViewerApp } from '@/lib/swoop/openViewerApp';
import { toast } from '@/lib/toast';

const CODE = 'testcodetestcode_1234';
const LINK = `owlette-swoop://${location.host}/app-link?code=${CODE}&next=%2Fswoop%2Fsite-1%2Fkiosk.lobby`;

let focused = true;
let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  jest.useFakeTimers();
  focused = true;
  visibility = 'visible';
  jest.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  jest.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  mockMintAppLink.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function open(onMissing = jest.fn(), mint = jest.fn().mockResolvedValue(CODE)) {
  const navigate = jest.fn();
  return {
    navigate,
    onMissing,
    mint,
    done: openViewerApp('site-1', 'kiosk.lobby', { mint, navigate, onMissing }),
  };
}

describe('openViewerApp', () => {
  it('mints one code and hands the app the link that carries it', async () => {
    const { done, mint, navigate } = open();
    await done;
    expect(mint).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(LINK);
  });

  it('says the app is missing after 1.5 s when the page kept its focus', async () => {
    const { done, onMissing } = open();
    await done;
    jest.advanceTimersByTime(1499);
    expect(onMissing).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('says nothing when the page lost its focus or went hidden by then', async () => {
    const first = open();
    await first.done;
    focused = false;
    jest.advanceTimersByTime(1500);
    expect(first.onMissing).not.toHaveBeenCalled();

    focused = true;
    visibility = 'hidden';
    const second = open();
    await second.done;
    jest.advanceTimersByTime(1500);
    expect(second.onMissing).not.toHaveBeenCalled();
  });

  it('a blur before the timer means the app took the link', async () => {
    const removed = jest.spyOn(window, 'removeEventListener');
    const { done, onMissing } = open();
    await done;
    jest.advanceTimersByTime(500);
    window.dispatchEvent(new Event('blur'));
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(2000);
    expect(onMissing).not.toHaveBeenCalled();
    expect(removed).toHaveBeenCalledWith('blur', expect.any(Function));
  });

  it('so does a visibility change', async () => {
    const removed = jest.spyOn(document, 'removeEventListener');
    const { done, onMissing } = open();
    await done;
    document.dispatchEvent(new Event('visibilitychange'));
    jest.advanceTimersByTime(2000);
    expect(onMissing).not.toHaveBeenCalled();
    expect(removed).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('a mint failure rejects and opens nothing', async () => {
    const { done, navigate, onMissing } = open(jest.fn(), jest.fn().mockRejectedValue(new Error('mfa required')));
    await expect(done).rejects.toThrow('mfa required');
    expect(navigate).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(2000);
    expect(onMissing).not.toHaveBeenCalled();
  });
});

describe('the default mint', () => {
  it("is mintAppLink for this browser's session", async () => {
    mockMintAppLink.mockResolvedValueOnce({ code: CODE, expiresAt: 0 });
    const navigate = jest.fn();
    await openViewerApp('site-1', 'kiosk.lobby', { navigate });
    expect(mockMintAppLink).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(LINK);
  });

  it("rejects with the route's reason", async () => {
    mockMintAppLink.mockRejectedValueOnce(new Error('mfa required'));
    const navigate = jest.fn();
    await expect(openViewerApp('site-1', 'kiosk.lobby', { navigate })).rejects.toThrow('mfa required');
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('when nothing took the link', () => {
  it('offers the app by default, with the way to get it', async () => {
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    await openViewerApp('site-1', 'kiosk.lobby', { mint: jest.fn().mockResolvedValue(CODE), navigate: jest.fn() });
    jest.advanceTimersByTime(1500);
    expect(toast.info).toHaveBeenCalledWith("the owlette swoop desktop app isn't installed on this computer", {
      action: { label: 'get it', onClick: expect.any(Function) },
    });
    const { action } = jest.mocked(toast.info).mock.calls[0][1] as { action: { onClick: () => void } };
    action.onClick();
    expect(open).toHaveBeenCalledWith('/download/swoop-viewer', '_blank', 'noopener');
  });
});

describe('openInViewerApp', () => {
  it('says so in a toast when the sign-in link cannot be made', async () => {
    mockMintAppLink.mockRejectedValueOnce(new Error('mfa required'));
    const said = new Promise<void>((resolve) => {
      jest.mocked(toast.error).mockImplementationOnce(() => resolve());
    });
    openInViewerApp('site-1', 'kiosk.lobby');
    await said;
    expect(toast.error).toHaveBeenCalledWith('could not open the owlette swoop desktop app', { description: 'mfa required' });
    expect(toast.info).not.toHaveBeenCalled();
  });
});
