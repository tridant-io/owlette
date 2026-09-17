"""The osadapter surface contract.

One shared body, run against every adapter that implements the whole surface,
plus a block per arm for what only that arm can be held to. `posix` carries the
half macOS and Linux share and is exercised as itself rather than through the
parametrisation, which `linux` joined once it answered the other nine
operations on top of it; `darwin` joins it with the macOS arm.
"""

import importlib
import inspect
import json
import os
import shutil
import stat
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

import psutil
import pytest

import osadapter

if sys.platform != 'win32':
    import pwd


posix_only = pytest.mark.skipif(sys.platform == 'win32', reason='posix-only')
# The shared arm's session lookup is loginctl and /proc, so whatever asserts
# either of those is held to on Linux; macOS answers both differently, in
# darwin.py.
linux_only = pytest.mark.skipif(
    not sys.platform.startswith('linux'),
    reason='a Linux mechanism; macOS answers it in darwin.py',
)

ADAPTERS = [
    pytest.param('win', marks=pytest.mark.windows),
    pytest.param('linux', marks=linux_only),
]
as_root = pytest.mark.skipif(
    sys.platform == 'win32' or os.geteuid() != 0,
    reason='needs the root daemon',
)

# The account the daemon spawns into: the kiosk user on a real machine, and any
# other local account will do to prove the process is not left running as root.
SPAWN_UID = 1000

# The operations the shared POSIX arm answers — everything either POSIX
# platform does the same way, the two GUI jobs included. The remaining nine are
# the per-OS arms' own.
POSIX_OPERATIONS = (
    'capture_screen', 'console_user', 'data_root', 'desktop_process_name',
    'json_lock', 'launch_managed_process', 'notify', 'run_job', 'session_env',
    'spawn_as_user',
)

PENDING_REBOOT_KEYS = {
    'pending', 'reasons', 'last_update_installed', 'next_scheduled_update',
}


@pytest.fixture(params=ADAPTERS)
def adapter(request):
    """Each adapter module that can run on this OS."""
    return importlib.import_module(f'osadapter.{request.param}')


@pytest.fixture
def win():
    return importlib.import_module('osadapter.win')


@pytest.fixture
def posix():
    return importlib.import_module('osadapter.posix')


@pytest.fixture
def linux():
    return importlib.import_module('osadapter.linux')


@pytest.fixture
def relocated(tmp_path, monkeypatch):
    """The data root, pointed at a sandbox for the duration of one test."""
    monkeypatch.setenv(osadapter.DATA_ROOT_ENV, str(tmp_path))
    return tmp_path


def _parameters(signature):
    return [(p.name, p.kind, p.default) for p in signature.parameters.values()]


def _documented(name):
    """The Protocol's signature for `name`, minus its `self`."""
    signature = inspect.signature(getattr(osadapter.OSAdapter, name))
    return signature.replace(parameters=list(signature.parameters.values())[1:])


class TestSurface:
    """The operation list itself."""

    def test_the_surface_is_nineteen_operations(self):
        assert len(osadapter.OPERATIONS) == 19

    def test_every_operation_is_implemented(self, adapter):
        missing = [
            name for name in osadapter.OPERATIONS
            if not callable(getattr(adapter, name, None))
        ]
        assert missing == []

    @pytest.mark.parametrize('name', osadapter.OPERATIONS)
    def test_the_implementation_matches_the_documented_signature(self, adapter, name):
        implemented = inspect.signature(getattr(adapter, name))
        assert _parameters(implemented) == _parameters(_documented(name))

    def test_get_returns_the_adapter_for_this_machine(self, adapter):
        assert osadapter.get() is adapter

    def test_operations_read_off_the_package(self, adapter):
        assert osadapter.desktop_process_name is adapter.desktop_process_name

    def test_the_package_hides_everything_else(self):
        with pytest.raises(AttributeError):
            getattr(osadapter, 'reboot_the_planet')


class TestBehaviour:
    """What each operation must be true of on any platform."""

    def test_data_root_is_the_data_path_seam(self, adapter):
        import shared_utils

        assert adapter.data_root() == shared_utils.get_data_path()
        assert adapter.data_root('config/config.json') == shared_utils.get_data_path(
            'config/config.json'
        )

    def test_desktop_process_name_names_the_desktop_app(self, adapter):
        assert adapter.desktop_process_name().startswith('owlette-desktop')

    def test_json_lock_is_a_context_manager(self, adapter):
        lock = adapter.json_lock()
        assert hasattr(lock, '__enter__') and hasattr(lock, '__exit__')
        with lock:
            pass

    def test_streamer_capability_is_a_bool(self, adapter):
        assert isinstance(adapter.streamer_capable(), bool)

    def test_pending_reboot_reports_the_documented_shape(self, adapter):
        result = adapter.pending_reboot()
        assert isinstance(result['pending'], bool)
        assert isinstance(result['reasons'], list)

    def test_machine_identity_is_stable_and_keyed(self, adapter):
        machine_id = adapter.stable_machine_id()
        assert machine_id and machine_id == adapter.stable_machine_id()

        material = adapter.key_material()
        assert isinstance(material, bytes) and material

    def test_console_user_is_a_name_or_nobody(self, adapter):
        user = adapter.console_user()
        assert user is None or (isinstance(user, str) and user)

    def test_an_unknown_service_verb_is_rejected(self, adapter):
        with pytest.raises(ValueError):
            adapter.service_control('obliterate', 'OwletteService')


