"""hoot's credential off Windows: the access token the daemon publishes.

The token store is the daemon's alone there (0600 root), so local hoot, a
console-user process, found no credential it could read and exited on every
launch. The daemon now writes its one-hour access token to
`ipc/cortex_token.json` on its tick, and hoot reads it through PublishedToken,
which never refreshes and never sees the agent token.
"""

import logging
import os
import stat
import sys
import time
from types import SimpleNamespace

import pytest

import auth_manager
import shared_utils
from auth_manager import AuthenticationError, PublishedToken


class _Storage:
    """encrypt_value and decrypt_value, with the token store's signatures."""

    def encrypt_value(self, value):
        return value[::-1]

    def decrypt_value(self, value):
        return value[::-1], False


@pytest.fixture
def token_path(tmp_path, monkeypatch):
    path = tmp_path / 'cortex_token.json'
    monkeypatch.setattr(shared_utils, 'CORTEX_TOKEN_PATH', str(path))
    monkeypatch.setattr(auth_manager, 'get_storage', lambda: _Storage())
    return path


def test_hoot_reads_the_token_the_daemon_published(token_path):
    auth_manager.publish_token('access-token-1', time.time() + 3600)

    hoot = PublishedToken()
    assert hoot.is_authenticated() is True
    assert hoot.get_valid_token() == 'access-token-1'
    assert 'access-token-1' not in token_path.read_text(encoding='utf-8')


def test_a_republished_token_replaces_the_last_one(token_path):
    auth_manager.publish_token('access-token-1', time.time() + 60)
    auth_manager.publish_token('access-token-2', time.time() + 3600)

    assert PublishedToken().get_valid_token() == 'access-token-2'
    # the temp file it was written through is gone
    assert os.listdir(token_path.parent) == [token_path.name]


def test_an_expired_token_is_no_credential(token_path):
    auth_manager.publish_token('access-token-1', time.time() - 1)

    hoot = PublishedToken()
    assert hoot.is_authenticated() is False
    with pytest.raises(AuthenticationError):
        hoot.get_valid_token()


@pytest.mark.parametrize(
    'content', [None, '', 'not json', '[]', '{}', '{"token": "x", "expiry": "soon"}'])
def test_nothing_published_or_a_damaged_file_is_no_credential(token_path, content):
    if content is not None:
        token_path.write_text(content, encoding='utf-8')

    assert PublishedToken().is_authenticated() is False


def test_withdrawing_removes_the_token_and_is_safe_to_repeat(token_path):
    auth_manager.publish_token('access-token-1', time.time() + 3600)

    auth_manager.withdraw_token()
    auth_manager.withdraw_token()

    assert not token_path.exists()
    assert PublishedToken().is_authenticated() is False


@pytest.mark.skipif(sys.platform == 'win32', reason='the POSIX mode bits')
def test_the_published_file_is_for_the_group_and_nobody_else(token_path):
    auth_manager.publish_token('access-token-1', time.time() + 3600)

    assert stat.S_IMODE(token_path.stat().st_mode) == 0o640


# ─── the daemon's half: _publish_cortex_token on the tick ─────────────────────


@pytest.fixture
def handed_over(monkeypatch):
    """What the daemon did with hoot's token file, in order, off Windows."""
    calls = []
    monkeypatch.setattr(sys, 'platform', 'linux')
    monkeypatch.setattr(
        auth_manager, 'publish_token',
        lambda token, expiry: calls.append(('publish', token, expiry)))
    monkeypatch.setattr(
        auth_manager, 'withdraw_token', lambda: calls.append(('withdraw',)))
    return calls


def _daemon(token=None, expiry=None, paired=True):
    """A service holding `token`, with `_publish_cortex_token` bound the way
    test_posix_loop_duties binds its methods."""
    from owlette_service import OwletteService

    manager = SimpleNamespace(current_token=lambda: (manager.token, manager.expiry))
    manager.token, manager.expiry = token, expiry
    svc = SimpleNamespace(
        firebase_client=SimpleNamespace(auth_manager=manager) if paired else None,
        _cortex_token_published=(),
        _cortex_token_error=None,
    )
    svc.publish = OwletteService._publish_cortex_token.__get__(svc, OwletteService)
    return svc, manager


def test_the_daemon_publishes_its_token_once_and_again_when_it_rotates(handed_over):
    svc, manager = _daemon('access-token-1', 1000.0)

    svc.publish(True)
    svc.publish(True)
    manager.token, manager.expiry = 'access-token-2', 4600.0
    svc.publish(True)

    assert handed_over == [
        ('publish', 'access-token-1', 1000.0),
        ('publish', 'access-token-2', 4600.0),
    ]


def test_the_token_is_withdrawn_when_hoot_is_switched_off(handed_over):
    svc, _ = _daemon('access-token-1', 1000.0)

    svc.publish(True)
    svc.publish(False)
    svc.publish(False)

    assert handed_over == [('publish', 'access-token-1', 1000.0), ('withdraw',)]


