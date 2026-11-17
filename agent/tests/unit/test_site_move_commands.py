"""
Unit tests for site_move_commands — the agent following a move to another site.

These pin the agent's side of the move: a refusal changes nothing, hoot and the
fleet session end before the new site's credentials are written, the switch
defers its command, the rebuilt client confirms and clears the move, and
`reconcile` finishes a switch a crash cut short without overriding a later
pairing. owlette_service is imported inside the tests, as elsewhere in this
suite, so collection order cannot double-initialise the cryptography bindings.
"""

import inspect
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
import requests

import site_move_commands
from command_router import COMMAND_DEFERRED, CommandRouter
from connection_manager import ConnectionState
from site_move_commands import (
    confirm_if_switched, confirm_on_connect, follow_in_background, follow_move,
    handle_site_move, reconcile, register_handlers,
)

API = 'https://dev.owlette.app/api'
MOVE_ID = 'test-site:machine-1'
MOVED = {
    'accessToken': 'dummy-target-access',
    'refreshToken': 'dummy-target-refresh',
    'expiresIn': 3600,
    'siteId': 'site-b',
}
SWITCHED = {'moveId': MOVE_ID, 'phase': 'switched', 'source': 'test-site', 'target': 'site-b'}


class FakeStorage:
    """The token store's slice the move touches, with save_credentials'
    semantics: one write, and no move given drops a stored one."""

    def __init__(self, calls, site_id='test-site', move=None):
        self.calls = calls
        self.saves_ok = True
        self.data = {
            'refresh_token': 'dummy-source-refresh',
            'access_token': 'dummy-source-access',
            'token_expiry': 1.0,
            'site_id': site_id,
        }
        if move is not None:
            self.data['move'] = dict(move)

    def get_refresh_token(self):
        return self.data.get('refresh_token')

    def get_site_id(self):
        return self.data.get('site_id')

    def get_move(self):
        return self.data.get('move')

    def save_credentials(self, refresh_token, access_token, expiry, site_id, move=None):
        self.calls.append('save_credentials')
        if not self.saves_ok:
            return False
        self.data.update(refresh_token=refresh_token, access_token=access_token,
                         token_expiry=expiry, site_id=site_id)
        if move is None:
            self.data.pop('move', None)
        else:
            self.data['move'] = dict(move)
        return True

    def clear_move(self):
        self.calls.append('clear_move')
        self.data.pop('move', None)
        return True


def _response(status, body=None):
    response = MagicMock()
    response.status_code = status
    response.json.return_value = {} if body is None else body
    return response


class FakeAuth:
    """AuthManager's slice the move touches. Its two move writes reach the
    store as the real ones do; that they hold the refresh lock is pinned in
    test_auth_manager.py."""

    api_base = API
    machine_id = 'machine-1'

    def __init__(self, storage):
        self.storage = storage

    def adopt_move_credentials(self, refresh_token, access_token, expiry, site_id, move):
        return self.storage.save_credentials(refresh_token, access_token, expiry, site_id, move=move)

    def finish_move(self):
        return self.storage.clear_move()

    def get_valid_token(self):
        return 'dummy-target-access'


def _client(storage, site_id='test-site'):
    return SimpleNamespace(auth_manager=FakeAuth(storage), site_id=site_id)


def _service(storage, calls):
    return SimpleNamespace(
        firebase_client=_client(storage),
        end_hoot=lambda why, wait=False: calls.append(('end_hoot', wait)),
        fleet_session=SimpleNamespace(
            withdraw=lambda forget=False: calls.append(('withdraw_fleet_session', forget))),
    )


@pytest.fixture
def calls():
    return []


@pytest.fixture
def config(mock_config, calls, monkeypatch):
    """config.json as conftest's mock_config, read and written in place."""

    def read_config(keys=None, process_list_id=None):
        item = mock_config
        for key in keys or []:
            item = item.get(key) if isinstance(item, dict) else None
        return item

    def write_config(keys, value):
        calls.append('write_config')
        item = mock_config
        for key in keys[:-1]:
            item = item.setdefault(key, {})
        item[keys[-1]] = value

    monkeypatch.setattr(site_move_commands.shared_utils, 'read_config', read_config)
    monkeypatch.setattr(site_move_commands.shared_utils, 'write_config', write_config)
    monkeypatch.setattr(site_move_commands.configure_site, '_drop_cloud_cache',
                        lambda: calls.append('drop_cloud_cache'))
    monkeypatch.setattr(site_move_commands, 'CONFIG_WRITE_RETRY_SECONDS', 0)
    site_move_commands._reconcile_due.clear()
    yield mock_config
    site_move_commands._reconcile_due.clear()


