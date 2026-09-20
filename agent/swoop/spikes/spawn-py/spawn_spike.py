"""swoop spike 0.3 harness: the six primitives plan.md D2 rests on.

Drives ``../securedesk/target/{release,debug}/securedesk.exe`` the way the
service will drive the streamer -- the service's own token retargeted to the
console session, `CreateProcessAsUser` on ``WinSta0\\Default`` over inherited
anonymous pipes, boxed in a kill-on-close job -- and measures each step.

It is **not** the product. Task 2.1 owns ``agent/src/swoop_spawn.py``; this
validates that path from outside and imports nothing from ``agent/src``.

  agent/.venv/Scripts/python agent/swoop/spikes/spawn-py/spawn_spike.py <cmd>

  preflight   identity, the pywin32 handle-list probe, the no-uac audit
  spawn       primitives 1, 2, 3 and 6, plus the handle census
  leak        the same spawn with NO handle list -- what the fallback gives away
  inject      primitive 4's injection half: the three desktop-rights arms
  desktop     primitive 4's capture half: follow the input desktop, time the
              recovery after DXGI_ERROR_ACCESS_LOST. A human drives Win+L.
  sas         primitive 5: record SoftwareSASGeneration, set 3, SendSAS(FALSE),
              restore. Needs SYSTEM and a human watching the screen.

Nothing here elevates. Every token is a duplicate of the one this process
already holds: there is no ``runas``, no ``ShellExecute`` and no manifest, so no
path can reach the AppInfo service and raise a consent prompt. ``spawn`` watches
for ``consent.exe`` across the window and reports what it saw.

Never puts anything on a command line but a subcommand, never writes into
``C:\\ProgramData\\Owlette``, never stops a service, and never prints the bundle
-- only its length.
"""

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import winapi  # noqa: E402  (after the path fix-up, on purpose)

HERE = os.path.dirname(os.path.abspath(__file__))
SPIKE_ROOT = os.path.dirname(HERE)
CHILD_DIR = os.path.join(SPIKE_ROOT, 'securedesk')

READY_TIMEOUT_S = 20.0
EXIT_TIMEOUT_S = 15.0

SAS_KEY = r'SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
SAS_VALUE = 'SoftwareSASGeneration'
SAS_SERVICES = 3

# The UAC prompt itself. Its absence across the spawn window is the observable
# half of primitive (6) -- the other half is that no source here asks to elevate.
CONSENT = 'consent.exe'

# Every way a Windows process can ask to be elevated, as text. A hit is not
# automatically a finding: the prose in these files says "no runas" a lot. The
# report prints the line so the reader decides.
ELEVATION_VERBS = (
    'runas', 'ShellExecute', 'requestedExecutionLevel', 'requireAdministrator',
    'highestAvailable', 'Start-Process', 'AppInfo',
)


def child_exe(override=None):
    if override:
        return override
    for profile in ('release', 'debug'):
        path = os.path.join(CHILD_DIR, 'target', profile, 'securedesk.exe')
        if os.path.exists(path):
            return path
    raise SystemExit(
        'securedesk.exe not built. cd agent/swoop/spikes/securedesk '
        '&& cargo build --release'
    )


def bundle_line(canary):
    """A bundle-shaped line: `agent/swoop/testdata/protocol/bundle/bundle-valid.json`'s
    shape with obviously fake values, plus the canary handle value.

    Fake or not, it is treated as a bundle: it is written once, it is never
    printed, and only its length is reported.
    """
    return json.dumps({
        'protocolVersion': 1,
        'agentVersion': '0.0.0-spike',
        'sid': 'sid_000000000000spike',
        'site': 'site_spike',
        'machine': 'machine_spike',
        'now': int(time.time()),
        'streamerEpoch': int(time.time() * 1_000_000),
        'signalUrl': 'wss://swoop-signal.example.invalid/v1/room/site_spike/machine_spike',
        'hostToken': 'FAKE.HOST.TOKEN',
        'jwtKeys': [],
        'sessionKey': 'FAKE-SESSION-KEY',
        'iceServers': [],
        'enablement': {
            'membersMayWatch': True, 'maxViewers': 4,
            'leaseSeconds': 300, 'sessionCapSeconds': 43200,
        },
        'indicator': 'banner',
        'ctl': True,
        'spikeCanary': canary,
    }, separators=(',', ':'))


