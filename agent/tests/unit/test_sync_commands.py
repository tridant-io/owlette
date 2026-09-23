"""tests for sync_commands — handler registration + integration with CommandRouter."""

import pytest

from command_router import CommandRouter
from sync_commands import register_handlers


def test_register_handlers_registers_all_three():
    router = CommandRouter()
    register_handlers(router)
    types = router.registered_types()
    assert 'sync_pull' in types
    assert 'cancel_sync' in types
    assert 'rollback_to_version' in types


def test_handlers_registered_only_once_via_decorator():
    """re-registering on the same router raises (matches CommandRouter contract)."""
    router = CommandRouter()
    register_handlers(router)
    with pytest.raises(ValueError, match="already registered"):
        register_handlers(router)


def test_sync_pull_validates_required_fields():
    """missing required fields surface as ValueError from _require_str."""
    from sync_commands import _handle_sync_pull
    with pytest.raises(ValueError, match="site_id"):
        _handle_sync_pull({}, 'cmd-1', service=object())
    with pytest.raises(ValueError, match="roost_id"):
        _handle_sync_pull({'site_id': 's'}, 'cmd-1', service=object())
    with pytest.raises(ValueError, match="version_id"):
        _handle_sync_pull({'site_id': 's', 'roost_id': 'f'}, 'cmd-1', service=object())


def test_cancel_sync_returns_message_when_no_inflight():
    """cancel_sync gracefully reports when there's nothing to cancel."""
    from sync_commands import _handle_cancel_sync
    from sync_state import SyncState

    class FakeService:
        pass

    fake = FakeService()
    fake._sync_state = SyncState(':memory:')
    try:
        result = _handle_cancel_sync(
            {'site_id': 's', 'roost_id': 'f', 'version_id': 'm'},
            'cmd-1', fake,
        )
        assert 'no distribution' in result.lower()
    finally:
        fake._sync_state.close()


def test_sync_pull_reuses_pending_cancel_registered_before_handler():
    """A cancel set while sync_pull is queued is observed when handler starts."""
    from sync_commands import (
        _handle_cancel_sync,
        _handle_sync_pull,
        _setup_cancel_refcounts,
        _setup_cancels,
        discard_pending_sync,
        register_pending_sync,
    )

    class FakeService:
        firebase_client = None

    key = ('s', 'r', 'v')
    event = register_pending_sync(*key)
    try:
        cancel_result = _handle_cancel_sync(
            {'site_id': 's', 'roost_id': 'r', 'version_id': 'v'},
            'cancel-1',
            FakeService(),
        )
        assert 'pending sync' in cancel_result
        assert event.is_set()

        result = _handle_sync_pull(
            {
                'site_id': 's',
                'roost_id': 'r',
                'version_id': 'v',
                'version_url': 'https://example.invalid/version.json',
                'extract_root': 'C:\\tmp\\owlette-test',
            },
            'sync-1',
            FakeService(),
        )

        assert result == 'sync_pull cancelled before distribution start (accepted)'
        assert key not in _setup_cancels
        assert key not in _setup_cancel_refcounts
    finally:
        discard_pending_sync(*key, event)


# ─── chunk url provider wiring (batch contract) ─────────────────────


def test_chunk_url_provider_calls_firebase_client_with_batch():
    """provider passes a list of hashes through to firebase_client and returns the dict."""
    from unittest.mock import MagicMock
    from sync_commands import _make_chunk_url_provider

    class FakeService:
        pass

    fake = FakeService()
    fake.firebase_client = MagicMock()
    fake.firebase_client.get_chunk_download_urls.return_value = {
        'a' * 64: 'https://r2.example/aaa',
        'b' * 64: 'https://r2.example/bbb',
    }

    provider = _make_chunk_url_provider(fake)
    urls = provider(['a' * 64, 'b' * 64])
    assert urls == {
        'a' * 64: 'https://r2.example/aaa',
        'b' * 64: 'https://r2.example/bbb',
    }
    fake.firebase_client.get_chunk_download_urls.assert_called_once_with(
        ['a' * 64, 'b' * 64]
    )


