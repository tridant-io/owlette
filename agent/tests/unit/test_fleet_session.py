"""
Unit tests for fleet_session: the keeper that exchanges the agent's own token
for this machine's fleet session and keeps the file its local MCP script reads
(ADR 0017).

The data root is a temp OWLETTE_DATA_ROOT, `requests.post` is a fake, and the
clock is the test's. Creating the folder with its DACL is acl_hardening's and
is replaced by a plain mkdir, so the same tests run on every platform; the
keeper's own platform gate is switched on for them.
"""

import json
import logging
import os
import sys
import threading
import time
from types import SimpleNamespace

import pytest
import requests

import acl_hardening
import fleet_session
from fleet_session import (
    MIN_ASK_GAP_SECONDS,
    NOT_GRANTED_SECONDS,
    REFRESH_SECONDS,
    RETRY_SECONDS,
    UNPAIRED_SECONDS,
    FleetSessionKeeper,
)

API_BASE = 'https://dev.owlette.app/api'
AGENT_TOKEN = 'agent-id-token-do-not-log'
START = 1_800_000_000.0


class FakeResponse:
    def __init__(self, status, body=None, text=None, headers=None):
        self.status_code = status
        self.headers = headers or {}
        self._body = body
        self._text = text

    def json(self):
        if self._text is not None:
            raise ValueError('not json')
        return self._body


def granted(token, expires_at):
    return FakeResponse(200, {'token': token, 'expiresAt': expires_at, 'ttlSeconds': 900})


def refused(status, code):
    return FakeResponse(status, {'type': 'about:blank', 'status': status, 'code': code})


class FakeApi:
    """`requests.post`, answering from a queue and recording every call."""

    def __init__(self):
        self.answers = []
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        answer = self.answers.pop(0)
        if callable(answer):
            answer = answer()
        if isinstance(answer, Exception):
            raise answer
        return answer


class Manager:
    def __init__(self, authenticated=True):
        self.authenticated = authenticated

    def is_authenticated(self):
        return self.authenticated

    def get_valid_token(self):
        return AGENT_TOKEN


class Clock:
    def __init__(self):
        self.now = START

    def __call__(self):
        return self.now


@pytest.fixture
def api(monkeypatch):
    fake = FakeApi()
    monkeypatch.setattr(requests, 'post', fake.post)
    return fake


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def client():
    return SimpleNamespace(auth_manager=Manager(), site_id='site-1', machine_id='kiosk-1')


@pytest.fixture
def keeper(tmp_path, monkeypatch, client, clock):
    monkeypatch.setenv('OWLETTE_DATA_ROOT', str(tmp_path))
    monkeypatch.setattr(fleet_session, '_SUPPORTED', True)
    # the dev api base, which the script's own check accepts
    monkeypatch.setattr(fleet_session.shared_utils, 'get_environment', lambda: 'development')
    monkeypatch.setattr(
        fleet_session, '_ensure_session_dir',
        lambda: os.makedirs(os.path.dirname(fleet_session.session_path()), exist_ok=True),
    )
    return FleetSessionKeeper(lambda: client, clock=clock)


def stored():
    """The session file's content, or None when there is no file."""
    try:
        with open(fleet_session.session_path(), encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def leave_a_file(content='{"token": "left-by-a-dead-run"}'):
    path = fleet_session.session_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)


def wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


# ----- the exchange and the file ----------------------------------------------

def test_a_granted_machine_gets_its_session_written_with_everything_the_script_needs(keeper, api, clock):
    api.answers = [granted('owf_first', START + 900)]

    keeper.refresh_once()

    assert stored() == {
        'token': 'owf_first',
        'expiresAt': START + 900,
        'apiBase': API_BASE,
        'siteId': 'site-1',
        'machineId': 'kiosk-1',
    }
    url, kwargs = api.calls[0]
    assert url == f'{API_BASE}/agent/fleet/session'
    assert kwargs == {'headers': {'Authorization': f'Bearer {AGENT_TOKEN}'}, 'timeout': 15}
    assert not os.path.exists(fleet_session.session_path() + '.tmp')