class Child:
    """A spawned securedesk.exe: its two pipes, its job and its exit code."""

    def __init__(self, process, thread, pid, job, stdin_w, stdout_r):
        self.pid = pid
        self.exit_code = None
        self._process = process
        self._thread = thread
        self._job = job
        self._closed = False
        # msvcrt takes ownership of the handle; the fd is what gets closed.
        import msvcrt
        self._in = os.fdopen(msvcrt.open_osfhandle(stdin_w, 0), 'wb', 0)
        self._out = os.fdopen(msvcrt.open_osfhandle(stdout_r, os.O_RDONLY), 'rb', 0)
        self.events = queue.Queue()
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()

    def _pump(self):
        try:
            for raw in self._out:
                line = raw.decode('utf-8', 'replace').strip()
                if line:
                    self.events.put(line)
        except Exception:
            pass  # a broken pipe is how a dead child reaches us
        finally:
            self.events.put(None)

    def send_bundle(self, line):
        """Stdin line 1. The buffer is wiped after the write, the way the
        product's `write_bundle` does -- the spike's bundle is fake and the
        habit is still the point."""
        buf = bytearray(line.encode('utf-8') + b'\n')
        try:
            self._in.write(buf)
        finally:
            buf[:] = b'\x00' * len(buf)

    def send(self, obj):
        self._in.write((json.dumps(obj, separators=(',', ':')) + '\n').encode('utf-8'))

    def wait_for(self, kind, timeout=READY_TIMEOUT_S, on_event=None):
        """The next event of ``kind``, with every event before it passed to
        ``on_event``. None on timeout or on the child going away."""
        deadline = time.perf_counter() + timeout
        while True:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                return None
            try:
                line = self.events.get(timeout=remaining)
            except queue.Empty:
                return None
            if line is None:
                return None
            try:
                event = json.loads(line)
            except ValueError:
                print(f'  < (not json) {line}')
                continue
            if on_event:
                on_event(event)
            if event.get('type') == kind:
                return event

    def wait_exit(self, timeout=EXIT_TIMEOUT_S):
        self.exit_code = winapi.wait(self._process, timeout)
        return self.exit_code

    def close(self):
        """Close the job -- which terminates the child -- and every handle."""
        if self._closed:
            return
        self._closed = True
        for stream in (self._in, self._out):
            try:
                stream.close()
            except Exception:
                pass
        for handle in (self._job, self._thread, self._process):
            winapi.close(handle)