def test_chunk_url_provider_with_empty_list_returns_empty_dict():
    """no hashes → no http call."""
    from unittest.mock import MagicMock
    from sync_commands import _make_chunk_url_provider

    class FakeService:
        pass

    fake = FakeService()
    fake.firebase_client = MagicMock()
    provider = _make_chunk_url_provider(fake)
    assert provider([]) == {}
    fake.firebase_client.get_chunk_download_urls.assert_not_called()


def test_chunk_url_provider_without_firebase_client_raises_clear_error():
    """when service.firebase_client is None (local-only mode), provider gives a clear error."""
    from sync_commands import _make_chunk_url_provider

    class FakeService:
        firebase_client = None

    provider = _make_chunk_url_provider(FakeService())
    with pytest.raises(NotImplementedError, match="firebase_client"):
        provider(['a' * 64])


# ─── failure reporting + fail-fast destination check ─────────────────


class _RecordingService:
    """
    a service stand-in with the two lazily-attached collaborators the
    handlers reach for, and no firebase_client (so target_state reporting
    is a no-op and the kill-switch check fails open).
    """
    firebase_client = None

    def __init__(self, state, allowlist):
        self._sync_state = state
        self._destination_allowlist = allowlist


def _sync_pull_cmd(extract_root: str) -> dict:
    return {
        'site_id': 's',
        'roost_id': 'r',
        'version_id': 'v',
        'version_url': 'https://example.invalid/version.json',
        'extract_root': extract_root,
    }


def test_sync_pull_refuses_out_of_root_extract_before_any_egress(tmp_path, monkeypatch):
    """
    fail-fast: a destination the allowlist rejects must be refused BEFORE the
    version body or a single chunk is fetched. previously the agent pulled the
    whole project down and only then declined to write it.
    """
    import sync_commands
    from destination_allowlist import DestinationAllowlist
    from sync_state import SyncState

    allowed = tmp_path / 'allowed'
    allowed.mkdir()
    state = SyncState(':memory:')
    service = _RecordingService(state, DestinationAllowlist([str(allowed)]))

    def _explode(*a, **kw):  # pragma: no cover - must never run
        raise AssertionError('network access attempted after a refused destination')

    monkeypatch.setattr(sync_commands, 'fetch_version', _explode)
    monkeypatch.setattr(sync_commands, 'download_all', _explode)

    try:
        result = sync_commands._handle_sync_pull(
            _sync_pull_cmd(str(tmp_path / 'not-allowed' / 'show')), 'cmd-1', service,
        )

        assert result.startswith('Error:'), result
        assert 'not allowed by destination_allowlist' in result
        # nothing was registered → nothing was downloaded
        assert state.find_distribution('s', 'r', 'v') is None
    finally:
        state.close()


def test_sync_pull_refusal_is_logged_locally(tmp_path, caplog):
    """
    an operator on the machine must be able to see WHY a deploy was refused
    without a firestore round trip.
    """
    import logging

    import sync_commands
    from destination_allowlist import DestinationAllowlist
    from sync_state import SyncState

    allowed = tmp_path / 'allowed'
    allowed.mkdir()
    state = SyncState(':memory:')
    service = _RecordingService(state, DestinationAllowlist([str(allowed)]))
    try:
        with caplog.at_level(logging.ERROR, logger='sync_commands'):
            sync_commands._handle_sync_pull(
                _sync_pull_cmd(str(tmp_path / 'not-allowed')), 'cmd-1', service,
            )
    finally:
        state.close()

    refusals = [r for r in caplog.records if 'REFUSED before download' in r.message]
    assert refusals, [r.message for r in caplog.records]
    assert refusals[0].levelno >= logging.ERROR


def test_sync_pull_version_failure_uses_the_error_prefix(tmp_path, monkeypatch):
    """
    handler failures must carry the `Error:` prefix — firebase_client keys the
    completed-vs-failed firestore status off exactly that.
    """
    import sync_commands
    from destination_allowlist import DestinationAllowlist
    from sync_state import SyncState
    from sync_version import VersionError

    extract = tmp_path / 'allowed' / 'show'
    extract.mkdir(parents=True)
    state = SyncState(':memory:')
    service = _RecordingService(state, DestinationAllowlist([str(tmp_path / 'allowed')]))

    def _boom(*a, **kw):
        raise VersionError('manifest digest mismatch')

    monkeypatch.setattr(sync_commands, 'fetch_version', _boom)

    try:
        result = sync_commands._handle_sync_pull(
            _sync_pull_cmd(str(extract)), 'cmd-1', service,
        )
        assert result.startswith('Error:'), result
        assert 'manifest digest mismatch' in result
    finally:
        state.close()


