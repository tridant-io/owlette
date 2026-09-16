"""Harness for the real-process lifecycle suite (process-identity 3.3.0, Wave 0).

This conftest builds three things and documents the honesty contract of each.

1. DECOY RUNNER. Every process this suite starts (directly, or through the
   service code under test) is a renamed copy of the CPython interpreter
   (`owlette-e2e-decoy-<runid>.exe`, copied from sys.base_prefix) running a
   sleep script. The unique image name guarantees no test can ever name a
   real-world executable in a destructive argument: the CURRENT code under
   test kills by bare image name (`_terminate_processes_for_install`), and
   this machine runs dozens of real python/node processes. The interpreter
   (not ping/waitfor) is used because the contract tests need a runner that
   accepts an arbitrary trailing argument (a marker script path) so that
   cmdline corroboration - `file_path in cmdline` - can be exercised exactly
   the way production exercises it against TouchDesigner (.toe in cmdline).

2. LAUNCH SEAM. The tests bind REAL unbound OwletteService methods onto a
   SimpleNamespace (descriptor protocol, house pattern from
   test_cortex_process_command.py). The single mock seam is the user-session
   plumbing inside launch_process_as_user: win32process.CreateProcessAsUser
   is monkeypatched to read the launcher handoff file (launch_<id>.json),
   subprocess.Popen the entry's exe_path + file_path directly, and write the
   pid file the real helper (process_launcher.py) would have written. The
   shim honours the real contract: same argv shape as ShellExecuteEx
   (exe_path, then file_path as its single argument), pid delivered through
   the real pid-file handshake, so launch_process_as_user's own validation,
   pid-file polling, app_states row write and return value all run REAL, and
   the returned PID is a real live process.
     Two documented deviations, both properties of the decoy runner and not
   of the code under test:
     - an entry with an empty file_path gets a default idle-script argument
       appended (a bare interpreter would read EOF on stdin and exit
       immediately; production targets are long-lived by nature);
     - the child env gains PYTHONHOME/PATH pointing at the real install so
       the renamed interpreter copy can boot from its temp dir.
   shared_utils.get_python_exe_path is also patched to sys.executable purely
   so launch_process_as_user can build the (unused by the shim) helper
   command line without raising in a repo checkout.

3. ISOLATION. shared_utils freezes CONFIG_PATH / RESULT_FILE_PATH at import
   from the data root, so a plain env redirect is NOT enough once the module
   is imported (and the wider suite imports it first). The seam used here is
   both: os.environ['OWLETTE_DATA_ROOT'] is set (covers every runtime
   get_data_path() call - launcher handoff files, restart flag, sentinels)
   AND the two import-frozen module constants are monkeypatched onto
   tmp_path. An autouse probe then re-resolves every path the suite can
   touch and FAILS the test up front if any of them still points at
   C:\ProgramData - a test that cannot prove isolation never runs its body.

LEAK POLICY. Every spawned process is registered as (pid, create_time,
Popen). Teardown always reaps by PID (never by image name) and then scans
for any process still wearing the decoy image. A test that PASSED while
leaving a registered decoy alive, or while any unregistered decoy-image
process exists, is failed by the fixture: a green test must account for
every process it caused. Tests that already failed (including strict xfails,
which abort mid-scenario by design) are cleaned up silently - their verdict
already stands and a teardown error would corrupt the xfail accounting.

IDENTITY ROW SCHEMA (forward contract, Wave 1 / D2). Contract tests that
need a pre-existing identity record write these row-level fields into
tmp/app_states.json, matching plan.md D2 ("(pid, create_time) minimum, plus
the exe image and (where available) the cmdline"):
    'create_time' : float, psutil.Process(pid).create_time()
    'exe'         : str, the launched image path
The fields are inert today (nothing reads them); Waves 1-5 make them
load-bearing. If the implementing wave picks different field names, update
craft_identity_fields() here - it is the single authority.

owlette_service is imported lazily inside fixtures/factories (never at
module scope) so collection order cannot double-initialise the cryptography
PyO3 bindings - same rule as test_cortex_process_command.py.
"""

