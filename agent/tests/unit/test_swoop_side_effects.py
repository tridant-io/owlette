"""Unit tests for swoop's two machine-wide side effects (Task 7.7).

The firewall rule and the SAS policy are the only things swoop changes outside
its own directory, so the four properties proved here are the ones an uninstall
depends on: enable and disable are idempotent, the prior policy value is
restored exactly (absent round-trips to a deleted value, never to a zero), the
work never runs on the caller's thread, and nothing elevates.

Every effect is injected -- no powershell runs, no registry key is opened and no
real state file is written outside ``tmp_path``.
"""

import json
import re
import threading
import time
import tokenize
from pathlib import Path

import pytest

import shared_utils
import swoop_manager
from swoop_manager import SwoopManager


class FakeRegistry:
    """The SAS value, as a dict would hold it. ``value`` is 'absent' or an int."""

    def __init__(self, value=swoop_manager.SAS_ABSENT):
        self.value = value
        self.reads = 0
        self.writes = []
        self.deletes = 0

    def read(self):
        self.reads += 1
        return self.value

    def write(self, value):
        self.writes.append(value)
        self.value = int(value)
        return True

    def delete(self):
        self.deletes += 1
        self.value = swoop_manager.SAS_ABSENT
        return True


class FakeShell:
    """Records every powershell script the manager asks for."""

    def __init__(self, ok=True, delay=0.0):
        self.ok = ok
        self.delay = delay
        self.scripts = []
        self.threads = []

    def __call__(self, script, timeout=None):
        self.scripts.append(script)
        self.threads.append(threading.current_thread())
        if self.delay:
            time.sleep(self.delay)
        return self.ok


class FakeFirebase:
    """Just the log_event surface the manager uses."""

    def __init__(self):
        self.events = []

    def log_event(self, action, level, details=None, **kwargs):
        self.events.append((action, level, details))
        return 'doc'


EXE_PATH = r'D:\Program Files\Owlette\swoop\owlette-swoop.exe'


@pytest.fixture
def effects(monkeypatch, tmp_path):
    """The manager plus its three injected effects, wired to fakes."""
    state_path = tmp_path / 'tmp' / 'swoop_side_effects.json'
    monkeypatch.setattr(swoop_manager, 'SIDE_EFFECT_STATE_PATH', str(state_path))
    monkeypatch.setattr(shared_utils, 'get_swoop_exe_path', lambda: EXE_PATH)

    registry = FakeRegistry()
    shell = FakeShell()
    monkeypatch.setattr(swoop_manager, '_read_sas_value', registry.read)
    monkeypatch.setattr(swoop_manager, '_write_sas_value', registry.write)
    monkeypatch.setattr(swoop_manager, '_delete_sas_value', registry.delete)
    monkeypatch.setattr(swoop_manager, '_run_powershell', shell)

    firebase = FakeFirebase()
    manager = SwoopManager(firebase_client=firebase)
    return {
        'manager': manager, 'registry': registry, 'shell': shell,
        'firebase': firebase, 'state_path': state_path,
    }


def read_state(effects):
    return json.loads(Path(effects['state_path']).read_text())


