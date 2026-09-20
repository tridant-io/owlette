"""`tmp/service_status.json` — the service→desktop seam.

The desktop app never talks to the cloud: what the status footer and the tray
say about this machine's site comes entirely from the `firebase` section this
file publishes. That makes the section a contract, and these tests hold it —
particularly `site_name`, which is the operator-facing label ("TEC") the
surfaces prefer over the site id ("default_site").
"""

import json
from types import SimpleNamespace

import pytest

import owlette_service
from connection_manager import ConnectionState
from health_probe import HealthState


class FakeFirebaseClient:
    """Only the surface `_write_service_status` reads off the cloud client."""

    def __init__(self, connected=True, site_id='default_site', site_name=None,
                 site_timezone=None):
        self.connected = connected
        self.site_id = site_id
        self.site_name = site_name
        # None = this site's process windows are machine-local (it never opted
        # into site-time schedules, or it opted back out).
        self.site_timezone = site_timezone
        self._last_heartbeat_time = 1_786_680_000

    def is_connected(self):
        return self.connected

    def write_health_to_firestore(self, status, error_code, message):
        """_update_health_state mirrors health to Firestore when connected."""


class FakeConnectionManager:
    """The two things `_wire_connection_status_listener` touches."""

    def __init__(self, state):
        self.state = state
        self.listeners = []

    def add_state_listener(self, listener):
        self.listeners.append(listener)


def make_service(tmp_path, monkeypatch, firebase_client=None, enabled=True):
    """An OwletteService with only the state `_write_service_status` touches."""
    service = object.__new__(owlette_service.OwletteService)
    service.firebase_client = firebase_client
    service._last_status_signature = None
    service._last_status_write_time = 0.0
    service._health_state = None

    root = tmp_path / 'tmp'
    monkeypatch.setattr(
        owlette_service.shared_utils, 'get_data_path',
        lambda rel: str(tmp_path / rel),
    )
    monkeypatch.setattr(
        owlette_service.shared_utils, 'read_config',
        lambda keys=None: enabled if keys == ['firebase', 'enabled'] else None,
    )
    return service, root / 'service_status.json'


def firebase_section(path):
    with open(path) as handle:
        return json.load(handle)['firebase']


@pytest.fixture(autouse=True)
def _quiet_status_writer(monkeypatch):
    """The writer's own audit log wants ProgramData; a null logger will do."""
    import logging
    monkeypatch.setattr(
        owlette_service, '_status_writer_logger',
        logging.getLogger('test.status_writer'), raising=False,
    )


class TestSiteName:
    def test_publishes_the_display_name_beside_the_id(self, tmp_path, monkeypatch):
        service, path = make_service(
            tmp_path, monkeypatch,
            FakeFirebaseClient(site_id='default_site', site_name='TEC'),
        )

        service._write_service_status()

        section = firebase_section(path)
        # Both, always: the name is what the operator reads, the id is what
        # every log line and support conversation is keyed on.
        assert section['site_name'] == 'TEC'
        assert section['site_id'] == 'default_site'

    def test_an_unknown_name_is_empty_not_missing(self, tmp_path, monkeypatch):
        # The desktop app falls back to the site id on an empty name. A missing
        # key would work too, but publishing it unconditionally means the shape
        # of the section never depends on what the cloud would say.
        service, path = make_service(
            tmp_path, monkeypatch, FakeFirebaseClient(site_name=None))

        service._write_service_status()

        assert firebase_section(path)['site_name'] == ''

    def test_an_unpaired_machine_names_no_site(self, tmp_path, monkeypatch):
        service, path = make_service(tmp_path, monkeypatch, None, enabled=False)

        service._write_service_status()

        section = firebase_section(path)
        assert section['site_id'] == ''
        assert section['site_name'] == ''
        assert section['enabled'] is False

    def test_a_rename_is_published_on_the_next_write_not_the_refresh_floor(
        self, tmp_path, monkeypatch
    ):
        # Writes are throttled by a content signature, so anything left out of it is invisible
        # for up to MIN_STATUS_WRITE_INTERVAL. A site renamed on the dashboard arrives on the
        # next reconnect and must not then sit in the client for another half-minute.
        client = FakeFirebaseClient(site_name='TEC')
        service, path = make_service(tmp_path, monkeypatch, client)
        service._write_service_status()

        client.site_name = 'TEC — main floor'
        service._write_service_status()

        assert firebase_section(path)['site_name'] == 'TEC — main floor'

    def test_the_early_write_names_no_site_yet(self, tmp_path, monkeypatch):
        # Written before the cloud client exists, so it can only report the
        # shape. Claiming a site here would put a stale name on screen for the
        # whole of startup.
        service, path = make_service(tmp_path, monkeypatch, None)

        service._write_service_status_early()

        section = firebase_section(path)
        assert section['site_name'] == ''
        assert section['site_id'] == ''