def launch(exe, use_token=True, handle_list=True, target_session=None):
    """Primitives (1), (2) and (3) in one call.

    ``handle_list=False`` is the fallback arm: `EXTENDED_STARTUPINFO_PRESENT`
    with a NULL attribute list behaves exactly like a plain `STARTUPINFO`, which
    is what pywin32 leaves the product with today.
    """
    report = {
        'exe': exe,
        'useToken': use_token,
        'handleList': handle_list,
        'thisSession': winapi.this_session(),
        'consoleSession': winapi.active_console_session(),
    }
    token = environment = None
    attributes = None
    child_ends = []
    parent_ends = []
    process = thread = job = 0
    canary = winapi.create_canary()
    report['canary'] = canary

    try:
        if use_token:
            session = target_session
            if session is None:
                session = winapi.active_console_session()
                if session == 0xFFFFFFFF:
                    session = winapi.this_session()
            at = time.perf_counter()
            token, environment, retargeted, error = winapi.duplicate_own_token(session)
            report['tokenMs'] = round((time.perf_counter() - at) * 1000, 3)
            report['targetSession'] = session
            report['retargeted'] = retargeted
            report['retargetError'] = error
            report['token'] = winapi.token_identity(token)
            report['environmentBlock'] = bool(environment)

        stdin_r, stdin_w = winapi.create_pipe()
        stdout_r, stdout_w = winapi.create_pipe()
        child_ends = [stdin_r, stdout_w]
        parent_ends = [stdin_w, stdout_r]
        # Our ends must not cross into the child, or stdout never sees eof.
        for handle in parent_ends:
            winapi.set_inheritable(handle, False)

        if handle_list:
            attributes = winapi.AttributeList(child_ends)
            report['handleListEntries'] = len(child_ends)
        # stderr shares the stdout pipe so the list is exactly the two pipe
        # handles the task names, and a panic still reaches the harness.
        si = winapi.make_startupinfo(stdin_r, stdout_w, stdout_w, attributes)
        report['lpDesktop'] = winapi.DESKTOP

        at = time.perf_counter()
        process, thread, pid = winapi.spawn(
            f'"{exe}"', si, token=token, environment=environment,
        )
        report['spawnMs'] = round((time.perf_counter() - at) * 1000, 3)
        report['pid'] = pid

        job = winapi.create_kill_on_close_job()
        winapi.assign_to_job(job, process)
        report['inJob'] = winapi.in_job(job, process)
        winapi.resume(thread)

        # The child owns these now; holding them keeps the pipes open.
        for handle in child_ends:
            winapi.close(handle)
        child_ends = []
        return Child(process, thread, pid, job, stdin_w, stdout_r), report
    except Exception:
        for handle in child_ends + parent_ends + [thread, process, job]:
            winapi.close(handle)
        raise
    finally:
        winapi.close(canary)
        if attributes:
            attributes.close()
        if token:
            winapi.close(token)
        if environment:
            winapi.userenv.DestroyEnvironmentBlock(environment)


def handshake(child, canary, report):
    """Primitive (2)'s measurement: bundle in, `ready` out, `kill` in,
    `exiting` out."""
    line = bundle_line(canary)
    report['bundleBytes'] = len(line.encode('utf-8')) + 1

    at = time.perf_counter()
    child.send_bundle(line)
    ready = child.wait_for('ready')
    report['readyMs'] = round((time.perf_counter() - at) * 1000, 3) if ready else None
    if not ready:
        report['failure'] = 'no ready event'
        return report
    report['ready'] = ready

    # The same probe again on a warm child. `readyMs` is startup plus the probe
    # plus the pipe; this is the probe plus the pipe, so the difference is what
    # process creation actually cost.
    at = time.perf_counter()
    child.send({'type': 'probe'})
    if child.wait_for('probe_result'):
        report['warmProbeMs'] = round((time.perf_counter() - at) * 1000, 3)

    at = time.perf_counter()
    child.send({'type': 'kill'})
    exiting = child.wait_for('exiting')
    report['killMs'] = round((time.perf_counter() - at) * 1000, 3) if exiting else None
    report['exiting'] = exiting
    report['exitCode'] = child.wait_exit()
    return report


def cmd_spawn(args, handle_list=True):
    exe = child_exe(args.exe)
    before = winapi.running_processes()
    child, report = launch(exe, use_token=not args.plain, handle_list=handle_list)
    try:
        handshake(child, report['canary'], report)
    finally:
        after = winapi.running_processes()
        child.close()
    report['consentSeen'] = sorted({
        name for pid, name in after.items()
        if name.lower() == CONSENT and pid not in before
    })
    report['consentAlreadyRunning'] = sorted({
        name for name in before.values() if name.lower() == CONSENT
    })

    probe = (report.get('ready') or {}).get('probe', {})
    inherited = probe.get('handlesInherited')
    print(f"spawned pid {report.get('pid')} on {report['lpDesktop']}")
    print(f"  token retargeted to session {report.get('targetSession')}: "
          f"{report.get('retargeted')} (error {report.get('retargetError')})")
    print(f"  child user {probe.get('userSid')} integrity {probe.get('integritySid')} "
          f"session {probe.get('sessionId')}")
    print(f"  window station {probe.get('windowStation')} desktop {probe.get('threadDesktop')}")
    print(f"  handle list: {'on' if handle_list else 'OFF'}, "
          f"inherited handles in child: {inherited}, canary: {probe.get('canary')}")
    print(f"  in job (kill-on-close): {report.get('inJob')}")
    print(f"  bundle {report.get('bundleBytes')} bytes -> ready: {report.get('readyMs')} ms "
          f"(warm probe round trip {report.get('warmProbeMs')} ms)")
    print(f"  kill -> exiting: {report.get('killMs')} ms, exit code {report.get('exitCode')}")
    print(f"  consent.exe appeared during the window: "
          f"{report['consentSeen'] or 'none'}")
    return report