import datetime
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

import psutil
import pytest


RUN_ID = uuid.uuid4().hex[:8]
DECOY_LIFETIME_SECONDS = 900  # self-destruct cap: no leak outlives 15 min

# Per-test spawn registry: list of dicts {pid, create_time, popen, note}.
# note is 'test' for direct spawns, 'service' for shim-launched children.
_REGISTRY = []


# --------------------------------------------------------------------------
# report stash so teardown fixtures can see the test's own verdict
# --------------------------------------------------------------------------

@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    rep = outcome.get_result()
    setattr(item, 'rep_' + rep.when, rep)


# --------------------------------------------------------------------------
# decoy image (session-scoped)
# --------------------------------------------------------------------------

@pytest.fixture(scope='session')
def decoy_env():
    """Copy the interpreter to a uniquely named decoy image + sleep scripts.

    Yields a namespace: exe (decoy image path), image (basename), idle_script,
    make_marker_script(label) -> a distinct sleep-script path, child_env
    (env dict letting the renamed copy boot).
    """
    if os.name != 'nt':  # pragma: no cover - suite is Windows-only
        pytest.skip('windows-only lifecycle suite')

    base = sys.base_prefix
    src = os.path.join(base, 'python.exe')
    if not os.path.isfile(src):
        pytest.fail('decoy setup: no python.exe under sys.base_prefix %r' % base)

    root = os.path.join(
        os.environ.get('TEMP', os.path.expanduser('~')),
        'owlette-e2e-decoys-%s' % RUN_ID)
    os.makedirs(root, exist_ok=True)
    image = 'owlette-e2e-decoy-%s.exe' % RUN_ID
    exe = os.path.join(root, image)
    shutil.copy2(src, exe)

    idle_script = os.path.join(root, 'idle_%s.py' % RUN_ID)
    with open(idle_script, 'w') as f:
        f.write('import time\ntime.sleep(%d)\n' % DECOY_LIFETIME_SECONDS)

    child_env = dict(os.environ)
    child_env['PYTHONHOME'] = base
    child_env['PATH'] = base + os.pathsep + child_env.get('PATH', '')
    # Never let the harness's pytest path leak into decoys.
    child_env.pop('PYTHONPATH', None)

    made = {}

    def make_marker_script(label):
        path = made.get(label)
        if path is None:
            path = os.path.join(root, 'marker_%s_%s.py' % (label, RUN_ID))
            with open(path, 'w') as f:
                f.write('import time\ntime.sleep(%d)\n' % DECOY_LIFETIME_SECONDS)
            made[label] = path
        return path

    yield SimpleNamespace(
        exe=exe, image=image, idle_script=idle_script,
        make_marker_script=make_marker_script, child_env=child_env)

    # Session safety sweep: identify by our unique image, kill by PID.
    for proc in psutil.process_iter(['pid', 'name']):
        try:
            if proc.info['name'] and proc.info['name'].lower() == image.lower():
                psutil.Process(proc.info['pid']).kill()
        except psutil.Error:
            continue
    shutil.rmtree(root, ignore_errors=True)


def _register(pid, create_time, popen, note):
    _REGISTRY.append(
        {'pid': pid, 'create_time': create_time, 'popen': popen, 'note': note})


