"""The osadapter surface contract.

One shared body, run against every adapter that can run on this machine. The
POSIX adapters join the parametrisation when they land; until then only `win`
is exercised, and the Windows-specific block below pins what each operation
delegates to.
"""

import importlib
import inspect
import subprocess
from types import SimpleNamespace

import pytest

import osadapter


ADAPTERS = [
    pytest.param('win', marks=pytest.mark.windows),
]

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

        assert issued == [(
            ['shutdown', '/r', '/t', '30', '/c', 'owlette remote reboot requested'],
            {'check': True, 'timeout': 15},
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
            {'check': True, 'timeout': 15},
        )]

    def test_cancel_reboot_reports_whether_the_abort_took(self, win, monkeypatch):
        issued = _record_subprocess_run(monkeypatch, returncode=0)
        assert win.cancel_reboot() is True
        assert issued[0][0] == ['shutdown', '/a']

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

    def test_capture_refuses_until_the_pipeline_moves_into_the_adapter(self, win):
        """Staged, not permanent: task 3.2 moves the capture round-trip here."""
        with pytest.raises(osadapter.NotSupportedHere):
            win.capture_screen('screenshot.png')


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
