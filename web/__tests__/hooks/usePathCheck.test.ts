/**
 * @jest-environment jsdom
 *
 * unit tests for `usePathCheck`: only a clear answer that a path is wrong speaks.
 * offline, a timeout, a refusal and an agent too old for the command all say
 * nothing. a warning outlives the user moving on to another process, and goes
 * when what it warns about no longer holds: the process is gone or the field holds
 * something else.
 */
import { renderHook, act } from '@testing-library/react';

// override the global `{ db: null }` mock — the watcher early-returns on null db.
jest.mock('@/lib/firebase', () => ({ db: {} }));

type Snapshot = { exists: () => boolean; data: () => Record<string, unknown> };
type DocListener = (snap: Snapshot) => void;

const listeners = new Map<DocListener, string>();

jest.mock('firebase/firestore', () => ({
  doc: jest.fn((_db: unknown, ...path: string[]) => ({ path: path.join('/') })),
  onSnapshot: jest.fn((ref: { path: string }, onNext: DocListener) => {
    listeners.set(onNext, ref.path);
    return () => listeners.delete(onNext);
  }),
}));

import { PATH_ANSWER_TIMEOUT_MS, usePathCheck } from '@/hooks/usePathCheck';
import { childPath, parsePathAnswer, withArgs, type PathAnswer } from '@/lib/pathCheck';

const SITE = 'site-a';
const MACHINE = 'machine-1';
const PROCESS = 'proc-1';
const NAME = 'show';
const VALUE = 'C:\\show\\run.py 8000';

const MISSING: PathAnswer = {
  status: 'missing',
  warning: 'missing',
  path: 'C:\\show\\run.py',
  rest: '8000',
  nearest: 'C:\\show',
};

let nextCommand = 0;
const fetchMock = jest.fn();

function accepted() {
  nextCommand += 1;
  return Promise.resolve({
    ok: true,
    status: 202,
    json: () => Promise.resolve({ ok: true, data: { commandId: `cmd_${nextCommand}` } }),
  });
}

/** let the POST and its body resolve. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function emit(pathEnd: string, data: Record<string, unknown> | null) {
  act(() => {
    for (const [listener, path] of [...listeners]) {
      if (path.endsWith(pathEnd)) listener({ exists: () => data !== null, data: () => data ?? {} });
    }
  });
}

function completedListeners(): number {
  return [...listeners.values()].filter((path) => path.endsWith('commands/completed')).length;
}

async function answer(commandId: string, entry: Record<string, unknown>) {
  emit('commands/completed', { [commandId]: entry });
  await settle();
}

function config(processes: Record<string, unknown>[] | null, machine = MACHINE) {
  emit(`config/${SITE}/machines/${machine}`, processes && { processes });
}

/** the saved config the warnings in these tests were checked against. */
function savedConfig() {
  config([{ id: PROCESS, exe_path: 'C:\\a.exe', file_path: VALUE, cwd: 'C:\\gone' }]);
}

