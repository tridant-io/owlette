"""
Unit tests for pairing_commands — the `unpair` handler — and the service method
behind it.

A dashboard revoke used to change nothing on the machine for up to an hour
(#327): the token doc was gone, but the agent kept syncing on its access token.
These pin the agent's side of the fix: the command lands, the agent confirms
the revoke with a refresh, a refused refresh unpairs through AuthManager's
hook, an accepted one is ignored (a sibling's token, or a stale command on a
machine paired again), the command is never completed, and
`OwletteService.unpair` takes the machine out of its site and ends swoop.
owlette_service and firebase_client are imported inside the tests, as
elsewhere in this suite, so collection order cannot double-initialise the
cryptography bindings.
"""

import inspect
from types import SimpleNamespace
from unittest.mock import patch

from auth_manager import TokenRefreshError, TokenRevokedError
from command_router import COMMAND_DEFERRED, CommandRouter
from pairing_commands import UNPAIR_REASON, handle_unpair, register_handlers

CMD = {'type': 'unpair', 'siteId': 'site-1', 'machineId': 'machine-1'}


class RecordingService:
    """The service slice the handler touches: a cloud client whose auth
    manager answers the confirming refresh the way the test says."""

    def __init__(self, refresh=None):
        self.reasons = []
        self.refreshes = 0

        def refresh_now():
            self.refreshes += 1
            if refresh is not None:
                raise refresh

        self.firebase_client = SimpleNamespace(
            auth_manager=SimpleNamespace(refresh_now=refresh_now))

    def unpair(self, reason):
        self.reasons.append(reason)


# registration and lanes

def test_register_handlers_registers_unpair():
    router = CommandRouter()
    register_handlers(router)
    assert router.registered_types() == ['unpair']


def test_unpair_rides_the_fast_lane():
    # a revoke that queued behind an install would leave a revoked machine
    # syncing for as long as the install takes
    from firebase_client import FirebaseClient

    assert 'unpair' in FirebaseClient._FAST_COMMAND_TYPES


def test_init_registers_the_pairing_handlers():
    from owlette_service import OwletteService

    source = inspect.getsource(OwletteService._init_state)
    assert 'from pairing_commands import register_handlers' in source
    assert '_register_pairing_handlers(self._command_router)' in source
    assert 'Failed to register pairing handlers' in source


def test_both_auth_manager_construction_sites_pass_the_unpair_hook():
    # the hook is the only exit for a machine that was offline during the
    # revoke; the runner's construction is the boot path under owlette-host
    from owlette_service import OwletteService
    import owlette_runner

    assert 'AuthManager(api_base=api_base, on_revoked=self.unpair)' in inspect.getsource(
        OwletteService._initialize_or_restart_firebase_client)
    assert 'on_revoked=_service_instance.unpair' in inspect.getsource(owlette_runner)


# the handler

def test_a_refused_refresh_is_the_revoke_and_the_hook_has_unpaired():
    # the hook runs inside AuthManager on the 401; the handler must not unpair
    # a second time on top of it, and must not complete the command: the
    # completion's metrics push would put online: true behind the flush
    service = RecordingService(refresh=TokenRevokedError('Invalid refresh token'))

    result = handle_unpair(dict(CMD), 'cmd-1', service)

    assert service.refreshes == 1
    assert service.reasons == []
    assert result is COMMAND_DEFERRED


def test_an_accepted_refresh_means_the_command_is_not_about_this_credential():
    # a sibling sharing the hostname whose own token survived, or a command
    # left queued for a machine that has since been paired again. deferred,
    # not completed, so the sibling it was meant for still finds it pending
    service = RecordingService()

    result = handle_unpair(dict(CMD), 'cmd-1', service)

    assert service.refreshes == 1
    assert service.reasons == []
    assert result is COMMAND_DEFERRED


def test_a_refresh_that_could_not_be_asked_is_settled_the_dashboards_way():
    service = RecordingService(refresh=TokenRefreshError('Network error: offline'))

    result = handle_unpair(dict(CMD), 'cmd-1', service)

    assert len(service.reasons) == 1
    assert service.reasons[0].startswith(UNPAIR_REASON)
    assert 'offline' in service.reasons[0]
    assert result is COMMAND_DEFERRED


def test_without_a_cloud_client_the_command_fails_rather_than_guesses():
    service = SimpleNamespace(firebase_client=None, unpair=lambda reason: None)

    assert handle_unpair(dict(CMD), 'cmd-1', service).startswith('Error:')


def test_handle_unpair_reaches_the_service_through_the_router():
    router = CommandRouter()
    register_handlers(router)
    service = RecordingService(refresh=TokenRefreshError('Network error: offline'))

    router.dispatch('unpair', dict(CMD), 'cmd-1', service)

    assert len(service.reasons) == 1


# OwletteService.unpair

def _service_double(hoot_pid=None):
    """OwletteService's unpair, bound to the slice of state it touches."""
    from owlette_service import OwletteService

    calls = []
    double = SimpleNamespace(
        _stop_swoop=lambda: calls.append('stop_swoop'),
        _is_cortex_alive=lambda: hoot_pid is not None,
        cortex_pid=hoot_pid,
    )
    double.unpair = OwletteService.unpair.__get__(double)
    return double, calls


def test_service_unpair_detaches_then_ends_swoop():
    double, calls = _service_double()

    with patch('owlette_service.configure_site.unpair',
               side_effect=lambda reason: calls.append(('unpair', reason))) as detach:
        double.unpair('the agent token was revoked')

    detach.assert_called_once_with('the agent token was revoked')
    # the site is left first: a swoop kill that raised must not keep a
    # revoked machine paired
    assert calls == [('unpair', 'the agent token was revoked'), 'stop_swoop']


def test_service_unpair_ends_a_running_hoot():
    # hoot holds its own access token for up to an hour; left running, site
    # members could keep chatting with a revoked machine through it
    double, _calls = _service_double(hoot_pid=4242)

    with patch('owlette_service.configure_site.unpair'), \
         patch('owlette_service.psutil.Process') as process:
        double.unpair('the agent token was revoked')

    process.assert_called_once_with(4242)
    process.return_value.terminate.assert_called_once()
