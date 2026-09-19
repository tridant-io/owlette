"""
Unit tests for swoop_commands — the three swoop command handlers.

Two contracts are pinned here:

  * the sid-only contract (PROTOCOL.md §11) — a swoop command carries the
    envelope the web writer stamps and, per type, a sid. Anything else is
    refused with an `Error:` string rather than ignored, because every active
    site member can read `commands/pending`.
  * the fast lane — these types dispatch on a per-command thread that must not
    do I/O, so the handlers are checked against poisoned socket/open/sleep.

The manager is a strict `spec` mock: a handler that calls a method SwoopManager
does not expose fails here rather than on a real machine.
"""

import builtins
import os
import socket
import time
from unittest.mock import MagicMock, call

import pytest

from command_router import CommandRouter
from swoop_commands import (
    _handle_swoop_kill,
    _handle_swoop_refresh,
    _handle_swoop_session_requested,
    register_handlers,
)

SWOOP_TYPES = ('swoop_session_requested', 'swoop_kill', 'swoop_refresh')

HANDLERS = {
    'swoop_session_requested': _handle_swoop_session_requested,
    'swoop_kill': _handle_swoop_kill,
    'swoop_refresh': _handle_swoop_refresh,
}


class _ManagerSpec:
    """SwoopManager's public surface (Task 2.1) — the spec the mocks are held to."""

    def ensure_streamer(self, sid):
        raise NotImplementedError

    def kill(self, reason):
        raise NotImplementedError

    def on_session_change(self):
        raise NotImplementedError

    def status(self):
        raise NotImplementedError


class _Service:
    def __init__(self, manager):
        self.swoop_manager = manager


def envelope(cmd_type, **extra):
    """the full document the web writer stamps, plus whatever the case adds."""
    doc = {
        'type': cmd_type,
        'siteId': 'site-1',
        'machineId': 'machine-1',
        'timestamp': 1789344000,
        'status': 'pending',
        'queuedBy': 'user-1',
        'createdAt': 1789344000,
        'expiresAt': 1789344060,
        'auditCorrelationId': 'corr-1',
    }
    doc.update(extra)
    return doc


@pytest.fixture
def manager():
    return MagicMock(spec=_ManagerSpec)


# registration

def test_register_handlers_registers_all_three():
    router = CommandRouter()
    register_handlers(router)
    assert router.registered_types() == sorted(SWOOP_TYPES)


def test_register_handlers_uses_the_register_decorator_shape():
    """fake router: register('<type>') returns the decorator that takes the handler."""
    registered = {}

    class FakeRouter:
        def register(self, cmd_type):
            def decorator(fn):
                registered[cmd_type] = fn
                return fn
            return decorator

    register_handlers(FakeRouter())
    assert set(registered) == set(SWOOP_TYPES)
    for cmd_type, fn in registered.items():
        assert fn is HANDLERS[cmd_type]


def test_register_handlers_is_not_repeatable_on_one_router():
    router = CommandRouter()
    register_handlers(router)
    with pytest.raises(ValueError, match='already registered'):
        register_handlers(router)


# happy paths — exactly one manager call each

def test_session_requested_calls_ensure_streamer_once(manager):
    result = _handle_swoop_session_requested(
        envelope('swoop_session_requested', sid='sid-abc'), 'cmd-1', _Service(manager)
    )
    assert manager.method_calls == [call.ensure_streamer('sid-abc')]
    assert not result.startswith('Error:')
    assert 'sid-abc' in result


def test_kill_with_sid_calls_kill_once_with_a_reason_naming_the_sid(manager):
    result = _handle_swoop_kill(
        envelope('swoop_kill', sid='sid-abc'), 'cmd-1', _Service(manager)
    )
    assert len(manager.method_calls) == 1
    (name, args, _kwargs), = manager.method_calls
    assert name == 'kill'
    reason, = args
    assert 'swoop_kill' in reason and 'sid-abc' in reason
    assert not result.startswith('Error:')


def test_kill_without_sid_still_calls_kill_once(manager):
    """an absent sid means 'kill whatever is running', not a refusal."""
    result = _handle_swoop_kill(envelope('swoop_kill'), 'cmd-1', _Service(manager))
    assert len(manager.method_calls) == 1
    (name, args, _kwargs), = manager.method_calls
    assert name == 'kill'
    reason, = args
    assert 'swoop_kill' in reason and 'sid=' not in reason
    assert not result.startswith('Error:')