def test_a_token_left_by_an_earlier_run_is_withdrawn_on_the_first_tick(handed_over):
    svc, _ = _daemon(paired=False)

    svc.publish(True)

    assert handed_over == [('withdraw',)]


def test_a_failed_write_is_tried_again_on_the_next_tick(handed_over, monkeypatch, caplog):
    svc, _ = _daemon('access-token-1', 1000.0)
    publish = auth_manager.publish_token

    def refuse(token, expiry):
        raise PermissionError('ipc is not writable')

    monkeypatch.setattr(auth_manager, 'publish_token', refuse)
    with caplog.at_level(logging.WARNING):
        svc.publish(True)
    monkeypatch.setattr(auth_manager, 'publish_token', publish)
    svc.publish(True)

    assert "Could not update hoot's access token" in caplog.text
    assert 'access-token-1' not in caplog.text
    assert handed_over == [('publish', 'access-token-1', 1000.0)]


def test_a_write_that_keeps_failing_is_said_once(handed_over, monkeypatch, caplog):
    svc, _ = _daemon('access-token-1', 1000.0)

    def refuse(token, expiry):
        raise PermissionError('ipc is not writable')

    monkeypatch.setattr(auth_manager, 'publish_token', refuse)
    with caplog.at_level(logging.WARNING):
        for _ in range(3):
            svc.publish(True)

    assert caplog.text.count("Could not update hoot's access token") == 1


def test_windows_publishes_nothing(handed_over, monkeypatch):
    """There hoot reads the token store itself, as it always has."""
    monkeypatch.setattr(sys, 'platform', 'win32')
    svc, _ = _daemon('access-token-1', 1000.0)

    svc.publish(True)

    assert handed_over == []


# ─── the tick that calls it, and hoot's own choice of credential ──────────────


def _tick(handed_over, monkeypatch, config):
    """One `_try_launch_cortex` against `config`, hoot not yet running."""
    from owlette_service import OwletteService

    svc, _ = _daemon('access-token-1', 1000.0)
    svc.cortex_pid = None
    svc._cortex_last_launch_time = 0.0
    svc._cortex_launch_cooldown = 0
    svc._publish_cortex_token = svc.publish
    svc._is_cortex_alive = lambda: False
    svc.launch_python_script_as_user = lambda name: (handed_over.append(('launch', name)), True)[1]
    monkeypatch.setattr(shared_utils, 'read_config', lambda *args, **kwargs: config)
    return OwletteService._try_launch_cortex.__get__(svc, OwletteService)()


def test_the_token_is_published_before_hoot_is_launched(handed_over, monkeypatch):
    """hoot exits at once if it finds no credential, so the order is the fix."""
    config = {'cortex': {'enabled': True}, 'firebase': {'enabled': True}}

    assert _tick(handed_over, monkeypatch, config) is True

    assert handed_over == [
        ('publish', 'access-token-1', 1000.0), ('launch', 'owlette_cortex.py')]


def test_a_machine_that_left_its_site_loses_the_token_on_the_next_tick(
        handed_over, monkeypatch):
    """Leaving switches cloud sync off in the config before the cloud client is
    torn down; the token goes with the config, not with the teardown."""
    config = {'cortex': {'enabled': True}, 'firebase': {'enabled': False}}

    _tick(handed_over, monkeypatch, config)

    assert ('withdraw',) in handed_over
    assert not any(call[0] == 'publish' for call in handed_over)


def test_hoot_switched_off_is_neither_handed_a_token_nor_launched(
        handed_over, monkeypatch):
    config = {'cortex': {'enabled': False}, 'firebase': {'enabled': True}}

    assert _tick(handed_over, monkeypatch, config) is False

    assert handed_over == [('withdraw',)]


@pytest.mark.parametrize('platform, expected', [
    ('linux', 'PublishedToken'), ('darwin', 'PublishedToken'), ('win32', 'AuthManager')])
def test_hoot_holds_the_agent_token_only_on_windows(monkeypatch, platform, expected):
    import owlette_cortex

    class AuthManager:
        def __init__(self, api_base):
            self.api_base = api_base

    monkeypatch.setattr(sys, 'platform', platform)
    monkeypatch.setattr(auth_manager, 'AuthManager', AuthManager)
    monkeypatch.setattr(
        shared_utils, 'get_configured_api_base', lambda config=None: 'https://owlette.app/api')

    credential = owlette_cortex._hoot_credential({})

    assert type(credential).__name__ == expected


@pytest.mark.skipif(sys.platform == 'win32', reason='the POSIX mode table')
def test_hoot_logs_where_the_mode_table_lets_the_console_user_write():
    import owlette_cortex
    from osadapter import posix

    relative = posix._relative_to(shared_utils.get_data_path(), owlette_cortex.LOG_DIR)

    assert posix._directory_mode(relative) == 0o770