# registration

def test_register_handlers_registers_site_move():
    router = CommandRouter()
    register_handlers(router)
    assert router.registered_types() == ['site_move']


def test_init_registers_the_site_move_handlers():
    from owlette_service import OwletteService

    source = inspect.getsource(OwletteService._init_state)
    assert 'from site_move_commands import register_handlers' in source
    assert '_register_site_move_handlers(self._command_router)' in source
    assert 'Failed to register site move handlers' in source


# a refusal changes nothing

@pytest.mark.parametrize('status', [404, 409, 410, 402, 401, 403, 500])
def test_a_refusal_leaves_every_piece_of_state_alone(status, calls, config):
    storage = FakeStorage(calls)
    before = dict(storage.data)
    service = _service(storage, calls)

    with patch('site_move_commands.requests.post',
               return_value=_response(status, {'error': 'refused for the test'})):
        result = follow_move(service, MOVE_ID)

    assert result.startswith('Error:')
    assert f'HTTP {status}' in result
    assert 'refused for the test' in result
    # hoot, the fleet session, the token store, config.json and the cache untouched
    assert calls == []
    assert storage.data == before
    assert config['firebase']['site_id'] == 'test-site'


def test_a_server_that_cannot_be_reached_changes_nothing(calls, config):
    storage = FakeStorage(calls)
    before = dict(storage.data)

    with patch('site_move_commands.requests.post',
               side_effect=requests.exceptions.ConnectionError('offline')):
        result = follow_move(_service(storage, calls), MOVE_ID)

    assert result.startswith('Error: could not reach the server')
    assert calls == []
    assert storage.data == before
    assert config['firebase']['site_id'] == 'test-site'


def test_an_answer_without_the_new_sites_credentials_changes_nothing(calls, config):
    storage = FakeStorage(calls)
    before = dict(storage.data)

    with patch('site_move_commands.requests.post',
               return_value=_response(200, {**MOVED, 'siteId': None})):
        result = follow_move(_service(storage, calls), MOVE_ID)

    assert result.startswith('Error:')
    assert calls == []
    assert storage.data == before


def test_credentials_that_could_not_be_saved_leave_config_alone(calls, config):
    storage = FakeStorage(calls)
    storage.saves_ok = False

    with patch('site_move_commands.requests.post', return_value=_response(200, MOVED)):
        result = follow_move(_service(storage, calls), MOVE_ID)

    assert result.startswith('Error:')
    assert 'write_config' not in calls
    assert storage.get_site_id() == 'test-site'
    assert storage.get_move() is None
    assert config['firebase']['site_id'] == 'test-site'


# the switch

def test_the_request_carries_the_stored_credential_machine_and_move(calls, config):
    storage = FakeStorage(calls)

    with patch('site_move_commands.requests.post', return_value=_response(200, MOVED)) as post:
        follow_move(_service(storage, calls), MOVE_ID)

    post.assert_called_once()
    assert post.call_args.args[0] == f'{API}/agent/auth/move'
    assert post.call_args.kwargs['json'] == {
        'refreshToken': 'dummy-source-refresh',
        'machineId': 'machine-1',
        'moveId': MOVE_ID,
    }
    assert post.call_args.kwargs['timeout'] > 0
    assert post.call_args.kwargs['headers']['User-Agent'].startswith('Owlette-Agent/')


def test_hoot_and_the_fleet_session_end_before_the_credentials_are_written(calls, config):
    # off windows hoot answers its end with an `offline` write on the old
    # site's token, which must go out before the switch
    storage = FakeStorage(calls)

    with patch('site_move_commands.requests.post', return_value=_response(200, MOVED)):
        result = follow_move(_service(storage, calls), MOVE_ID)

    assert result is COMMAND_DEFERRED
    assert calls == [
        ('end_hoot', True),
        ('withdraw_fleet_session', True),
        'save_credentials',
        'write_config', 'drop_cloud_cache',
    ]


def test_the_switch_stores_the_new_sites_credentials_and_the_move_in_one_write(calls, config):
    storage = FakeStorage(calls)

    with patch('site_move_commands.requests.post', return_value=_response(200, MOVED)):
        follow_move(_service(storage, calls), MOVE_ID)

    assert calls.count('save_credentials') == 1
    assert storage.get_refresh_token() == 'dummy-target-refresh'
    assert storage.data['access_token'] == 'dummy-target-access'
    assert storage.get_site_id() == 'site-b'
    assert storage.get_move() == SWITCHED
    assert config['firebase']['site_id'] == 'site-b'


