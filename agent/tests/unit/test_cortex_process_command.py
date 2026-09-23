"""Regression tests for OwletteService._handle_cortex_process_command (OWL-03).

The Cortex Tier-2 process-control path used to pass the process *config dict*
to shared_utils.graceful_terminate(), which expects an integer PID. That raised
TypeError on every restart/kill/start, the broad except swallowed it into a
silent {'status': 'failed'}, and so Cortex Tier-2 / autonomous self-healing
never actually acted. These tests pin the contract: the handler resolves the
running PID from self.last_started and hands an *int* to the kill/relaunch
helpers — never the config dict.

The real method is bound onto a tiny fake via the descriptor protocol
(``OwletteService.<method>.__get__(fake, OwletteService)``) so the production
body runs against controlled attributes without constructing the full Windows
service. owlette_service is imported lazily inside the fixtures/tests (matching
test_display_manager.py) so module collection does not eagerly initialize the
cryptography rust bindings, whose PyO3 single-init trips on certain orderings.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


PROC = {'id': 'proc-1', 'name': 'TouchDesigner'}


def _make_service():
    from owlette_service import OwletteService
    svc = SimpleNamespace(
        last_started={},
        firebase_client=MagicMock(),
        kill_and_relaunch_process=MagicMock(return_value=4321),
        handle_process_launch=MagicMock(return_value=5678),
    )
    svc._handle_cortex_process_command = (
        OwletteService._handle_cortex_process_command.__get__(svc, OwletteService)
    )
    return svc


@pytest.fixture
def graceful_terminate(monkeypatch):
    """Patch the I/O boundary; yield the graceful_terminate spy.

    The Wave-5 identity gate is stubbed open here (and the durable-record
    resolver stubbed empty) because these tests pin the PID-plumbing
    contract, not the gate -- the gate has its own suite in
    test_kill_safety.py, and left real it would read the live app_states
    file, which unit tests must never depend on.
    """
    import owlette_service
    monkeypatch.setattr(
        owlette_service.shared_utils, 'read_config',
        lambda *a, **k: {'processes': [PROC]},
    )
    gt = MagicMock(return_value=True)
    monkeypatch.setattr(owlette_service.shared_utils, 'graceful_terminate', gt)
    monkeypatch.setattr(
        owlette_service.shared_utils, 'update_process_status_in_json', MagicMock(),
    )
    monkeypatch.setattr(owlette_service.Util, 'is_pid_running', lambda pid: True)
    monkeypatch.setattr(owlette_service, '_identity_gate',
                        lambda pid, process_list_id: (True, None))
    monkeypatch.setattr(owlette_service, '_resolve_recorded_pid',
                        lambda process_list_id: None)
    return gt


class TestProvisionCortexKey:
    """The same shape of bug on the key-provisioning path.

    _handle_provision_cortex_key called shared_utils.write_config(config) with
    one argument against a two-parameter (keys, value) signature, so every
    provisioning attempt raised TypeError into the broad except and came back as
    a plain "Error: ..." string — the key was never stored.
    """

    @pytest.fixture
    def provision(self, monkeypatch):
        import owlette_service
        from owlette_service import OwletteService

        storage = MagicMock()
        storage.encrypt_value.return_value = 'encrypted-blob'
        monkeypatch.setitem(
            __import__('sys').modules, 'secure_storage',
            SimpleNamespace(get_storage=lambda: storage),
        )
        monkeypatch.setattr(
            owlette_service.shared_utils, 'read_config',
            lambda *a, **k: {'firebase': {'enabled': True},
                             'cortex': {'model': 'claude-opus-4'}},
        )
        writes = MagicMock()
        monkeypatch.setattr(owlette_service.shared_utils, 'write_config', writes)

        svc = SimpleNamespace()
        svc._handle_provision_cortex_key = (
            OwletteService._handle_provision_cortex_key.__get__(svc, OwletteService)
        )
        return svc, writes

    def test_the_key_is_actually_stored(self, provision):
        svc, writes = provision

        result = svc._handle_provision_cortex_key(
            {'api_key': 'sk-ant-test', 'provider': 'anthropic'})

        assert result == "Cortex API key provisioned successfully"
        writes.assert_called_once()
        keys, value = writes.call_args[0]
        # The regression guard: two arguments, matching write_config(keys, value).
        assert keys == ['cortex']
        assert value['apiKeyEncrypted'] == 'encrypted-blob'
        assert value['provider'] == 'anthropic'
        assert value['enabled'] is True

    def test_existing_cortex_settings_survive(self, provision):
        svc, writes = provision

        svc._handle_provision_cortex_key({'api_key': 'sk-ant-test'})

        _keys, value = writes.call_args[0]
        # Writing the whole branch must not drop siblings already on disk.
        assert value['model'] == 'claude-opus-4'

    def test_a_missing_key_is_rejected_before_any_write(self, provision):
        svc, writes = provision

        assert svc._handle_provision_cortex_key({'api_key': ''}) == "Error: No API key provided"
        writes.assert_not_called()


def test_kill_passes_int_pid_not_config_dict(graceful_terminate):
    """OWL-03: graceful_terminate must receive the int PID, never the dict."""
    svc = _make_service()
    svc.last_started = {'proc-1': {'pid': 1234}}

    result = svc._handle_cortex_process_command('kill_process', 'TouchDesigner')

    assert result['status'] == 'completed'
    # The contract under test is the first argument: an int pid, never the
    # config dict. exe_path rides along so a .bat/.cmd target's payload is
    # reaped with its wrapper; it is None here because PROC has no exe_path.
    graceful_terminate.assert_called_once_with(1234, exe_path=None)
    # The regression guard: the arg is an int PID, not the process config dict.
    (called_arg,), _ = graceful_terminate.call_args
    assert isinstance(called_arg, int) and not isinstance(called_arg, dict)


def test_restart_running_process_relaunches_with_int_pid(graceful_terminate):
    svc = _make_service()
    svc.last_started = {'proc-1': {'pid': 1234}}

    result = svc._handle_cortex_process_command('restart_process', 'TouchDesigner')

    assert result['status'] == 'completed'
    svc.kill_and_relaunch_process.assert_called_once_with(1234, PROC)
    svc.handle_process_launch.assert_not_called()


def test_restart_when_not_running_launches(graceful_terminate, monkeypatch):
    import owlette_service
    monkeypatch.setattr(owlette_service.Util, 'is_pid_running', lambda pid: False)
    svc = _make_service()
    svc.last_started = {}  # no recorded pid

    result = svc._handle_cortex_process_command('restart_process', 'TouchDesigner')

    assert result['status'] == 'completed'
    svc.handle_process_launch.assert_called_once_with(PROC)
    svc.kill_and_relaunch_process.assert_not_called()


def test_kill_when_not_running_is_noop(graceful_terminate, monkeypatch):
    import owlette_service
    monkeypatch.setattr(owlette_service.Util, 'is_pid_running', lambda pid: False)
    svc = _make_service()
    svc.last_started = {'proc-1': {'pid': 1234}}

    result = svc._handle_cortex_process_command('kill_process', 'TouchDesigner')

    assert result['status'] == 'completed'
    assert 'not running' in result['result'].lower()
    graceful_terminate.assert_not_called()


def test_unknown_process_returns_error(graceful_terminate):
    svc = _make_service()
    result = svc._handle_cortex_process_command('kill_process', 'NoSuchProc')
    assert 'error' in result and 'not found' in result['error'].lower()
