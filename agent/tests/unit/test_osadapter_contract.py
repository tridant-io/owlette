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
import logging
import os
import plistlib
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
darwin_only = pytest.mark.skipif(
    sys.platform != 'darwin',
    reason='a macOS mechanism; Linux answers it in linux.py',
)

ADAPTERS = [
    pytest.param('win', marks=pytest.mark.windows),
    pytest.param('linux', marks=linux_only),
    pytest.param('darwin', marks=darwin_only),
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
def darwin():
    return importlib.import_module('osadapter.darwin')


@pytest.fixture
def relocated(tmp_path, monkeypatch):
    """The data root, pointed at a sandbox for the duration of one test."""
    monkeypatch.setenv(osadapter.DATA_ROOT_ENV, str(tmp_path))
    return tmp_path


@pytest.fixture
def seat(posix, tmp_path, monkeypatch):
    """A graphical seat, written into a /proc and a cgroup tree of our own.

    The only way to hold the session lookup to a GDM kiosk from a machine that
    has no graphical seat at all, and the layout is the one the kiosk reports
    — down to the root-owned session leader that carries no display.
    """
    return _FakeSeat(posix, tmp_path, monkeypatch)


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


def test_a_platform_with_an_arm_runs_what_needs_one():
    """Every platform the suite runs on has an arm.

    conftest skipped the tests that stub an operation while macOS had none;
    that gate retired with darwin.py. This fails, rather than skips, on a leg
    whose arm has gone missing — where every test that reads an operation off
    the package would otherwise error at setup.
    """
    assert osadapter.get() is not None


def test_a_platform_with_no_arm_has_nothing_to_stub(monkeypatch):
    """Why the retired gate existed, kept as the record of it: on a platform
    with no arm `get()` raises — before `monkeypatch.setattr` or `patch.object`
    can put a stub in place, since both read the attribute they replace first."""
    monkeypatch.setattr(osadapter, '_ARMS', {})
    monkeypatch.setattr(osadapter, '_adapter', None)

    with pytest.raises(NotImplementedError):
        osadapter.get()


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

    @linux_only
    def test_a_tty_session_is_not_a_seat(self, posix, monkeypatch):
        """What a headless box, a container and WSL all look like: a login is
        listed, and none of them has a display to reach."""
        _stub_sessions(monkeypatch, posix, {
            '4': 'User=0\nName=root\nClass=user\nLeader=291\nType=tty\nActive=yes\n',
        })
        assert posix.console_user() is None

    @linux_only
    def test_the_active_graphical_session_names_the_console_user(self, posix, monkeypatch):
        _stub_sessions(monkeypatch, posix, {
            '2': 'User=0\nName=root\nClass=user\nLeader=291\nType=tty\nActive=yes\n',
            '3': 'User=1000\nName=kiosk\nClass=user\nLeader=1402\nType=x11\nActive=yes\n',
        })
        assert posix.console_user() == 'kiosk'

    @linux_only
    @pytest.mark.parametrize('state', ['State=online\n', ''])
    def test_a_switched_away_session_is_not_the_console_user(
        self, posix, monkeypatch, state
    ):
        """Another session holds the foreground, so nobody is at this one's
        screen. logind answers `Active=no` and publishes `State=online` for
        it — its other live state — while a logind too old to publish the
        property publishes nothing. Neither reading may reach the seat.
        """
        _stub_sessions(monkeypatch, posix, {
            '3': 'User=1000\nName=kiosk\nClass=user\nLeader=1402\n'
                 f'Type=x11\nActive=no\n{state}',
        })

        # The negative control: `online` is in the State allowlist, so
        # without the Active check this answers 'kiosk'.
        assert posix.console_user() is None

    @linux_only
    def test_a_session_being_torn_down_is_not_a_seat(self, posix, monkeypatch):
        """Measured on the kiosk VM: `loginctl terminate-user kiosk` killed
        the X server at 18:38:34 and logind went on listing the session as
        Active=yes, Class=user, Type=x11 until 18:40:04 — systemd's 90 s scope
        stop timeout, because the root gdm-session-worker in the scope would
        not exit. Every launch into that window returned a real pid and the
        process died with the display it was handed: nine relaunches in forty
        seconds, the budget gone and the reboot-pending gate armed, for an
        operator logging out. logind publishes the one property that moves.
        """
        asked = []

        def _loginctl(*args):
            if args[0] == 'list-sessions':
                return '1 1000 kiosk seat0 tty2 active no -\n'
            asked.append(list(args))
            return ('User=1000\nName=kiosk\nClass=user\nLeader=1402\n'
                    'Type=x11\nActive=yes\nState=closing\n')

        monkeypatch.setattr(posix, '_loginctl', _loginctl)

        # The negative control: without the State check this answers 'kiosk',
        # and without `-p State` in the query the property never arrives.
        assert posix.console_user() is None
        assert 'State' in asked[0]

    @linux_only
    def test_the_state_a_standing_session_reports_is_still_a_seat(
        self, posix, monkeypatch
    ):
        """The other half. `active` is what a standing login reports, and
        `online` is carried beside it because the allowlist is a statement
        about State alone: logind's live-but-not-foreground state is not a
        teardown. Active=yes never accompanies it — logind reports `active`
        for exactly the sessions it reports Active=yes for, unless one is
        closing or opening — so what keeps a background session out of the
        seat is the Active check above, not this filter."""
        for state in ('active', 'online'):
            _stub_sessions(monkeypatch, posix, {
                '1': 'User=1000\nName=kiosk\nClass=user\nLeader=1402\n'
                     f'Type=x11\nActive=yes\nState={state}\n',
            })
            assert posix.console_user() == 'kiosk'

    @linux_only
    def test_a_session_that_is_still_opening_is_not_a_seat_yet(
        self, posix, monkeypatch
    ):
        """logind's fourth State, and the one reading that can stand behind
        Active=yes on a session nobody is at yet: `opening` is a session
        created whose scope job has not finished, so its display server may
        not be up. It fails closed — the refusal records the `failed`
        cooldown and the retry comes a minute later, reading `active` and
        launching then — because a launch into a session that is still
        starting is the launch that dies with the display it was handed,
        which is the same loss the `closing` half of this filter exists to
        prevent."""
        _stub_sessions(monkeypatch, posix, {
            '1': 'User=1000\nName=kiosk\nClass=user\nLeader=1402\n'
                 'Type=x11\nActive=yes\nState=opening\n',
        })

        # The negative control: with `opening` in the allowlist this answers
        # 'kiosk' and the launch goes into the half-built session.
        assert posix.console_user() is None

    @linux_only
    def test_the_login_screen_is_not_a_console_user(self, posix, monkeypatch):
        """Proven on the kiosk VM: at the GDM greeter — before the autologin,
        and after any logout, which does not re-fire it — logind lists an
        active x11 session of its own, owned by the display manager's system
        account. Answering with it made `gdm` the console user: the account a
        managed process would then be started as on an unattended login
        screen, and the uid the privileged request seam would trust.
        """
        _stub_sessions(monkeypatch, posix, {
            'c1': 'User=123\nName=gdm\nClass=greeter\nLeader=1180\n'
                  'Type=x11\nActive=yes\n',
            '1': 'User=1000\nName=kiosk\nClass=user\nLeader=1402\n'
                 'Type=tty\nActive=yes\n',
        })

        # The negative control: without the Class check this answers 'gdm'.
        assert posix.console_user() is None

    @linux_only
    def test_the_display_comes_from_a_process_inside_the_session(self, posix, seat):
        """Not from the session leader. On GDM — X11 and Wayland alike —
        the Leader logind names is a root-owned `gdm-session-worker` whose
        environment holds no DISPLAY, no cookie and root's own PATH, and
        `loginctl show-session -p Display` is empty on both, so the only place
        the variables exist is a process the session itself started.
        """
        cookie = seat.cookie(seat.runtime / 'gdm' / 'Xauthority')
        seat.gdm()

        env = posix.session_env(seat.UID)

        assert env['DISPLAY'] == ':0'
        assert env['XAUTHORITY'] == cookie
        assert env['XDG_RUNTIME_DIR'] == f'/run/user/{seat.UID}'
        assert env['DBUS_SESSION_BUS_ADDRESS'] == f'unix:path=/run/user/{seat.UID}/bus'
        assert env['XDG_SESSION_TYPE'] == 'x11'
        assert 'GNOME_KEYRING_CONTROL' not in env

    @linux_only
    def test_the_account_half_is_never_taken_from_the_session(self, posix, seat):
        """HOME, USER, LOGNAME and PATH describe the account the process is
        about to run as; lifting them off the session handed the kiosk user
        whatever the process they were read from happened to hold."""
        seat.gdm()

        env = posix.session_env(seat.UID)

        assert env['USER'] == 'kiosk'
        assert env['LOGNAME'] == 'kiosk'
        assert env['HOME'] == str(seat.home)
        assert env['PATH'] == seat.account['PATH']

    @linux_only
    def test_the_session_leader_is_never_the_source(self, posix, seat):
        """THE negative control: even a leader that does carry a display is
        not the process asked, because it is not the session user's."""
        seat.process(1292, 0, {'DISPLAY': ':99', 'USER': 'root'})
        seat.process(1500, seat.UID, seat.session_environ())

        assert posix.session_env(seat.UID)['DISPLAY'] == ':0'

    @linux_only
    def test_the_sessions_processes_are_the_ones_its_scope_names(self, posix, seat):
        """cgroup v2 keeps them in one scope, and that list is the session —
        an older process of the same account, in another session, is not."""
        seat.process(900, seat.UID, {'DISPLAY': ':99'}, member=False)
        seat.process(1500, seat.UID, seat.session_environ())

        assert posix.session_env(seat.UID)['DISPLAY'] == ':0'

    @linux_only
    def test_a_machine_with_no_scope_file_walks_proc_instead(self, posix, seat):
        """A v1 hierarchy, or a scope under another slice: the processes whose
        own cgroup names the scope answer, and nothing else does."""
        seat.process(900, seat.UID, {'DISPLAY': ':99'}, member=False)
        seat.process(1500, seat.UID, seat.session_environ())
        (seat.scope / 'cgroup.procs').unlink()

        assert posix.session_env(seat.UID)['DISPLAY'] == ':0'

    @linux_only
    def test_the_display_can_come_from_a_user_unit_beside_the_scope(
            self, posix, seat):
        """The layout the kiosk VM actually has. Since GNOME 3.34 the session
        is a set of systemd *user* units: the scope holds the PAM worker, Xorg
        and the session binary, while gnome-shell — the process carrying
        WAYLAND_DISPLAY, and DISPLAY once XWayland has started — runs under
        `user@<uid>.service`, beside the scope and not inside it.
        """
        cookie = seat.cookie(seat.runtime / 'gdm' / 'Xauthority')
        seat.process(1292, 0, {'USER': 'root'})
        seat.process(1980, seat.UID, {'XDG_SESSION_TYPE': 'x11'})
        seat.user_unit(2178, seat.UID, seat.session_environ())

        env = posix.session_env(seat.UID)

        assert env['DISPLAY'] == ':0'
        assert env['XAUTHORITY'] == cookie
        assert env['USER'] == 'kiosk'

    @linux_only
    def test_a_user_unit_of_another_account_is_still_never_the_source(
            self, posix, seat):
        """The widened rung keeps the narrow rule: only the session user's own
        processes are asked, so nothing root runs in that slice can hand the
        daemon a display."""
        seat.user_unit(1292, 0, {'DISPLAY': ':99'}, unit='root-owned.service')
        seat.user_unit(2178, seat.UID, seat.session_environ())

        assert posix.session_env(seat.UID)['DISPLAY'] == ':0'

    @linux_only
    def test_the_user_manager_answers_on_a_machine_that_has_run_hundreds(
            self, posix, seat):
        """The rung that answers a Wayland seat at all, on a box that started
        more than the bound's worth of processes before anyone logged in — an
        ordinary kiosk. It was a /proc walk of the numerically lowest pids,
        which are the boot's own: gnome-shell, started at login and numbered
        accordingly, was never reached. The unit's own subtree of `cgroup.procs`
        files is read instead, and a `cgroup.procs` names one cgroup and not its
        children, so the shell two levels down is in the answer.
        """
        cookie = seat.cookie(seat.runtime / 'gdm' / 'Xauthority')
        for pid in range(1, 320):
            seat.process(pid, 0, {'USER': 'root'}, member=False)
        seat.user_unit(
            4021, seat.UID,
            seat.session_environ(
                WAYLAND_DISPLAY='wayland-0', XDG_SESSION_TYPE='wayland'),
            unit='org.gnome.Shell@wayland.service')

        env = posix.session_env(seat.UID)

        # The negative control: bounded to the lowest 256 pids, the walk saw
        # nothing but the boot's processes and this raised KeyError.
        assert env['WAYLAND_DISPLAY'] == 'wayland-0'
        assert env['XDG_SESSION_TYPE'] == 'wayland'
        assert env['XAUTHORITY'] == cookie
        assert env['USER'] == 'kiosk'

    @linux_only
    def test_the_user_manager_answers_on_a_legacy_hierarchy_too(
            self, posix, seat):
        """A box booted with systemd.unified_cgroup_hierarchy=0, or any
        distro still on the hybrid one, publishes none of that subtree — so
        the rung that answers a Wayland seat had nothing to read at all and
        the lookup ended with the account half and no display. The unit is
        matched the way the rung below matches the scope instead: on the
        processes whose own cgroup line names it, which a v1 systemd
        publishes just as it does the scope's.
        """
        cookie = seat.cookie(seat.runtime / 'gdm' / 'Xauthority')
        seat.process(1292, 0, {'USER': 'root'}, member=False)
        seat.user_unit(2178, seat.UID, seat.session_environ())
        seat.legacy_hierarchy()

        env = posix.session_env(seat.UID)

        # The negative control: with the unified walk as the only rung,
        # every one of these was absent and this raised KeyError.
        assert env['DISPLAY'] == ':0'
        assert env['XAUTHORITY'] == cookie
        assert env['USER'] == 'kiosk'

    @linux_only
    def test_the_user_manager_answers_when_its_subtree_is_somewhere_else(
            self, posix, seat):
        """The marker at the root says the hierarchy is unified. It says
        nothing about where this manager's subtree is, and a delegated or
        renamed slice puts it somewhere the walk of `user.slice` never
        reaches — a unified box answering nothing at all, on the one rung
        that carries a Wayland display. The walk opening no `cgroup.procs`
        is the same evidence a missing hierarchy gives, and takes the same
        path-independent match.
        """
        cookie = seat.cookie(seat.runtime / 'gdm' / 'Xauthority')
        seat.process(1292, 0, {'USER': 'root'}, member=False)
        seat.user_unit(2178, seat.UID, seat.session_environ())
        shutil.rmtree(seat.cgroup / 'user.slice' / f'user-{seat.UID}.slice'
                      / f'user@{seat.UID}.service')

        env = posix.session_env(seat.UID)

        # The negative control: with no fallback below the unified walk this
        # answered nothing and every one of these raised KeyError.
        assert env['DISPLAY'] == ':0'
        assert env['XAUTHORITY'] == cookie
        assert env['USER'] == 'kiosk'

    @linux_only
    def test_the_walk_is_bounded_by_the_session_users_own_processes(
            self, posix, seat, monkeypatch):
        """The other half of the same bug, on the rung that does walk /proc.
        Ownership is what makes a pid a candidate, so the bound counts those
        and not the machine's — and ownership is settled before anything is
        opened for a process that cannot answer.
        """
        monkeypatch.setattr(posix, '_SESSION_SCAN_LIMIT', 2)
        for pid in range(100, 400):
            seat.process(pid, 0, {'USER': 'root'}, member=False)
        seat.process(9100, seat.UID, seat.session_environ(), member=False,
                     cgroup=f'0::/user.slice/user-{seat.UID}.slice'
                            f'/session-{seat.ID}.scope\n')
        opened = []
        read_entry = posix._read_entry
        monkeypatch.setattr(posix, '_read_entry', lambda path: (
            opened.append(path), read_entry(path))[1])

        assert posix.session_env(seat.UID)['DISPLAY'] == ':0'
        assert [path for path in opened if path.endswith('cgroup')] == [
            posix._proc_path(9100, 'cgroup')]

    @linux_only
    def test_another_login_of_the_same_account_is_not_the_session(
            self, posix, seat, caplog):
        """The kiosk VM has this shape whenever it is administered: the seat is
        one scope under the user's slice and the ssh login is another. A
        forwarded DISPLAY belongs to a screen on somebody else's desk, so the
        widened rung asks the session's user units and not the slice."""
        seat.process(
            2453, seat.UID, {'DISPLAY': 'localhost:10.0'}, member=False,
            cgroup=f'0::/user.slice/user-{seat.UID}.slice/session-6.scope\n')

        with caplog.at_level(logging.WARNING):
            env = posix.session_env(seat.UID)

        assert 'DISPLAY' not in env
        assert 'carries a display' in caplog.text

    @linux_only
    def test_the_kernels_own_list_of_the_session_is_read_whole(self, posix, seat):
        """`cgroup.procs` is the kernel's answer to what the session is, and
        truncating it to the walk's limit dropped the display carrier on any
        seat running more processes than that — a browser tree is enough."""
        for pid in range(3000, 3000 + posix._SESSION_SCAN_LIMIT + 40):
            seat.process(pid, seat.UID, {'XDG_SESSION_TYPE': 'x11'})
        seat.process(9000, seat.UID, seat.session_environ())

        assert posix.session_env(seat.UID)['DISPLAY'] == ':0'

    @linux_only
    def test_the_walk_is_bounded_by_what_it_opens_not_by_what_it_finds(
            self, posix, seat, monkeypatch):
        """The limit bounds the scan, not the result: a walk that matched
        nothing read one cgroup file per process on the machine before giving
        up, and said so in the same one line either way."""
        monkeypatch.setattr(posix, '_SESSION_SCAN_LIMIT', 4)
        for pid in range(900, 940):
            seat.process(pid, seat.UID, {'DISPLAY': ':99'}, member=False)
        opened = []
        read_entry = posix._read_entry
        monkeypatch.setattr(posix, '_read_entry', lambda path: (
            opened.append(path), read_entry(path))[1])

        assert 'DISPLAY' not in posix.session_env(seat.UID)
        assert 0 < len(
            [path for path in opened if path.endswith('cgroup')]) <= 2 * 4

    @linux_only
    def test_a_session_variable_set_to_nothing_is_not_lifted(self, posix, seat):
        """An empty WAYLAND_DISPLAY names no socket, and a toolkit that picks
        its backend on the variable's presence stops there rather than falling
        back to the DISPLAY beside it."""
        seat.gdm(environ=seat.session_environ(
            WAYLAND_DISPLAY='', XDG_SESSION_TYPE=''))

        env = posix.session_env(seat.UID)

        assert env['DISPLAY'] == ':0'
        assert 'WAYLAND_DISPLAY' not in env
        assert 'XDG_SESSION_TYPE' not in env

    @linux_only
    def test_the_cookie_the_session_names_but_does_not_have_falls_through(
            self, posix, seat):
        """An XAUTHORITY naming nothing is worse than none at all: X stops
        there rather than looking anywhere else."""
        gdm_cookie = seat.cookie(seat.runtime / 'gdm' / 'Xauthority')
        seat.gdm(environ=seat.session_environ(XAUTHORITY='/gone/Xauthority'))

        assert posix.session_env(seat.UID)['XAUTHORITY'] == gdm_cookie

    @linux_only
    def test_the_home_cookie_is_the_last_resort(self, posix, seat):
        """What `startx` and the older display managers write, and what GDM
        never creates — so it is tried last and only when it is there."""
        home_cookie = seat.cookie(seat.home / '.Xauthority')
        seat.gdm(environ=seat.session_environ(XAUTHORITY='/gone/Xauthority'))

        assert posix.session_env(seat.UID)['XAUTHORITY'] == home_cookie

    @linux_only
    def test_no_cookie_anywhere_is_no_variable_at_all(self, posix, seat):
        seat.gdm(environ=seat.session_environ(XAUTHORITY='/gone/Xauthority'))

        assert 'XAUTHORITY' not in posix.session_env(seat.UID)

    @linux_only
    def test_a_session_with_no_display_leaves_the_account_alone_and_says_so(
            self, posix, seat, caplog):
        seat.process(1292, 0, {'USER': 'root'})
        seat.process(1500, seat.UID, {'LANG': 'C.UTF-8'})

        with caplog.at_level(logging.WARNING):
            env = posix.session_env(seat.UID)

        assert 'DISPLAY' not in env and 'XAUTHORITY' not in env
        assert env['USER'] == 'kiosk'
        assert 'carries a display' in caplog.text

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

    @as_root
    def test_every_concurrent_managed_launch_comes_back_live(self, posix, monkeypatch):
        """Why the spawn is `Popen(user=…)` and not a `preexec_fn`: the daemon
        launches out of its 5-second loop with the alert, config-push and
        roost-scrub threads running, and a fork-side callback in a threaded
        process can deadlock on a lock it inherited mid-acquire. One launch in
        a hundred that hangs is a kiosk that never comes up."""
        account = _spawn_account()
        monkeypatch.setattr(posix, 'console_user', lambda: account.pw_name)
        spec = {'id': 'sleeper', 'exe_path': '/bin/sleep', 'file_path': '30'}
        launched, taken = [], threading.Lock()

        def launch():
            for _ in range(25):
                pid = posix.launch_managed_process(spec)
                with taken:
                    launched.append(pid)

        threads = [threading.Thread(target=launch) for _ in range(4)]
        try:
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(120)

            assert len(launched) == 100
            assert [pid for pid in launched if not pid] == []
            for pid in launched:
                process = psutil.Process(pid)
                assert process.is_running()
                assert process.status() != psutil.STATUS_ZOMBIE
                assert process.uids().real == account.pw_uid
        finally:
            for pid in launched:
                if pid:
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

    def test_the_desktop_gate_is_the_tray_marker(self, posix, private_executable):
        """The same marker and image-name check the tray-liveness guard reads,
        which is what desktop_process_name() re-pointed onto this arm. It asks
        the package for the name, so it needs the arm `get()` selects."""
        import shared_utils

        app = private_executable(posix.desktop_process_name())
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

    def test_a_write_does_not_follow_a_link_left_at_its_temp_name(
        self, posix, relocated
    ):
        """`tmp/` and `config/` are group-writable, so the fixed `<name>.tmp`
        every JSON write goes through is a name the kiosk session can occupy
        first. Followed, it would truncate a root-only file outside the tree,
        fill it with the daemon's JSON, hand it the destination's mode and the
        daemon's group, and then move the link over the destination — which is
        a file-overwrite-and-regrant primitive, not a state file."""
        import shared_utils

        assert shared_utils.ensure_data_directories() is True
        states = Path(shared_utils.get_data_path('tmp/app_states.json'))
        victim = relocated / 'victim.json'
        victim.write_text('{"root": "only"}', encoding='utf-8')
        os.chmod(victim, 0o600)
        Path(f'{states}.tmp').symlink_to(victim)

        shared_utils.write_json_to_file({'pid': 1}, str(states))

        assert json.loads(victim.read_text(encoding='utf-8')) == {'root': 'only'}
        assert _mode(victim) == 0o600
        assert not os.path.islink(states)
        assert json.loads(states.read_text(encoding='utf-8')) == {'pid': 1}


@linux_only
class TestLinux:
    """The Linux arm: the nine operations the shared POSIX half leaves to it."""

    def test_the_seat_is_the_type_logind_reports(self, linux, posix, monkeypatch):
        """logind's Type, and not a variable read off the session leader: on
        GDM that leader is a root-owned PAM worker which declares nothing, so
        the probe that used to read it only ever fell through to this."""
        _seat(monkeypatch, posix, 'x11')
        assert linux._session_type() == 'x11'

        _seat(monkeypatch, posix, 'wayland')
        assert linux._session_type() == 'wayland'

    def test_without_a_seat_there_is_no_session_type(self, linux, posix, monkeypatch):
        monkeypatch.setattr(posix, '_graphical_session', lambda uid=None: None)
        monkeypatch.setattr(posix, '_desktop_pid', lambda: None)

        assert linux._session_type() is None
        assert linux.streamer_capable() is False

    def test_the_login_screen_is_not_a_seat_to_stream(self, linux, posix, monkeypatch):
        """The greeter's session is typed x11 and is active, so every gate that
        reads the session type answered yes for a machine sitting at the login
        screen: capture-capable, streamer-capable, an x11 seat to launch into.
        It is no login of ours, and with no app resident there is no session.
        """
        _stub_sessions(monkeypatch, posix, {
            'c1': 'User=123\nName=gdm\nClass=greeter\nLeader=1180\n'
                  'Type=x11\nActive=yes\n',
        })
        monkeypatch.setattr(posix, '_desktop_pid', lambda: None)

        # The negative control: without the Class check both answer x11/True.
        assert linux._session_type() is None
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

        assert linux._session_type() == 'x11'
        assert linux.streamer_capable() is True

        monkeypatch.setattr(
            posix, '_process_environ',
            lambda pid: {'WAYLAND_DISPLAY': 'wayland-0', 'DISPLAY': ':0'},
        )

        assert linux._session_type() == 'wayland'

    def test_a_wayland_seat_refuses_the_capture(self, linux, posix, monkeypatch):
        """A grab from outside a Wayland session is a black frame, so the
        refusal is typed and the app is never asked for one."""
        _seat(monkeypatch, posix, 'wayland')
        monkeypatch.setattr(posix, 'capture_screen', _never_called)

        result = linux.capture_screen(0, executor=_never_called, timeout_s=5)

        assert result['error'] == 'unsupported_on_platform'
        assert result['session_type'] == 'wayland'
        assert linux.streamer_capable() is False

    def test_an_x11_seat_captures_through_the_shared_job(self, linux, posix, monkeypatch):
        _seat(monkeypatch, posix, 'x11')
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


@darwin_only
class TestDarwin:
    """The macOS arm: the operations the shared POSIX half leaves to it."""

    def test_the_tree_and_its_group_are_the_macos_ones(self, posix):
        """posix.py answers both POSIX arms off one platform switch, and the
        package, the seam and the mode table all read these three."""
        assert posix.DATA_ROOT == '/Library/Application Support/Owlette'
        assert posix.GROUP == '_owlette'
        assert posix.GROUP_ADD == 'dseditgroup -o edit -a USER -t user _owlette'

    def test_the_agents_own_service_name_resolves_to_its_label(self, darwin, monkeypatch):
        """Every call site spells the agent's service the way the Windows SCM
        does; this arm is what knows the label it has here."""
        import shared_utils

        launchctl = _Launchctl(monkeypatch, darwin, {'print': [(0, _launchd_job('running'))]})

        assert darwin.service_control('restart', shared_utils.SERVICE_NAME) is True
        assert launchctl.calls[0] == [
            'launchctl', 'kickstart', '-k', 'system/app.owlette.agent',
        ]

    def test_a_start_is_the_state_the_job_reached(self, darwin, monkeypatch):
        """kickstart returns once the start is issued, so the state is watched
        for rather than read once."""
        launchctl = _Launchctl(monkeypatch, darwin, {'print': [
            (0, _launchd_job('not running')), (0, _launchd_job('running')),
        ]})

        assert darwin.service_control('start', 'app.owlette.agent') is True
        assert launchctl.calls[0] == ['launchctl', 'kickstart', 'system/app.owlette.agent']

    def test_a_start_that_never_reaches_running_is_a_failure(self, darwin, monkeypatch):
        monkeypatch.setitem(darwin._SERVICE_CONTROLS, 'start', (True, 0.1))
        _Launchctl(monkeypatch, darwin, {'print': [(0, _launchd_job('not running'))]})

        assert darwin.service_control('start', 'app.owlette.agent') is False

    def test_only_the_jobs_own_state_line_is_read(self, darwin, monkeypatch):
        """The blocks nested inside a job carry lines of their own; one of them
        reading `running` says nothing about the job."""
        monkeypatch.setitem(darwin._SERVICE_CONTROLS, 'start', (True, 0.1))
        nested = _launchd_job('not running').replace(
            '\tendpoints = {\n', '\tendpoints = {\n\t\tstate = running\n')
        _Launchctl(monkeypatch, darwin, {'print': [(0, nested)]})

        assert darwin.service_control('start', 'app.owlette.agent') is False

    def test_a_stop_is_a_bootout_that_answers_once_the_job_is_gone(
            self, darwin, monkeypatch):
        """Not a signal: launchd relaunches a KeepAlive job the moment a signal
        ends it, and the agent's own plist carries KeepAlive."""
        launchctl = _Launchctl(monkeypatch, darwin, {'print': [(113, '')]})

        assert darwin.service_control('stop', 'app.owlette.agent') is True
        assert launchctl.calls[0] == ['launchctl', 'bootout', 'system/app.owlette.agent']

    def test_a_stop_that_left_the_job_running_is_a_failure(self, darwin, monkeypatch):
        monkeypatch.setitem(darwin._SERVICE_CONTROLS, 'stop', (False, 0.1))
        _Launchctl(monkeypatch, darwin, {'print': [(0, _launchd_job('running'))]})

        assert darwin.service_control('stop', 'app.owlette.agent') is False

    def test_a_job_that_is_installed_but_not_loaded_is_already_stopped(
            self, darwin, monkeypatch, tmp_path):
        (tmp_path / 'app.owlette.agent.plist').write_bytes(b'')
        monkeypatch.setattr(darwin, 'LAUNCH_DAEMONS_DIR', str(tmp_path))
        _Launchctl(monkeypatch, darwin, {
            'bootout': [(3, 'Boot-out failed: 3: No such process')],
            'print': [(113, '')],
        })

        assert darwin.service_control('stop', 'app.owlette.agent') is True

    def test_a_stop_against_a_label_launchd_does_not_know_is_a_failure(
            self, darwin, monkeypatch, tmp_path):
        """Negative control for the stop above: a label nothing answers to reads
        exactly like a stopped job, which is the state a stop wanted — so a
        mis-spelled or not-yet-packaged label would otherwise answer that it
        had been stopped."""
        monkeypatch.setattr(darwin, 'LAUNCH_DAEMONS_DIR', str(tmp_path))
        _Launchctl(monkeypatch, darwin, {
            'bootout': [(3, 'Boot-out failed: 3: No such process')],
            'print': [(113, '')],
        })

        assert darwin.service_control('stop', 'app.owlette.kiosk') is False

    def test_a_start_of_a_job_that_is_not_loaded_bootstraps_its_plist(
            self, darwin, monkeypatch, tmp_path):
        """A stop is a bootout, and kickstart reaches only a loaded job — so
        without this a service stopped here could not be started again here."""
        plist = tmp_path / 'app.owlette.agent.plist'
        plist.write_bytes(b'')
        monkeypatch.setattr(darwin, 'LAUNCH_DAEMONS_DIR', str(tmp_path))
        launchctl = _Launchctl(monkeypatch, darwin, {
            'kickstart': [(113, ''), (0, '')],
            'print': [(0, _launchd_job('running'))],
        })

        assert darwin.service_control('start', 'app.owlette.agent') is True
        assert launchctl.calls[:3] == [
            ['launchctl', 'kickstart', 'system/app.owlette.agent'],
            ['launchctl', 'bootstrap', 'system', str(plist)],
            ['launchctl', 'kickstart', 'system/app.owlette.agent'],
        ]

    def test_a_start_with_no_plist_to_bootstrap_is_a_failure(
            self, darwin, monkeypatch, tmp_path):
        monkeypatch.setattr(darwin, 'LAUNCH_DAEMONS_DIR', str(tmp_path))
        launchctl = _Launchctl(monkeypatch, darwin, {'kickstart': [(113, '')]})

        assert darwin.service_control('start', 'app.owlette.kiosk') is False
        assert [call[1] for call in launchctl.calls] == ['kickstart']

    def test_a_launchctl_that_never_ran_is_a_failure_for_every_verb(
            self, darwin, monkeypatch):
        """An unreachable launchctl leaves the job in no known state, and
        'not running' must not read as a successful stop."""
        _Launchctl(monkeypatch, darwin, {
            'bootout': [None], 'kickstart': [None], 'print': [None],
        })

        for verb in ('stop', 'start', 'restart'):
            assert darwin.service_control(verb, 'app.owlette.agent') is False

    def test_a_name_that_cannot_be_a_label_reaches_nothing(self, darwin, monkeypatch):
        """The label names the plist a bootstrap reads, so it is held to what
        a label is made of before it becomes part of a path."""
        launchctl = _Launchctl(monkeypatch, darwin, {})

        assert darwin.service_control('start', '../../../tmp/evil') is False
        assert launchctl.calls == []

    def test_the_machine_id_is_the_platform_uuid(self, darwin, monkeypatch):
        _registry(monkeypatch, darwin, {
            (b'IOPlatformExpertDevice', 'IOPlatformUUID'): _PLATFORM_UUID,
        })

        assert darwin.stable_machine_id() == _PLATFORM_UUID
        assert darwin.key_material() == _PLATFORM_UUID.encode()

    @pytest.mark.parametrize('published', [None, '', 'not-a-uuid', 7])
    def test_an_identity_the_registry_does_not_give_is_never_stood_in_for(
            self, darwin, monkeypatch, published):
        """The token store is keyed on this value, and a store that fails to
        decrypt reads as empty and is overwritten under the next key derived —
        so a stand-in answered for one failed read would unpair the machine
        for good. The Linux arm's uuid.getnode() fallback is the negative
        control this refuses to repeat."""
        _registry(monkeypatch, darwin, {
            (b'IOPlatformExpertDevice', 'IOPlatformUUID'): published,
        })

        with pytest.raises(OSError):
            darwin.key_material()
        with pytest.raises(OSError):
            darwin.stable_machine_id()

    def test_the_identity_read_in_process_is_the_one_ioreg_reports(self, darwin):
        """Decision 8 names `ioreg -rd1 -c IOPlatformExpertDevice`; the arm
        reads the same property without the spawn, and this holds the two to
        the same answer on a real Mac."""
        printed = subprocess.run(
            ['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice'],
            capture_output=True, text=True, timeout=30, check=True,
        ).stdout

        assert f'"IOPlatformUUID" = "{darwin.stable_machine_id()}"' in printed

    def test_a_registry_property_that_is_not_there_is_none(self, darwin):
        assert darwin._registry_property(None, 'NoSuchPropertyAnywhere') is None
        assert darwin._registry_property(b'NoSuchClassAnywhere', 'IOPlatformUUID') is None

    def test_the_console_session_names_the_console_user(self, darwin, posix, monkeypatch):
        account = pwd.getpwuid(os.getuid())
        _consoles(monkeypatch, darwin, [_console(account.pw_name, account.pw_uid)])

        assert posix.console_user() == account.pw_name
        assert posix._graphical_session(account.pw_uid) == posix._Session(
            account.pw_name, 'aqua', '100017', account.pw_uid)
        assert posix._graphical_session(account.pw_uid + 1) is None

    def test_a_session_switched_away_from_is_not_the_console_user(
            self, darwin, posix, monkeypatch):
        """Fast User Switching keeps the other login listed, off the console:
        nobody is at its screen."""
        _consoles(monkeypatch, darwin, [
            _console('kiosk', 501, on_console=False),
            _console('operator', 502),
        ])
        assert posix.console_user() == 'operator'

        # The negative control: without the console flag this answers kiosk.
        _consoles(monkeypatch, darwin, [_console('kiosk', 501, on_console=False)])
        assert posix.console_user() is None

    def test_a_login_that_has_not_finished_is_not_a_seat_yet(
            self, darwin, posix, monkeypatch):
        """The macOS reading of logind's `opening`: a launch into a login that
        is still starting is the launch that dies with the session it was
        handed, so it fails closed and retries on the next tick."""
        _consoles(monkeypatch, darwin, [_console('kiosk', 501, login_done=False)])

        assert posix.console_user() is None

    @pytest.mark.parametrize('name, uid', [
        ('loginwindow', 0), ('loginwindow', 89), ('root', 0), ('_mbsetupuser', 248),
        ('kiosk', 0),
    ])
    def test_the_login_window_and_setup_assistant_are_not_a_console_user(
            self, darwin, posix, monkeypatch, name, uid):
        """The macOS reading of a greeter: an unattended login window must not
        become the account a managed process runs as, or the uid the privileged
        request seam trusts."""
        _consoles(monkeypatch, darwin, [_console(name, uid)])

        assert posix.console_user() is None

    def test_nobody_logged_in_is_no_seat(self, darwin, posix, monkeypatch):
        _consoles(monkeypatch, darwin, None)
        assert posix.console_user() is None

        _consoles(monkeypatch, darwin, [])
        assert posix.console_user() is None

    def test_the_seat_costs_the_loop_no_process(self, posix, monkeypatch):
        """The seat is asked about every tick while a managed process is down,
        so it is read in-process: no loginctl, no stat, no ioreg."""
        def _no_spawn(*args, **kwargs):
            raise AssertionError('the seat spawned a process')

        monkeypatch.setattr(subprocess, 'Popen', _no_spawn)
        monkeypatch.setattr(subprocess, 'run', _no_spawn)

        user = posix.console_user()

        assert user is None or pwd.getpwnam(user)

    def test_a_macos_session_env_is_the_account_and_nothing_x11(
            self, darwin, posix, monkeypatch, tmp_path):
        """No DISPLAY to lift and no cookie to hand over: a process reaches
        WindowServer through the bootstrap namespace its spawn puts it in.
        XQuartz leaves a ~/.Xauthority behind, which is nothing to pass on."""
        account = pwd.getpwuid(os.getuid())
        home = tmp_path / 'home'
        home.mkdir()
        (home / '.Xauthority').write_bytes(b'')
        monkeypatch.setattr(posix, '_account_env', lambda uid: {
            'HOME': str(home), 'USER': account.pw_name,
            'LOGNAME': account.pw_name, 'PATH': '/usr/bin:/bin',
        })
        _consoles(monkeypatch, darwin, [_console(account.pw_name, account.pw_uid)])

        assert posix.session_env(account.pw_uid) == {
            'HOME': str(home), 'USER': account.pw_name,
            'LOGNAME': account.pw_name, 'PATH': '/usr/bin:/bin',
        }

    def test_a_session_spawn_is_a_job_in_the_users_gui_domain(
            self, darwin, posix, private_executable, tmp_path):
        """The shape decision 4 needs, measured rather than assumed: the pid is
        the program's own — not a wrapper's, which is what `asuser … sudo -u`
        would have handed back — launchd is its parent, it runs as the user and
        is its own TCC-responsible process, and its exited job does not stay
        loaded past the next spawn's sweep."""
        uid = os.getuid()
        domain = f'gui/{uid}'
        if subprocess.run(['launchctl', 'print', domain], capture_output=True).returncode:
            # The only test that reaches launchd for real: on the CI runner,
            # whose user is logged in, a missing domain is a broken leg and a
            # skip there would read as a pass.
            if os.environ.get('GITHUB_ACTIONS') == 'true':
                pytest.fail(f'no GUI domain for uid {uid} on the CI runner')
            pytest.skip(f'no GUI domain for uid {uid} on this machine')
        program = private_executable('kiosk-app')

        pid = posix.spawn_as_user([str(program), '--fullscreen'], uid)
        process = psutil.Process(pid)
        try:
            assert process.exe() == str(program)
            assert process.cmdline() == [str(program), '--fullscreen']
            assert process.uids().real == uid
            assert process.ppid() == 1
            assert _responsible_pid(pid) == pid
            label = process.environ()['XPC_SERVICE_NAME']
            assert label.startswith(darwin.SESSION_JOB_PREFIX)
        finally:
            _kill_quietly(process)
            psutil.wait_procs([process], timeout=5)

        darwin._sweep_session_jobs(domain, time.monotonic() + 30)

        printed = subprocess.run(['launchctl', 'print', domain], capture_output=True, text=True)
        assert label not in printed.stdout

    def test_the_job_carries_the_command_its_directory_and_the_account(
            self, darwin, monkeypatch):
        launchd = _SessionLaunchd(monkeypatch, darwin, pid=os.getpid())
        env = {'HOME': '/Users/kiosk', 'USER': 'kiosk', 'LOGNAME': 'kiosk', 'PATH': '/usr/bin:/bin'}

        pid = darwin._spawn_in_gui_domain(
            ['/Applications/Kiosk.app/Contents/MacOS/Kiosk', '--fullscreen'],
            os.getuid(), env, cwd='/Users/Shared/Owlette')

        assert pid == os.getpid()
        domain = f'gui/{os.getuid()}'
        assert [call[:3] for call in launchd.calls] == [
            ['launchctl', 'print', domain],
            ['launchctl', 'bootstrap', domain],
            ['launchctl', 'kickstart', '-p'],
        ]
        path, job = launchd.jobs[0]
        assert launchd.calls[2][3] == f"{domain}/{job['Label']}"
        assert job == {
            'Label': job['Label'],
            'ProgramArguments': ['/Applications/Kiosk.app/Contents/MacOS/Kiosk', '--fullscreen'],
            'EnvironmentVariables': env,
            'WorkingDirectory': '/Users/Shared/Owlette',
            'ProcessType': 'Interactive',
            'AbandonProcessGroup': True,
            'RunAtLoad': False,
            'KeepAlive': False,
        }
        # launchd read the plist at bootstrap, and nothing of it stays behind.
        assert not os.path.exists(path)

    def test_two_spawns_of_one_command_line_never_share_a_job(self, darwin, monkeypatch):
        """Two managed entries may run the same command line; one label for
        both would boot the other's running instance out on every relaunch."""
        launchd = _SessionLaunchd(monkeypatch, darwin, pid=os.getpid())

        for _ in range(2):
            darwin._spawn_in_gui_domain(['/usr/local/bin/player'], os.getuid(), {})

        first, second = (job['Label'] for _, job in launchd.jobs)
        assert first != second
        assert 'bootout' not in [call[1] for call in launchd.calls]

    def test_only_the_session_jobs_that_have_exited_are_swept(self, darwin, monkeypatch):
        """A job stays loaded once its process exits. The sweep takes those of
        ours and nothing else: a running one of ours is a managed process, and
        the rest of the domain is the user's own."""
        prefix = darwin.SESSION_JOB_PREFIX
        exited, running, failed = (f'{prefix}{uuid.uuid4().hex}' for _ in range(3))
        launchd = _SessionLaunchd(monkeypatch, darwin, pid=os.getpid(), services=(
            f'\t\t       0      0 \t{exited}\n'
            f'\t\t    4242      - \t{running}\n'
            '\t\t       0      - \tcom.apple.SafariHistoryServiceAgent\n'
            f'\t\t       0   (pe) \t{failed}\n'
            # The same job with its columns spaced rather than tabbed: the
            # output is not launchctl's API, and a layout change must not
            # stop the sweep reading it.
            f'    0  -  {prefix}{"0" * 32}\n'
            f'\t"{prefix}{"1" * 32}" => disabled\n'
        ))

        darwin._spawn_in_gui_domain(['/usr/local/bin/player'], os.getuid(), {})

        domain = f'gui/{os.getuid()}'
        assert [call for call in launchd.calls if call[1] == 'bootout'] == [
            ['launchctl', 'bootout', f'{domain}/{exited}'],
            ['launchctl', 'bootout', f'{domain}/{failed}'],
            ['launchctl', 'bootout', f'{domain}/{prefix}{"0" * 32}'],
        ]

    def test_a_job_launchd_refuses_is_a_failed_launch(self, darwin, monkeypatch):
        _SessionLaunchd(monkeypatch, darwin, pid=os.getpid(), bootstrap=(5, 'Bootstrap failed: 5'))

        with pytest.raises(OSError, match='bootstrap'):
            darwin._spawn_in_gui_domain(['/usr/local/bin/player'], os.getuid(), {})

    def test_a_kickstart_that_names_no_pid_boots_its_job_back_out(self, darwin, monkeypatch):
        launchd = _SessionLaunchd(monkeypatch, darwin, pid=None)

        with pytest.raises(OSError, match='no pid'):
            darwin._spawn_in_gui_domain(['/usr/local/bin/player'], os.getuid(), {})

        label = launchd.jobs[0][1]['Label']
        assert launchd.calls[-1] == ['launchctl', 'bootout', f'gui/{os.getuid()}/{label}']

    def test_the_pid_is_handed_back_once_it_is_the_program(
            self, darwin, monkeypatch, private_executable):
        """launchd reports the pid while it can still be xpcproxy — root, and
        another image — and the supervisor records whatever the pid is on
        return. Stood in for here by a process that is the trampoline until
        the bound runs out."""
        trampoline = private_executable('xpcproxy')
        child = subprocess.Popen([str(trampoline)])
        deadline = time.monotonic() + 30
        try:
            _wait_for(lambda: _exe(child.pid) == str(trampoline))
            darwin._await_exec(child.pid, os.getuid(), deadline)

            monkeypatch.setattr(darwin, 'XPCPROXY', str(trampoline))
            monkeypatch.setattr(darwin, '_EXEC_SETTLE_SECONDS', 0.2)
            with pytest.raises(OSError, match='did not become its program'):
                darwin._await_exec(child.pid, os.getuid(), deadline)
            monkeypatch.setattr(darwin, 'XPCPROXY', '/usr/libexec/xpcproxy')
            with pytest.raises(OSError):
                darwin._await_exec(child.pid, os.getuid() + 1, deadline)
        finally:
            _stop_child(child)

    def test_a_job_gone_before_it_became_its_program_is_a_failed_launch(
            self, darwin, private_executable):
        """launchd could not change to the directory or exec the file: on Linux
        Popen raises for that, and handing the pid back instead booked a crash
        — alert, screenshot and relaunch budget — for a launch that never
        happened."""
        child = subprocess.Popen([str(private_executable('kiosk-app'))])
        _stop_child(child)

        with pytest.raises(OSError, match='exited before it became its program'):
            darwin._await_exec(child.pid, os.getuid(), time.monotonic() + 30)

    def test_one_spawn_at_a_time_reaches_launchd(self, darwin, monkeypatch):
        """A sweep boots out every session job with no process, and a job a
        concurrent spawn has bootstrapped but not yet kickstarted is one — so
        the sweep, the bootstrap and the kickstart are one spawn's alone."""
        launchd = _SessionLaunchd(monkeypatch, darwin, pid=os.getpid())
        held = []
        run = launchd._run

        def _run(command, timeout_seconds):
            held.append(darwin._session_spawn_lock.locked())
            return run(command, timeout_seconds)

        monkeypatch.setattr(darwin, '_run', _run)

        darwin._spawn_in_gui_domain(['/usr/local/bin/player'], os.getuid(), {})

        assert held == [True, True, True]
        assert not darwin._session_spawn_lock.locked()

    def test_a_launchd_that_stops_answering_cannot_hold_the_loop(self, darwin, monkeypatch):
        """The monitor loop launches managed processes itself: however many
        launchctl calls a spawn makes, a stalled launchd costs it one budget
        and not each call's own timeout in turn."""
        monkeypatch.setattr(darwin, '_SPAWN_BUDGET_SECONDS', 0.5)
        timeouts = []

        def _stalled(command, timeout_seconds):
            timeouts.append(timeout_seconds)
            time.sleep(min(timeout_seconds, 0.5))
            return None

        monkeypatch.setattr(darwin, '_run', _stalled)
        started = time.monotonic()

        with pytest.raises(OSError):
            darwin._spawn_in_gui_domain(['/usr/local/bin/player'], os.getuid(), {})

        assert time.monotonic() - started < 3
        assert max(timeouts) <= 1

    def test_the_inventory_is_the_application_bundles_on_disk(
            self, darwin, monkeypatch, tmp_path):
        """Walked directly: the Spotlight answer system_profiler gives listed
        none of /Applications on the machine this arm was written on."""
        applications = tmp_path / 'Applications'
        users = tmp_path / 'Users'
        _app(applications / 'TouchDesigner.app', CFBundleShortVersionString='2025.31310')
        _app(applications / 'Derivative' / 'Tools' / 'Palette.app', CFBundleVersion='7')
        _app(applications / 'TouchDesigner.app' / 'Contents' / 'Helpers' / 'Helper.app')
        _app(applications / 'a' / 'b' / 'c' / 'TooDeep.app')
        (applications / 'Alias.app').symlink_to(applications / 'TouchDesigner.app')
        _app(users / 'kiosk' / 'Applications' / 'Mine.app', CFBundleShortVersionString='1.0')
        (users / 'Shared').mkdir()
        monkeypatch.setattr(darwin, 'APPLICATION_DIRS', (str(applications),))
        monkeypatch.setattr(darwin, 'USERS_DIR', str(users))

        rows = darwin.installed_software()

        # Nothing inside a bundle, nothing through a link, nothing deeper
        # than a vendor's suite folder.
        assert [row['name'] for row in rows] == ['Mine', 'Palette', 'TouchDesigner']
        touchdesigner = rows[2]
        assert touchdesigner == {
            'name': 'TouchDesigner',
            'version': '2025.31310',
            'publisher': '',
            'install_location': str(applications / 'TouchDesigner.app'),
            # The bundle itself: uninstalling an application removes it, and
            # the dashboard refuses to queue an uninstall with no command.
            'uninstall_command': str(applications / 'TouchDesigner.app'),
            'installer_type': 'app',
        }
        assert rows[1]['version'] == '7'

    def test_a_bundle_whose_info_plist_cannot_be_read_is_not_listed(
            self, darwin, monkeypatch, tmp_path):
        applications = tmp_path / 'Applications'
        _app(applications / 'Kiosk.app')
        broken = applications / 'Broken.app' / 'Contents'
        broken.mkdir(parents=True)
        (broken / 'Info.plist').symlink_to(applications / 'Kiosk.app' / 'Contents' / 'Info.plist')
        monkeypatch.setattr(darwin, 'APPLICATION_DIRS', (str(applications),))
        monkeypatch.setattr(darwin, 'USERS_DIR', str(tmp_path / 'nobody'))

        assert [row['name'] for row in darwin.installed_software()] == ['Kiosk']

    def test_the_inventory_walk_is_bounded(self, darwin, monkeypatch, tmp_path):
        applications = tmp_path / 'Applications'
        for index in range(12):
            _app(applications / f'App{index:02}.app')
        monkeypatch.setattr(darwin, 'APPLICATION_DIRS', (str(applications),))
        monkeypatch.setattr(darwin, 'USERS_DIR', str(tmp_path / 'nobody'))
        monkeypatch.setattr(darwin, '_INVENTORY_SCAN_LIMIT', 5)

        assert len(darwin.installed_software()) < 5

    def test_a_reboot_is_a_countdown_that_can_still_be_cancelled(
            self, darwin, monkeypatch):
        """`shutdown +0` reboots in the foreground with nothing left to abort,
        and the dashboard reports a scheduled reboot as cancellable."""
        issued = _record_subprocess_run(monkeypatch)

        darwin.reboot(30)
        darwin.reboot(150, 'owlette is restarting this machine')
        darwin.shutdown(0)

        assert issued[0][0] == ['/sbin/shutdown', '-r', '+1']
        assert issued[1][0] == [
            '/sbin/shutdown', '-r', '+3', 'owlette is restarting this machine',
        ]
        assert issued[2][0] == ['/sbin/shutdown', '-h', '+1']

    def test_the_scheduler_is_handed_no_pipe(self, darwin, monkeypatch):
        """shutdown forks a scheduler that keeps every descriptor it was given
        until the machine goes down: waiting on a pipe it holds would wait for
        the reboot, so nothing it is handed can be one."""
        issued = _record_subprocess_run(monkeypatch)

        darwin.reboot(60)

        kwargs = issued[0][1]
        assert 'capture_output' not in kwargs
        assert kwargs['stdin'] is subprocess.DEVNULL
        assert kwargs['stdout'] is subprocess.DEVNULL
        assert kwargs['stderr'] not in (subprocess.PIPE, None)

    def test_a_refused_shutdown_raises(self, darwin, monkeypatch):
        _record_subprocess_run(monkeypatch, returncode=1)

        with pytest.raises(subprocess.CalledProcessError):
            darwin.reboot(60)

    def test_a_cancel_with_nothing_scheduled_is_a_failure(
            self, darwin, monkeypatch, tmp_path):
        """The dashboard clears its pending state off the answer, so aborting
        nothing is the failure the Windows arm's `shutdown /a` reports."""
        monkeypatch.setattr(darwin, 'SHUTDOWN_COMMAND', str(tmp_path / 'shutdown'))

        assert darwin.cancel_reboot() is False

    def test_a_cancel_ends_the_scheduler_launchd_adopted(
            self, darwin, monkeypatch, private_executable):
        """What a countdown looks like once `shutdown` has returned: the
        system's own binary in a session of its own, its parent gone and
        launchd its parent now. The daemon kept no pid for it — one kept
        across a restart could name another process by then — so it is found
        by what it is."""
        scheduler = private_executable('shutdown')
        monkeypatch.setattr(darwin, 'SHUTDOWN_COMMAND', str(scheduler))
        pending = _adopted_by_launchd(scheduler)
        try:
            assert darwin.cancel_reboot() is True
            assert not pending.is_running()
        finally:
            _kill_quietly(pending)

    def test_a_shutdown_still_attached_to_whoever_ran_it_is_not_pending(
            self, darwin, monkeypatch, private_executable):
        """Negative control for the cancel above: `shutdown now` runs in the
        foreground of whoever ran it, with nothing left to count down — the
        same binary, but not a scheduler, and never the one to end."""
        foreground = private_executable('shutdown')
        monkeypatch.setattr(darwin, 'SHUTDOWN_COMMAND', str(foreground))
        child = subprocess.Popen([str(foreground)])
        try:
            _wait_for(lambda: _exe(child.pid) == str(foreground))

            assert darwin.cancel_reboot() is False
            assert child.poll() is None
        finally:
            _stop_child(child)

    def test_pending_reboot_delegates_to_the_mcp_probe(self, darwin, monkeypatch):
        """One reader of softwareupdate's answer, whether the hoot tool or the
        service's own fifteen-minute check is asking."""
        import mcp_tools

        probed = {'pending': True, 'reasons': ['software_update'],
                  'last_update_installed': None, 'next_scheduled_update': None}
        monkeypatch.setattr(mcp_tools, 'check_pending_reboot', lambda params, config: probed)

        assert darwin.pending_reboot() is probed

    def test_a_fresh_report_of_no_grant_refuses_the_capture(
            self, darwin, posix, monkeypatch, relocated):
        """A grab without Screen Recording need not fail on macOS — it can come
        back missing every other application's windows — so an app that has
        said it holds no grant is never asked for a frame."""
        _report_grant(darwin, monkeypatch, relocated, screen_recording=False)
        monkeypatch.setattr(posix, 'capture_screen', _never_called)

        result = darwin.capture_screen(0, executor=_never_called, timeout_s=5)

        assert result['error'] == 'screen_recording_not_granted'
        assert darwin.streamer_capable() is False

    def test_a_fresh_grant_captures_through_the_shared_job(
            self, darwin, posix, monkeypatch, relocated):
        _report_grant(darwin, monkeypatch, relocated, screen_recording=True)
        captured = {'outputDir': '/tmp/out', 'files': ['screenshot.png']}
        monkeypatch.setattr(
            posix, 'capture_screen', lambda monitor, *, executor, timeout_s: captured)

        assert darwin.capture_screen(0, executor=None, timeout_s=5) is captured
        assert darwin.streamer_capable() is True

    def test_an_app_that_has_not_reported_answers_for_the_grant_itself(
            self, darwin, posix, monkeypatch, relocated):
        """No report is not a refusal: the job runner holds the grant or does
        not at the moment it captures. It is not a capability either."""
        monkeypatch.setattr(darwin, 'console_user', lambda: pwd.getpwuid(os.getuid()).pw_name)
        captured = {'outputDir': '/tmp/out', 'files': ['screenshot.png']}
        monkeypatch.setattr(
            posix, 'capture_screen', lambda monitor, *, executor, timeout_s: captured)

        assert darwin.capture_screen(0, executor=None, timeout_s=5) is captured
        assert darwin.streamer_capable() is False

    @pytest.mark.parametrize('screen_recording, checked_at', [
        (True, lambda now: now - 3600),
        (True, lambda now: now + 3600),
        ('yes', lambda now: now),
        (True, lambda now: 'now'),
        (True, lambda now: True),
    ])
    def test_a_report_that_is_stale_or_malformed_is_no_report(
            self, darwin, monkeypatch, relocated, screen_recording, checked_at):
        """The grant can be withdrawn in System Settings at any moment, so an
        old report says nothing about now — and a report from ahead of this
        clock or of the wrong shape says nothing at all."""
        _report_grant(
            darwin, monkeypatch, relocated,
            screen_recording=screen_recording, checked_at=checked_at(time.time()))

        assert darwin.streamer_capable() is False

    def test_a_report_the_console_user_did_not_write_is_no_report(
            self, darwin, monkeypatch, relocated):
        """`ipc/` is the whole group's to write into, so a report counts only
        in the console user's own file that nobody else can rewrite."""
        path = _report_grant(darwin, monkeypatch, relocated, screen_recording=True)
        assert darwin.streamer_capable() is True

        os.chmod(path, 0o664)
        assert darwin.streamer_capable() is False

        os.chmod(path, 0o644)
        monkeypatch.setattr(darwin, 'console_user', lambda: 'root')
        assert darwin.streamer_capable() is False

        monkeypatch.setattr(darwin, 'console_user', lambda: None)
        assert darwin.streamer_capable() is False

    def test_a_report_that_is_not_a_file_of_its_own_is_not_read(
            self, darwin, monkeypatch, relocated):
        path = _report_grant(darwin, monkeypatch, relocated, screen_recording=True)
        bait = relocated / 'bait.json'
        os.replace(path, bait)
        path.symlink_to(bait)

        assert darwin.streamer_capable() is False


def _launchd_job(state):
    """`launchctl print system/app.owlette.agent`, trimmed to the lines the
    arm reads and one nested block that has lines of its own."""
    return (
        'system/app.owlette.agent = {\n'
        '\tactive count = 1\n'
        '\tpath = /Library/LaunchDaemons/app.owlette.agent.plist\n'
        '\ttype = LaunchDaemon\n'
        f'\tstate = {state}\n'
        '\n'
        '\tendpoints = {\n'
        '\t\tport = 0x1a03\n'
        '\t}\n'
        '\n'
        '\tdomain = system\n'
        '}\n'
    )


# A made-up hardware UUID in the shape ioreg prints the real one.
_PLATFORM_UUID = '5F1C0E54-8E3B-4F6A-9D7C-2B8A1E3F4D5C'


def _registry(monkeypatch, darwin, properties):
    """The IORegistry, answered from {(entry class, property): value}."""
    monkeypatch.setattr(
        darwin, '_registry_property',
        lambda entry_class, name: properties.get((entry_class, name)),
    )


def _consoles(monkeypatch, darwin, sessions):
    """IOConsoleUsers as WindowServer publishes it: None when nobody has ever
    logged in since boot."""
    _registry(monkeypatch, darwin, {(None, 'IOConsoleUsers'): sessions})


def _console(name, uid, on_console=True, login_done=True):
    """One IOConsoleUsers entry, in the shape measured on macOS 26.6."""
    return {
        'kCGSSessionUserNameKey': name,
        'kCGSSessionUserIDKey': uid,
        'kCGSSessionGroupIDKey': 20,
        'kCGSSessionOnConsoleKey': on_console,
        'kCGSessionLoginDoneKey': login_done,
        'kCGSSessionAuditIDKey': 100017,
        'kCGSSessionIDKey': 257,
        'kSCSecuritySessionID': 100017,
        'kCGSSessionSystemSafeBoot': False,
        'kCGSSessionLoginwindowSafeLogin': False,
    }


class _SessionLaunchd:
    """launchctl as a session spawn meets it: the domain's services block the
    sweep reads, the plist each bootstrap was handed — read while the file
    still exists — and the pid `kickstart -p` prints, None for none."""

    def __init__(self, monkeypatch, darwin, pid, services='', bootstrap=(0, '')):
        self.pid = pid
        self.services = services
        self.bootstrap = bootstrap
        self.calls = []
        self.jobs = []
        monkeypatch.setattr(darwin, '_run', self._run)

    def _run(self, command, timeout_seconds):
        self.calls.append(list(command))
        verb = command[1]
        if verb == 'print':
            return _completed(0, f'gui/501 = {{\n\tservices = {{\n{self.services}\t}}\n}}\n')
        if verb == 'bootstrap':
            with open(command[3], 'rb') as f:
                self.jobs.append((command[3], plistlib.load(f)))
            return _completed(*self.bootstrap)
        if verb == 'kickstart':
            return _completed(0, '' if self.pid is None else f'{self.pid}\n')
        return _completed(0, '')


def _completed(returncode, stdout):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr='')


