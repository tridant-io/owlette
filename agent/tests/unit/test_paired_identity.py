"""Off Windows the console user can write config.json and replace config/machine_id,
and a refused refresh clears the token store. So on a paired machine the server the
daemon talks to and the identity it presents come from the access token in the store,
which only root can write, and neither file can talk a machine out of its site.

The daemon's half runs on every OS here: the store is in memory and the one check
that says "this is the daemon, off Windows" is patched in.
"""

import base64
import json
import os
import sys
import threading
from types import SimpleNamespace

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src'))

import auth_manager
import firestore_rest_client
import secure_storage
import shared_utils
from auth_manager import AuthManager, TokenRevokedError
from secure_storage import SecureStorage

PROD = 'production'
DEV = 'development'
PROD_API = 'https://owlette.app/api'
DEV_API = 'https://dev.owlette.app/api'
MACHINE = 'TEC-MBA'


def jwt(aud=shared_utils.get_project_id(PROD), machine_id=MACHINE, **claims):
    def segment(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b'=').decode()
    return '.'.join([segment({'alg': 'RS256'}),
                     segment({'aud': aud, 'machine_id': machine_id, 'site_id': 'site-a', **claims}),
                     'signature'])


class MemoryStore(SecureStorage):
    """The real store's reads, over a dict rather than an encrypted file."""

    def __init__(self, data=None):
        self.data = data if data is not None else {}

    def _load_data(self):
        return dict(self.data)

    def _save_data(self, data):
        self.data = dict(data)
        return True

    def clear_tokens(self):
        self.data = {}
        return True

    def is_cleared(self):
        return not self.data


def fielded_store(aud=None, expiry=1.0):
    """What a store written by any fielded agent holds, with its access token expired."""
    return MemoryStore({
        'refresh_token': 'refresh',
        'access_token': jwt(aud or shared_utils.get_project_id(PROD)),
        'token_expiry': expiry,
        'site_id': 'site-a',
    })


class Server:
    """The two owlette servers' refresh route: each knows only its own tokens, and the
    token's machine (web/app/api/agent/auth/refresh/route.ts:136,178)."""

    def __init__(self, home=PROD_API):
        self.home = home
        self.calls = []

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append((url, json['machineId']))
        if not url.startswith(self.home + '/'):
            return self._answer(401, {'error': 'Invalid refresh token'})
        if json['machineId'] != MACHINE:
            return self._answer(403, {'error': 'Machine ID mismatch. Token may be compromised.'})
        project = shared_utils.get_project_id(PROD if self.home == PROD_API else DEV)
        return self._answer(200, {'accessToken': jwt(project), 'refreshToken': 'rotated',
                                  'expiresIn': 3600})

    @staticmethod
    def _answer(status, body):
        return SimpleNamespace(status_code=status, json=lambda: body, text=str(body))


@pytest.fixture
def machine(tmp_path, monkeypatch):
    """A paired prod machine, as the daemon off Windows sees it."""
    monkeypatch.setenv('OWLETTE_DATA_ROOT', str(tmp_path))
    (tmp_path / 'config').mkdir()
    config = tmp_path / 'config' / 'config.json'
    monkeypatch.setattr(shared_utils, 'CONFIG_PATH', str(config))
    monkeypatch.setattr(shared_utils, '_machine_id', None)
    monkeypatch.setattr(shared_utils, '_store_is_authoritative', lambda: True)

    state = SimpleNamespace(store=fielded_store(), server=Server(), revoked=[], root=tmp_path,
                            config=config)
    monkeypatch.setattr(secure_storage, 'get_storage', lambda: state.store)
    monkeypatch.setattr(auth_manager, 'get_storage', lambda: state.store)
    monkeypatch.setattr(auth_manager.requests, 'post',
                        lambda *args, **kwargs: state.server.post(*args, **kwargs))

    state.write_config = lambda **fields: config.write_text(json.dumps({
        'environment': PROD,
        'firebase': {'enabled': True, 'site_id': 'site-a', 'api_base': PROD_API,
                     'project_id': shared_utils.get_project_id(PROD)},
        **fields}))
    state.write_config()
    (tmp_path / 'config' / 'machine_id').write_text(MACHINE)

    def daemon_refresh():
        manager = AuthManager(api_base=shared_utils.get_configured_api_base(),
                              on_revoked=state.revoked.append)
        manager.refresh_now()

    state.daemon_refresh = daemon_refresh
    return state