def cmd_leak(args):
    """The fallback arm, so the memo can say what it actually gives away rather
    than that it is 'less strict'."""
    print('no handle list -- this is the arm that models what pywin32 leaves us with')
    return cmd_spawn(args, handle_list=False)


def cmd_job(args):
    """Primitive (3) on its own: close the job without sending `kill` and prove
    the child is gone."""
    exe = child_exe(args.exe)
    child, report = launch(exe, use_token=not args.plain)
    at = None
    try:
        child.send_bundle(bundle_line(report['canary']))
        report['ready'] = bool(child.wait_for('ready'))
        at = time.perf_counter()
    finally:
        child.close()
    report['jobCloseMs'] = round((time.perf_counter() - at) * 1000, 3) if at else None
    still = winapi.running_processes()
    # Name as well as pid: a pid can be reused, and "survived" must not be a
    # coincidence either way.
    report['survived'] = still.get(report['pid'], '').lower() == 'securedesk.exe'
    print(f"pid {report['pid']} ready: {report['ready']}")
    print(f"  job closed with no kill line; still running: {report['survived']} "
          f"(measured {report['jobCloseMs']} ms after the close)")
    return report


def cmd_inject(args):
    """Primitive (4)'s injection half, all three desktop-rights arms.

    Moves this machine's real pointer and presses a real left shift.
    """
    exe = child_exe(args.exe)
    child, report = launch(exe, use_token=not args.plain)
    arms = []
    try:
        child.send_bundle(bundle_line(report['canary']))
        if not child.wait_for('ready'):
            raise SystemExit('child never became ready')
        for arm in ('none', 'capture', 'inject'):
            child.send({'type': 'inject', 'arm': arm})
            result = child.wait_for('inject_result', timeout=30)
            if not result:
                result = {'arm': arm, 'failure': 'no result'}
            arms.append(result)
            print(f"  arm {result.get('arm'):8} attached={result.get('attached')} "
                  f"desktop={result.get('inputDesktop')} "
                  f"mouse: SendInput={result.get('sendInputMouse')} "
                  f"err={result.get('mouseLastError')} arrived={result.get('mouseArrived')} | "
                  f"key: SendInput={result.get('sendInputKeyDown')} "
                  f"err={result.get('keyLastError')} arrived={result.get('keyDownArrived')}")
        child.send({'type': 'kill'})
        child.wait_for('exiting')
    finally:
        child.close()
    report['arms'] = arms
    return report


def cmd_desktop(args):
    """Primitive (4)'s capture half. The human drives the desktop switches."""
    exe = child_exe(args.exe)
    child, report = launch(exe, use_token=not args.plain)
    events = []
    try:
        child.send_bundle(bundle_line(report['canary']))
        if not child.wait_for('ready'):
            raise SystemExit('child never became ready')
        print(f'following the input desktop for {args.seconds}s with '
              f'{args.access} rights -- lock the machine (Win+L), unlock, '
              f'raise a UAC prompt, and watch the lines below')
        child.send({
            'type': 'desk', 'seconds': args.seconds,
            'access': args.access, 'output': args.output,
        })
        done = child.wait_for(
            'desk_done', timeout=args.seconds + 30,
            on_event=lambda e: (events.append(e), print(f"  < {json.dumps(e)}")),
        )
        report['deskDone'] = done
        child.send({'type': 'kill'})
        child.wait_for('exiting')
    finally:
        child.close()
    report['events'] = events
    recoveries = [e for e in events if e.get('type') == 'desk_recovered']
    print(f'\n  {len(recoveries)} recoveries:')
    for event in recoveries:
        print(f"    {event.get('reason')} -> {event.get('desktop')}: "
              f"{event.get('recoveredMs')} ms ({event.get('blankFrames')} blank frames)")
    return report