def test_every_sync_pull_failure_return_is_error_prefixed():
    """
    static guard: a future edit that adds a `return f"sync_pull failed: ..."`
    without the prefix would silently record the failure as a completed
    command. every failure return goes through `_failure()`.
    """
    import re
    from pathlib import Path

    import sync_commands

    source = Path(sync_commands.__file__).read_text(encoding='utf-8')
    bad = re.findall(r'return f?"(?:sync_pull|rollback)[^"]*fail[^"]*"', source)
    assert bad == [], f"failure returns bypassing _failure(): {bad}"


# the legacy default extract root


@pytest.fixture(autouse=True)
def _reset_substitution_notice():
    """the substitution logs once per process; each test starts from unlogged."""
    import sync_commands
    sync_commands._legacy_root_substitution_logged = False
    yield
    sync_commands._legacy_root_substitution_logged = False


@pytest.mark.parametrize('family,expected', [
    ('windows', '~/Documents/Owlette'),
    ('macos', '/Users/Shared/Owlette'),
    ('linux', '/var/lib/owlette/projects'),
])
@pytest.mark.parametrize('sent', [
    '~/Documents/Owlette',
    '~/Documents/Owlette/',
    '~\\Documents\\Owlette',
])
def test_the_legacy_default_root_becomes_this_os_default(
        family, expected, sent, monkeypatch):
    """
    the fanout has no idea what the target runs, so every roost with no
    explicit extractPath arrives carrying the windows default. a POSIX agent
    lands it under its own default root instead of refusing the deploy;
    windows keeps the literal it was sent.
    """
    import destination_allowlist
    import sync_commands

    monkeypatch.setattr(destination_allowlist, '_os_family', lambda: family)
    assert sync_commands._substitute_legacy_default_root(sent) == (
        sent if family == 'windows' else expected
    )


@pytest.mark.parametrize('family', ['windows', 'macos', 'linux'])
@pytest.mark.parametrize('chosen', [
    '/opt/exhibit',
    '~/Documents/show1',
    '~/Documents/OwletteOther',
    'C:\\render',
])
def test_a_root_the_operator_chose_is_passed_through(family, chosen, monkeypatch):
    """negative control: only the one legacy literal is substituted."""
    import destination_allowlist
    import sync_commands

    monkeypatch.setattr(destination_allowlist, '_os_family', lambda: family)
    assert sync_commands._substitute_legacy_default_root(chosen) == chosen


def test_the_substitution_is_logged_once_per_process(caplog, monkeypatch):
    import logging

    import destination_allowlist
    import sync_commands

    monkeypatch.setattr(destination_allowlist, '_os_family', lambda: 'linux')
    with caplog.at_level(logging.INFO, logger='sync_commands'):
        for _ in range(3):
            sync_commands._substitute_legacy_default_root('~/Documents/Owlette')

    lines = [r for r in caplog.records if 'is the windows' in r.message]
    assert len(lines) == 1, [r.message for r in caplog.records]


def test_the_handler_validates_the_substituted_root(tmp_path, monkeypatch):
    """the substitution happens before the allowlist check, so the refusal
    names the root the agent would actually have written to."""
    import destination_allowlist
    import sync_commands
    from destination_allowlist import DestinationAllowlist
    from sync_state import SyncState

    allowed = tmp_path / 'allowed'
    allowed.mkdir()
    state = SyncState(':memory:')
    service = _RecordingService(state, DestinationAllowlist([str(allowed)]))
    monkeypatch.setattr(destination_allowlist, '_os_family', lambda: 'linux')

    def _explode(*a, **kw):  # pragma: no cover - must never run
        raise AssertionError('network access attempted after a refused destination')

    monkeypatch.setattr(sync_commands, 'fetch_version', _explode)

    try:
        result = sync_commands._handle_sync_pull(
            _sync_pull_cmd('~/Documents/Owlette'), 'cmd-1', service,
        )
    finally:
        state.close()

    assert result.startswith('Error:'), result
    assert '/var/lib/owlette/projects' in result
    assert 'Documents' not in result