def test_the_command_is_deferred_once_switched(calls, config):
    # its completion would be written on the site the machine just left
    storage = FakeStorage(calls)
    router = CommandRouter()
    register_handlers(router)

    with patch('site_move_commands.requests.post', return_value=_response(200, MOVED)):
        result = router.dispatch(
            'site_move', {'type': 'site_move', 'moveId': MOVE_ID}, 'cmd-1', _service(storage, calls))

    assert result is COMMAND_DEFERRED


def test_a_locked_config_is_asked_again_until_the_write_lands(calls, config, monkeypatch):
    # an editor or a scan holding config.json is usually gone in moments
    storage = FakeStorage(calls)
    write_config = site_move_commands.shared_utils.write_config
    attempts = []

    def locked_twice(keys, value):
        attempts.append(value)
        if len(attempts) < 3:
            raise OSError('config.json exists but could not be read')
        write_config(keys, value)

    monkeypatch.setattr(site_move_commands.shared_utils, 'write_config', locked_twice)
    with patch('site_move_commands.requests.post', return_value=_response(200, MOVED)):
        result = follow_move(_service(storage, calls), MOVE_ID)

    assert result is COMMAND_DEFERRED
    assert attempts == ['site-b'] * 3
    assert config['firebase']['site_id'] == 'site-b'
    assert not site_move_commands.reconcile_due()


def test_a_config_write_that_keeps_failing_defers_and_leaves_the_switch_to_the_main_loop(
        calls, config, monkeypatch):
    # the old client keeps the old site while auth holds the new site's
    # token, and the old site refuses its writes: nothing short of the
    # config write ends that
    storage = FakeStorage(calls)
    write_config = site_move_commands.shared_utils.write_config
    attempts = []

    def unreadable(keys, value):
        attempts.append(value)
        raise OSError('config.json exists but could not be read')

    monkeypatch.setattr(site_move_commands.shared_utils, 'write_config', unreadable)
    with patch('site_move_commands.requests.post', return_value=_response(200, MOVED)):
        result = follow_move(_service(storage, calls), MOVE_ID)

    assert result is COMMAND_DEFERRED
    assert len(attempts) == site_move_commands.CONFIG_WRITE_ATTEMPTS > 1
    assert storage.get_move() == SWITCHED
    assert config['firebase']['site_id'] == 'test-site'
    assert site_move_commands.reconcile_due()

    # the main loop's next site check, with the file free again
    monkeypatch.setattr(site_move_commands.shared_utils, 'write_config', write_config)
    with patch('secure_storage.get_storage', return_value=storage):
        reconcile()

    assert config['firebase']['site_id'] == 'site-b'
    assert not site_move_commands.reconcile_due()


def test_a_reconcile_that_fails_stays_due_until_it_lands(calls, config, monkeypatch):
    storage = FakeStorage(calls, site_id='site-b', move=SWITCHED)
    write_config = site_move_commands.shared_utils.write_config

    def unreadable(keys, value):
        raise OSError('config.json exists but could not be read')

    monkeypatch.setattr(site_move_commands.shared_utils, 'write_config', unreadable)
    with patch('secure_storage.get_storage', return_value=storage):
        reconcile()
        assert site_move_commands.reconcile_due()

        monkeypatch.setattr(site_move_commands.shared_utils, 'write_config', write_config)
        reconcile()

    assert config['firebase']['site_id'] == 'site-b'
    assert not site_move_commands.reconcile_due()


def test_a_reconcile_with_nothing_to_finish_is_no_longer_due(calls, config):
    site_move_commands._reconcile_due.set()

    with patch('secure_storage.get_storage', return_value=FakeStorage(calls)):
        reconcile()

    assert not site_move_commands.reconcile_due()


def test_a_move_already_followed_is_not_fetched_again(calls, config):
    # the old site's client keeps projecting the move until the rebuild
    storage = FakeStorage(calls, site_id='site-b', move=SWITCHED)

    with patch('site_move_commands.requests.post') as post:
        result = follow_move(_service(storage, calls), MOVE_ID)

    assert result is COMMAND_DEFERRED
    post.assert_not_called()
    assert calls == []


