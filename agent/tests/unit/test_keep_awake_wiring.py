"""How the service wires keep screens awake: the site's switch, the daemon's
hold, the desktop app's report and the machine document's `displayAwake`.

The service builds through `_init_state`, as owlette_runner builds it, and
then gets a fake holder: nothing real is held here. The property that matters
most is the loop's: the tick hands the switch on and never waits on the OS, the
app's report or the cloud.
"""

import json
import sys
import threading
import time

import pytest

import acl_hardening
import owlette_service
from keep_awake import KeepAwake


class FakeKeepAwake:
    """KeepAwake's surface, recording what it was asked."""

    def __init__(self):
        self.asked = []
        self.held = False
        self.reason = None
        self.released = 0

    def set_wanted(self, wanted):
        self.asked.append(wanted)

    def status(self):
        return {
            'wanted': self.asked[-1] if self.asked else False,
            'held': self.held,
            'how': 'power_request',
            'reason': self.reason,
        }

    def release(self, timeout=2.0):
        self.released += 1


class FakeClient:
    """The cloud client's two keep-awake surfaces."""

    def __init__(self, keep_awake=True, connected=True):
        self.site_keep_awake = keep_awake
        self.connected = connected
        self.written = []

    def set_machine_flags(self, flags):
        if not self.connected:
            raise RuntimeError('Firebase client not connected')
        self.written.append(flags)


@pytest.fixture
def service(monkeypatch):
    monkeypatch.setattr(
        owlette_service.shared_utils, 'read_config', lambda *a, **kw: {})
    monkeypatch.setattr(
        owlette_service.shared_utils, 'get_api_base_url',
        lambda environment=None: 'https://example.invalid/api')
    monkeypatch.setattr(
        owlette_service, '_read_session_keep_awake', lambda: (True, None))
    svc = object.__new__(owlette_service.OwletteService)
    svc._init_state()
    svc.keep_awake = FakeKeepAwake()
    svc.firebase_client = FakeClient()
    return svc


def tick(svc):
    """One loop tick's keep-awake duty, and the mirror it started, if any."""
    svc._check_keep_awake()
    worker = svc._display_awake_thread
    if worker is not None:
        worker.join(5)


def tick_until_the_periodic_check(svc):
    for _ in range(owlette_service.DISPLAY_AWAKE_CHECK_ITERATIONS):
        tick(svc)


def mirrored(client):
    return [flags['displayAwake'] for flags in client.written]


def test_the_hosted_service_carries_a_real_holder(monkeypatch):
    monkeypatch.setattr(
        owlette_service.shared_utils, 'read_config', lambda *a, **kw: {})
    monkeypatch.setattr(
        owlette_service.shared_utils, 'get_api_base_url',
        lambda environment=None: 'https://example.invalid/api')
    svc = object.__new__(owlette_service.OwletteService)
    svc._init_state()

    assert isinstance(svc.keep_awake, KeepAwake)
    # nothing asked until the loop reads the site's switch.
    assert svc._keep_awake_wanted is False
    assert svc.keep_awake.status()['wanted'] is False


class TestTheSwitch:
    def test_is_handed_to_the_holder_once_per_change(self, service):
        tick(service)
        tick(service)
        tick(service)
        assert service.keep_awake.asked == [True]

        service.firebase_client.site_keep_awake = False
        tick(service)
        tick(service)
        assert service.keep_awake.asked == [True, False]

        service.firebase_client.site_keep_awake = True
        tick(service)
        assert service.keep_awake.asked == [True, False, True]

    def test_no_cloud_client_is_nobody_asking(self, service):
        service.firebase_client = None
        tick(service)
        # never asked, so never told to let go either.
        assert service.keep_awake.asked == []

        service.firebase_client = FakeClient()
        tick(service)
        service.firebase_client = None
        tick(service)
        assert service.keep_awake.asked == [True, False]

    def test_a_tick_after_the_stop_does_not_take_the_hold_back(self, service, monkeypatch):
        monkeypatch.setattr(
            owlette_service.session_state, 'set_intent_if_none', lambda intent: None)
        service._write_service_status = lambda running=True: None
        service.firebase_client = None
        service.graceful_shutdown('scm_stop')
        service.firebase_client = FakeClient()

        tick(service)

        assert service.keep_awake.asked == []


