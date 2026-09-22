"""Tests for the self-restart watchdog — pure decision logic and persistence."""

import json
import os
import time

import pytest

try:
    from connection_manager import (
        _should_restart,
        _merge_watchdog_config,
        _emergency_kill_active,
        WATCHDOG_DEFAULTS,
        REASON_CONNECTION_STUCK,
    )
    import watchdog_state
except ImportError:
    pytest.skip("watchdog modules not importable", allow_module_level=True)


class TestShouldRestart:
    """The decision function must be deterministic. Callers pass all time inputs
    so tests don't depend on real clocks or sleep.
    """

    @pytest.fixture
    def config(self):
        return _merge_watchdog_config(None)  # use defaults

    def test_disabled_never_fires(self, config):
        config['enabled'] = False
        # Massive elapsed time, should still not fire
        decision = _should_restart(
            now_mono=100000.0,
            last_success_mono=0.0,
            process_start_mono=0.0,
            last_fatal_mono=None,
            config=config,
        )
        assert decision.should_fire is False
        assert 'disabled' in decision.detail

    def test_boot_grace_suppresses_fire(self, config):
        # Uptime = 60s, boot grace = 180s → suppressed
        decision = _should_restart(
            now_mono=60.0,
            last_success_mono=None,
            process_start_mono=0.0,
            last_fatal_mono=None,
            config=config,
        )
        assert decision.should_fire is False
        assert 'boot grace' in decision.detail

    def test_never_connected_fires_after_threshold(self, config):
        # Uptime = threshold + grace + 1, never connected → should fire
        failure = config['thresholds']['failure_seconds']
        grace = config['thresholds']['boot_grace_seconds']
        uptime = failure + grace + 1
        decision = _should_restart(
            now_mono=uptime,
            last_success_mono=None,  # never connected
            process_start_mono=0.0,
            last_fatal_mono=None,
            config=config,
        )
        assert decision.should_fire is True
        assert decision.reason_code == REASON_CONNECTION_STUCK

    def test_recent_success_suppresses_fire(self, config):
        # Connected 10s ago, threshold = 360s → below threshold
        now = 10000.0
        decision = _should_restart(
            now_mono=now,
            last_success_mono=now - 10.0,
            process_start_mono=now - 1000.0,  # past boot grace
            last_fatal_mono=None,
            config=config,
        )
        assert decision.should_fire is False
        assert 'below threshold' in decision.detail

    def test_stale_success_triggers_fire(self, config):
        # Last success was longer ago than failure_seconds
        failure = config['thresholds']['failure_seconds']
        now = 10000.0
        decision = _should_restart(
            now_mono=now,
            last_success_mono=now - (failure + 10.0),
            process_start_mono=now - 5000.0,
            last_fatal_mono=None,
            config=config,
        )
        assert decision.should_fire is True
        assert decision.reason_code == REASON_CONNECTION_STUCK

    def test_fatal_error_suppresses_fire(self, config):
        # Fatal error moments ago → suppress even if threshold exceeded
        failure = config['thresholds']['failure_seconds']
        now = 10000.0
        decision = _should_restart(
            now_mono=now,
            last_success_mono=now - (failure + 10.0),
            process_start_mono=now - 5000.0,
            last_fatal_mono=now - 30.0,  # very recent fatal
            config=config,
        )
        assert decision.should_fire is False
        assert 'fatal' in decision.detail

    def test_old_fatal_error_does_not_suppress(self, config):
        # Fatal error was >fatal_error_suppression_seconds ago → no longer suppresses
        failure = config['thresholds']['failure_seconds']
        fatal_suppress = config['preconditions']['fatal_error_suppression_seconds']
        now = 10000.0
        decision = _should_restart(
            now_mono=now,
            last_success_mono=now - (failure + 10.0),
            process_start_mono=now - 5000.0,
            last_fatal_mono=now - (fatal_suppress + 100.0),  # stale fatal
            config=config,
        )
        assert decision.should_fire is True

    def test_pure_function_never_reads_clock(self, config, monkeypatch):
        """Sanity check: _should_restart must not touch time.monotonic/time.time.
        Caller is expected to pass all time inputs.
        """
        import time as time_module

        mono_called = {'n': 0}
        time_called = {'n': 0}

        def bad_mono():
            mono_called['n'] += 1
            return 0.0

        def bad_time():
            time_called['n'] += 1
            return 0.0

        monkeypatch.setattr(time_module, 'monotonic', bad_mono)
        monkeypatch.setattr(time_module, 'time', bad_time)

        _should_restart(
            now_mono=1000.0,
            last_success_mono=500.0,
            process_start_mono=0.0,
            last_fatal_mono=None,
            config=config,
        )
        assert mono_called['n'] == 0, "pure function should not call time.monotonic()"
        assert time_called['n'] == 0, "pure function should not call time.time()"