class TestScheduleTimezone:
    """`firebase.schedule_timezone` — which clock this machine judges its process
    windows on, published for the desktop app.

    The desktop app writes schedule copy ("times run on the site's clock" vs
    "times run on this machine's clock") and never talks to the cloud, so this
    field is the only way it can know. Empty string means machine-local: either
    the site never opted into site-time schedules or it opted back out. The
    distinction is not "unknown" — an empty value is a definite answer.
    """

    def test_publishes_the_timezone_a_site_opted_into(self, tmp_path, monkeypatch):
        service, path = make_service(
            tmp_path, monkeypatch,
            FakeFirebaseClient(site_timezone='America/Los_Angeles'),
        )

        service._write_service_status()

        assert firebase_section(path)['schedule_timezone'] == 'America/Los_Angeles'

    def test_a_machine_local_site_publishes_empty_not_missing(self, tmp_path, monkeypatch):
        # Every site today. The key is written unconditionally so the desktop app
        # never has to tell "opted out" from "an older agent that had no idea".
        service, path = make_service(
            tmp_path, monkeypatch, FakeFirebaseClient(site_timezone=None))

        service._write_service_status()

        assert firebase_section(path)['schedule_timezone'] == ''

    def test_an_unpaired_machine_names_no_timezone(self, tmp_path, monkeypatch):
        service, path = make_service(tmp_path, monkeypatch, None, enabled=False)

        service._write_service_status()

        assert firebase_section(path)['schedule_timezone'] == ''

    def test_the_early_write_carries_the_same_shape(self, tmp_path, monkeypatch):
        service, path = make_service(tmp_path, monkeypatch, None)

        service._write_service_status_early()

        assert firebase_section(path)['schedule_timezone'] == ''

    def test_opting_in_reaches_the_desktop_on_the_next_write(self, tmp_path, monkeypatch):
        # The load-bearing one. Writes are throttled by a content signature and
        # skipped entirely for up to MIN_STATUS_WRITE_INTERVAL, so a field left
        # out of the signature is invisible for half a minute after the flag
        # flips — long enough for the operator to conclude it did not work.
        client = FakeFirebaseClient(site_timezone=None)
        service, path = make_service(tmp_path, monkeypatch, client)
        service._write_service_status()
        assert firebase_section(path)['schedule_timezone'] == ''

        client.site_timezone = 'America/Los_Angeles'
        service._write_service_status()

        assert firebase_section(path)['schedule_timezone'] == 'America/Los_Angeles'

    def test_opting_back_out_reaches_it_just_as_fast(self, tmp_path, monkeypatch):
        client = FakeFirebaseClient(site_timezone='America/Los_Angeles')
        service, path = make_service(tmp_path, monkeypatch, client)
        service._write_service_status()

        client.site_timezone = None
        service._write_service_status()

        assert firebase_section(path)['schedule_timezone'] == ''

    def test_an_unchanged_timezone_does_not_defeat_the_throttle(
        self, tmp_path, monkeypatch
    ):
        # Negative control for the two above: adding a field to the signature is
        # only correct if it still compares equal when nothing changed.
        client = FakeFirebaseClient(site_timezone='America/Los_Angeles')
        service, path = make_service(tmp_path, monkeypatch, client)
        service._write_service_status()

        path.unlink()
        service._write_service_status()

        # Nothing changed and the refresh floor has not elapsed, so the write is
        # skipped and the file is not recreated. Had the new field entered the
        # signature in a form that never compares equal to itself, the service
        # would rewrite this file every 5 seconds for the life of the machine.
        assert not path.exists()


class FakeSwoopManager:
    """Only what `_swoop_section` reads off SwoopManager.status()."""

    def __init__(self, viewers=0, controllers=0, indicator=None):
        self.viewers = viewers
        self.controllers = controllers
        self.indicator = indicator

    def status(self):
        streamer = {} if self.indicator is None else {'indicator': self.indicator}
        return {
            'state': 'running' if self.viewers else 'idle',
            'viewers': self.viewers,
            'controllers': self.controllers,
            'streamer': streamer,
        }