def test_it_asks_again_only_when_the_interval_is_up_and_then_rotates_the_file(keeper, api, clock):
    api.answers = [granted('owf_first', START + 900), granted('owf_second', START + 1500)]
    keeper.refresh_once()

    clock.now = START + REFRESH_SECONDS - 1
    keeper.refresh_once()
    assert len(api.calls) == 1
    assert stored()['token'] == 'owf_first'

    clock.now = START + REFRESH_SECONDS
    keeper.refresh_once()
    assert len(api.calls) == 2
    assert stored()['token'] == 'owf_second'


@pytest.mark.parametrize('status, code', [(403, 'fleet_not_granted'), (401, 'pairing_revoked')])
def test_a_refusal_deletes_the_file_and_is_asked_again_in_an_hour(keeper, api, clock, status, code):
    api.answers = [granted('owf_first', START + 900), refused(status, code), refused(status, code)]
    keeper.refresh_once()
    clock.now = START + REFRESH_SECONDS

    keeper.refresh_once()

    assert stored() is None
    clock.now += NOT_GRANTED_SECONDS - 1
    keeper.refresh_once()
    assert len(api.calls) == 2
    clock.now += 1
    keeper.refresh_once()
    assert len(api.calls) == 3


def test_a_settings_change_makes_an_ungranted_machine_ask_at_once(keeper, api, clock):
    api.answers = [refused(403, 'fleet_not_granted'), granted('owf_now_granted', START + 960)]
    keeper.refresh_once()
    assert stored() is None

    clock.now = START + 60
    keeper.request_refresh()
    keeper.refresh_once()

    assert stored()['token'] == 'owf_now_granted'


def test_settings_changes_never_make_it_ask_twice_inside_a_minute(keeper, api, clock):
    # the command reaches every machine of a site, most of which hold no grant
    api.answers = [refused(403, 'fleet_not_granted'), refused(403, 'fleet_not_granted')]
    keeper.refresh_once()

    clock.now = START + MIN_ASK_GAP_SECONDS - 1
    keeper.request_refresh()
    keeper.request_refresh()
    keeper.refresh_once()
    assert len(api.calls) == 1

    clock.now = START + MIN_ASK_GAP_SECONDS
    keeper.refresh_once()
    assert len(api.calls) == 2


def test_a_request_never_pushes_back_an_ask_that_is_already_due(keeper, api, clock):
    api.answers = [requests.ConnectionError('down'), granted('owf_first', START + 900)]
    keeper.refresh_once()
    keeper.withdraw()

    keeper.request_refresh()
    keeper.refresh_once()

    assert stored()['token'] == 'owf_first'


def test_the_worst_case_stays_under_the_routes_thirty_calls_an_hour(keeper, api, clock):
    api.answers = [FakeResponse(500, {})] * 100

    while clock.now < START + 3600:
        keeper.refresh_once()
        clock.now += 5

    assert len(api.calls) <= 24


def test_a_network_error_keeps_the_session_until_it_runs_out_then_deletes_it(keeper, api, clock):
    api.answers = [
        granted('owf_first', START + 900),
        requests.ConnectionError('down'),
        requests.ConnectionError('down'),
        requests.ConnectionError('down'),
    ]
    keeper.refresh_once()

    clock.now = START + REFRESH_SECONDS
    keeper.refresh_once()
    assert stored()['token'] == 'owf_first'

    # not asked again before the retry is due
    clock.now += RETRY_SECONDS - 1
    keeper.refresh_once()
    assert len(api.calls) == 2

    clock.now += 1
    keeper.refresh_once()
    assert len(api.calls) == 3
    assert stored()['token'] == 'owf_first'

    clock.now = START + 900
    keeper.refresh_once()
    assert stored() is None


def test_an_expired_session_is_deleted_even_when_no_refresh_is_due(keeper, api, clock):
    api.answers = [granted('owf_short', START + 300)]
    keeper.refresh_once()

    clock.now = START + 300
    keeper.refresh_once()

    assert len(api.calls) == 1
    assert stored() is None


def test_a_429_waits_out_a_whole_interval(keeper, api, clock):
    api.answers = [refused(429, 'rate_limited'), granted('owf_later', START + 1500)]
    keeper.refresh_once()

    clock.now = START + REFRESH_SECONDS - 1
    keeper.refresh_once()
    assert len(api.calls) == 1

    clock.now = START + REFRESH_SECONDS
    keeper.refresh_once()
    assert stored()['token'] == 'owf_later'