def read_sas_policy():
    """The current `SoftwareSASGeneration`, as ``(present, value)``."""
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, SAS_KEY, 0, winreg.KEY_READ) as key:
            value, _kind = winreg.QueryValueEx(key, SAS_VALUE)
            return True, value
    except FileNotFoundError:
        return False, None
    except OSError:
        return False, None


def write_sas_policy(present, value):
    """Set or remove `SoftwareSASGeneration`. Removing is how 'absent' is
    restored: leaving a 0 behind is a different policy, not the old one."""
    import winreg
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, SAS_KEY, 0, winreg.KEY_SET_VALUE) as key:
        if present:
            winreg.SetValueEx(key, SAS_VALUE, 0, winreg.REG_DWORD, value)
        else:
            try:
                winreg.DeleteValue(key, SAS_VALUE)
            except FileNotFoundError:
                pass


def reg_query():
    """`reg query` output, verbatim, for the memo to paste."""
    reg = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'reg.exe')
    result = subprocess.run(
        [reg, 'query', f'HKLM\\{SAS_KEY}', '/v', SAS_VALUE],
        capture_output=True, text=True, timeout=15,
    )
    # An absent value answers on stderr, and stdout is a bare newline rather
    # than empty, so `or` on the raw strings picks the wrong one.
    return (result.stdout.strip() or result.stderr.strip()
            or f'(reg exited {result.returncode} with no output)')


def cmd_sas(args):
    """Primitive (5). Records the prior policy, sets 3, asks the child to raise
    the sequence, and puts the policy back whatever happens."""
    exe = child_exe(args.exe)
    present, prior = read_sas_policy()
    report = {'priorPresent': present, 'priorValue': prior, 'priorQuery': reg_query()}
    print(f'prior SoftwareSASGeneration: '
          f'{prior if present else "absent"}')
    print(f'--- reg query before ---\n{report["priorQuery"]}\n---')

    try:
        write_sas_policy(True, SAS_SERVICES)
    except PermissionError as e:
        report['failure'] = f'cannot set the policy: {e}'
        print(report['failure'])
        return report
    report['setQuery'] = reg_query()

    try:
        child, spawned = launch(exe, use_token=not args.plain)
        report.update(spawned)
        try:
            child.send_bundle(bundle_line(report['canary']))
            if not child.wait_for('ready'):
                raise SystemExit('child never became ready')
            print('raising the secure attention sequence -- watch the screen')
            child.send({'type': 'sas'})
            report['sas'] = child.wait_for('sas_result', timeout=30)
            print(f"  {json.dumps(report.get('sas'))}")
            child.send({'type': 'kill'})
            child.wait_for('exiting')
        finally:
            child.close()
    finally:
        write_sas_policy(present, prior)
        report['restoredPresent'], report['restoredValue'] = read_sas_policy()
        report['restoredQuery'] = reg_query()
        print(f'--- reg query after restore ---\n{report["restoredQuery"]}\n---')
    return report


def scan_for_elevation():
    """Every line in the spike that mentions a way to elevate.

    Prose counts: the report prints the line so a reader can see that the only
    hits are the comments saying this never happens.
    """
    hits = []
    # Only what this spike owns. The other spikes' vendored virtualenvs are full
    # of the word and say nothing about whether this path can elevate.
    for top in (HERE, CHILD_DIR):
        for root, dirs, files in os.walk(top):
            dirs[:] = [d for d in dirs
                       if d not in ('target', '__pycache__', '.git', '.venv')]
            for name in files:
                if not name.endswith(('.py', '.rs', '.toml')):
                    continue
                path = os.path.join(root, name)
                try:
                    with open(path, encoding='utf-8') as handle:
                        for number, line in enumerate(handle, 1):
                            for verb in ELEVATION_VERBS:
                                if verb.lower() in line.lower():
                                    hits.append({
                                        'file': os.path.relpath(path, SPIKE_ROOT),
                                        'line': number,
                                        'verb': verb,
                                        'text': line.strip()[:160],
                                    })
                                    break
                except OSError:
                    continue
    return hits