def test_one_follow_runs_at_a_time(calls, config):
    storage = FakeStorage(calls)

    with site_move_commands._follow_lock, \
         patch('site_move_commands.requests.post') as post:
        result = follow_move(_service(storage, calls), MOVE_ID)

    assert result is COMMAND_DEFERRED
    post.assert_not_called()


def test_a_command_without_a_move_id_is_refused():
    assert handle_site_move({'type': 'site_move'}, 'cmd-1', SimpleNamespace()).startswith('Error:')


def test_without_a_cloud_client_the_follow_fails_rather_than_guesses():
    assert follow_move(SimpleNamespace(firebase_client=None), MOVE_ID).startswith('Error:')


def test_the_move_callback_returns_at_once_and_follows_on_its_own_thread():
    # it runs inline on the thread that read the site projection
    started = threading.Event()
    release = threading.Event()
    seen = []

    def follow(service, move_id):
        seen.append((service, move_id, threading.current_thread().name))
        started.set()
        release.wait(5)

    service = SimpleNamespace()
    with patch('site_move_commands.follow_move', side_effect=follow):
        follow_in_background(service, MOVE_ID)
        assert started.wait(5)
        release.set()

    assert seen == [(service, MOVE_ID, 'site-move')]


# the confirm

def _switched_client(calls, move=SWITCHED, site_id='site-b'):
    return _client(FakeStorage(calls, site_id='site-b', move=move), site_id=site_id)


def test_the_confirm_posts_the_new_sites_credential_and_clears_the_move(calls):
    client = _switched_client(calls)

    with patch('site_move_commands.requests.post', return_value=_response(200)) as post:
        confirm_if_switched(client)

    post.assert_called_once()
    assert post.call_args.args[0] == f'{API}/agent/auth/move/confirm'
    assert post.call_args.kwargs['json'] == {'machineId': 'machine-1', 'moveId': MOVE_ID}
    assert post.call_args.kwargs['headers']['Authorization'] == 'Bearer dummy-target-access'
    assert client.auth_manager.storage.get_move() is None


def test_a_confirm_the_server_has_no_move_for_counts_as_done(calls):
    # a lost 200, a cancel, or a removal
    client = _switched_client(calls)

    with patch('site_move_commands.requests.post', return_value=_response(404)):
        confirm_if_switched(client)

    assert client.auth_manager.storage.get_move() is None


@pytest.mark.parametrize('status', [400, 401, 403, 409, 500])
def test_a_refused_confirm_keeps_the_move_for_the_next_connect(status, calls):
    client = _switched_client(calls)

    with patch('site_move_commands.requests.post',
               return_value=_response(status, {'code': 'move_not_switching'})):
        confirm_if_switched(client)

    assert client.auth_manager.storage.get_move() == SWITCHED
    assert 'clear_move' not in calls


def test_a_confirm_that_could_not_be_sent_keeps_the_move(calls):
    client = _switched_client(calls)

    with patch('site_move_commands.requests.post',
               side_effect=requests.exceptions.ConnectionError('offline')):
        confirm_if_switched(client)

    assert client.auth_manager.storage.get_move() == SWITCHED


@pytest.mark.parametrize('move, site_id', [
    (None, 'site-b'),
    (SWITCHED, 'test-site'),
    ({**SWITCHED, 'phase': 'fetching'}, 'site-b'),
])
def test_only_a_switched_move_to_the_clients_site_is_confirmed(move, site_id, calls):
    client = _switched_client(calls, move=move, site_id=site_id)

    with patch('site_move_commands.requests.post') as post:
        confirm_if_switched(client)

    post.assert_not_called()


def test_a_refresh_during_the_confirms_clear_keeps_the_rotated_refresh_token(tmp_path, monkeypatch):
    # clearing the move rewrites the whole store: a refresh that saved a
    # rotated refresh token between that read and write would be lost, and
    # once the server's grace passed the next refresh would unpair the machine
    import auth_manager
    import osadapter
    import secure_storage

    monkeypatch.setattr(osadapter, '_adapter', SimpleNamespace(
        key_material=lambda: b'dummy-machine-binding',
        stable_machine_id=lambda: 'dummy-machine-binding',
    ))
    store = secure_storage.SecureStorage(config_dir=tmp_path)
    assert store.save_credentials('dummy-target-refresh', 'dummy-target-access',
                                  time.time() + 3600, 'site-b', move=SWITCHED)
    auth = auth_manager.AuthManager(api_base=API, machine_id='machine-1', storage=store)
    client = SimpleNamespace(auth_manager=auth, site_id='site-b')

    def post(url, **kwargs):
        if url.endswith('/agent/auth/refresh'):
            return _response(200, {'accessToken': 'dummy-rotated-access', 'expiresIn': 3600,
                                   'refreshToken': 'dummy-rotated-refresh'})
        return _response(200)

    confirming = threading.current_thread()
    refresh = threading.Thread(target=auth.refresh_now, name='refresh')
    real_save = store._save_data

    def save(data):
        if threading.current_thread() is confirming and not refresh.is_alive() and 'move' not in data:
            # the clear has read the store and is about to write it back
            refresh.start()
            refresh.join(0.3)
        return real_save(data)

    monkeypatch.setattr(store, '_save_data', save)
    with patch('requests.post', side_effect=post):
        confirm_if_switched(client)
        refresh.join(5)

    assert not refresh.is_alive()
    assert store.get_refresh_token() == 'dummy-rotated-refresh'
    assert store.get_move() is None