@pytest.mark.parametrize('retry_after, waits', [
    ('1800', 1800),
    # never sooner than a retry, never later than the hourly ask
    ('5', RETRY_SECONDS),
    ('86400', NOT_GRANTED_SECONDS),
    ('soon', REFRESH_SECONDS),
])
def test_a_429_waits_as_long_as_the_server_says(keeper, api, clock, retry_after, waits):
    api.answers = [
        FakeResponse(429, {'code': 'rate_limited'}, headers={'Retry-After': retry_after}),
        granted('owf_later', START + waits + 900),
    ]
    keeper.refresh_once()

    clock.now = START + waits - 1
    keeper.refresh_once()
    assert len(api.calls) == 1

    clock.now = START + waits
    keeper.refresh_once()
    assert stored()['token'] == 'owf_later'


def test_a_server_error_that_is_not_json_is_retried_soon(keeper, api, clock):
    api.answers = [FakeResponse(502, text='<html>bad gateway</html>'), granted('owf_later', START + 1020)]
    keeper.refresh_once()
    assert stored() is None

    clock.now = START + RETRY_SECONDS
    keeper.refresh_once()

    assert stored()['token'] == 'owf_later'


@pytest.mark.parametrize('body', [
    {'expiresAt': START + 900},
    {'token': '', 'expiresAt': START + 900},
    {'token': 'owf_x'},
    {'token': 'owf_x', 'expiresAt': 'soon'},
    {'token': 'owf_x', 'expiresAt': True},
    {'token': 'owf_x', 'expiresAt': START},
    ['owf_x'],
])
def test_a_200_that_is_no_session_writes_nothing(keeper, api, body):
    api.answers = [FakeResponse(200, body)]

    keeper.refresh_once()

    assert stored() is None


def test_an_unpaired_machine_asks_nothing_and_looks_again_soon(keeper, api, clock, client):
    client.auth_manager.authenticated = False
    leave_a_file()

    keeper.refresh_once()

    assert api.calls == []
    assert stored() is None
    client.auth_manager.authenticated = True
    api.answers = [granted('owf_paired', START + 930)]
    clock.now = START + UNPAIRED_SECONDS
    keeper.refresh_once()
    assert stored()['token'] == 'owf_paired'


def test_no_client_yet_is_the_same_as_unpaired(tmp_path, monkeypatch, api, clock):
    monkeypatch.setenv('OWLETTE_DATA_ROOT', str(tmp_path))
    monkeypatch.setattr(fleet_session, '_SUPPORTED', True)

    FleetSessionKeeper(lambda: None, clock=clock).refresh_once()

    assert api.calls == []


# ----- a file left by a run that died ------------------------------------------

def test_constructing_a_keeper_touches_no_file(keeper):
    leave_a_file()

    FleetSessionKeeper(lambda: None)

    assert stored() == {'token': 'left-by-a-dead-run'}


def test_a_leftover_file_is_replaced_by_the_first_session(keeper, api):
    leave_a_file()
    api.answers = [granted('owf_first', START + 900)]

    keeper.refresh_once()

    assert stored()['token'] == 'owf_first'


@pytest.mark.parametrize('answer', [
    refused(403, 'fleet_not_granted'),
    requests.Timeout('slow'),
    FakeResponse(500, {}),
])
def test_a_leftover_file_is_deleted_when_the_first_pass_gets_no_session(keeper, api, answer):
    leave_a_file()
    api.answers = [answer]

    keeper.refresh_once()

    assert stored() is None


# ----- the write, and a withdrawal ----------------------------------------------

def test_a_refused_write_is_finished_on_the_next_pass_without_asking_again(keeper, api, monkeypatch):
    api.answers = [granted('owf_first', START + 900)]
    real_replace = os.replace
    refusals = [PermissionError(13, 'the script has it open')]

    def replace(src, dst):
        if refusals:
            raise refusals.pop()
        real_replace(src, dst)

    monkeypatch.setattr(fleet_session.os, 'replace', replace)
    ensured = []

    def ensure():
        ensured.append(1)
        os.makedirs(os.path.dirname(fleet_session.session_path()), exist_ok=True)

    monkeypatch.setattr(fleet_session, '_ensure_session_dir', ensure)

    keeper.refresh_once()
    assert stored() is None
    # no half-written copy waits on disk with a live session in it
    assert not os.path.exists(fleet_session.session_path() + '.tmp')

    keeper.refresh_once()
    assert stored()['token'] == 'owf_first'
    assert len(api.calls) == 1
    # the folder is looked at again after a failed write: it may be what went
    assert len(ensured) == 2