@pytest.mark.windows
class TestWindows:
    """What the Windows arm delegates to, and what it refuses."""

    def test_streamer_capable_is_unconditionally_true(self, win):
        assert win.streamer_capable() is True

    def test_desktop_process_name_is_the_tray_image_name(self, win):
        import shared_utils

        assert win.desktop_process_name() == 'owlette-desktop.exe'
        assert win.desktop_process_name() == shared_utils.DESKTOP_EXE_NAME

    def test_json_lock_is_the_cross_process_mutex(self, win):
        import shared_utils

        with win.json_lock() as held:
            assert isinstance(held, shared_utils._CrossProcessLock)

    def test_pending_reboot_delegates_to_the_mcp_probe(self, win, monkeypatch):
        import mcp_tools

        probed = {'pending': True, 'reasons': ['cbs']}
        monkeypatch.setattr(
            mcp_tools, 'check_pending_reboot', lambda params, config: probed
        )
        assert win.pending_reboot() is probed

    def test_pending_reboot_carries_the_windows_probe_keys(self, win):
        assert set(win.pending_reboot()) == PENDING_REBOOT_KEYS

    def test_installed_software_delegates_to_the_registry_reader(self, win, monkeypatch):
        import registry_utils

        catalogue = [{'name': 'TouchDesigner', 'version': '2023.12120'}]
        monkeypatch.setattr(
            registry_utils, 'get_installed_software', lambda: catalogue
        )
        assert win.installed_software() is catalogue

    def test_notify_maps_onto_the_notification_tool(self, win, monkeypatch):
        import mcp_tools

        sent = {}

        def _show_notification(params, config):
            sent.update(params)
            return {'style': 'toast', 'status': 'sent'}

        monkeypatch.setattr(mcp_tools, '_show_notification', _show_notification)

        assert win.notify('owlette', 'rebooting in 30s')['status'] == 'sent'
        assert sent == {'title': 'owlette', 'message': 'rebooting in 30s'}

    def test_stop_waits_for_the_service_to_reach_stopped(self, win, monkeypatch):
        import win32service

        service = _FakeService(win32service.SERVICE_RUNNING)
        service.install(monkeypatch)

        assert win.service_control('stop', 'OwletteService') is True
        assert service.controls == [('stop', 'OwletteService')]
        assert service.state == win32service.SERVICE_STOPPED

    def test_a_stop_that_never_reaches_stopped_is_a_failure(self, win, monkeypatch):
        import win32service

        service = _FakeService(win32service.SERVICE_RUNNING, settles=False)
        service.install(monkeypatch)

        assert win.service_control('stop', 'OwletteService') is False

    def test_a_service_already_in_the_requested_state_is_a_success(
        self, win, monkeypatch
    ):
        import pywintypes
        import win32service
        import winerror

        service = _FakeService(win32service.SERVICE_STOPPED, refuses={
            'stop': pywintypes.error(
                winerror.ERROR_SERVICE_NOT_ACTIVE, 'StopService', 'not active'
            ),
        })
        service.install(monkeypatch)

        assert win.service_control('stop', 'OwletteService') is True

    def test_restart_stops_then_starts(self, win, monkeypatch):
        import win32service

        service = _FakeService(win32service.SERVICE_RUNNING)
        service.install(monkeypatch)

        assert win.service_control('restart', 'OwletteService') is True
        assert service.controls == [
            ('stop', 'OwletteService'), ('start', 'OwletteService'),
        ]
        assert service.state == win32service.SERVICE_RUNNING

    def test_restart_does_not_start_a_service_that_would_not_stop(
        self, win, monkeypatch
    ):
        import win32service

        service = _FakeService(win32service.SERVICE_RUNNING, settles=False)
        service.install(monkeypatch)

        assert win.service_control('restart', 'OwletteService') is False
        assert service.controls == [('stop', 'OwletteService')]

    def test_a_refused_control_is_a_failure(self, win, monkeypatch):
        import win32service

        service = _FakeService(win32service.SERVICE_RUNNING, refuses={
            'stop': OSError('access denied'),
        })
        service.install(monkeypatch)

        assert win.service_control('stop', 'OwletteService') is False

    def test_reboot_issues_the_shutdown_command(self, win, monkeypatch):
        issued = _record_subprocess_run(monkeypatch)

        win.reboot(30, 'owlette remote reboot requested')

        # CREATE_NO_WINDOW: the desktop app spawns the CLI with no console of
        # its own, and a console child left to allocate one flashes a window
        # across the kiosk display.
        assert issued == [(
            ['shutdown', '/r', '/t', '30', '/c', 'owlette remote reboot requested'],
            {'check': True, 'timeout': 15,
             'creationflags': subprocess.CREATE_NO_WINDOW},
        )]

    def test_reboot_without_a_message_omits_the_comment(self, win, monkeypatch):
        issued = _record_subprocess_run(monkeypatch)

        win.reboot(0)

        assert issued[0][0] == ['shutdown', '/r', '/t', '0']

    def test_shutdown_issues_the_power_off_command(self, win, monkeypatch):
        issued = _record_subprocess_run(monkeypatch)

        win.shutdown(30, 'owlette remote shutdown requested')

        assert issued == [(
            ['shutdown', '/s', '/t', '30', '/c', 'owlette remote shutdown requested'],
            {'check': True, 'timeout': 15,
             'creationflags': subprocess.CREATE_NO_WINDOW},
        )]

    def test_cancel_reboot_reports_whether_the_abort_took(self, win, monkeypatch):
        issued = _record_subprocess_run(monkeypatch, returncode=0)
        assert win.cancel_reboot() is True
        # CREATE_NO_WINDOW for the same reason the reboot above carries it: a
        # dismissal runs from the CLI the desktop app spawns without a console,
        # and a child left to allocate one flashes a window at the kiosk.
        assert issued[0] == (
            ['shutdown', '/a'],
            {'capture_output': True, 'timeout': 15,
             'creationflags': subprocess.CREATE_NO_WINDOW},
        )

        _record_subprocess_run(monkeypatch, returncode=1)
        assert win.cancel_reboot() is False

    @pytest.mark.parametrize('name, call', [
        ('session_env', lambda a: a.session_env(1000)),
        ('spawn_as_user', lambda a: a.spawn_as_user(['owlette'], 1000)),
        ('run_job', lambda a: a.run_job({'type': 'capture'})),
        ('launch_managed_process', lambda a: a.launch_managed_process({})),
    ])
    def test_the_service_owned_operations_refuse(self, win, name, call):
        with pytest.raises(osadapter.NotSupportedHere):
            call(win)

    def test_capture_runs_the_grab_in_the_console_session(self, win):
        """The round-trip the service has always made: mss in the console
        user's session writing a raw PNG, compression left to the caller
        because that interpreter frequently cannot import PIL."""
        calls = []
        answered = {'outputDir': 'C:\\ipc\\out', 'files': ['screenshot.png']}

        def executor(job_type, code, **kwargs):
            calls.append((job_type, code, kwargs))
            return answered

        assert win.capture_screen(2, executor=executor, timeout_s=9) is answered

        job_type, code, kwargs = calls[0]
        assert (job_type, kwargs) == ('python', {'timeout': 9, 'trusted': True})
        assert 'import mss' in code and 'PIL' not in code
        assert "'screenshot.png'" in code
        assert '2 if 2 > 0' in code


class _FakeService:
    """An in-memory SCM: a control moves the state, the wait polls for it."""

    def __init__(self, state, settles=True, refuses=None):
        self.state = state
        self.settles = settles
        self.refuses = refuses or {}
        self.controls = []

    def install(self, monkeypatch):
        import win32service
        import win32serviceutil

        monkeypatch.setattr(
            win32serviceutil, 'StartService',
            self._control('start', win32service.SERVICE_RUNNING),
        )
        monkeypatch.setattr(
            win32serviceutil, 'StopService',
            self._control('stop', win32service.SERVICE_STOPPED),
        )
        monkeypatch.setattr(win32serviceutil, 'WaitForServiceStatus', self._wait)

    def _control(self, verb, reaches):
        def _issue(name):
            self.controls.append((verb, name))
            if verb in self.refuses:
                raise self.refuses[verb]
            if self.settles:
                self.state = reaches
        return _issue

    def _wait(self, name, wanted, seconds):
        if self.state != wanted:
            raise OSError(f"{name} never reached {wanted} in {seconds}s")