class TestMergeConfig:
    def test_none_returns_defaults(self):
        merged = _merge_watchdog_config(None)
        assert merged['enabled'] == WATCHDOG_DEFAULTS['enabled']
        assert merged['thresholds']['failure_seconds'] == WATCHDOG_DEFAULTS['thresholds']['failure_seconds']

    def test_partial_override_merges_defaults(self):
        user = {'thresholds': {'failure_seconds': 30}}
        merged = _merge_watchdog_config(user)
        assert merged['thresholds']['failure_seconds'] == 30
        # boot_grace_seconds still defaulted
        assert merged['thresholds']['boot_grace_seconds'] == WATCHDOG_DEFAULTS['thresholds']['boot_grace_seconds']

    def test_full_override(self):
        user = {
            'enabled': False,
            'thresholds': {'failure_seconds': 10, 'boot_grace_seconds': 5},
            'budget': {'max_per_window': 1, 'window_seconds': 60},
            'preconditions': {'require_internet': False, 'fatal_error_suppression_seconds': 0},
        }
        merged = _merge_watchdog_config(user)
        assert merged['enabled'] is False
        assert merged['thresholds']['failure_seconds'] == 10
        assert merged['budget']['max_per_window'] == 1
        assert merged['preconditions']['require_internet'] is False

    def test_defaults_not_mutated_by_merge(self):
        """Regression: _merge_watchdog_config must deep-copy so subsequent
        calls don't see mutated defaults.
        """
        user1 = {'thresholds': {'failure_seconds': 999}}
        _merge_watchdog_config(user1)
        # Fresh merge should still show default value
        merged2 = _merge_watchdog_config(None)
        assert merged2['thresholds']['failure_seconds'] == WATCHDOG_DEFAULTS['thresholds']['failure_seconds']


def _registry_value_absent():
    raise FileNotFoundError('WatchdogDisabled')


class TestEmergencyKill:
    @pytest.fixture(autouse=True)
    def _off_switch_absent(self, monkeypatch):
        # never read the real registry: a dev box may have the switch set.
        monkeypatch.setattr('connection_manager._read_watchdog_disabled_value',
                            _registry_value_absent)

    def test_neither_signal_returns_false(self, monkeypatch):
        monkeypatch.delenv("OWLETTE_DISABLE_WATCHDOG_RESTART", raising=False)
        assert _emergency_kill_active() is False

    def test_env_var_set_returns_true(self, monkeypatch):
        monkeypatch.setenv("OWLETTE_DISABLE_WATCHDOG_RESTART", "1")
        assert _emergency_kill_active() is True

    def test_env_var_wrong_value_returns_false(self, monkeypatch):
        monkeypatch.setenv("OWLETTE_DISABLE_WATCHDOG_RESTART", "0")
        assert _emergency_kill_active() is False

    def test_registry_value_one_returns_true(self, monkeypatch):
        monkeypatch.delenv("OWLETTE_DISABLE_WATCHDOG_RESTART", raising=False)
        monkeypatch.setattr('connection_manager._read_watchdog_disabled_value', lambda: 1)
        assert _emergency_kill_active() is True



@pytest.fixture
def temp_state(monkeypatch, tmp_path):
    """Redirect watchdog_state paths to a temp directory for isolation."""
    budget = tmp_path / 'watchdog_budget.owlette_service.json'
    history = tmp_path / 'watchdog_history.owlette_service.json'
    monkeypatch.setattr('watchdog_state.BUDGET_PATH', str(budget))
    monkeypatch.setattr('watchdog_state.HISTORY_PATH', str(history))
    yield {'budget': str(budget), 'history': str(history), 'tmp_path': tmp_path}