def test_the_move_ends_hoot_only_through_the_service():
    # end_hoot holds off the main loop's relaunch while the site switches
    source = inspect.getsource(site_move_commands)

    assert 'service.end_hoot(' in source
    assert '_is_cortex_alive' not in source
    assert 'cortex_pid' not in source


def test_the_move_writes_the_store_only_through_the_auth_managers_methods():
    # its refresh lock is the auth manager's own; the move never takes it itself
    source = inspect.getsource(site_move_commands)

    assert '_refresh_lock' not in source
    assert 'storage.save_credentials' not in source
    assert 'storage.clear_move' not in source


class FakeManager:
    def __init__(self, state):
        self.state = state
        self.listeners = []

    def add_state_listener(self, listener):
        self.listeners.append(listener)


def _join_confirms():
    for thread in threading.enumerate():
        if thread.name == 'site-move-confirm':
            thread.join(5)


def test_a_client_already_connected_confirms_at_once():
    # the client connects in its constructor, before any listener exists
    manager = FakeManager(ConnectionState.CONNECTED)

    with patch('site_move_commands.confirm_if_switched') as confirm:
        confirm_on_connect(SimpleNamespace(connection_manager=manager))
        _join_confirms()

    confirm.assert_called_once()
    assert len(manager.listeners) == 1


def test_a_later_connect_confirms_and_other_transitions_do_not():
    manager = FakeManager(ConnectionState.CONNECTING)

    with patch('site_move_commands.confirm_if_switched') as confirm:
        confirm_on_connect(SimpleNamespace(connection_manager=manager))
        assert confirm.call_count == 0

        listener, = manager.listeners
        listener(SimpleNamespace(new_state=ConnectionState.BACKOFF))
        listener(SimpleNamespace(new_state=ConnectionState.CONNECTED))
        _join_confirms()

    confirm.assert_called_once()


# reconcile

def test_reconcile_finishes_a_switch_a_crash_cut_short(calls, config, monkeypatch):
    # the process died between the token store write and the config write
    storage = FakeStorage(calls)
    write_config = site_move_commands.shared_utils.write_config

    def crash(keys, value):
        raise RuntimeError('the power went out')

    monkeypatch.setattr(site_move_commands.shared_utils, 'write_config', crash)
    with patch('site_move_commands.requests.post', return_value=_response(200, MOVED)):
        follow_move(_service(storage, calls), MOVE_ID)
    assert (storage.get_site_id(), config['firebase']['site_id']) == ('site-b', 'test-site')

    # the next start
    monkeypatch.setattr(site_move_commands.shared_utils, 'write_config', write_config)
    calls.clear()
    with patch('secure_storage.get_storage', return_value=storage), \
         patch('site_move_commands.requests.post') as post:
        reconcile()

    assert config['firebase']['site_id'] == 'site-b'
    assert calls == ['write_config', 'drop_cloud_cache']
    # never a second mint: the move stays for the confirm the rebuilt client sends
    post.assert_not_called()
    assert storage.get_move() == SWITCHED


def test_reconcile_ignores_a_stale_move_after_a_re_pair(calls, config):
    # paired to site-c since: the move to site-b it left behind must not win
    storage = FakeStorage(calls, site_id='site-c', move=SWITCHED)

    with patch('secure_storage.get_storage', return_value=storage):
        reconcile()

    assert config['firebase']['site_id'] == 'test-site'
    assert calls == []