def _responsible_pid(pid):
    """The pid TCC holds responsible for `pid`'s requests."""
    import ctypes

    quarantine = ctypes.CDLL('/usr/lib/system/libquarantine.dylib')
    responsible = quarantine.responsibility_get_pid_responsible_for_pid
    responsible.argtypes, responsible.restype = [ctypes.c_int], ctypes.c_int
    return responsible(pid)


class _Launchctl:
    """launchctl, answered per subcommand from a script: each subcommand's
    replies are handed out in order and the last one repeats, and one with no
    script succeeds silently. A None reply is a launchctl that could not be run
    at all."""

    def __init__(self, monkeypatch, darwin, script):
        self.script = {verb: list(replies) for verb, replies in script.items()}
        self.calls = []
        monkeypatch.setattr(darwin, '_run', self._run)
        monkeypatch.setattr(darwin, '_STATE_POLL_SECONDS', 0.01)

    def _run(self, command, timeout_seconds):
        self.calls.append(list(command))
        replies = self.script.get(command[1], [(0, '')])
        reply = replies.pop(0) if len(replies) > 1 else replies[0]
        if reply is None:
            return None
        return SimpleNamespace(returncode=reply[0], stdout=reply[1], stderr=reply[1])


def _app(bundle, **info):
    """An application bundle whose Info.plist carries `info`."""
    contents = bundle / 'Contents'
    contents.mkdir(parents=True)
    (contents / 'Info.plist').write_bytes(
        plistlib.dumps({'CFBundleExecutable': bundle.stem, **info}))