def _record_subprocess_run(monkeypatch, returncode=0):
    """Capture what the adapter hands subprocess.run instead of running it."""
    issued = []

    def _run(command, **kwargs):
        issued.append((command, kwargs))
        return SimpleNamespace(returncode=returncode, stdout=b'', stderr=b'')

    monkeypatch.setattr(subprocess, 'run', _run)
    return issued


@posix_only
class TestPosix:
    """The shared POSIX arm: what it answers, on the machine running the suite."""

    @pytest.mark.parametrize('name', POSIX_OPERATIONS)
    def test_the_implementation_matches_the_documented_signature(self, posix, name):
        implemented = inspect.signature(getattr(posix, name))
        assert _parameters(implemented) == _parameters(_documented(name))

    def test_the_arm_answers_for_this_machine(self, posix):
        assert osadapter.data_root() == posix.data_root()

    def test_data_root_is_the_data_path_seam(self, posix):
        import shared_utils

        assert posix.data_root() == shared_utils.get_data_path()
        assert posix.data_root('config/config.json') == shared_utils.get_data_path(
            'config/config.json'
        )

    def test_the_desktop_app_is_named_without_an_exe_suffix(self, posix):
        assert posix.desktop_process_name() == 'owlette-desktop'

    def test_capture_is_a_job_for_the_desktop_app(self, posix, monkeypatch, relocated):
        """The daemon has no display, so the grab is the app's — and the result
        is the shape the Windows executor answers with, down to the monitor
        count screenshot_capture reads off stdout."""
        monkeypatch.setattr(posix, '_desktop_pid', lambda: os.getpid())
        runner = _FakeJobRunner(
            relocated, {'files': ['screenshot.png'], 'monitors': 2}
        )
        runner.start()
        try:
            result = posix.capture_screen(1, executor=_never_called, timeout_s=7)
        finally:
            runner.stop()

        assert runner.seen['type'] == 'capture'
        assert (runner.seen['monitor'], runner.seen['timeout_s']) == (1, 7)
        assert result['files'] == ['screenshot.png']
        assert result['stdout'] == 'monitors=2'
        assert result['outputDir'] == str(
            relocated / 'ipc' / 'results' / runner.seen['id']
        )

    def test_a_capture_is_held_to_the_callers_budget(
        self, posix, monkeypatch, relocated
    ):
        """The crash screenshot captures inline on the monitor loop with an
        eight-second budget: an app that is up and never answers must not
        hold that loop for the two minutes the seam otherwise allows — the
        cap is stood down to ten seconds so a regression fails here in ten
        rather than holding the suite for the full two minutes.
        """
        monkeypatch.setattr(posix, '_desktop_pid', lambda: os.getpid())
        monkeypatch.setattr(posix, 'JOB_TIMEOUT_SECONDS', 10)
        monkeypatch.setattr(posix, '_JOB_HANDOVER_SECONDS', 0.2)
        started = time.monotonic()

        result = posix.capture_screen(0, executor=_never_called, timeout_s=0.3)

        assert result['error'] == 'desktop_not_running'
        assert time.monotonic() - started < 5

    def test_a_capture_the_app_refuses_leaves_nothing_behind(
        self, posix, monkeypatch, relocated
    ):
        """The caller raises on the error without reading any output, so the
        result directory — which is the caller's to remove — goes here rather
        than staying in the seam for good.
        """
        monkeypatch.setattr(posix, '_desktop_pid', lambda: os.getpid())
        runner = _FakeJobRunner(relocated, {'error': 'no_display'})
        runner.start()
        try:
            result = posix.capture_screen(0, executor=_never_called, timeout_s=5)
        finally:
            runner.stop()

        assert result['error'] == 'no_display'
        assert list((relocated / 'ipc' / 'results').iterdir()) == []

    def test_capture_without_the_desktop_app_fails_closed(self, posix, monkeypatch):
        monkeypatch.setattr(posix, '_desktop_pid', lambda: None)

        result = posix.capture_screen(0, executor=_never_called, timeout_s=5)

        assert result['error'] == 'desktop_not_running'

    def test_a_notification_is_a_job_that_leaves_nothing_behind(
        self, posix, monkeypatch, relocated
    ):
        """No osascript and no notify-send: neither reaches a session from a
        root daemon. The job writes no files, so its result directory — which
        is the caller's to remove — goes on the way out."""
        monkeypatch.setattr(posix, '_desktop_pid', lambda: os.getpid())
        runner = _FakeJobRunner(relocated, {'shown': True})
        runner.start()
        try:
            result = posix.notify('owlette', 'the projector is off')
        finally:
            runner.stop()

        assert result == {'status': 'sent'}
        assert runner.seen['type'] == 'notify'
        assert runner.seen['title'] == 'owlette'
        assert runner.seen['body'] == 'the projector is off'
        assert list((relocated / 'ipc' / 'results').iterdir()) == []

    def test_a_notification_without_the_desktop_app_fails_closed(self, posix, monkeypatch):
        monkeypatch.setattr(posix, '_desktop_pid', lambda: None)

        assert posix.notify('owlette', 'hi')['error'] == 'desktop_not_running'

    def test_console_user_is_an_account_or_nobody(self, posix):
        user = posix.console_user()
        assert user is None or pwd.getpwnam(user)

    def test_a_tty_session_is_not_a_seat(self, posix, monkeypatch):
        """What a headless box, a container and WSL all look like: a login is
        listed, and none of them has a display to reach."""
        _stub_sessions(monkeypatch, posix, {
            '4': 'User=0\nName=root\nLeader=291\nType=tty\nActive=yes\n',
        })
        assert posix.console_user() is None

    def test_the_active_graphical_session_names_the_console_user(self, posix, monkeypatch):
        _stub_sessions(monkeypatch, posix, {
            '2': 'User=0\nName=root\nLeader=291\nType=tty\nActive=yes\n',
            '3': 'User=1000\nName=kiosk\nLeader=1402\nType=x11\nActive=yes\n',
        })
        assert posix.console_user() == 'kiosk'

    def test_a_switched_away_session_is_not_the_console_user(self, posix, monkeypatch):
        _stub_sessions(monkeypatch, posix, {
            '3': 'User=1000\nName=kiosk\nLeader=1402\nType=x11\nActive=no\n',
        })
        assert posix.console_user() is None

    @linux_only
    def test_session_env_is_lifted_from_the_session_leader(self, posix, monkeypatch):
        leader = _leader_carrying({
            'DISPLAY': ':0',
            'XAUTHORITY': '/run/user/1000/gdm/Xauthority',
            'XDG_RUNTIME_DIR': '/run/user/1000',
            'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/1000/bus',
            'XDG_SESSION_TYPE': 'x11',
            'WAYLAND_DISPLAY': 'wayland-0',
            'GNOME_KEYRING_CONTROL': '/run/user/1000/keyring',
        })
        try:
            _stub_leader(monkeypatch, posix, leader.pid)
            env = posix.session_env(os.getuid())
        finally:
            _stop_child(leader)

        assert env['DISPLAY'] == ':0'
        assert env['XAUTHORITY'] == '/run/user/1000/gdm/Xauthority'
        assert env['XDG_RUNTIME_DIR'] == '/run/user/1000'
        assert env['DBUS_SESSION_BUS_ADDRESS'] == 'unix:path=/run/user/1000/bus'
        assert env['WAYLAND_DISPLAY'] == 'wayland-0'
        assert 'GNOME_KEYRING_CONTROL' not in env

    @linux_only
    def test_xauthority_falls_back_to_the_home_cookie(self, posix, monkeypatch):
        """Only when the leader carries none — GDM, LightDM and SDDM each keep
        the cookie somewhere else, and a guess would be the wrong one."""
        leader = _leader_carrying({'DISPLAY': ':0', 'HOME': '/home/kiosk'})
        try:
            _stub_leader(monkeypatch, posix, leader.pid)
            env = posix.session_env(os.getuid())
        finally:
            _stop_child(leader)

        assert env['XAUTHORITY'] == '/home/kiosk/.Xauthority'

    def test_without_a_seat_the_environment_is_the_account_alone(self, posix, monkeypatch):
        monkeypatch.setattr(posix, '_graphical_session', lambda uid=None: None)

        env = posix.session_env(os.getuid())

        assert env['HOME'] == pwd.getpwuid(os.getuid()).pw_dir
        assert 'DISPLAY' not in env and 'XAUTHORITY' not in env

    @as_root
    def test_spawn_as_user_runs_as_that_account(self, posix):
        account = _spawn_account()
        pid = posix.spawn_as_user(['/bin/sleep', '30'], account.pw_uid)
        try:
            process = psutil.Process(pid)
            assert process.is_running()
            assert process.uids().real == account.pw_uid
            assert process.gids().real == account.pw_gid
        finally:
            _stop_pid(posix, pid)

    @as_root
    def test_a_spawned_process_that_exits_leaves_no_pid_behind(self, posix):
        """Supervision is pid-based, and a child nobody waits on keeps its pid as
        a zombie — which is exactly what a pid check reads as still running."""
        account = _spawn_account()
        pid = posix.spawn_as_user(['/bin/sleep', '0.1'], account.pw_uid)

        _wait_for(lambda: _status(pid) in (psutil.STATUS_ZOMBIE, None))
        posix._reap_finished()

        assert not psutil.pid_exists(pid)

    @as_root
    def test_a_managed_process_launches_as_the_console_user(self, posix, monkeypatch):
        account = _spawn_account()
        monkeypatch.setattr(posix, 'console_user', lambda: account.pw_name)

        pid = posix.launch_managed_process({
            'id': 'sleeper', 'exe_path': '/bin/sleep', 'file_path': '30',
        })
        try:
            process = psutil.Process(pid)
            assert process.is_running()
            assert process.uids().real == account.pw_uid
            assert process.cmdline() == ['/bin/sleep', '30']
        finally:
            _stop_pid(posix, pid)

    def test_a_managed_process_needs_somebody_at_the_machine(self, posix, monkeypatch):
        """Never as root: a kiosk application the daemon owns has no display and
        writes its files where the operator cannot reach them."""
        monkeypatch.setattr(posix, 'console_user', lambda: None)

        assert posix.launch_managed_process({'exe_path': '/bin/sleep'}) is None

    def test_a_managed_process_is_never_launched_through_a_symlink(
        self, posix, monkeypatch, tmp_path
    ):
        """The refusal OwletteService._validate_path applies on Windows: the row
        arrives from Firestore, and a link under a directory the console user can
        write is not the path the operator chose."""
        link = tmp_path / 'app'
        link.symlink_to('/bin/sleep')
        monkeypatch.setattr(
            posix, 'console_user', lambda: pwd.getpwuid(os.getuid()).pw_name
        )

        assert posix.launch_managed_process(
            {'exe_path': str(link), 'file_path': '0.1'}
        ) is None

    @pytest.mark.parametrize('spec', [
        {'exe_path': '/nowhere/missing-binary'},
        {'exe_path': ''},
        {'exe_path': '/bin/sleep', 'cwd': '/nowhere/missing-directory'},
    ])
    def test_a_managed_process_that_cannot_run_is_refused(self, posix, monkeypatch, spec):
        monkeypatch.setattr(
            posix, 'console_user', lambda: pwd.getpwuid(os.getuid()).pw_name
        )

        assert posix.launch_managed_process(spec) is None

    def test_a_gui_job_with_no_desktop_app_fails_closed(self, posix, monkeypatch):
        monkeypatch.setattr(posix, '_desktop_pid', lambda: None)

        result = posix.run_job({'type': 'notify', 'title': 'owlette'})

        assert result['error'] == 'desktop_not_running'
        assert result['job'] == 'notify'

    @linux_only
    def test_the_desktop_gate_is_the_tray_marker(self, posix, tmp_path):
        """The same marker and image-name check the tray-liveness guard reads,
        which is what desktop_process_name() re-pointed onto this arm. It asks
        the package for the name, so it needs the arm `get()` selects."""
        import shared_utils

        app = tmp_path / posix.desktop_process_name()
        shutil.copy('/bin/sleep', app)
        marker = Path(shared_utils.TRAY_PID_PATH)
        marker.parent.mkdir(parents=True, exist_ok=True)
        child = subprocess.Popen([str(app), '30'])
        try:
            marker.write_text(str(child.pid), encoding='utf-8')
            assert posix._desktop_pid() == child.pid
        finally:
            _stop_child(child)
            marker.unlink(missing_ok=True)

    def test_a_gui_job_returns_what_the_app_wrote(self, posix, monkeypatch, relocated):
        monkeypatch.setattr(posix, '_desktop_pid', lambda: os.getpid())
        runner = _FakeJobRunner(relocated, {'files': ['screenshot.png'], 'stdout': 'monitors=2'})
        runner.start()
        try:
            result = posix.run_job({'type': 'capture', 'monitor': 0})
        finally:
            runner.stop()

        assert result['files'] == ['screenshot.png']
        assert result['outputDir'] == str(relocated / 'ipc' / 'results' / runner.seen['id'])
        assert runner.seen['type'] == 'capture'
        assert list((relocated / 'ipc' / 'jobs').iterdir()) == []

    def test_a_gui_job_the_app_never_answers_is_withdrawn(self, posix, monkeypatch, relocated):
        monkeypatch.setattr(posix, '_desktop_pid', lambda: os.getpid())
        monkeypatch.setattr(posix, 'JOB_TIMEOUT_SECONDS', 0.3)

        result = posix.run_job({'type': 'notify', 'title': 'owlette'})

        assert result['error'] == 'desktop_not_running'
        assert list((relocated / 'ipc' / 'jobs').iterdir()) == []

    def test_a_result_written_after_the_caller_gave_up_is_swept(
        self, posix, monkeypatch, relocated
    ):
        """outputDir is the caller's to remove and an abandoned job has no
        caller, so the next job through the seam clears what arrived late."""
        monkeypatch.setattr(posix, '_desktop_pid', lambda: os.getpid())
        monkeypatch.setattr(posix, 'JOB_TIMEOUT_SECONDS', 0.2)
        results = relocated / 'ipc' / 'results'
        runner = _FakeJobRunner(relocated, {'files': []}, delay=0.6)
        runner.start()
        try:
            assert posix.run_job({'type': 'notify'})['error'] == 'desktop_not_running'
            _wait_for(lambda: results.is_dir() and any(results.iterdir()))
        finally:
            runner.stop()

        monkeypatch.setattr(posix, '_desktop_pid', lambda: None)
        posix.run_job({'type': 'notify'})

        assert list(results.iterdir()) == []

    def test_the_app_cannot_name_the_directory_the_caller_removes(
        self, posix, monkeypatch, relocated
    ):
        """The result is written by the console user, and its caller removes
        `outputDir` as root once it has read the output
        (screenshot_capture.capture_in_user_session), so the seam names that
        directory rather than reading it back out of the result."""
        monkeypatch.setattr(posix, '_desktop_pid', lambda: os.getpid())
        elsewhere = relocated / 'elsewhere'
        elsewhere.mkdir()
        runner = _FakeJobRunner(relocated, {'files': [], 'outputDir': str(elsewhere)})
        runner.start()
        try:
            result = posix.run_job({'type': 'capture'})
        finally:
            runner.stop()

        assert result['outputDir'] == str(
            relocated / 'ipc' / 'results' / runner.seen['id']
        )
        assert elsewhere.is_dir()

    def test_a_result_that_is_not_a_file_of_its_own_is_not_read(self, posix, relocated):
        """The result directory is the app's to write: a link the daemon would
        follow out of the seam and a fifo it would block on past its own
        deadline are both refused."""
        output = relocated / 'ipc' / 'results' / 'probe'
        output.mkdir(parents=True)
        result = output / 'result.json'
        bait = relocated / 'bait.json'
        bait.write_text('{"files": []}', encoding='utf-8')
        result.symlink_to(bait)

        assert posix._read_result(str(result)) is None

        result.unlink()
        os.mkfifo(result)
        read = []
        reader = threading.Thread(
            target=lambda: read.append(posix._read_result(str(result))), daemon=True
        )
        reader.start()
        reader.join(5)

        assert not reader.is_alive()
        assert read == [None]

    def test_json_lock_is_the_cross_process_lock(self, posix, relocated):
        import shared_utils

        with posix.json_lock() as held:
            assert isinstance(held, shared_utils._CrossProcessLock)
            assert held.acquired
        assert _mode(relocated / 'tmp' / 'json.lock') == 0o660

    def test_the_json_lock_is_never_taken_through_a_symlink(self, posix, relocated):
        """`tmp/` is group-writable by design, and the daemon opens the lock
        O_RDWR on every config read and write — through a link that is whatever
        the console user pointed it at, a device node included."""
        import shared_utils

        assert shared_utils.ensure_data_directories() is True
        lock = relocated / 'tmp' / 'json.lock'
        bait = relocated / 'bait'
        bait.write_text('', encoding='utf-8')
        lock.unlink()
        lock.symlink_to(bait)

        with shared_utils._CrossProcessLock() as held:
            assert held.fd is None
            assert not held.acquired

    def test_two_processes_cannot_lose_a_json_update(self, posix, relocated):
        """The lock is cross-process or it is nothing: the desktop app writes
        the same files as the daemon."""
        counter = relocated / 'counter.json'
        counter.write_text(json.dumps({'count': 0}), encoding='utf-8')

        _run_writers(relocated, counter, cycles=200, gap=0.0, locked=True)

        assert json.loads(counter.read_text(encoding='utf-8'))['count'] == 400

    def test_the_same_writers_lose_updates_without_it(self, posix, relocated):
        """Negative control: the read-modify-write above is only safe because
        something serialises it."""
        counter = relocated / 'counter.json'
        counter.write_text(json.dumps({'count': 0}), encoding='utf-8')

        _run_writers(relocated, counter, cycles=50, gap=0.002, locked=False)

        assert json.loads(counter.read_text(encoding='utf-8'))['count'] < 100

    def test_the_data_root_carries_the_mode_table(self, posix, tmp_path, monkeypatch):
        import shared_utils

        root = tmp_path / 'owlette'
        # Negative control: a tree that is already there, wide open.
        (root / 'ipc').mkdir(parents=True)
        (root / 'config').mkdir()
        (root / 'config' / 'config.json').write_text('{}', encoding='utf-8')
        os.chmod(root / 'ipc', 0o777)
        os.chmod(root / 'config' / 'config.json', 0o666)
        monkeypatch.setenv(osadapter.DATA_ROOT_ENV, str(root))

        assert shared_utils.ensure_data_directories() is True

        assert _mode(root) == 0o750
        assert _mode(root / 'config') == 0o770
        assert _mode(root / 'tmp') == 0o770
        assert _mode(root / 'ipc') == 0o770
        assert _mode(root / 'ipc' / 'cortex_commands') == 0o770
        assert _mode(root / 'ipc' / 'jobs') == 0o770
        assert _mode(root / 'ipc' / 'results') == 0o770
        assert _mode(root / 'ipc' / 'swoop') == 0o770
        assert _mode(root / 'logs') == 0o750
        assert _mode(root / 'logs' / 'swoop') == 0o770
        assert _mode(root / 'cache') == 0o750
        assert _mode(root / 'config' / 'config.json') == 0o660

    def test_the_mode_table_is_not_applied_through_a_symlink(
        self, posix, tmp_path, monkeypatch
    ):
        """Half the table is group-writable by design, so an entry the console
        user swapped for a link must not carry 0770 out of the tree — least of
        all onto the root itself, which keeps `.tokens.enc` out of their reach."""
        import shared_utils

        root = tmp_path / 'owlette'
        outside = tmp_path / 'outside'
        outside.mkdir()
        os.chmod(outside, 0o700)
        monkeypatch.setenv(osadapter.DATA_ROOT_ENV, str(root))
        assert shared_utils.ensure_data_directories() is True

        (root / 'ipc' / 'jobs').rmdir()
        (root / 'ipc' / 'jobs').symlink_to(outside)
        (root / 'config' / 'machine_id').symlink_to(outside / 'cookie')
        (outside / 'cookie').write_text('x', encoding='utf-8')
        os.chmod(outside / 'cookie', 0o600)

        assert shared_utils.ensure_data_directories() is True

        assert _mode(outside) == 0o700
        assert _mode(outside / 'cookie') == 0o600
        assert _mode(root) == 0o750

    def test_the_group_owns_what_the_desktop_app_writes_into(self, posix, tmp_path, monkeypatch):
        """Only on a machine where packaging has created the group — until then
        the modes stand alone and the arm says so once."""
        import shared_utils

        gid = posix._group_gid()
        if gid is None or os.geteuid() != 0:
            pytest.skip(f'no {posix.GROUP} group to give the tree to')

        root = tmp_path / 'owlette'
        monkeypatch.setenv(osadapter.DATA_ROOT_ENV, str(root))
        cli_cache = root / posix.CLI_CACHE_DIR
        cli_cache.mkdir(parents=True)
        (cli_cache / 'claude').write_text('#!/bin/sh\n', encoding='utf-8')

        assert shared_utils.ensure_data_directories() is True

        assert os.stat(root).st_gid == gid
        assert os.stat(root / 'ipc').st_gid == gid
        assert os.stat(cli_cache).st_gid == gid
        assert os.stat(cli_cache / 'claude').st_gid == gid

    def test_a_file_the_daemon_writes_later_joins_the_group(self, posix, tmp_path):
        """The table is applied when the daemon starts; the cortex CLI is
        downloaded hours afterwards and is 0o750, which is the group's to run or
        nobody's."""
        import shared_utils

        gid = posix._group_gid()
        if gid is None or os.geteuid() != 0:
            pytest.skip(f'no {posix.GROUP} group to give the file to')
        binary = tmp_path / 'claude'
        binary.write_text('#!/bin/sh\n', encoding='utf-8')

        shared_utils.grant_data_group(str(binary))

        assert os.stat(binary).st_gid == gid

    def test_a_config_write_keeps_the_mode_the_table_set(self, posix, relocated):
        """The seam is the lock and the mode together: a write that came back at
        the daemon's umask would leave the app locking a file it cannot open."""
        import shared_utils

        assert shared_utils.ensure_data_directories() is True
        config = Path(shared_utils.get_data_path('config/config.json'))
        config.write_text('{}', encoding='utf-8')
        os.chmod(config, 0o660)

        shared_utils.write_json_to_file({'version': 1}, str(config))

        assert _mode(config) == 0o660

    def test_a_config_write_is_not_carried_off_a_planted_symlink(
        self, posix, relocated
    ):
        """A destination the console user swapped for a link has no identity to
        carry: carrying it would give a root-written config.json that file's
        mode, its group and its setgid bit."""
        import shared_utils

        assert shared_utils.ensure_data_directories() is True
        config = Path(shared_utils.get_data_path('config/config.json'))
        bait = relocated / 'bait.json'
        bait.write_text('{"bait": true}', encoding='utf-8')
        os.chmod(bait, 0o2666)
        config.symlink_to(bait)

        shared_utils.write_json_to_file({'version': 1}, str(config))

        assert _mode(config) == 0o660
        assert not os.stat(config).st_mode & (stat.S_ISUID | stat.S_ISGID)
        assert json.loads(bait.read_text(encoding='utf-8')) == {'bait': True}

    def test_a_config_written_for_the_first_time_reaches_the_app(
        self, posix, relocated
    ):
        """Pairing writes config.json on a machine whose daemon is already up.
        At the daemon's umask it would land 0644 root inside a directory the
        table opened to the group, and stay that way until the next start."""
        import shared_utils

        assert shared_utils.ensure_data_directories() is True
        config = Path(shared_utils.get_data_path('config/config.json'))
        private = relocated / 'private'
        private.mkdir(mode=0o750)

        shared_utils.write_json_to_file({'version': 1}, str(config))
        shared_utils.write_json_to_file({'version': 1}, str(private / 'state.json'))

        assert _mode(config) == 0o660
        # Only a directory that grants the group write hands the group anything.
        assert not _mode(private / 'state.json') & stat.S_IWGRP