def test_a_session_the_file_never_took_is_dropped_once_it_runs_out(keeper, api, clock, monkeypatch):
    api.answers = [granted('owf_first', START + 900), granted('owf_second', START + 1800)]
    real_replace = os.replace
    held = [True]

    def replace(src, dst):
        if held[0]:
            raise PermissionError(13, 'the script has it open')
        real_replace(src, dst)

    monkeypatch.setattr(fleet_session.os, 'replace', replace)
    keeper.refresh_once()

    held[0] = False
    clock.now = START + 900
    keeper.refresh_once()

    assert len(api.calls) == 2
    assert stored()['token'] == 'owf_second'


def test_a_folder_that_is_not_the_services_stops_the_retries_for_an_hour(keeper, api, clock, monkeypatch):
    def untrusted():
        raise acl_hardening.UntrustedDirectory('refusing to use existing untrusted directory')

    monkeypatch.setattr(fleet_session, '_ensure_session_dir', untrusted)
    api.answers = [granted('owf_first', START + 900), granted('owf_second', START + 4500)]

    keeper.refresh_once()
    assert stored() is None

    clock.now = START + NOT_GRANTED_SECONDS - 1
    keeper.refresh_once()
    assert len(api.calls) == 1


def test_withdraw_deletes_the_file_and_a_half_written_copy(keeper, api):
    api.answers = [granted('owf_first', START + 900)]
    keeper.refresh_once()
    with open(fleet_session.session_path() + '.tmp', 'w', encoding='utf-8') as f:
        f.write('{"token": "half-written"}')

    keeper.withdraw()

    assert stored() is None
    assert not os.path.exists(fleet_session.session_path() + '.tmp')


def test_a_refresh_in_flight_cannot_put_the_file_back_after_a_withdrawal(keeper, api):
    def answered_after_the_machine_left():
        keeper.withdraw()
        return granted('owf_too_late', START + 900)

    api.answers = [answered_after_the_machine_left, granted('owf_after_a_re_pair', START + 900)]

    keeper.refresh_once()
    assert stored() is None

    # and the keeper asks again at once, for a machine that paired straight back
    keeper.refresh_once()
    assert stored()['token'] == 'owf_after_a_re_pair'


def test_withdraw_does_nothing_where_the_keeper_is_not_supported(keeper, monkeypatch):
    leave_a_file()
    monkeypatch.setattr(fleet_session, '_SUPPORTED', False)

    keeper.withdraw()

    assert stored() == {'token': 'left-by-a-dead-run'}


# ----- tick: the loop's side -----------------------------------------------------

def test_tick_starts_one_worker_at_a_time(keeper, api):
    gate = threading.Event()

    def held():
        gate.wait(5)
        return granted('owf_first', START + 900)

    api.answers = [held]

    keeper.tick()
    assert wait_for(lambda: len(api.calls) == 1)
    first = keeper._thread
    keeper.tick()
    keeper.tick()

    assert keeper._thread is first
    assert first.daemon
    gate.set()
    first.join(5)
    assert stored()['token'] == 'owf_first'
    assert len(api.calls) == 1


def test_tick_starts_nothing_while_nothing_is_due(keeper, api, clock):
    api.answers = [granted('owf_first', START + 900)]
    keeper.refresh_once()
    keeper._thread = None

    clock.now = START + REFRESH_SECONDS - 1
    keeper.tick()

    assert keeper._thread is None


def test_tick_does_nothing_where_the_keeper_is_not_supported(keeper, api, monkeypatch):
    monkeypatch.setattr(fleet_session, '_SUPPORTED', False)

    keeper.tick()

    assert keeper._thread is None
    assert api.calls == []


def test_a_request_that_lands_during_a_pass_buys_one_more(keeper, api, clock):
    gate = threading.Event()

    def held():
        gate.wait(5)
        return refused(403, 'fleet_not_granted')

    api.answers = [held, granted('owf_granted_meanwhile', START + 900)]

    keeper.tick()
    assert wait_for(lambda: len(api.calls) == 1)
    keeper.request_refresh()
    gate.set()
    keeper._thread.join(5)
    assert stored() is None

    clock.now = START + MIN_ASK_GAP_SECONDS
    keeper.tick()
    keeper._thread.join(5)

    assert stored()['token'] == 'owf_granted_meanwhile'