class TestTheTick:
    def test_never_waits_on_the_mirror_and_runs_one_at_a_time(self, service, monkeypatch):
        gate = threading.Event()
        reads = []

        def slow_read():
            reads.append(None)
            gate.wait(5)
            return True, None

        monkeypatch.setattr(owlette_service, '_read_session_keep_awake', slow_read)
        try:
            started = time.monotonic()
            service._check_keep_awake()
            # the daemon's hold changes while the first check is still reading:
            # a check is due at once, but only one runs.
            service.keep_awake.held = True
            service._check_keep_awake()
            assert time.monotonic() - started < 1.0
            assert service.keep_awake.asked == [True]
        finally:
            gate.set()
        service._display_awake_thread.join(5)
        assert len(reads) == 1

        # the change the busy tick skipped is checked on the next one.
        tick(service)
        assert len(reads) == 2
        assert mirrored(service.firebase_client)[-1]['held'] is True


class TestTheMirror:
    def test_is_written_on_each_change_only(self, service):
        tick(service)
        assert mirrored(service.firebase_client) == [{
            'wanted': True, 'held': False, 'session': None, 'how': None, 'reason': None,
        }]

        # nothing changed: the periodic check comes round and writes nothing.
        tick_until_the_periodic_check(service)
        assert len(service.firebase_client.written) == 1

        service.keep_awake.held = True
        tick(service)
        assert mirrored(service.firebase_client)[-1] == {
            'wanted': True, 'held': True, 'session': None,
            'how': 'power_request', 'reason': None,
        }
        assert len(service.firebase_client.written) == 2

    def test_carries_the_session_report_from_the_periodic_check(self, service, monkeypatch):
        service.keep_awake.held = True
        tick(service)
        assert mirrored(service.firebase_client)[-1]['session'] is None

        monkeypatch.setattr(
            owlette_service, '_read_session_keep_awake', lambda: (True, True))
        tick_until_the_periodic_check(service)

        assert mirrored(service.firebase_client)[-1]['session'] is True
        assert len(service.firebase_client.written) == 2

    def test_a_write_that_did_not_land_is_tried_again(self, service):
        service.firebase_client.connected = False
        tick(service)
        assert service.firebase_client.written == []

        service.firebase_client.connected = True
        tick_until_the_periodic_check(service)
        assert len(service.firebase_client.written) == 1

    def test_a_new_client_writes_it_again(self, service):
        tick(service)
        first = service.firebase_client

        # a re-pair builds a new client for a machine document that may not
        # carry the mirror at all.
        service.firebase_client = FakeClient()
        tick_until_the_periodic_check(service)

        assert len(first.written) == 1
        assert len(service.firebase_client.written) == 1

    def test_an_unreadable_report_is_not_called_no_display(self, service, monkeypatch):
        def broken():
            raise RuntimeError('loginctl went away')

        monkeypatch.setattr(owlette_service, '_read_session_keep_awake', broken)
        tick(service)

        assert mirrored(service.firebase_client)[-1]['reason'] is None


class TestDisplayAwake:
    @staticmethod
    def daemon(wanted=True, held=True, reason=None):
        return {'wanted': wanted, 'held': held, 'how': 'systemd_inhibit', 'reason': reason}

    def test_both_halves_held(self):
        assert owlette_service._display_awake(self.daemon(), True, True) == {
            'wanted': True, 'held': True, 'session': True,
            'how': 'systemd_inhibit', 'reason': None,
        }

    def test_no_report_and_nobody_at_the_seat_is_no_display(self):
        value = owlette_service._display_awake(self.daemon(), False, None)
        assert value['session'] is None
        assert value['reason'] == 'no_display'

    def test_no_report_with_somebody_at_the_seat_is_no_reason(self):
        assert owlette_service._display_awake(self.daemon(), True, None)['reason'] is None

    def test_the_daemons_own_reason_comes_first(self):
        value = owlette_service._display_awake(
            self.daemon(held=False, reason='no_inhibit'), False, None)
        assert value['reason'] == 'no_inhibit'
        # nothing holds it, so nothing is named as holding it.
        assert value['how'] is None

    def test_nothing_wanted_needs_no_reason(self):
        value = owlette_service._display_awake(
            self.daemon(wanted=False, held=False), False, None)
        assert value == {
            'wanted': False, 'held': False, 'session': None, 'how': None, 'reason': None,
        }