@linux_only
class TestLinux:
    """The Linux arm: the nine operations the shared POSIX half leaves to it."""

    def test_the_seat_is_named_by_what_its_leader_declares(self, linux, posix, monkeypatch):
        """The variable every process in the session reads, not the label
        logind kept: a session can be re-typed under a running leader."""
        _seat(monkeypatch, posix, 'x11', {'XDG_SESSION_TYPE': 'wayland'})

        assert linux.session_type() == 'wayland'

    def test_a_leader_that_declares_nothing_leaves_logind_to_say(self, linux, posix, monkeypatch):
        _seat(monkeypatch, posix, 'x11', {})

        assert linux.session_type() == 'x11'

    def test_without_a_seat_there_is_no_session_type(self, linux, posix, monkeypatch):
        monkeypatch.setattr(posix, '_graphical_session', lambda uid=None: None)
        monkeypatch.setattr(posix, '_desktop_pid', lambda: None)

        assert linux.session_type() is None
        assert linux.streamer_capable() is False

    def test_a_seat_logind_does_not_list_is_named_by_the_app(
        self, linux, posix, monkeypatch
    ):
        """The Xorg kiosk layout: the user auto-logs into a tty and runs
        `startx`, so logind types the session `tty` and lists no seat at all —
        but the app holding the display is what a capture goes through, and
        its environment names the session this machine really runs.
        """
        monkeypatch.setattr(posix, '_graphical_session', lambda uid=None: None)
        monkeypatch.setattr(posix, '_desktop_pid', lambda: 4711)
        monkeypatch.setattr(posix, '_process_environ', lambda pid: {'DISPLAY': ':0'})

        assert linux.session_type() == 'x11'
        assert linux.streamer_capable() is True

        monkeypatch.setattr(
            posix, '_process_environ',
            lambda pid: {'WAYLAND_DISPLAY': 'wayland-0', 'DISPLAY': ':0'},
        )

        assert linux.session_type() == 'wayland'

    def test_a_wayland_seat_refuses_the_capture(self, linux, posix, monkeypatch):
        """A grab from outside a Wayland session is a black frame, so the
        refusal is typed and the app is never asked for one."""
        _seat(monkeypatch, posix, 'wayland', {})
        monkeypatch.setattr(posix, 'capture_screen', _never_called)

        result = linux.capture_screen(0, executor=_never_called, timeout_s=5)

        assert result['error'] == 'unsupported_on_platform'
        assert result['session_type'] == 'wayland'
        assert linux.streamer_capable() is False

    def test_an_x11_seat_captures_through_the_shared_job(self, linux, posix, monkeypatch):
        _seat(monkeypatch, posix, 'x11', {})
        captured = {'outputDir': '/tmp/out', 'files': ['screenshot.png']}
        monkeypatch.setattr(
            posix, 'capture_screen',
            lambda monitor, *, executor, timeout_s: captured,
        )

        assert linux.capture_screen(0, executor=None, timeout_s=5) is captured
        assert linux.streamer_capable() is True

    def test_a_start_is_the_state_the_unit_reached(self, linux, monkeypatch):
        commands = _FakeCommands(monkeypatch, linux, [('is-active', (0, 'active'))])

        assert linux.service_control('start', 'owlette-agent.service') is True
        assert commands.calls[0] == ['systemctl', 'start', 'owlette-agent.service']

    def test_a_stop_that_left_the_unit_running_is_a_failure(self, linux, monkeypatch):
        _FakeCommands(monkeypatch, linux, [('is-active', (0, 'active'))])

        assert linux.service_control('stop', 'owlette-agent') is False

    def test_a_stop_is_a_success_once_the_unit_is_not_active(self, linux, monkeypatch):
        """`is-active` exits non-zero for a unit that is not running, which is
        the answer the caller wanted, not a failed query."""
        _FakeCommands(monkeypatch, linux, [('is-active', (3, 'inactive'))])

        assert linux.service_control('stop', 'owlette-agent') is True

    def test_a_stop_against_a_unit_systemd_does_not_know_is_a_failure(
        self, linux, monkeypatch
    ):
        """Negative control for the stop above: `is-active` reports a unit
        that was never installed exactly as it reports a stopped one, which
        is the state a stop wanted — so a mis-spelled or not-yet-packaged
        unit would otherwise answer that it had been stopped.
        """
        commands = _FakeCommands(monkeypatch, linux, [
            ('systemctl stop', (5, '')),
            ('LoadState', (0, 'not-found')),
            ('is-active', (3, 'inactive')),
        ])

        assert linux.service_control('stop', 'owlette-kiosk') is False
        assert commands.calls[1] == [
            'systemctl', 'show', '-p', 'LoadState', '--value',
            'owlette-kiosk.service',
        ]

    def test_a_systemctl_that_never_ran_is_a_failure_for_every_verb(self, linux, monkeypatch):
        """Negative control for the stop above: an unreachable systemctl leaves
        the unit in no known state, and 'not active' must not read as success."""
        _FakeCommands(monkeypatch, linux, [('systemctl', None)])

        assert linux.service_control('stop', 'owlette-agent') is False
        assert linux.service_control('start', 'owlette-agent') is False

    def test_the_agents_own_service_name_resolves_to_its_unit(self, linux, monkeypatch):
        """Every call site spells the agent's service the way the Windows SCM
        does; this arm is what knows the unit it is here."""
        import shared_utils

        commands = _FakeCommands(monkeypatch, linux, [('is-active', (0, 'active'))])

        assert linux.service_control('restart', shared_utils.SERVICE_NAME) is True
        assert commands.calls[0] == ['systemctl', 'restart', 'owlette-agent.service']

    def test_the_machine_id_is_the_one_systemd_wrote(self, linux, monkeypatch, tmp_path):
        identity = tmp_path / 'machine-id'
        identity.write_text('4c2f6a1b9e8d4f3a8b7c6d5e4f3a2b1c\n', encoding='utf-8')
        monkeypatch.setattr(
            linux, 'MACHINE_ID_FILES', (str(tmp_path / 'absent'), str(identity)),
        )

        assert linux.stable_machine_id() == '4c2f6a1b9e8d4f3a8b7c6d5e4f3a2b1c'
        assert linux.key_material() == b'4c2f6a1b9e8d4f3a8b7c6d5e4f3a2b1c'

    def test_a_machine_with_no_machine_id_still_has_an_identity(self, linux, monkeypatch, tmp_path):
        """A container carries an empty one; the token store still needs
        something machine-bound to key on."""
        empty = tmp_path / 'machine-id'
        empty.write_text('\n', encoding='utf-8')
        monkeypatch.setattr(linux, 'MACHINE_ID_FILES', (str(empty),))

        assert linux.stable_machine_id() == str(uuid.getnode())

    def test_installed_software_reads_the_dpkg_database(self, linux, monkeypatch):
        rows = (
            'owlette-agent\t3.4.0\tTridant <support@tridant.io>\tinstalled\n'
            'libva2\t2.20.0-2build1\tUbuntu Developers <u@d>\tinstalled\n'
            'removed-thing\t1.0\tSomebody <s@t>\tconfig-files\n'
        )
        _FakeCommands(monkeypatch, linux, [('dpkg-query', (0, rows))])

        packages = linux.installed_software()

        # A package removed but not purged is not installed software.
        assert [package['name'] for package in packages] == ['owlette-agent', 'libva2']
        assert packages[0]['version'] == '3.4.0'
        assert packages[0]['publisher'] == 'Tridant <support@tridant.io>'
        assert packages[0]['uninstall_command'] == 'apt-get remove -y owlette-agent'
        # Both of these are read off every row by the dashboard's uninstall
        # dialog, which has no arm for a missing field.
        assert packages[0]['installer_type'] == 'dpkg'
        assert packages[0]['install_location'] == ''

    def test_a_dpkg_query_that_fails_is_no_inventory(self, linux, monkeypatch):
        _FakeCommands(monkeypatch, linux, [('dpkg-query', (2, ''))])

        assert linux.installed_software() == []

    def test_a_reboot_is_a_countdown_that_can_still_be_cancelled(self, linux, monkeypatch):
        """`shutdown +0` fires at once with nothing left to abort, and the
        dashboard reports a scheduled reboot as cancellable."""
        issued = _record_subprocess_run(monkeypatch)

        linux.reboot(30)
        linux.reboot(150, 'owlette is restarting this machine')
        linux.shutdown(0)

        assert issued[0][0] == ['shutdown', '-r', '+1']
        assert issued[1][0] == [
            'shutdown', '-r', '+3', 'owlette is restarting this machine',
        ]
        assert issued[2][0] == ['shutdown', '-h', '+1']
        assert issued[0][1]['check'] is True

    def test_cancel_reboot_reports_whether_the_abort_took(
        self, linux, monkeypatch, tmp_path
    ):
        scheduled = tmp_path / 'scheduled'
        scheduled.write_text('MODE=reboot\n', encoding='utf-8')
        monkeypatch.setattr(linux, 'SCHEDULED_SHUTDOWN_FILE', str(scheduled))
        commands = _FakeCommands(monkeypatch, linux, [('shutdown -c', (0, ''))])

        assert linux.cancel_reboot() is True
        assert commands.calls[0] == ['shutdown', '-c']

        _FakeCommands(monkeypatch, linux, [('shutdown -c', (1, ''))])

        assert linux.cancel_reboot() is False

    def test_a_cancel_with_nothing_scheduled_is_a_failure(
        self, linux, monkeypatch, tmp_path
    ):
        """`shutdown -c` exits 0 whether or not there was a shutdown to
        abort, and the dashboard clears its pending state off the answer.
        """
        monkeypatch.setattr(
            linux, 'SCHEDULED_SHUTDOWN_FILE', str(tmp_path / 'never-scheduled'),
        )
        _FakeCommands(monkeypatch, linux, [('shutdown -c', (0, ''))])

        assert linux.cancel_reboot() is False

    def test_pending_reboot_delegates_to_the_mcp_probe(self, linux, monkeypatch):
        """One reader for the marker file, whether the hoot tool or the
        service's own fifteen-minute check is asking."""
        import mcp_tools

        monkeypatch.setattr(
            mcp_tools, 'check_pending_reboot',
            lambda params, config: {'pending': True, 'reasons': ['package_update'],
                                    'last_update_installed': None,
                                    'next_scheduled_update': None},
        )

        assert linux.pending_reboot()['reasons'] == ['package_update']

    def test_pending_reboot_carries_the_windows_probe_keys(self, linux):
        assert set(linux.pending_reboot()) == PENDING_REBOOT_KEYS