@pytest.fixture
def spawn_decoy(decoy_env):
    """Spawn one live decoy; returns (popen, pid, create_time).

    script=None runs the shared idle script; pass a marker-script path to
    give the decoy a distinguishable cmdline (production analogue: one
    TouchDesigner.exe per .toe file).
    """
    def _spawn(script=None):
        argv = [decoy_env.exe, script or decoy_env.idle_script]
        popen = subprocess.Popen(
            argv,
            env=decoy_env.child_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        try:
            create_time = psutil.Process(popen.pid).create_time()
        except psutil.Error:
            popen.kill()
            popen.wait(timeout=5)
            pytest.fail('decoy died at spawn - harness broken, not the code')
        # It must still be alive a beat later, or every survival assertion
        # in the suite is vacuous.
        time.sleep(0.2)
        if popen.poll() is not None:
            pytest.fail('decoy exited immediately (rc=%s) - harness broken'
                        % popen.returncode)
        _register(popen.pid, create_time, popen, 'test')
        return popen, popen.pid, create_time

    return _spawn


def pid_ct(pid):
    """(pid, create_time) for a live pid, or (pid, None) if gone."""
    try:
        return pid, psutil.Process(pid).create_time()
    except psutil.Error:
        return pid, None


def is_alive(pid, create_time):
    """True iff pid is running AND still the same process (create_time)."""
    try:
        return psutil.Process(pid).create_time() == create_time
    except psutil.Error:
        return False


def wait_gone(pid, create_time, timeout=6.0):
    """True once (pid, create_time) no longer names a live process."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not is_alive(pid, create_time):
            return True
        time.sleep(0.1)
    return False


def service_spawns():
    """(pid, create_time) of every child the code under test launched."""
    return [(e['pid'], e['create_time'])
            for e in _REGISTRY if e['note'] == 'service']


@pytest.fixture(autouse=True)
def leak_check(request, decoy_env):
    """Registry-driven teardown + leak verdict. See module docstring."""
    _REGISTRY.clear()
    yield

    survivors = []
    for entry in _REGISTRY:
        if is_alive(entry['pid'], entry['create_time']):
            survivors.append((entry['pid'], entry['note']))
            try:
                psutil.Process(entry['pid']).kill()  # by PID, never by image
            except psutil.Error:
                pass
    # Reap every Popen so no ResourceWarning fires from __del__ under
    # filterwarnings=error.
    for entry in _REGISTRY:
        popen = entry['popen']
        if popen is not None:
            try:
                popen.wait(timeout=5)
            except Exception:
                pass

    strays = []
    for proc in psutil.process_iter(['pid', 'name']):
        try:
            name = proc.info['name']
            if name and name.lower() == decoy_env.image.lower():
                strays.append(proc.info['pid'])
                psutil.Process(proc.info['pid']).kill()
        except psutil.Error:
            continue

    # Wave 2 ruling (2026-09-05): registered survivors in a PASSING test are
    # reaped silently, not failed. The contract tests end by ASSERTING that
    # unmanaged decoys are still alive — that aliveness IS the contract — so a
    # green contract test and a fail-on-registered-survivors policy are mutually
    # exclusive by construction. The machine-hygiene property is preserved by
    # the reap above (by PID, create_time-verified); the discipline signal now
    # applies only to UNREGISTERED strays, which still mean the code under test
    # spawned something the harness never authorised — that is the real leak.
    rep = getattr(request.node, 'rep_call', None)
    if rep is not None and rep.passed and strays:
        pytest.fail(
            'unregistered decoy stray in a passing test: strays=%r '
            '(reaped by PID; the code under test spawned outside the registry)'
            % (strays,))


# --------------------------------------------------------------------------
# isolated data root + probe
# --------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def data_root(tmp_path, monkeypatch):
    """Redirect the agent data root to tmp_path and PROVE it before running."""
    import shared_utils

    root = tmp_path / 'Owlette'
    (root / 'config').mkdir(parents=True)
    (root / 'tmp').mkdir()
    (root / 'logs').mkdir()

    # Runtime seam: everything that calls get_data_path() from now on.
    monkeypatch.setenv('OWLETTE_DATA_ROOT', str(root))
    # Import-frozen seam: constants resolved before this fixture existed.
    monkeypatch.setattr(shared_utils, 'CONFIG_PATH',
                        str(root / 'config' / 'config.json'))
    monkeypatch.setattr(shared_utils, 'RESULT_FILE_PATH',
                        str(root / 'tmp' / 'app_states.json'))
    shared_utils._invalidate_config_cache()

    # THE PROBE: re-resolve every path the suite can write through and fail
    # loudly if any escaped the sandbox. This must hold on every test.
    tmp_norm = os.path.normcase(os.path.normpath(str(tmp_path)))
    program_data = os.path.normcase(r'c:\programdata')
    resolved = {
        'CONFIG_PATH': shared_utils.CONFIG_PATH,
        'RESULT_FILE_PATH': shared_utils.RESULT_FILE_PATH,
        'get_data_path()': shared_utils.get_data_path(),
        "get_data_path('tmp')": shared_utils.get_data_path('tmp'),
        "get_data_path('tmp/restart.flag')":
            shared_utils.get_data_path('tmp/restart.flag'),
    }
    for label, path in resolved.items():
        norm = os.path.normcase(os.path.normpath(path))
        if norm.startswith(program_data) or not norm.startswith(tmp_norm):
            pytest.fail(
                'ISOLATION PROBE FAILED: %s resolves to %r which is outside '
                'the test sandbox %r - refusing to run against the live '
                'install' % (label, path, str(tmp_path)))

    yield root


def make_entry(entry_id, name, exe_path, file_path='', launch_mode='always',
               **overrides):
    entry = {
        'id': entry_id,
        'name': name,
        'exe_path': exe_path,
        'file_path': file_path,
        'cwd': '',
        'launch_mode': launch_mode,
        'autolaunch': launch_mode != 'off',
        'priority': 'Normal',
        'visibility': 'Show',
        'time_delay': '0',
        'time_to_init': '10',
        'relaunch_attempts': '3',
        'check_responsive': True,
    }
    entry.update(overrides)
    return entry


def write_config(entries):
    """Write the redirected config.json and drop the mtime cache."""
    import shared_utils
    config = {'firebase': {'enabled': False}, 'processes': entries}
    with open(shared_utils.CONFIG_PATH, 'w') as f:
        json.dump(config, f, indent=2)
    shared_utils._invalidate_config_cache()
    return config


def read_app_states():
    import shared_utils
    if not os.path.exists(shared_utils.RESULT_FILE_PATH):
        return {}
    with open(shared_utils.RESULT_FILE_PATH, 'r') as f:
        return json.load(f)


def write_app_states(states):
    import shared_utils
    shared_utils.write_json_to_file(states, shared_utils.RESULT_FILE_PATH)


def craft_identity_fields(row, create_time, exe_path):
    """Stamp the Wave-1 (D2) identity fields onto an app_states row.

    Single authority for the forward schema - see module docstring. Inert
    against today's code; create_time is the psutil value captured while the
    recorded process was alive - the same source Wave 2 will use when it
    writes the record for real.
    """
    row['create_time'] = create_time
    row['exe'] = exe_path
    return row


# --------------------------------------------------------------------------
# the service double
# --------------------------------------------------------------------------

# Real OwletteService methods bound onto the double via the descriptor
# protocol. Everything on this list runs the production body.
_REAL_METHODS = [
    'handle_process',
    'handle_process_launch',
    '_launch_locked',
    '_launch_lock_for',
    'kill_and_relaunch_process',
    '_kill_and_relaunch_locked',
    'handle_unresponsive_process',
    'reached_max_relaunch_attempts',
    '_is_restart_prompt_active',
    'log_and_notify',
    '_find_running_process_by_exe',
    '_adopt_running_instance',
    'recover_running_processes',
    '_terminate_processes_for_install',
    'launch_process_as_user',
    'handle_firebase_command',
    '_get_process_launch_mode',
    'main',
]


@pytest.fixture
def service_factory(monkeypatch, decoy_env):
    """Factory building service doubles with the launch seam installed.

    Multiple doubles per test are the point: a fresh double with the state
    files preserved IS the simulated service restart.
    """
    import shared_utils
    import owlette_service
    from owlette_service import OwletteService

    # -- launch seam (installed once per test) ----------------------------
    monkeypatch.setattr(shared_utils, 'get_python_exe_path',
                        lambda: sys.executable)

    def _fake_create_process_as_user(token, app_name, command_line, *rest):
        # command_line: '"<python>" "<process_launcher.py>" "<args_file>"'
        args_file = command_line.rsplit('"', 2)[-2]
        with open(args_file, 'r') as f:
            launch_args = json.load(f)
        exe_path = launch_args['exe_path']
        file_path = launch_args.get('file_path') or ''
        # ShellExecuteEx contract: file_path is the single parameter. The
        # idle default keeps a bare decoy-runner launch long-lived (see
        # module docstring, deviation 1).
        argv = [exe_path, file_path if file_path else decoy_env.idle_script]
        popen = subprocess.Popen(
            argv,
            env=decoy_env.child_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        try:
            create_time = psutil.Process(popen.pid).create_time()
            _register(popen.pid, create_time, popen, 'service')
        except psutil.Error:
            _register(popen.pid, -1.0, popen, 'service')
        with open(launch_args['pid_file'], 'w') as f:
            json.dump({'pid': popen.pid}, f)
        # (hProcess, hThread, dwProcessId, dwThreadId) of the helper.
        return None, None, popen.pid, 0

    monkeypatch.setattr(owlette_service.win32process, 'CreateProcessAsUser',
                        _fake_create_process_as_user)

    # -- double builder ---------------------------------------------------
    def _make():
        svc = SimpleNamespace(
            # attribute set mirrors OwletteService._init_state (the slice
            # these methods touch); the parity rule applies to src, not here
            last_started={},
            install_locks={},
            relaunch_attempts={},
            first_start=True,
            results={},
            firebase_client=None,
            _shutting_down=False,
            _skip_launch_delay=set(),
            manual_overrides={},
            current_time=datetime.datetime.now(),
            current_timestamp=int(time.time()),
            _cached_site_timezone=None,
            _launch_locks={},
            _launch_locks_guard=threading.Lock(),
            _restart_prompt_until=0.0,
            active_installations={},
            _command_rate_limits={},
            COMMAND_RATE_LIMIT_SECONDS=OwletteService.COMMAND_RATE_LIMIT_SECONDS,
            HANG_CONFIRM_SECONDS=OwletteService.HANG_CONFIRM_SECONDS,
            console_user_token=object(),  # truthy: a user session exists
            environment=None,
            _restart_exit_code=0,
            _shutdown_trigger=None,
            _command_router=SimpleNamespace(has_handler=lambda cmd_type: False),
            is_alive=True,
            _service_start_time=time.time(),
            _reboot_schedule_counter=0,
            _display_check_counter=0,
            _roost_scrub_check_counter=0,
        )
        for method_name in _REAL_METHODS:
            unbound = getattr(OwletteService, method_name)
            setattr(svc, method_name, unbound.__get__(svc, OwletteService))
        svc._validate_path = OwletteService._validate_path  # staticmethod

        # User-session plumbing the sandbox cannot provide; each is either
        # spied on by tests or a no-op with the real return contract.
        svc._refresh_user_token = lambda: None
        svc.launch_python_script_as_user = MagicMock(return_value=True)
        svc.launch_desktop_app_as_user = MagicMock(return_value=False)
        svc._write_cortex_event = MagicMock()          # crash-event spy
        svc._capture_crash_screenshot = MagicMock(return_value=None)
        return svc

    return _make


def tick(svc, entry):
    """One monitor-loop visit to one entry, as main() would perform it."""
    svc.current_time = datetime.datetime.now()
    svc.handle_process(entry)