def wait_for(predicate, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


# enable


def test_enable_creates_both_rules_and_sets_the_policy(effects):
    effects['manager']._enable_side_effects()

    assert len(effects['shell'].scripts) == 1
    script = effects['shell'].scripts[0]
    assert swoop_manager.FIREWALL_RULE_NAME in script
    assert swoop_manager.FIREWALL_MDNS_RULE_NAME in script
    assert f"-Group '{swoop_manager.FIREWALL_GROUP}'" in script
    assert '-Direction Inbound -Action Allow' in script
    assert '-Protocol UDP' in script
    assert f'-LocalPort {swoop_manager.MDNS_PORT}' in script
    assert EXE_PATH in script
    # remove-then-create, so a relocated install's stale rule is corrected.
    assert script.index('Remove-NetFirewallRule') < script.index('New-NetFirewallRule')

    assert effects['registry'].writes == [swoop_manager.SAS_ENABLED_VALUE]
    assert read_state(effects) == {
        swoop_manager.STATE_KEY_FIREWALL: EXE_PATH,
        swoop_manager.STATE_KEY_SAS_PRIOR: swoop_manager.SAS_ABSENT,
    }
    assert effects['firebase'].events[0][0] == 'swoop_side_effects_applied'


def test_enable_records_the_prior_value_before_writing_the_policy(effects, monkeypatch):
    """Without the record first, a crash between the two loses 'absent'."""
    order = []
    real_write_state = swoop_manager._write_side_effect_state
    monkeypatch.setattr(
        swoop_manager, '_write_side_effect_state',
        lambda state: (order.append('record'), real_write_state(state))[1],
    )
    monkeypatch.setattr(
        swoop_manager, '_write_sas_value',
        lambda value: (order.append('policy'), True)[1],
    )

    effects['manager']._enable_side_effects()

    assert order == ['record', 'policy']


def test_enable_is_idempotent(effects):
    manager = effects['manager']
    manager._enable_side_effects()
    manager._enable_side_effects()
    manager._enable_side_effects()

    # one firewall call, one policy write -- and, above all, the recorded prior
    # is still 'absent' rather than the 3 we set ourselves.
    assert len(effects['shell'].scripts) == 1
    assert effects['registry'].writes == [swoop_manager.SAS_ENABLED_VALUE]
    assert effects['registry'].reads == 1
    assert read_state(effects)[swoop_manager.STATE_KEY_SAS_PRIOR] == swoop_manager.SAS_ABSENT


def test_enable_re_scopes_the_rule_when_the_install_moved(effects, monkeypatch):
    """An upgrade into another directory must not keep the old rule."""
    manager = effects['manager']
    manager._enable_side_effects()

    moved = r'C:\Program Files\Owlette\swoop\owlette-swoop.exe'
    monkeypatch.setattr(shared_utils, 'get_swoop_exe_path', lambda: moved)
    manager._enable_side_effects()

    assert len(effects['shell'].scripts) == 2
    assert moved in effects['shell'].scripts[1]
    assert read_state(effects)[swoop_manager.STATE_KEY_FIREWALL] == moved
    # and the policy is still untouched: one capture, one write.
    assert effects['registry'].reads == 1
    assert effects['registry'].writes == [swoop_manager.SAS_ENABLED_VALUE]


def test_enable_retries_the_half_that_failed(effects):
    effects['shell'].ok = False
    manager = effects['manager']
    manager._enable_side_effects()

    assert read_state(effects) == {
        swoop_manager.STATE_KEY_SAS_PRIOR: swoop_manager.SAS_ABSENT,
    }

    effects['shell'].ok = True
    manager._enable_side_effects()

    assert len(effects['shell'].scripts) == 2
    assert read_state(effects)[swoop_manager.STATE_KEY_FIREWALL] == EXE_PATH
    # the policy was captured the first time and is not captured again.
    assert effects['registry'].reads == 1
    assert effects['registry'].writes == [swoop_manager.SAS_ENABLED_VALUE]


def test_enable_leaves_the_policy_alone_when_the_record_is_corrupt(effects):
    Path(effects['state_path']).parent.mkdir(parents=True, exist_ok=True)
    Path(effects['state_path']).write_text('{not json')

    effects['manager']._enable_side_effects()

    assert effects['registry'].reads == 0
    assert effects['registry'].writes == []
    assert effects['shell'].scripts == []


def test_enable_leaves_the_policy_alone_when_it_cannot_be_read(effects, monkeypatch):
    monkeypatch.setattr(swoop_manager, '_read_sas_value', lambda: None)

    effects['manager']._enable_side_effects()

    assert effects['registry'].writes == []
    assert swoop_manager.STATE_KEY_SAS_PRIOR not in read_state(effects)
    assert read_state(effects)[swoop_manager.STATE_KEY_FIREWALL] == EXE_PATH


def test_enable_skips_the_rule_when_the_streamer_is_not_installed(effects, monkeypatch):
    monkeypatch.setattr(shared_utils, 'get_swoop_exe_path', lambda: None)

    effects['manager']._enable_side_effects()

    assert effects['shell'].scripts == []
    assert read_state(effects) == {
        swoop_manager.STATE_KEY_SAS_PRIOR: swoop_manager.SAS_ABSENT,
    }


# disable


def test_disable_deletes_the_value_when_the_prior_was_absent(effects):
    manager = effects['manager']
    manager._enable_side_effects()
    assert effects['registry'].value == swoop_manager.SAS_ENABLED_VALUE

    manager._disable_side_effects()

    assert effects['registry'].deletes == 1
    assert effects['registry'].writes == [swoop_manager.SAS_ENABLED_VALUE]  # no restore write
    assert effects['registry'].value == swoop_manager.SAS_ABSENT
    assert effects['shell'].scripts[1] == swoop_manager._firewall_remove_script()
    assert f"-Group '{swoop_manager.FIREWALL_GROUP}'" in effects['shell'].scripts[1]
    assert not Path(effects['state_path']).exists()
    assert effects['firebase'].events[-1][0] == 'swoop_side_effects_removed'


@pytest.mark.parametrize('prior', [0, 1, 2, 3])
def test_disable_restores_the_exact_prior_value(effects, prior):
    effects['registry'].value = prior
    manager = effects['manager']
    manager._enable_side_effects()
    manager._disable_side_effects()

    assert effects['registry'].writes == [swoop_manager.SAS_ENABLED_VALUE, prior]
    assert effects['registry'].deletes == 0
    assert effects['registry'].value == prior


def test_disable_is_idempotent(effects):
    manager = effects['manager']
    manager._enable_side_effects()
    manager._disable_side_effects()

    before = (len(effects['shell'].scripts), len(effects['registry'].writes),
              effects['registry'].deletes)
    manager._disable_side_effects()
    manager._disable_side_effects()

    assert (len(effects['shell'].scripts), len(effects['registry'].writes),
            effects['registry'].deletes) == before


def test_disable_without_a_record_touches_nothing(effects):
    effects['manager']._disable_side_effects()

    assert effects['shell'].scripts == []
    assert effects['registry'].writes == []
    assert effects['registry'].deletes == 0


def test_disable_keeps_the_record_of_the_half_that_failed(effects):
    manager = effects['manager']
    manager._enable_side_effects()
    effects['shell'].ok = False

    manager._disable_side_effects()

    # the policy is back, the rule is not, so only the rule is still recorded.
    assert read_state(effects) == {swoop_manager.STATE_KEY_FIREWALL: EXE_PATH}
    assert effects['registry'].deletes == 1


def test_restore_refuses_a_record_it_cannot_trust(effects):
    for prior in ('nope', 9, -1, True, None, {}):
        effects['registry'].writes.clear()
        effects['registry'].deletes = 0
        assert swoop_manager._restore_sas_value(prior) is False
        assert effects['registry'].writes == []
        assert effects['registry'].deletes == 0


# off the main loop


def test_set_enabled_returns_without_waiting(effects):
    effects['shell'].delay = 0.5
    caller = threading.current_thread()

    started = time.monotonic()
    effects['manager'].set_enabled(True)
    elapsed = time.monotonic() - started

    # the service's 5-second loop is the caller; it must not wait on powershell.
    assert elapsed < 0.1
    assert wait_for(lambda: effects['registry'].writes)
    assert effects['shell'].threads[0] is not caller
    assert effects['shell'].threads[0].name == 'swoop-manager'


def test_set_enabled_false_runs_the_disable_path_off_thread(effects):
    manager = effects['manager']
    manager._enable_side_effects()
    caller = threading.current_thread()

    started = time.monotonic()
    manager.set_enabled(False)
    elapsed = time.monotonic() - started

    assert elapsed < 0.1
    assert wait_for(lambda: effects['registry'].deletes == 1)
    assert effects['shell'].threads[-1] is not caller


def test_the_spawn_path_applies_no_side_effect(effects, monkeypatch):
    """Only an explicit set_enabled() moves a machine-wide setting.

    A spawn must not: the whole agent suite drives _do_ensure with an injected
    backend, and a firewall rule or a machine policy is not something a unit
    test may leave behind on the box it ran on.
    """
    manager = effects['manager']
    monkeypatch.setattr(manager, '_spawn_gate', lambda: None)
    manager._spawn = type('S', (), {
        'verify_install': staticmethod(lambda: EXE_PATH),
        'fetch_bundle': staticmethod(
            lambda *a, **k: (_ for _ in ()).throw(RuntimeError('stop here')),
        ),
    })()

    manager._do_ensure('sid-1')

    assert effects['shell'].scripts == []
    assert effects['registry'].reads == 0
    assert effects['registry'].writes == []


# never raises, never elevates


def test_neither_path_raises_when_every_effect_fails(effects, monkeypatch):
    def boom(*args, **kwargs):
        raise OSError('registry is on fire')

    monkeypatch.setattr(swoop_manager, '_read_sas_value', boom)
    monkeypatch.setattr(swoop_manager, '_write_sas_value', boom)
    monkeypatch.setattr(swoop_manager, '_delete_sas_value', boom)
    monkeypatch.setattr(swoop_manager, '_run_powershell', boom)
    # a record with the rule applied and the policy not: enable reaches the
    # registry, disable reaches powershell, and both effects blow up.
    monkeypatch.setattr(swoop_manager, '_read_side_effect_state',
                        lambda: {swoop_manager.STATE_KEY_FIREWALL: True})

    manager = effects['manager']
    manager._enable_side_effects()
    manager._disable_side_effects()

    assert [e[0] for e in effects['firebase'].events] == [
        'swoop_side_effects_failed', 'swoop_side_effects_failed',
    ]


def test_the_worker_survives_a_side_effect_failure(effects, monkeypatch):
    def boom(*args, **kwargs):
        raise OSError('registry is on fire')

    monkeypatch.setattr(swoop_manager, '_read_sas_value', boom)
    manager = effects['manager']

    manager.set_enabled(True)
    assert wait_for(lambda: effects['firebase'].events)

    # the same worker keeps taking work after the failure.
    monkeypatch.setattr(swoop_manager, '_read_sas_value', effects['registry'].read)
    manager.set_enabled(True)
    assert wait_for(lambda: effects['registry'].writes)


def test_powershell_is_invoked_without_elevation(monkeypatch):
    calls = {}

    def fake_run(argv, **kwargs):
        calls['argv'] = argv
        calls['kwargs'] = kwargs
        return type('R', (), {'returncode': 0, 'stdout': '', 'stderr': ''})()

    monkeypatch.setattr(swoop_manager.subprocess, 'run', fake_run)

    assert swoop_manager._run_powershell(swoop_manager._firewall_create_script(EXE_PATH))

    argv = calls['argv']
    assert argv[:5] == ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command']
    assert calls['kwargs'].get('shell') in (None, False)
    joined = ' '.join(argv).lower()
    for forbidden in ('runas', '-verb', 'shellexecute', 'start-process'):
        assert forbidden not in joined


def _executable_source(path):
    """The module's code with comments and docstrings dropped.

    Argument strings are kept, because ``'runas'`` as a verb is exactly what
    this is looking for; only the prose that talks about it is removed.
    """
    kept = []
    previous = tokenize.ENCODING
    statement_start = (tokenize.ENCODING, tokenize.NEWLINE, tokenize.NL,
                       tokenize.INDENT, tokenize.DEDENT)
    with open(path, 'rb') as f:
        for token in tokenize.tokenize(f.readline):
            if token.type == tokenize.COMMENT:
                continue
            if not (token.type == tokenize.STRING and previous in statement_start):
                kept.append(token.string)
            previous = token.type
    return ' '.join(kept).lower()


def test_no_elevation_anywhere_in_the_module():
    """Source-level, so the guarantee holds for code no test exercises."""
    source = _executable_source(swoop_manager.__file__)
    for forbidden in ('runas', 'shellexecute', '-verb', 'start-process', 'elevat'):
        assert forbidden not in source, f'{forbidden} appears in swoop_manager.py'


def test_the_state_file_holds_nothing_but_the_two_flags(effects):
    effects['registry'].value = 2
    effects['manager']._enable_side_effects()

    state = read_state(effects)
    assert set(state) == {swoop_manager.STATE_KEY_FIREWALL,
                          swoop_manager.STATE_KEY_SAS_PRIOR}
    assert not re.search(r'token|bearer|secret', json.dumps(state), re.IGNORECASE)