def _seat(monkeypatch, posix, declared, environ):
    """A graphical session logind types `declared`, whose leader holds `environ`."""
    monkeypatch.setattr(
        posix, '_graphical_session',
        lambda uid=None: posix._Session('kiosk', 1402, declared),
    )
    monkeypatch.setattr(posix, '_process_environ', lambda pid: dict(environ))


class _FakeCommands:
    """The commands an arm shells out to, answered from a table of
    {what the argv contains: (returncode, stdout)}. A None answer is a command
    that could not be run at all."""

    def __init__(self, monkeypatch, module, replies):
        self.replies = replies
        self.calls = []
        monkeypatch.setattr(module, '_run', self._run)

    def _run(self, command, timeout_seconds):
        self.calls.append(list(command))
        joined = ' '.join(command)
        for match, reply in self.replies:
            if match in joined:
                if reply is None:
                    return None
                return SimpleNamespace(returncode=reply[0], stdout=reply[1], stderr='')
        return SimpleNamespace(returncode=0, stdout='', stderr='')


def _stub_sessions(monkeypatch, posix, sessions):
    """Answer loginctl out of a table of {session id: its properties}."""
    def _loginctl(*args):
        if args[0] == 'list-sessions':
            return ''.join(
                f'{session_id} 1000 user seat0 tty2 active no -\n'
                for session_id in sessions
            )
        return sessions[args[1]]

    monkeypatch.setattr(posix, '_loginctl', _loginctl)