class TestShutdown:
    def test_lets_go_of_both_halves(self, service, monkeypatch):
        monkeypatch.setattr(
            owlette_service.session_state, 'set_intent_if_none', lambda intent: None)
        tick(service)
        assert service._keep_awake_wanted is True
        written = []
        service._write_service_status = (
            lambda running=True: written.append((running, service._keep_awake_section())))
        service.firebase_client = None

        assert service.graceful_shutdown('scm_stop') is True

        # the final status write tells the desktop app to let go of the session...
        assert written == [(False, {'wanted': False})]
        # ...and the daemon lets go of its own.
        assert service.keep_awake.released == 1


class TestTheSessionReportOnWindows:
    """The Windows arm of the report read, with the ACL seams faked so it runs
    on every OS. The POSIX arm is in test_posix_loop_duties.py."""

    CONSOLE_SID = object()

    @pytest.fixture
    def report(self, tmp_path, monkeypatch):
        monkeypatch.setattr(sys, 'platform', 'win32')
        monkeypatch.setattr(
            owlette_service.shared_utils, 'get_data_path',
            lambda rel: str(tmp_path / rel))
        monkeypatch.setattr(acl_hardening, 'console_user_sid', lambda: self.CONSOLE_SID)
        owners = {'trusted': True}
        monkeypatch.setattr(
            acl_hardening, 'is_trusted_owner',
            lambda path, user_sid=None: owners['trusted'] and user_sid is self.CONSOLE_SID)
        path = tmp_path / 'ipc' / 'keep_awake.json'
        path.parent.mkdir()

        def write(body=None, at=None, **fields):
            if body is None:
                body = json.dumps({
                    'held': True, 'how': 'execution_state', 'reason': None,
                    'at': int(time.time()) if at is None else at, **fields,
                })
            path.write_text(body)

        write.owners = owners
        return write

    def test_a_fresh_report_of_the_console_users_counts(self, report):
        report()
        assert owlette_service._read_session_keep_awake() == (True, True)

        report(held=False, reason='windows refused the execution state')
        assert owlette_service._read_session_keep_awake() == (True, False)

    def test_no_report_is_no_session(self, report):
        assert owlette_service._read_session_keep_awake() == (True, None)

    def test_nobody_at_the_console_is_no_seat(self, report, monkeypatch):
        report()
        monkeypatch.setattr(acl_hardening, 'console_user_sid', lambda: None)
        assert owlette_service._read_session_keep_awake() == (False, None)

    def test_a_report_another_account_wrote_is_ignored(self, report):
        report()
        report.owners['trusted'] = False
        assert owlette_service._read_session_keep_awake() == (True, None)

    @pytest.mark.parametrize('age', [
        owlette_service.KEEP_AWAKE_REPORT_MAX_AGE_SECONDS + 5,
        -(owlette_service._KEEP_AWAKE_REPORT_CLOCK_SKEW_SECONDS + 5),
    ])
    def test_a_report_out_of_its_time_is_ignored(self, report, age):
        report(at=int(time.time()) - age)
        assert owlette_service._read_session_keep_awake() == (True, None)

    @pytest.mark.parametrize('body', [
        'not json',
        '[true]',
        json.dumps({'held': 'yes', 'at': 1}),
        json.dumps({'held': True, 'at': True}),
        json.dumps({'held': True}),
        json.dumps({'held': True, 'at': 1, 'pad': 'x' * owlette_service._KEEP_AWAKE_REPORT_LIMIT}),
    ])
    def test_a_report_not_in_the_apps_shape_is_ignored(self, report, body):
        report(body=body)
        assert owlette_service._read_session_keep_awake() == (True, None)


def test_the_heartbeat_says_this_agent_keeps_screens_awake():
    from unittest.mock import MagicMock

    from firebase_client import FirebaseClient

    client = FirebaseClient.__new__(FirebaseClient)
    client.db = MagicMock()
    client.logger = MagicMock()
    client.connection_manager = MagicMock()
    client.connection_manager.is_connected = True
    client.machine_id = 'kiosk-01'
    client.site_id = 'site1'
    client._last_primary = None
    client._cached_display_profile = None
    client._ensure_profile = MagicMock(return_value=None)
    client._ensure_display_profile = MagicMock(return_value=None)

    assert client._upload_metrics({'memory': {}, 'processes': {}}) is True

    machine_doc = (
        client.db.collection.return_value.document.return_value
        .collection.return_value.document.return_value
    )
    payload = machine_doc.update.call_args[0][0]
    assert payload['capabilities.keepAwake'] == 1
    # dotted, so the sibling capabilities survive the write.
    assert 'capabilities' not in payload