def test_a_worker_that_raises_ends_and_names_only_the_error_type(keeper, monkeypatch, caplog):
    caplog.set_level(logging.WARNING)

    def boom(now, epoch):
        raise RuntimeError(f'unexpected, with {AGENT_TOKEN} in it')

    monkeypatch.setattr(keeper, '_fetch', boom)

    keeper.tick()
    keeper._thread.join(5)

    assert not keeper._thread.is_alive()
    assert 'refresh failed (RuntimeError)' in caplog.text
    assert AGENT_TOKEN not in caplog.text


# ----- never the token ------------------------------------------------------------

def test_neither_token_reaches_a_log_line(keeper, api, clock, caplog, monkeypatch):
    caplog.set_level(logging.DEBUG)
    api.answers = [
        granted('owf_secret_session', START + 900),
        # requests quotes the header it refuses
        requests.exceptions.InvalidHeader(f"Invalid header value 'Bearer {AGENT_TOKEN}'"),
        FakeResponse(500, {'detail': 'owf_secret_session'}),
        refused(403, 'fleet_not_granted'),
    ]

    keeper.refresh_once()
    for _ in range(3):
        clock.now += NOT_GRANTED_SECONDS
        keeper.refresh_once()

    assert len(api.calls) == 4
    assert caplog.records
    assert AGENT_TOKEN not in caplog.text
    assert 'owf_secret_session' not in caplog.text


def test_an_unchanged_failure_is_logged_once(keeper, api, clock, caplog):
    caplog.set_level(logging.WARNING)
    api.answers = [requests.ConnectionError('down')] * 3

    for _ in range(3):
        keeper.refresh_once()
        clock.now += RETRY_SECONDS

    assert len([r for r in caplog.records if 'could not refresh' in r.getMessage()]) == 1


# ----- the folder, and the script's side of the contract ---------------------------

def test_the_folder_is_created_with_the_row_the_acl_table_gives_it(tmp_path, monkeypatch):
    monkeypatch.setenv('OWLETTE_DATA_ROOT', str(tmp_path))
    folder = os.path.dirname(fleet_session.session_path())
    aces = [('sid', 1, 2)]
    created = []
    monkeypatch.setattr(
        acl_hardening, 'specs',
        lambda: [SimpleNamespace(path=os.path.join(str(tmp_path), 'other'), aces=[]),
                 SimpleNamespace(path=folder, aces=aces)],
    )
    monkeypatch.setattr(acl_hardening, 'create_private_dir', lambda path, spec: created.append((path, spec)))

    fleet_session._ensure_session_dir()

    assert created == [(folder, aces)]


def test_the_script_reads_what_the_keeper_writes(keeper, api, monkeypatch):
    pytest.importorskip('mcp')
    import fleet_mcp

    assert fleet_mcp.session_path() == fleet_session.session_path()
    now = time.time()
    keeper._clock = lambda: now
    api.answers = [granted('owf_round_trip', int(now) + 900)]

    keeper.refresh_once()

    session, why = fleet_mcp.read_session()
    assert why is None
    assert session == {
        'token': 'owf_round_trip',
        'expiresAt': int(now) + 900,
        'apiBase': API_BASE,
        'siteId': 'site-1',
        'machineId': 'kiosk-1',
    }


def test_the_keeper_is_windows_only_for_now():
    assert fleet_session._SUPPORTED == (sys.platform == 'win32')


# ----- the service's side ----------------------------------------------------------

def test_the_service_makes_the_keeper_in_main_ticks_it_on_the_loop_and_withdraws_it():
    # imported inside the test, as elsewhere in this suite. main() and not
    # __init__: owlette_runner never runs __init__.
    import inspect

    from owlette_service import OwletteService

    main = inspect.getsource(OwletteService.main)
    assert 'self.fleet_session = fleet_session.FleetSessionKeeper(' in main
    assert 'self.fleet_session.tick()' in main
    assert 'self.fleet_session.withdraw()' in inspect.getsource(OwletteService.unpair)
    assert 'self.fleet_session.withdraw()' in inspect.getsource(OwletteService.graceful_shutdown)