def _stub_leader(monkeypatch, posix, pid):
    """Make `pid` the leader of this machine's graphical session."""
    monkeypatch.setattr(
        posix, '_graphical_session',
        lambda uid=None: posix._Session('kiosk', pid, 'x11'),
    )


def _leader_carrying(env):
    """A live process holding exactly `env`, to read /proc back out of.

    Waits for the exec: until then /proc reports the forked interpreter's
    environment, which is the suite's own and carries no display at all.
    """
    leader = subprocess.Popen(['/bin/sleep', '30'], env=env)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if Path(f'/proc/{leader.pid}/environ').read_bytes().count(b'\0') == len(env):
            return leader
        time.sleep(0.01)
    _stop_child(leader)
    raise AssertionError('the session leader never took its own environment')


def _never_called(*args, **kwargs):
    """The Windows user-session executor, which no POSIX arm may reach."""
    raise AssertionError('a POSIX arm called the user-session executor')


def _stop_child(child):
    child.kill()
    child.wait()


def _stop_pid(posix, pid):
    """Stop a process the arm spawned, and let the arm reap it as it does.

    Never os.waitpid here: reaping the child on the test's own account would
    hide whether the arm releases the pid at all, which is the whole of what a
    pid-based supervisor reads.
    """
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass

    def _released():
        posix._reap_finished()
        return not psutil.pid_exists(pid)

    _wait_for(_released)