@pytest.mark.parametrize('move', [None, {**SWITCHED, 'phase': 'fetching'}])
def test_reconcile_without_a_switched_move_does_nothing(move, calls, config):
    storage = FakeStorage(calls, site_id='site-b', move=move)

    with patch('secure_storage.get_storage', return_value=storage):
        reconcile()

    assert config['firebase']['site_id'] == 'test-site'
    assert calls == []


def test_reconcile_leaves_a_config_that_already_names_the_target(calls, config):
    config['firebase']['site_id'] = 'site-b'
    storage = FakeStorage(calls, site_id='site-b', move=SWITCHED)

    with patch('secure_storage.get_storage', return_value=storage):
        reconcile()

    assert calls == []


def test_reconcile_never_raises(calls, config):
    with patch('secure_storage.get_storage', side_effect=RuntimeError('no store')):
        reconcile()


# the service and the runner

def test_reconcile_runs_before_the_boot_path_reads_the_site():
    import owlette_runner

    source = inspect.getsource(owlette_runner)
    assert source.index('site_move_commands.reconcile()') < source.index(
        "site_id = shared_utils.read_config(['firebase', 'site_id'])")


def test_the_main_loops_site_check_finishes_a_due_switch_before_it_reads_the_site():
    # only while one is due, and in the same pass that then sees the new site
    from owlette_service import OwletteService

    source = inspect.getsource(OwletteService.main)
    check = source.index('if firebase_check_counter >= 2:')
    due = source.index('if site_move_commands.reconcile_due():')
    finish = source.index('site_move_commands.reconcile()', due)
    read = source.index("current_site_id = shared_utils.read_config(['firebase', 'site_id'])")
    assert check < due < finish < read


def test_main_wires_the_move_callback_and_confirms_after_start():
    from owlette_service import OwletteService

    source = inspect.getsource(OwletteService.main)
    callback = 'site_move_commands.follow_in_background(self, move_id)'
    assert 'register_move_callback(' in source and callback in source
    start = source.index('self.firebase_client.start()')
    assert source.index(callback) < start
    assert source.index('site_move_commands.confirm_on_connect(self.firebase_client)') > start


class TestClientReinit:
    """_initialize_or_restart_firebase_client: reconcile before the site is
    read, the move callback on the new client, the confirm after its start."""

    def test_reinit_reconciles_registers_and_confirms_in_order(self):
        from owlette_service import OwletteService

        order = []
        config = {
            ('firebase', 'enabled'): True,
            ('firebase', 'site_id'): 'site-b',
            ('firebase', 'project_id'): 'proj',
        }

        def read_config(keys=None):
            order.append(('read_config', tuple(keys or ())))
            return config.get(tuple(keys or ()))

        client = MagicMock()
        client.register_move_callback.side_effect = lambda cb: order.append('register_move_callback')
        client.start.side_effect = lambda: order.append('client_start')
        auth = MagicMock()
        auth.is_authenticated.return_value = True
        svc = SimpleNamespace(
            firebase_client=None,
            handle_firebase_command=MagicMock(),
            handle_config_update=MagicMock(),
            _on_removed_from_site=MagicMock(),
            _wire_connection_status_listener=MagicMock(),
            _update_health_state=MagicMock(),
            _handle_watchdog_restart=MagicMock(),
            _restart_swoop=MagicMock(),
            unpair=MagicMock(),
        )
        reinit = OwletteService._initialize_or_restart_firebase_client.__get__(svc)

        with patch('owlette_service.FIREBASE_AVAILABLE', True), \
             patch('owlette_service.FirebaseClient', return_value=client), \
             patch('auth_manager.AuthManager', return_value=auth), \
             patch('owlette_service.shared_utils.read_config', side_effect=read_config), \
             patch('owlette_service.shared_utils.get_configured_api_base', return_value=API), \
             patch('owlette_service.shared_utils.get_data_path', return_value='cache.json'), \
             patch('owlette_service.site_move_commands.reconcile',
                   side_effect=lambda: order.append('reconcile')), \
             patch('owlette_service.site_move_commands.confirm_on_connect',
                   side_effect=lambda c: order.append(('confirm_on_connect', c))), \
             patch('owlette_service.site_move_commands.follow_in_background') as follow:
            assert reinit() is True
            callback = client.register_move_callback.call_args.args[0]
            callback(MOVE_ID)

        assert order.index('reconcile') < order.index(('read_config', ('firebase', 'site_id')))
        assert order.index('register_move_callback') < order.index('client_start')
        assert order.index('client_start') < order.index(('confirm_on_connect', client))
        follow.assert_called_once_with(svc, MOVE_ID)