class TestConfigCannotMoveAPairedMachine:
    @pytest.mark.parametrize('edit', [
        {'firebase': {'enabled': True, 'site_id': 'site-a', 'api_base': DEV_API}},
        {'environment': DEV, 'firebase': {'enabled': True, 'site_id': 'site-a'}},
        {'environment': DEV, 'firebase': {'enabled': True, 'site_id': 'site-a',
                                          'api_base': 'https://attacker.invalid/api'}},
    ])
    def test_pointing_config_at_the_other_server_does_not_unpair(self, machine, edit):
        machine.write_config(**edit)

        machine.daemon_refresh()

        assert machine.server.calls == [(f'{PROD_API}/agent/auth/refresh', MACHINE)]
        assert machine.revoked == []
        assert machine.store.data['refresh_token'] == 'rotated'

    def test_it_holds_for_a_dev_machine_too(self, machine):
        machine.store = fielded_store(shared_utils.get_project_id(DEV))
        machine.server = Server(DEV_API)
        machine.write_config(environment=PROD, firebase={'api_base': PROD_API, 'enabled': True,
                                                         'site_id': 'site-a'})

        machine.daemon_refresh()

        assert machine.server.calls == [(f'{DEV_API}/agent/auth/refresh', MACHINE)]
        assert machine.revoked == []

    def test_the_root_children_that_refresh_without_a_hook_keep_the_store(self, machine):
        # `report_issue` and `dismiss_reboot` spawn these; with no hook a refused
        # refresh clears the store directly (auth_manager.py:454).
        machine.write_config(firebase={'api_base': DEV_API, 'enabled': True, 'site_id': 'site-a'})

        token = AuthManager(api_base=shared_utils.get_configured_api_base()).get_valid_token()

        assert token
        assert machine.store.data['refresh_token'] == 'rotated'

    def test_every_reader_of_the_environment_agrees(self, machine):
        machine.write_config(environment=DEV, firebase={
            'enabled': True, 'site_id': 'site-a', 'api_base': DEV_API,
            'project_id': 'somebody-elses-project'})

        assert shared_utils.get_environment() == PROD
        assert shared_utils.get_api_base_url() == PROD_API
        assert shared_utils.get_configured_api_base() == PROD_API
        assert shared_utils.get_project_id() == shared_utils.get_project_id(PROD)
        assert shared_utils.get_configured_project_id() == shared_utils.get_project_id(PROD)
        assert shared_utils.get_web_host() == 'owlette.app'


class TestMachineIdFileCannotUnpair:
    def test_replacing_the_file_does_not_change_what_refresh_presents(self, machine):
        # config/ is 0770, so the group can rename the root-owned file and put its own there.
        (machine.root / 'config' / 'machine_id').write_text('someone-else')

        machine.daemon_refresh()

        assert machine.server.calls == [(f'{PROD_API}/agent/auth/refresh', MACHINE)]
        assert machine.revoked == []
        assert shared_utils.get_machine_id() == MACHINE

    def test_removing_the_file_does_not_reseed_a_hostname(self, machine):
        (machine.root / 'config' / 'machine_id').unlink()

        assert shared_utils.get_machine_id() == MACHINE


class TestARealRevokeStillUnpairs:
    def test_a_refusal_from_the_machines_own_server_reaches_the_hook(self, machine):
        machine.server = Server('https://nobody.invalid')

        with pytest.raises(TokenRevokedError):
            machine.daemon_refresh()

        assert len(machine.revoked) == 1

    def test_the_token_being_gone_from_its_server_clears_a_hookless_store(self, machine):
        machine.server = Server('https://nobody.invalid')
        manager = AuthManager(api_base=shared_utils.get_configured_api_base())

        with pytest.raises(TokenRevokedError):
            manager.refresh_now()

        assert machine.store.data == {}


class TestFieldedStores:
    def test_a_store_from_before_this_change_needs_nothing_written_to_it(self, machine):
        before = dict(machine.store.data)
        machine.write_config(firebase={'api_base': DEV_API, 'enabled': True, 'site_id': 'site-a'})

        assert shared_utils.get_environment() == PROD
        assert shared_utils.get_machine_id() == MACHINE
        assert machine.store.data == before

    def test_an_expired_token_still_says_who_issued_it(self, machine):
        assert machine.store.data['token_expiry'] == 1.0
        assert shared_utils.get_environment() == PROD

    def test_a_config_already_disagreeing_with_its_token_is_healed_not_unpaired(self, machine):
        # Refreshing against the wrong server is what would have unpaired it.
        machine.write_config(environment=DEV, firebase={'enabled': True, 'site_id': 'site-a'})

        machine.daemon_refresh()

        assert machine.revoked == []

    @pytest.mark.parametrize('access_token', [None, '', 'not-a-jwt', 'a.%%%.c', 'a.bnVsbA.c'])
    def test_a_store_with_no_readable_token_falls_back_and_pins_on_its_first_refresh(
            self, machine, access_token):
        machine.store.data['access_token'] = access_token
        machine.write_config(environment=PROD)

        assert shared_utils.get_environment() == PROD
        machine.daemon_refresh()

        assert machine.revoked == []
        assert machine.store.issued_claims()['aud'] == shared_utils.get_project_id(PROD)

    def test_a_token_from_a_project_owlette_does_not_know_leaves_the_config_in_charge(
            self, machine):
        machine.store.data['access_token'] = jwt('demo-playwright-e2e')
        machine.write_config(environment=DEV, firebase={'project_id': 'demo-playwright-e2e'})

        assert shared_utils.get_environment() == DEV
        assert shared_utils.get_configured_project_id() == 'demo-playwright-e2e'