def _report_grant(darwin, monkeypatch, root, **report):
    """What the desktop app writes about its grants, as the user running the
    suite — who stands in for the console user."""
    monkeypatch.setattr(darwin, 'console_user', lambda: pwd.getpwuid(os.getuid()).pw_name)
    report.setdefault('checked_at', time.time())
    path = root / 'ipc' / 'tcc.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report), encoding='utf-8')
    os.chmod(path, 0o644)
    return path


def _adopted_by_launchd(executable):
    """`executable` detached into a session of its own, its parent gone —
    the shape shutdown(8)'s scheduler takes once `shutdown` has returned."""
    launched = subprocess.run(
        [sys.executable, '-c',
         'import subprocess, sys\n'
         'print(subprocess.Popen([sys.argv[1]], start_new_session=True,'
         ' stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,'
         ' stderr=subprocess.DEVNULL).pid)',
         str(executable)],
        capture_output=True, text=True, timeout=30, check=True,
    )
    process = psutil.Process(int(launched.stdout))
    _wait_for(lambda: process.ppid() == 1)
    return process


def _kill_quietly(process):
    try:
        process.kill()
    except psutil.NoSuchProcess:
        pass


def _exe(pid):
    try:
        return psutil.Process(pid).exe()
    except psutil.Error:
        return None