class TestConsumeBudget:
    DEFAULT_BUDGET = {'max_per_window': 3, 'window_seconds': 3600}

    def test_empty_file_allows_restart(self, temp_state):
        assert watchdog_state.consume_budget(self.DEFAULT_BUDGET) is True
        # File now exists with one entry
        state = watchdog_state.read_budget()
        assert len(state['restarts']) == 1

    def test_budget_exhaustion_after_max(self, temp_state):
        assert watchdog_state.consume_budget(self.DEFAULT_BUDGET) is True
        assert watchdog_state.consume_budget(self.DEFAULT_BUDGET) is True
        assert watchdog_state.consume_budget(self.DEFAULT_BUDGET) is True
        # 4th attempt → budget exhausted
        assert watchdog_state.consume_budget(self.DEFAULT_BUDGET) is False

    def test_old_entries_pruned_outside_window(self, temp_state):
        """Entries older than window_seconds are removed on read, freeing slots."""
        # Seed the file with 3 old timestamps
        now = time.time()
        old_ts = now - 7200  # 2h ago, outside 1h window
        with open(temp_state['budget'], 'w') as f:
            json.dump({'schema': 1, 'restarts': [old_ts, old_ts, old_ts]}, f)
        # All three entries should be pruned on consume → allowed
        assert watchdog_state.consume_budget(self.DEFAULT_BUDGET) is True
        state = watchdog_state.read_budget()
        assert len(state['restarts']) == 1  # just our new entry

    def test_corrupt_json_recovers_to_empty(self, temp_state):
        with open(temp_state['budget'], 'w') as f:
            f.write("{not valid json")
        # Should treat as empty and allow
        assert watchdog_state.consume_budget(self.DEFAULT_BUDGET) is True

    def test_future_timestamps_sanitised(self, temp_state):
        """Entries with timestamps > now+300s are dropped (clock skew protection)."""
        now = time.time()
        future_ts = now + 10000  # clearly future (clock rolled back)
        with open(temp_state['budget'], 'w') as f:
            json.dump({'schema': 1, 'restarts': [future_ts, future_ts, future_ts]}, f)
        # All three are sanitised → budget allows
        assert watchdog_state.consume_budget(self.DEFAULT_BUDGET) is True

    def test_ancient_timestamps_sanitised(self, temp_state):
        """Entries older than 24h are dropped regardless of window."""
        now = time.time()
        ancient_ts = now - 200000  # ~2.3 days ago
        with open(temp_state['budget'], 'w') as f:
            json.dump({'schema': 1, 'restarts': [ancient_ts]}, f)
        # Ancient entry dropped → fresh budget
        assert watchdog_state.consume_budget(self.DEFAULT_BUDGET) is True
        state = watchdog_state.read_budget()
        assert len(state['restarts']) == 1

    def test_missing_file_treated_as_empty(self, temp_state):
        assert not os.path.exists(temp_state['budget'])
        assert watchdog_state.consume_budget(self.DEFAULT_BUDGET) is True


class TestHistory:
    def test_append_and_read_pending(self, temp_state):
        snap = {'restart_id': 'abc-1', 'reason_code': 'connection_stuck'}
        watchdog_state.append_history(snap)
        pending = watchdog_state.read_pending_history()
        assert len(pending) == 1
        assert pending[0]['restart_id'] == 'abc-1'

    def test_mark_submitted_hides_entry_from_pending(self, temp_state):
        watchdog_state.append_history({'restart_id': 'abc-1'})
        watchdog_state.append_history({'restart_id': 'abc-2'})
        assert watchdog_state.mark_submitted('abc-1', log_id='log-1') is True
        pending = watchdog_state.read_pending_history()
        assert len(pending) == 1
        assert pending[0]['restart_id'] == 'abc-2'

    def test_mark_submitted_idempotent(self, temp_state):
        """Calling mark_submitted twice should not fail or duplicate state."""
        watchdog_state.append_history({'restart_id': 'abc-1'})
        assert watchdog_state.mark_submitted('abc-1', log_id='log-1') is True
        # Second call — no-op
        assert watchdog_state.mark_submitted('abc-1', log_id='log-1') is True

    def test_mark_submitted_unknown_id_is_noop(self, temp_state):
        watchdog_state.append_history({'restart_id': 'abc-1'})
        # Mark a different id → no-op, returns True (idempotent)
        assert watchdog_state.mark_submitted('does-not-exist') is True
        # Original still pending
        pending = watchdog_state.read_pending_history()
        assert len(pending) == 1

    def test_history_capped_at_max_entries(self, temp_state):
        """Oldest entries drop when cap exceeded."""
        for i in range(15):
            watchdog_state.append_history({'restart_id': f'id-{i}'})
        # Only last 10 retained
        pending = watchdog_state.read_pending_history()
        assert len(pending) == 10
        # Oldest kept is id-5 (dropped id-0 through id-4)
        assert pending[0]['restart_id'] == 'id-5'
        assert pending[-1]['restart_id'] == 'id-14'

    def test_corrupt_history_file_recovers(self, temp_state):
        with open(temp_state['history'], 'w') as f:
            f.write("not json")
        # Append should succeed against the reset state
        assert watchdog_state.append_history({'restart_id': 'new-1'}) is True
        pending = watchdog_state.read_pending_history()
        assert len(pending) == 1