class TestPairingStillMoves:
    def test_a_fresh_machine_takes_its_server_from_the_config(self, machine):
        machine.store = MemoryStore()
        machine.write_config(environment=DEV, firebase={'api_base': DEV_API})

        assert shared_utils.get_environment() == DEV
        assert shared_utils.get_configured_api_base() == DEV_API

    def test_a_fresh_machine_keeps_its_identity_file(self, machine):
        machine.store = MemoryStore()

        assert shared_utils.get_machine_id() == MACHINE

    def test_an_administrators_pairing_to_the_other_server_moves_the_machine(self, machine):
        manager = AuthManager(api_base=DEV_API)

        manager._persist_credentials(jwt(shared_utils.get_project_id(DEV)), 'new', 3600, 'site-b')

        assert shared_utils.get_environment() == DEV
        assert shared_utils.get_configured_api_base() == DEV_API

    def test_a_cleared_store_hands_the_decision_back_to_the_config(self, machine):
        machine.write_config(environment=DEV, firebase={'api_base': DEV_API})
        assert shared_utils.get_environment() == PROD

        machine.store.clear_tokens()

        assert shared_utils.get_environment() == DEV


class TestOnlyTheDaemonOffWindows:
    def test_anywhere_else_config_decides_as_it_always_did(self, machine, monkeypatch):
        monkeypatch.setattr(shared_utils, '_store_is_authoritative', lambda: False)
        machine.write_config(environment=DEV, firebase={'api_base': DEV_API,
                                                        'project_id': 'from-config'})
        (machine.root / 'config' / 'machine_id').write_text('from-the-file')

        assert shared_utils.get_environment() == DEV
        assert shared_utils.get_configured_api_base() == DEV_API
        assert shared_utils.get_configured_project_id() == 'from-config'
        assert shared_utils.get_machine_id() == 'from-the-file'

    def test_a_store_that_cannot_be_opened_leaves_the_config_in_charge(self, machine, monkeypatch):
        def no_key_material():
            raise RuntimeError('no key material')

        monkeypatch.setattr(secure_storage, 'get_storage', no_key_material)
        machine.write_config(environment=DEV)

        assert shared_utils.get_environment() == DEV


class TestStoreIsAuthoritative:
    @pytest.mark.parametrize('windows, euid, expected', [
        (False, 0, True),
        (False, 501, False),
        (True, 0, False),
    ])
    def test_it_is_root_off_windows(self, monkeypatch, windows, euid, expected):
        monkeypatch.setattr(shared_utils, '_IS_WINDOWS', windows)
        monkeypatch.setattr(os, 'geteuid', lambda: euid, raising=False)

        assert shared_utils._store_is_authoritative() is expected


class TestIssuedClaims:
    def test_it_reads_the_stored_access_token(self):
        claims = MemoryStore({'access_token': jwt('some-project')}).issued_claims()

        assert (claims['aud'], claims['machine_id'], claims['site_id']) == (
            'some-project', MACHINE, 'site-a')

    @pytest.mark.parametrize('token', [None, '', 7, 'one-segment', 'a.%%%.c', 'a.bnVsbA.c'])
    def test_anything_else_is_no_claims(self, token):
        assert MemoryStore({'access_token': token}).issued_claims() == {}


class TestSiteIdCannotUnpair:
    """Editing `firebase.site_id` costs the machine its connection, not its pairing: the
    rules refuse a token on a site it was not issued for, and only a document that was
    there and has gone reports removal."""

    def _listen(self, get_document):
        client = firestore_rest_client.FirestoreRestClient.__new__(
            firestore_rest_client.FirestoreRestClient)
        polled = threading.Event()

        def polling(path, _suppress_logging=False):
            polled.set()
            return get_document()

        client.get_document = polling
        changes = []
        thread, _wake, stop = client.listen_to_document(
            'config/not-my-site/machines/TEC-MBA', changes.append, min_interval=0.01)
        assert polled.wait(5)
        stop.set()
        thread.join(5)
        return changes

    def test_a_refused_read_never_reads_as_removed(self):
        def refused():
            response = SimpleNamespace(status_code=403)
            raise requests.exceptions.HTTPError('403 Forbidden', response=response)

        assert self._listen(refused) == []

    def test_a_document_that_never_existed_never_reads_as_removed(self):
        assert self._listen(lambda: None) == []