beforeEach(() => {
  jest.useFakeTimers();
  listeners.clear();
  nextCommand = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(accepted);
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('usePathCheck', () => {
  it('posts the field and value to the machine it was saved on', async () => {
    const { result } = renderHook(() => usePathCheck(SITE));

    act(() => result.current.check(MACHINE, PROCESS, NAME, [{ field: 'file_path', value: VALUE }]));
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/sites/${SITE}/machines/${MACHINE}/path-check`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ field: 'file_path', value: VALUE }) }),
    );
  });

  it('warns on a missing path once the saved config confirms it, naming the process it is about', async () => {
    const { result } = renderHook(() => usePathCheck(SITE));

    act(() => result.current.check(MACHINE, PROCESS, NAME, [{ field: 'file_path', value: VALUE }]));
    await settle();
    await answer('cmd_1', { status: 'completed', result: JSON.stringify(MISSING) });
    expect(result.current.warning).toBeNull();

    savedConfig();

    expect(result.current.warning).toEqual({
      machineId: MACHINE,
      processId: PROCESS,
      processName: NAME,
      field: 'file_path',
      value: VALUE,
      kind: 'missing',
      path: 'C:\\show\\run.py',
      rest: '8000',
      nearest: 'C:\\show',
    });
  });

  it.each(['folder', 'file', 'link', 'network', 'not_absolute'])('warns on %s', async (kind) => {
    const { result } = renderHook(() => usePathCheck(SITE));

    act(() => result.current.check(MACHINE, PROCESS, NAME, [{ field: 'exe_path', value: 'C:\\a.exe' }]));
    await settle();
    await answer('cmd_1', { status: 'completed', result: JSON.stringify({ ...MISSING, warning: kind, status: 'unknown' }) });
    savedConfig();

    expect(result.current.warning?.kind).toBe(kind);
  });

  it('says nothing when the path is there', async () => {
    const { result } = renderHook(() => usePathCheck(SITE));

    act(() => result.current.check(MACHINE, PROCESS, NAME, [{ field: 'exe_path', value: 'C:\\a.exe' }]));
    await settle();
    await answer('cmd_1', {
      status: 'completed',
      result: JSON.stringify({ status: 'file', warning: null, path: 'C:\\a.exe', rest: '', nearest: null }),
    });

    expect(result.current.warning).toBeNull();
  });

  it('says nothing for an agent too old to know the command', async () => {
    const { result } = renderHook(() => usePathCheck(SITE));

    act(() => result.current.check(MACHINE, PROCESS, NAME, [{ field: 'exe_path', value: 'C:\\a.exe' }]));
    await settle();
    await answer('cmd_1', { status: 'completed', result: 'Unknown command type: check_path' });

    expect(result.current.warning).toBeNull();
  });

  it('says nothing when the command failed', async () => {
    const { result } = renderHook(() => usePathCheck(SITE));

    act(() => result.current.check(MACHINE, PROCESS, NAME, [{ field: 'exe_path', value: 'C:\\a.exe' }]));
    await settle();
    await answer('cmd_1', { status: 'failed', error: 'Error: rate limited' });

    expect(result.current.warning).toBeNull();
  });

  it('says nothing for an offline machine, and opens no listener', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ code: 'machine_offline' }) }),
    );
    const { result } = renderHook(() => usePathCheck(SITE));

    act(() => result.current.check(MACHINE, PROCESS, NAME, [{ field: 'exe_path', value: 'C:\\a.exe' }]));
    await settle();

    expect(result.current.warning).toBeNull();
    expect(listeners.size).toBe(0);
  });

  it('says nothing when the request itself fails', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('network down')));
    const { result } = renderHook(() => usePathCheck(SITE));

    act(() => result.current.check(MACHINE, PROCESS, NAME, [{ field: 'exe_path', value: 'C:\\a.exe' }]));
    await settle();

    expect(result.current.warning).toBeNull();
  });

  it('stops listening at the timeout, and an answer after it says nothing', async () => {
    const { result } = renderHook(() => usePathCheck(SITE));

    act(() => result.current.check(MACHINE, PROCESS, NAME, [{ field: 'exe_path', value: 'C:\\a.exe' }]));
    await settle();
    expect(completedListeners()).toBe(1);

    act(() => {
      jest.advanceTimersByTime(PATH_ANSWER_TIMEOUT_MS);
    });
    await settle();

    expect(completedListeners()).toBe(0);
    await answer('cmd_1', { status: 'completed', result: JSON.stringify(MISSING) });
    expect(result.current.warning).toBeNull();
  });

  it('a check of another process does not drop the one still on its way', async () => {
    const { result } = renderHook(() => usePathCheck(SITE));

    act(() => result.current.check(MACHINE, 'proc-a', 'a', [{ field: 'exe_path', value: 'C:\\a.exe' }]));
    await settle();
    act(() => result.current.check(MACHINE, 'proc-b', 'b', [{ field: 'exe_path', value: 'C:\\b.exe' }]));
    await settle();

    await answer('cmd_1', { status: 'completed', result: JSON.stringify({ ...MISSING, path: 'C:\\a.exe', rest: '' }) });
    config([{ id: 'proc-a', exe_path: 'C:\\a.exe' }, { id: 'proc-b', exe_path: 'C:\\b.exe' }]);

    expect(result.current.warning?.processId).toBe('proc-a');
    expect(result.current.warning?.processName).toBe('a');
  });

  it('a newer check of the same field replaces the older one, asked or answered', async () => {
    const { result } = renderHook(() => usePathCheck(SITE));

    act(() => result.current.check(MACHINE, PROCESS, NAME, [{ field: 'exe_path', value: 'C:\\old.exe' }]));
    await settle();
    act(() => result.current.check(MACHINE, PROCESS, NAME, [{ field: 'exe_path', value: 'C:\\new.exe' }]));
    await settle();

    await answer('cmd_1', { status: 'completed', result: JSON.stringify({ ...MISSING, path: 'C:\\old.exe', rest: '' }) });
    config([{ id: PROCESS, exe_path: 'C:\\new.exe' }]);
    expect(result.current.warning).toBeNull();

    await answer('cmd_2', { status: 'completed', result: JSON.stringify({ ...MISSING, path: 'C:\\new.exe', rest: '' }) });
    config([{ id: PROCESS, exe_path: 'C:\\new.exe' }]);
    expect(result.current.warning?.path).toBe('C:\\new.exe');
  });

  describe('the guard', () => {
    async function showing() {
      const hook = renderHook(() => usePathCheck(SITE));
      act(() => hook.result.current.check(MACHINE, PROCESS, NAME, [{ field: 'file_path', value: VALUE }]));
      await settle();
      await answer('cmd_1', { status: 'completed', result: JSON.stringify(MISSING) });
      savedConfig();
      expect(hook.result.current.warning).not.toBeNull();
      return hook;
    }

    it('drops the warning when the process is gone', async () => {
      const { result } = await showing();
      config([{ id: 'someone-else', file_path: VALUE }]);
      expect(result.current.warning).toBeNull();
    });

    it('drops the warning when the machine config is gone', async () => {
      const { result } = await showing();
      config(null);
      expect(result.current.warning).toBeNull();
    });

    it('drops the warning when the field no longer holds that value', async () => {
      const { result } = await showing();
      config([{ id: PROCESS, file_path: 'C:\\other.toe' }]);
      expect(result.current.warning).toBeNull();
    });

    it('keeps the warning when another field of the process changes', async () => {
      const { result } = await showing();
      config([{ id: PROCESS, file_path: VALUE, name: 'renamed', cwd: 'C:\\elsewhere' }]);
      expect(result.current.warning).not.toBeNull();
    });

    it('reads a saved value past its surrounding space', async () => {
      const { result } = await showing();
      config([{ id: PROCESS, file_path: `  ${VALUE} ` }]);
      expect(result.current.warning).not.toBeNull();
    });

    it('closes its listener once no warning is left', async () => {
      const { result } = await showing();
      act(() => result.current.dismiss(result.current.warning!));
      expect([...listeners.values()].filter((path) => path.startsWith('config/'))).toHaveLength(0);
    });
  });

  it('leaving the site drops what is open and what is showing', async () => {
    const { result, rerender } = renderHook(({ site }) => usePathCheck(site), { initialProps: { site: SITE } });

    act(() => result.current.check(MACHINE, PROCESS, NAME, [{ field: 'file_path', value: VALUE }]));
    await settle();
    await answer('cmd_1', { status: 'completed', result: JSON.stringify(MISSING) });
    savedConfig();
    expect(result.current.warning).not.toBeNull();

    rerender({ site: 'site-b' });
    await settle();

    expect(result.current.warning).toBeNull();
    expect(listeners.size).toBe(0);
  });

  it('unmounting closes the listener', async () => {
    const { result, unmount } = renderHook(() => usePathCheck(SITE));

    act(() => result.current.check(MACHINE, PROCESS, NAME, [{ field: 'exe_path', value: 'C:\\a.exe' }]));
    await settle();
    unmount();
    await settle();

    expect(listeners.size).toBe(0);
  });

  async function twoWarnings() {
    const hook = renderHook(() => usePathCheck(SITE));
    act(() =>
      hook.result.current.check(MACHINE, PROCESS, NAME, [
        { field: 'exe_path', value: 'C:\\a.exe' },
        { field: 'cwd', value: 'C:\\gone' },
      ]),
    );
    await settle();
    await answer('cmd_1', { status: 'completed', result: JSON.stringify({ ...MISSING, path: 'C:\\a.exe', rest: '' }) });
    await answer('cmd_2', { status: 'completed', result: JSON.stringify({ ...MISSING, path: 'C:\\gone', rest: '' }) });
    savedConfig();
    return hook;
  }

  it('shows one warning at a time, and dismiss moves to the next', async () => {
    const { result } = await twoWarnings();

    expect(result.current.warning?.field).toBe('exe_path');
    act(() => result.current.dismiss(result.current.warning!));
    savedConfig();
    expect(result.current.warning?.field).toBe('cwd');
    act(() => result.current.dismiss(result.current.warning!));
    expect(result.current.warning).toBeNull();
  });

  it('dismissing the same warning twice does not lose the next one', async () => {
    // esc during a pick's save, then the save finishing: both dismiss that warning.
    const { result } = await twoWarnings();
    const first = result.current.warning!;

    act(() => result.current.dismiss(first));
    savedConfig();
    act(() => result.current.dismiss(first));
    savedConfig();

    expect(result.current.warning?.field).toBe('cwd');
  });

  it('listFolder resolves with the folder, and with null when the machine says nothing', async () => {
    const { result } = renderHook(() => usePathCheck(SITE));

    let read: PathAnswer | null | undefined;
    act(() => {
      void result.current.listFolder(MACHINE, 'C:\\show').then((value) => { read = value; });
    });
    await settle();
    await answer('cmd_1', {
      status: 'completed',
      result: JSON.stringify({
        status: 'folder', warning: null, path: 'C:\\show', rest: '', nearest: null,
        parent: 'C:\\', folders: ['a'], files: ['b.toe'], truncated: false,
      }),
    });
    expect(read?.files).toEqual(['b.toe']);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ field: 'folder', value: 'C:\\show' });

    let gone: PathAnswer | null | undefined;
    act(() => {
      void result.current.listFolder(MACHINE, 'C:\\gone').then((value) => { gone = value; });
    });
    await settle();
    act(() => {
      jest.advanceTimersByTime(PATH_ANSWER_TIMEOUT_MS);
    });
    await settle();
    expect(gone).toBeNull();
  });
});

describe('parsePathAnswer', () => {
  it.each([
    'Unknown command type: check_path',
    '',
    'null',
    '[]',
    '"missing"',
    JSON.stringify({ status: 'gone', warning: null, path: null, rest: '', nearest: null }),
    JSON.stringify({ status: 'missing', warning: 'loud', path: null, rest: '', nearest: null }),
    JSON.stringify({ status: 'missing', warning: 'missing', path: 7, rest: '', nearest: null }),
    JSON.stringify({ status: 'missing', warning: 'missing', path: null, nearest: null }),
    JSON.stringify({ status: 'folder', warning: null, path: 'C:\\', rest: '', nearest: null, files: [1] }),
  ])('reads %s as no answer', (result) => {
    expect(parsePathAnswer(result)).toBeNull();
  });

  it('reads the agent answer', () => {
    expect(parsePathAnswer(JSON.stringify(MISSING))).toEqual(MISSING);
  });
});

describe('writing a pick back', () => {
  it('keeps the arguments after the path', () => {
    expect(withArgs('C:\\show\\new.py', '8000')).toBe('C:\\show\\new.py 8000');
  });

  it('quotes a path with spaces only when arguments follow it', () => {
    expect(withArgs('C:\\my show\\new.py', '8000')).toBe('"C:\\my show\\new.py" 8000');
    expect(withArgs('C:\\my show\\new.py', '')).toBe('C:\\my show\\new.py');
  });

  it('joins a child to a windows or posix folder, root or not', () => {
    expect(childPath('C:\\show', 'a')).toBe('C:\\show\\a');
    expect(childPath('C:\\', 'a')).toBe('C:\\a');
    expect(childPath('/opt/show', 'a')).toBe('/opt/show/a');
    expect(childPath('/', 'a')).toBe('/a');
  });
});