def swoop_section(path):
    with open(path) as handle:
        return json.load(handle)['swoop']


class TestSwoopSection:
    """`swoop` — the tray's live session row.

    The desktop app has no other way to know a session is running: it never
    talks to the cloud and never reads the streamer. `active` is capture, not
    the process — the streamer lingers for a minute after the last viewer
    leaves, and a badge that outlives the capture is exactly what the session
    indicator promises never happens.
    """

    def test_an_idle_machine_publishes_the_zero_shape(self, tmp_path, monkeypatch):
        service, path = make_service(tmp_path, monkeypatch, FakeFirebaseClient())
        service.swoop_manager = None

        service._write_service_status()

        assert swoop_section(path) == {
            'active': False, 'viewers': 0, 'controllers': 0,
            'since': 0, 'indicator': 'none',
        }

    def test_the_early_write_carries_the_same_shape(self, tmp_path, monkeypatch):
        # Written before swoop exists. Readers must never have to tell "key
        # absent" from "nobody is watching".
        service, path = make_service(tmp_path, monkeypatch, None)

        service._write_service_status_early()

        assert swoop_section(path) == {
            'active': False, 'viewers': 0, 'controllers': 0,
            'since': 0, 'indicator': 'none',
        }

    def test_a_live_session_counts_its_viewers(self, tmp_path, monkeypatch):
        service, path = make_service(tmp_path, monkeypatch, FakeFirebaseClient())
        service.swoop_manager = FakeSwoopManager(
            viewers=2, controllers=1, indicator='tray')

        service._write_service_status()

        section = swoop_section(path)
        assert section['active'] is True
        assert section['viewers'] == 2
        assert section['controllers'] == 1
        # The site's policy, as the streamer echoed it back from its bundle.
        assert section['indicator'] == 'tray'
        assert section['since'] > 0

    def test_a_session_start_forces_an_immediate_write(self, tmp_path, monkeypatch):
        # The load-bearing one. Writes are skipped for up to
        # MIN_STATUS_WRITE_INTERVAL unless the signature changed, so a session
        # left out of it would light the tray up to half a minute late.
        service, path = make_service(tmp_path, monkeypatch, FakeFirebaseClient())
        service.swoop_manager = FakeSwoopManager()
        service._write_service_status()
        assert swoop_section(path)['active'] is False

        service.swoop_manager.viewers = 1
        service.swoop_manager.indicator = 'tray'
        service._write_service_status()

        assert swoop_section(path)['active'] is True

    def test_a_session_end_forces_an_immediate_write(self, tmp_path, monkeypatch):
        service, path = make_service(tmp_path, monkeypatch, FakeFirebaseClient())
        service.swoop_manager = FakeSwoopManager(viewers=1, indicator='tray')
        service._write_service_status()
        assert swoop_section(path)['active'] is True

        service.swoop_manager.viewers = 0
        service._write_service_status()

        section = swoop_section(path)
        assert section['active'] is False
        # Zeroed with the badge: a stale start time on a cleared row would put
        # the tray's one-toast-per-session guard on the wrong session.
        assert section['since'] == 0

    def test_a_lingering_streamer_does_not_keep_the_badge_lit(
        self, tmp_path, monkeypatch
    ):
        # The streamer stays alive for 60s after the last viewer leaves. The
        # manager still reports a running state; capture has already stopped.
        service, path = make_service(tmp_path, monkeypatch, FakeFirebaseClient())
        manager = FakeSwoopManager(viewers=0, indicator='tray')
        manager.status = lambda: {
            'state': 'running', 'viewers': 0, 'controllers': 0,
            'streamer': {'indicator': 'tray'},
        }
        service.swoop_manager = manager

        service._write_service_status()

        assert swoop_section(path)['active'] is False

    def test_the_start_time_holds_still_across_writes(self, tmp_path, monkeypatch):
        service, path = make_service(tmp_path, monkeypatch, FakeFirebaseClient())
        service.swoop_manager = FakeSwoopManager(viewers=1, indicator='tray')
        service._write_service_status()
        since = swoop_section(path)['since']

        service.swoop_manager.viewers = 2
        service._write_service_status()

        # Same session: a moving start time would re-toast on every write.
        assert swoop_section(path)['since'] == since

    def test_an_unknown_indicator_is_not_published(self, tmp_path, monkeypatch):
        # The three the bundle can carry, and nothing else: the tray gates a
        # toast on this value.
        service, path = make_service(tmp_path, monkeypatch, FakeFirebaseClient())
        service.swoop_manager = FakeSwoopManager(viewers=1, indicator='everywhere')

        service._write_service_status()

        assert swoop_section(path)['indicator'] == 'none'

    def test_a_manager_that_cannot_answer_does_not_lose_the_write(
        self, tmp_path, monkeypatch
    ):
        service, path = make_service(tmp_path, monkeypatch, FakeFirebaseClient())
        manager = FakeSwoopManager()
        manager.status = lambda: (_ for _ in ()).throw(RuntimeError('wedged'))
        service.swoop_manager = manager

        service._write_service_status()

        assert swoop_section(path)['active'] is False
        assert firebase_section(path)['site_id'] == 'default_site'

    def test_an_idle_session_does_not_defeat_the_throttle(self, tmp_path, monkeypatch):
        # Negative control: the new signature fields must still compare equal
        # to themselves, or the service rewrites this file every 5 seconds.
        service, path = make_service(tmp_path, monkeypatch, FakeFirebaseClient())
        service.swoop_manager = FakeSwoopManager()
        service._write_service_status()

        path.unlink()
        service._write_service_status()

        assert not path.exists()