def _wait_for(condition, seconds=5):
    """Wait for something the OS settles in its own time."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.02)
    raise AssertionError(f'the condition never held within {seconds}s')


def _status(pid):
    """psutil's status for a pid, or None once it is gone entirely."""
    try:
        return psutil.Process(pid).status()
    except psutil.NoSuchProcess:
        return None


def _spawn_account():
    """A local account that is not the one running the suite."""
    try:
        return pwd.getpwuid(SPAWN_UID)
    except KeyError:
        pytest.skip(f'no account at uid {SPAWN_UID} to spawn as')


def _mode(path):
    return os.stat(path).st_mode & 0o777


# One read-modify-write loop over a JSON counter, as a second process. Run twice
# at once, it is either serialised by the lock or it loses updates.
_WRITER = """
import json, os, sys, time

sys.path.insert(0, sys.argv[1])
import shared_utils

counter, cycles, gap, locked = sys.argv[2], int(sys.argv[3]), float(sys.argv[4]), sys.argv[5] == 'locked'

for _ in range(cycles):
    lock = shared_utils._CrossProcessLock() if locked else None
    if lock is not None:
        lock.__enter__()
    try:
        with open(counter, 'r', encoding='utf-8') as f:
            state = json.load(f)
        state['count'] += 1
        time.sleep(gap)
        temp = f'{counter}.{os.getpid()}.tmp'
        with open(temp, 'w', encoding='utf-8') as f:
            json.dump(state, f)
        os.replace(temp, counter)
    finally:
        if lock is not None:
            lock.__exit__()
"""