def _seat(monkeypatch, posix, declared):
    """A graphical session logind types `declared`."""
    monkeypatch.setattr(
        posix, '_graphical_session',
        lambda uid=None: posix._Session('kiosk', declared, '2', 1000),
    )


class _FakeSeat:
    """A logind session as the kernel publishes one.

    A scope naming the session's processes, and a /proc entry per process
    carrying the account it runs as and the environment it was given. The
    adapter's own roots are pointed here, so the lookup reads nothing outside
    tmp_path and its answer does not depend on this machine having a display.
    """

    ID = '2'
    UID = 1000

    def __init__(self, posix, tmp_path, monkeypatch):
        self.posix = posix
        self.proc = tmp_path / 'proc'
        self.cgroup = tmp_path / 'cgroup'
        self.scope = (
            self.cgroup / 'user.slice' / f'user-{self.UID}.slice'
            / f'session-{self.ID}.scope'
        )
        self.runtime = tmp_path / 'run' / 'user' / str(self.UID)
        self.home = tmp_path / 'home' / 'kiosk'
        for directory in (self.proc, self.scope, self.runtime, self.home):
            directory.mkdir(parents=True)
        # The unified hierarchy's own marker at the root: the per-unit
        # subtree exists only on a box that publishes this, and this seat
        # is the kiosk VM's — Ubuntu 24.04, unified.
        (self.cgroup / 'cgroup.controllers').write_text(
            'cpuset cpu io memory pids', encoding='utf-8')
        self.account = {
            'HOME': str(self.home), 'USER': 'kiosk', 'LOGNAME': 'kiosk',
            'PATH': '/usr/local/bin:/usr/bin:/bin',
        }
        self.members = []
        monkeypatch.setattr(posix, 'PROC_ROOT', str(self.proc))
        monkeypatch.setattr(posix, 'CGROUP_ROOT', str(self.cgroup))
        monkeypatch.setattr(posix, 'RUNTIME_DIR_ROOT', str(tmp_path / 'run' / 'user'))
        monkeypatch.setattr(posix, '_account_env', lambda uid: dict(self.account))
        monkeypatch.setattr(
            posix, '_graphical_session',
            lambda uid=None: posix._Session('kiosk', 'x11', self.ID, self.UID),
        )

    def process(self, pid, uid, environ, *, member=True, cgroup=None):
        """One process the kernel would publish, in this session or outside it."""
        entry = self.proc / str(pid)
        entry.mkdir()
        (entry / 'status').write_text(
            f'Name:\tproc{pid}\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\n',
            encoding='utf-8')
        (entry / 'environ').write_bytes(b''.join(
            f'{name}={value}\0'.encode('utf-8')
            for name, value in environ.items()))
        (entry / 'cgroup').write_text(
            cgroup or (
                f'0::/user.slice/user-{self.UID}.slice/session-{self.ID}.scope\n'
                if member else '0::/system.slice/cron.service\n'),
            encoding='utf-8')
        if member:
            self.members.append(pid)
            (self.scope / 'cgroup.procs').write_text(
                ''.join(f'{member_pid}\n' for member_pid in self.members),
                encoding='utf-8')

    def user_unit(self, pid, uid, environ, unit='org.gnome.Shell@x11.service'):
        """A process of a systemd user unit: inside the user's slice, outside
        the session scope — where the kiosk VM's own gnome-shell runs.

        Published the way the kernel publishes it: the unit's own cgroup lists
        it, two levels below `user@<uid>.service`, and a `cgroup.procs` there
        names that cgroup's processes and none of its children's.
        """
        relative = (
            f'user.slice/user-{self.UID}.slice/user@{self.UID}.service'
            f'/session.slice/{unit}')
        self.process(pid, uid, environ, member=False,
                     cgroup=f'0::/{relative}\n')
        directory = self.cgroup / relative
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / 'cgroup.procs').open('a', encoding='utf-8') as f:
            f.write(f'{pid}\n')

    def legacy_hierarchy(self):
        """The same seat on a v1 or hybrid box; called once it is built.

        None of the unified tree is there — no `cgroup.controllers` at the
        root and none of the per-unit directories — and every process's own
        cgroup line is in the shape a v1 systemd writes it.
        """
        (self.cgroup / 'cgroup.controllers').unlink()
        shutil.rmtree(self.cgroup / 'user.slice')
        for entry in self.proc.iterdir():
            line = entry / 'cgroup'
            line.write_text(
                line.read_text(encoding='utf-8').replace(
                    '0::/', '1:name=systemd:/'),
                encoding='utf-8')

    def gdm(self, leader=1292, shell=1500, environ=None):
        """The Ubuntu 24.04 GDM layout: a root-owned PAM worker as the session
        leader, and the user's own shell holding what a display needs."""
        self.process(leader, 0, {
            'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin',
            'USER': 'root',
            'LANG': 'C.UTF-8',
            'GDM_SESSION_DBUS_ADDRESS': 'unix:abstract=/tmp/dbus-gdm',
        })
        self.process(
            shell, self.UID,
            self.session_environ() if environ is None else environ)

    def session_environ(self, **overrides):
        """What gnome-shell holds. The account variables are deliberately not
        the kiosk user's: the session runs processes of more than one account,
        so what is lifted from it can never stand in for the account's own.
        """
        environ = {
            'DISPLAY': ':0',
            'XAUTHORITY': str(self.runtime / 'gdm' / 'Xauthority'),
            'XDG_RUNTIME_DIR': f'/run/user/{self.UID}',
            'DBUS_SESSION_BUS_ADDRESS': f'unix:path=/run/user/{self.UID}/bus',
            'XDG_SESSION_TYPE': 'x11',
            'GNOME_KEYRING_CONTROL': f'/run/user/{self.UID}/keyring',
            'USER': 'gdm', 'LOGNAME': 'gdm', 'HOME': '/var/lib/gdm',
            'PATH': '/session/only',
        }
        environ.update(overrides)
        return environ

    def cookie(self, path):
        """An X cookie that is really there, at `path`."""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'')
        return str(path)


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
        self._served = set()
        self._stopped = threading.Event()

    def run(self):
        while not self._stopped.wait(0.02):
            for request in sorted(self.jobs.glob('*.json')):
                # Once per request, as the real runner does: the daemon removes
                # the request only after it has read the result, and a runner
                # that served it again in that gap would rebuild the result
                # directory the daemon had just removed (macos-15 CI, 2026-09-25).
                if request.name in self._served:
                    continue
                self._served.add(request.name)
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