def test_refresh_calls_on_session_change_once(manager):
    """the doorbell is reached through the manager — the handler never touches it."""
    result = _handle_swoop_refresh(envelope('swoop_refresh'), 'cmd-1', _Service(manager))
    assert manager.method_calls == [call.on_session_change()]
    assert not result.startswith('Error:')


def test_handlers_do_not_import_the_doorbell():
    import swoop_commands
    source = open(swoop_commands.__file__, encoding='utf-8').read()
    assert 'import swoop_doorbell' not in source
    assert 'from swoop_doorbell' not in source


# the sid-only contract

@pytest.mark.parametrize('cmd_type', SWOOP_TYPES)
def test_extra_field_is_refused(cmd_type, manager):
    payload = envelope(cmd_type, bundle={'token': 'nope'})
    if cmd_type == 'swoop_session_requested':
        payload['sid'] = 'sid-abc'
    result = HANDLERS[cmd_type](payload, 'cmd-1', _Service(manager))
    assert result.startswith('Error:')
    assert 'bundle' in result
    assert manager.method_calls == []


def test_session_requested_without_a_sid_is_refused(manager):
    result = _handle_swoop_session_requested(
        envelope('swoop_session_requested'), 'cmd-1', _Service(manager)
    )
    assert result.startswith('Error:')
    assert 'sid' in result
    assert manager.method_calls == []


@pytest.mark.parametrize('bad_sid', ['', '   ', 42, [], {'sid': 'x'}])
def test_a_present_sid_must_be_a_non_empty_string(bad_sid, manager):
    result = _handle_swoop_session_requested(
        envelope('swoop_session_requested', sid=bad_sid), 'cmd-1', _Service(manager)
    )
    assert result.startswith('Error:')
    assert manager.method_calls == []


def test_refresh_carrying_a_sid_is_refused(manager):
    """an enablement toggle names no session, so sid is not in refresh's contract."""
    result = _handle_swoop_refresh(
        envelope('swoop_refresh', sid='sid-abc'), 'cmd-1', _Service(manager)
    )
    assert result.startswith('Error:')
    assert 'sid' in result
    assert manager.method_calls == []


# degraded service

@pytest.mark.parametrize('cmd_type', SWOOP_TYPES)
def test_missing_swoop_manager_returns_an_error_string(cmd_type):
    payload = envelope(cmd_type)
    if cmd_type == 'swoop_session_requested':
        payload['sid'] = 'sid-abc'
    result = HANDLERS[cmd_type](payload, 'cmd-1', object())
    assert result.startswith('Error:')
    assert 'swoop_manager' in result


@pytest.mark.parametrize('cmd_type', SWOOP_TYPES)
def test_a_raising_manager_becomes_an_error_string(cmd_type, manager):
    manager.ensure_streamer.side_effect = RuntimeError('boom')
    manager.kill.side_effect = RuntimeError('boom')
    manager.on_session_change.side_effect = RuntimeError('boom')
    payload = envelope(cmd_type)
    if cmd_type == 'swoop_session_requested':
        payload['sid'] = 'sid-abc'
    result = HANDLERS[cmd_type](payload, 'cmd-1', _Service(manager))
    assert result.startswith('Error:')
    assert 'RuntimeError' in result


# fast lane: no I/O, no sleeping

@pytest.mark.parametrize('cmd_type', SWOOP_TYPES)
def test_handlers_do_no_io_and_never_sleep(cmd_type, manager, monkeypatch):
    def boom(*_args, **_kwargs):
        raise AssertionError(f'{cmd_type} handler touched a forbidden primitive')

    monkeypatch.setattr(time, 'sleep', boom)
    monkeypatch.setattr(socket, 'socket', boom)
    monkeypatch.setattr(socket, 'create_connection', boom)
    monkeypatch.setattr(os, 'stat', boom)
    monkeypatch.setattr(builtins, 'open', boom)
    try:
        import requests.sessions
        monkeypatch.setattr(requests.sessions.Session, 'request', boom)
    except ImportError:  # pragma: no cover — requests is a hard agent dependency
        pass

    payload = envelope(cmd_type)
    if cmd_type == 'swoop_session_requested':
        payload['sid'] = 'sid-abc'
    result = HANDLERS[cmd_type](payload, 'cmd-1', _Service(manager))
    assert not result.startswith('Error:')
    assert len(manager.method_calls) == 1