def _run_writers(root, counter, cycles, gap, locked):
    """Two of _WRITER at once, under this test's data root."""
    import shared_utils

    script = root / 'writer.py'
    script.write_text(_WRITER, encoding='utf-8')
    source = str(Path(shared_utils.__file__).parent)
    environment = dict(os.environ, OWLETTE_DATA_ROOT=str(root))
    arguments = [
        str(script), source, str(counter), str(cycles), str(gap),
        'locked' if locked else 'unlocked',
    ]
    writers = [
        subprocess.Popen([sys.executable, *arguments], env=environment)
        for _ in range(2)
    ]
    for writer in writers:
        assert writer.wait(timeout=120) == 0


class _FakeJobRunner(threading.Thread):
    """Stands in for the resident app's job runner
    (desktop/src-tauri/src/jobrunner.rs, task 4.3): pick the request up, write
    the result beside it."""

    def __init__(self, root, result, delay=0):
        super().__init__(daemon=True)
        self.jobs = root / 'ipc' / 'jobs'
        self.results = root / 'ipc' / 'results'
        self.result = result
        self.delay = delay
        self.seen = None
        self._stopped = threading.Event()

    def run(self):
        while not self._stopped.wait(0.02):
            for request in sorted(self.jobs.glob('*.json')):
                job = json.loads(request.read_text(encoding='utf-8'))
                self.seen = job
                # A runner slower than the caller's patience: the result lands
                # after the caller has given up and withdrawn the request.
                self._stopped.wait(self.delay)
                output = self.results / job['id']
                output.mkdir(parents=True, exist_ok=True)
                (output / 'result.json').write_text(
                    json.dumps({'outputDir': str(output), **self.result}),
                    encoding='utf-8',
                )

    def stop(self):
        self._stopped.set()
        self.join(timeout=5)