def manifest_asks_to_elevate(exe):
    """Whether the built child embeds a manifest that requests elevation.

    A Rust binary embeds no application manifest by default, so the string is
    absent and the child runs `asInvoker`. If it ever appears, the spike's
    'cannot raise a prompt' claim has to be re-argued rather than repeated.
    """
    if not os.path.exists(exe):
        return None
    with open(exe, 'rb') as handle:
        blob = handle.read()
    for needle in (b'requestedExecutionLevel', b'requireAdministrator', b'highestAvailable'):
        if needle in blob or needle.decode().encode('utf-16-le') in blob:
            return needle.decode()
    return None


def cmd_preflight(args):
    supported, version, detail = winapi.handle_list_support()
    report = {
        'python': sys.version.split()[0],
        'pid': os.getpid(),
        'thisSession': winapi.this_session(),
        'consoleSession': winapi.active_console_session(),
        'pywin32Version': version,
        'pywin32HandleList': supported,
        'pywin32Detail': detail,
    }
    token, environment, retargeted, error = winapi.duplicate_own_token(winapi.this_session())
    try:
        report['token'] = winapi.token_identity(token)
        report['retargetedToOwnSession'] = retargeted
        report['retargetError'] = error
    finally:
        winapi.close(token)
        if environment:
            winapi.userenv.DestroyEnvironmentBlock(environment)

    # The ctypes arm of the same question, proven by building a real list.
    probe_handles = []
    try:
        read, write = winapi.create_pipe()
        probe_handles = [read, write]
        with winapi.AttributeList(probe_handles):
            report['ctypesHandleList'] = True
    except winapi.Win32Error as e:
        report['ctypesHandleList'] = False
        report['ctypesHandleListError'] = str(e)
    finally:
        for handle in probe_handles:
            winapi.close(handle)

    exe = None
    try:
        exe = child_exe(args.exe)
    except SystemExit:
        pass
    report['childExe'] = exe
    report['childManifest'] = manifest_asks_to_elevate(exe) if exe else None
    report['elevationHits'] = scan_for_elevation()

    print(f"python {report['python']}, pid {report['pid']}, session {report['thisSession']}, "
          f"console session {report['consoleSession']}")
    print(f"  token: {report['token']['userSid']} integrity "
          f"{report['token']['integritySid']} elevationType "
          f"{report['token']['elevationType']} elevated {report['token']['elevated']}")
    print(f"  SetTokenInformation(TokenSessionId) on our own session: "
          f"{retargeted} (error {error})")
    print(f"  pywin32 {version}: PROC_THREAD_ATTRIBUTE_HANDLE_LIST expressible: "
          f"{supported} -- {detail}")
    print(f"  ctypes STARTUPINFOEX handle list: {report['ctypesHandleList']}")
    print(f"  child exe: {exe}")
    print(f"  child manifest asks to elevate: {report['childManifest'] or 'no'}")
    print(f"  lines mentioning an elevation verb: {len(report['elevationHits'])}")
    for hit in report['elevationHits']:
        print(f"    {hit['file']}:{hit['line']} [{hit['verb']}] {hit['text']}")
    return report


COMMANDS = {
    'preflight': cmd_preflight,
    'spawn': cmd_spawn,
    'leak': cmd_leak,
    'job': cmd_job,
    'inject': cmd_inject,
    'desktop': cmd_desktop,
    'sas': cmd_sas,
}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('command', choices=sorted(COMMANDS))
    parser.add_argument('--exe', help='securedesk.exe, if not the built one')
    parser.add_argument('--plain', action='store_true',
                        help='CreateProcessW instead of CreateProcessAsUserW, '
                             'to measure the pipes and the job without a token')
    parser.add_argument('--seconds', type=int, default=90,
                        help='how long `desktop` follows the input desktop')
    parser.add_argument('--access', default='capture', choices=('capture', 'inject'),
                        help='the desktop rights `desktop` opens with')
    parser.add_argument('--output', type=int, default=0, help='which display to duplicate')
    parser.add_argument('--json', help='write the full report to this file')
    args = parser.parse_args(argv)

    report = COMMANDS[args.command](args)
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as handle:
            json.dump(report, handle, indent=2)
        print(f'\nreport written to {args.json}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