def stale_network_error():
    """The verdict TEC-B4A's boot-time probe recorded seconds before DHCP
    finished — the snapshot that used to outlive the condition it described."""
    return HealthState(
        status='network_error',
        error_code='network_error',
        error_message='Network not reachable at startup (host: dev.owlette.app).',
        checked_at=1_786_680_000,
    )


def make_wired_service(tmp_path, monkeypatch, manager_state):
    """A service + fake client whose connection manager starts in `manager_state`."""
    client = FakeFirebaseClient()
    client.connection_manager = FakeConnectionManager(manager_state)
    service, path = make_service(tmp_path, monkeypatch, client)
    service._connection_status_manager = None
    service._health_state = stale_network_error()
    return service, client.connection_manager, path


def health_section(path):
    with open(path) as handle:
        return json.load(handle)['health']


class TestHealthClearsOnConnect:
    """The connect-clears-health seam (TEC-B4A regression, 2026-08-17).

    Health fields are snapshots — the boot-time probe, or the last outage.
    A live connection disproves them, and the connection status listener is
    the one place both hosting paths and every re-init converge, so that is
    where the clear lives. Without it the tray flashed red for the machine's
    whole uptime while `firebase.connected` sat true in the same document.
    """

    def test_wiring_against_an_already_connected_manager_clears_the_stale_error(
        self, tmp_path, monkeypatch
    ):
        # The constructor connects before anything is listening, so the CONNECTED transition has
        # already happened by the time the listener is wired — how the cold-boot probe error
        # used to survive.
        service, _, path = make_wired_service(
            tmp_path, monkeypatch, ConnectionState.CONNECTED)

        service._wire_connection_status_listener()

        assert health_section(path)['status'] == 'ok'
        assert firebase_section(path)['connected'] is True

    def test_a_connected_transition_clears_the_outage_verdict(
        self, tmp_path, monkeypatch
    ):
        service, manager, path = make_wired_service(
            tmp_path, monkeypatch, ConnectionState.DISCONNECTED)
        service._wire_connection_status_listener()
        assert health_section(path)['status'] == 'network_error'

        manager.state = ConnectionState.CONNECTED
        for listener in manager.listeners:
            listener(SimpleNamespace(new_state=ConnectionState.CONNECTED))

        assert health_section(path)['status'] == 'ok'

    def test_a_disconnect_transition_leaves_the_error_standing(
        self, tmp_path, monkeypatch
    ):
        # Only a live connection is evidence. BACKOFF must not launder the
        # error the health callback just recorded.
        service, manager, path = make_wired_service(
            tmp_path, monkeypatch, ConnectionState.DISCONNECTED)
        service._wire_connection_status_listener()

        for listener in manager.listeners:
            listener(SimpleNamespace(new_state=ConnectionState.BACKOFF))

        assert health_section(path)['status'] == 'network_error'

    def test_wiring_while_disconnected_leaves_the_error_standing(
        self, tmp_path, monkeypatch
    ):
        # A re-init whose connect failed must keep its verdict — the old
        # unconditional clear after re-init stamped ok here regardless.
        service, _, path = make_wired_service(
            tmp_path, monkeypatch, ConnectionState.DISCONNECTED)

        service._wire_connection_status_listener()

        assert health_section(path)['status'] == 'network_error'
