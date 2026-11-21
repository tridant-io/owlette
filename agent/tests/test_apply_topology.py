"""Unit tests for the service-side ``apply_topology`` state machine.

Pins Session 0 behaviour (the production deployment topology) by mocking at the
``_spawn_user_session_helper`` IPC seam, so the real pre-apply gate chain (kill
switch, remote-apply flag, Mosaic refuse, concurrent-apply lock, cooldown, input
validation), helper envelope handling, and post-apply audit + watchdog logic all
run. Mocking the helper boundary rather than CCD primitives keeps the tests tied
to the production wire format — a change to the ``ok`` / ``changes`` / ``code``
keys fails loudly, not silently.

The Session 1+ branch is covered by ``tests/unit/test_display_manager.py``
(``TestApplyTopologyAutoRestore``).
"""

import threading
import time
from unittest.mock import MagicMock

import pytest

import display_manager as dm
from display_manager import DisplayErrorCode


# A minimally valid layout — passes ``_validate_desired_layout`` so we get
# past the input-shape gate and into the gate chain we're actually testing.
SAMPLE_DESIRED = {
    'monitors': [
        {'edidHash': 'aaaaaaaa', 'primary': True, 'position': {'x': 0, 'y': 0}},
        {'edidHash': 'bbbbbbbb', 'primary': False, 'position': {'x': 1920, 'y': 0}},
    ],
}


@pytest.fixture
def reset_apply_state():
    """Clear ``apply_topology`` module state so flag / timestamp leakage from a
    prior test can't contaminate the next case.
    """
    yield
    dm._apply_in_flight = False
    dm._ack_event.clear()
    dm._current_apply_id = None
    dm._last_apply_time = 0.0
    dm._last_apply_finished_at = 0.0


@pytest.fixture
def force_session_0(monkeypatch):
    """Pin ``_is_session_0`` True so ``apply_topology`` takes the helper branch —
    the boundary this file mocks. The S1 path lives in test_display_manager.py.
    """
    monkeypatch.setattr(dm, '_is_session_0', lambda: True)


@pytest.fixture(autouse=True)
def isolate_display_ipc(monkeypatch, tmp_path):
    """Keep service-side helper request/response files inside pytest temp."""
    monkeypatch.setattr(dm, '_ipc_tempdir', lambda: str(tmp_path))


@pytest.fixture
def enable_remote_apply(monkeypatch):
    """Kill switch (``displays.enabled``) defaults to enabled (None → enabled per
    the production read) and the Wave 6.1 gate (``displays.remoteApplyEnabled``)
    reads True. Tests needing a different config override the key inline.
    """
    import shared_utils

    def _read(keys=None, **_kw):
        if keys == ['displays', 'remoteApplyEnabled']:
            return True
        return None

    monkeypatch.setattr(shared_utils, 'read_config', _read)


@pytest.fixture
def mock_mosaic_inactive(monkeypatch):
    """Default the NVIDIA Mosaic probe to inactive — the common-path precondition.
    Refuse-guard tests override it inline.
    """
    import nvapi_display
    monkeypatch.setattr(
        nvapi_display, 'detect_mosaic', lambda: {'active': False, 'grids': []},
    )


@pytest.fixture
def stub_resync(monkeypatch):
    """``_trigger_profile_resync`` is fire-and-forget; stub it so the success path
    doesn't call into a mocked firebase client's ``_ensure_display_profile``.
    """
    monkeypatch.setattr(dm, '_trigger_profile_resync', lambda fb: None)


def _join_watchdog():
    """If the success path armed the apply watchdog, wait for it to exit.

    The watchdog blocks on ``_ack_event.wait(ack_timeout)`` then clears
    ``_apply_in_flight`` in its finally block, so success-path tests ack the
    apply and join here to keep that state out of the next test.
    """
    for t in threading.enumerate():
        if t.name == 'display-apply-watchdog':
            t.join(timeout=2.0)


class TestApplyTopologyServiceStateMachine:
    """Service-side state-machine coverage for ``apply_topology`` in Session 0.

    One gate or one helper-response shape per test, with the rest of the chain on
    happy defaults via ``enable_remote_apply`` + ``mock_mosaic_inactive``.
    """

    # 1. Success path

    def test_success_path_arms_watchdog_and_emits_audit(
        self, monkeypatch, force_session_0, enable_remote_apply,
        mock_mosaic_inactive, stub_resync, reset_apply_state,
    ):
        """Success emits ``display_apply_succeeded``, arms the revert watchdog, and
        returns ``success: True`` with ``applyId`` and ``changes`` intact.
        """
        changes = [{'monitorId': 'aaaaaaaa', 'field': 'primary'}]
        spawn_calls = []

        def _fake_spawn(helper_args, out_path, timeout):
            spawn_calls.append({'args': helper_args, 'timeout': timeout})
            return {'ok': True, 'changes': changes}

        monkeypatch.setattr(dm, '_spawn_user_session_helper', _fake_spawn)

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, ack_timeout=30, firebase_client=fb,
            apply_id='success-id',
        )

        assert result['success'] is True
        assert result['applyId'] == 'success-id'
        assert result['changes'] == changes
        assert result['revertDeadlineSeconds'] == 30
        assert isinstance(result['revertDeadlineEpochMs'], int)

        # Helper boundary crossed exactly once, with the apply-json command shape.
        assert len(spawn_calls) == 1
        assert spawn_calls[0]['args'][0] == '--apply-json'

        # Audit event for success was emitted with the apply_id payload.
        assert fb.log_event.called
        call = fb.log_event.call_args
        assert call.kwargs['action'] == 'display_apply_succeeded'
        assert call.kwargs['extra_fields']['applyId'] == 'success-id'
        assert call.kwargs['extra_fields']['changes'] == changes

        # Watchdog holds _apply_in_flight until ack/timeout; ack so it exits before
        # the next test.
        assert dm._apply_in_flight is True
        dm._ack_event.set()
        _join_watchdog()
        assert dm._apply_in_flight is False

    # 2. SDC_VALIDATE failure

    def test_validate_rejected_returns_code_and_emits_failure(
        self, monkeypatch, force_session_0, enable_remote_apply,
        mock_mosaic_inactive, stub_resync, reset_apply_state,
    ):
        """SDC_VALIDATE rejection surfaces the ``validate_rejected`` code and emits
        a ``display_apply_failed`` audit event with the same code stamped in.
        """
        def _fake_spawn(helper_args, out_path, timeout):
            return {
                'ok': False,
                'error': 'set-display-config rejected layout (rc=87)',
                'code': DisplayErrorCode.VALIDATE_REJECTED,
            }

        monkeypatch.setattr(dm, '_spawn_user_session_helper', _fake_spawn)

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='validate-id',
        )

        assert result['success'] is False
        assert result['code'] == DisplayErrorCode.VALIDATE_REJECTED
        assert 'rejected' in result['error']

        # The specific code lets dashboard alert routing distinguish validate-fail
        # from generic apply-fail.
        assert fb.log_event.called
        call = fb.log_event.call_args
        assert call.kwargs['action'] == 'display_apply_failed'
        assert call.kwargs['extra_fields']['code'] == str(
            DisplayErrorCode.VALIDATE_REJECTED,
        )

        # No watchdog on failure — the in-flight flag must clear via finally.
        assert dm._apply_in_flight is False

    # 3. Zero active paths post-verify

    def test_zero_active_paths_post_verify_triggers_defensive_revert(
        self, monkeypatch, force_session_0, enable_remote_apply,
        mock_mosaic_inactive, stub_resync, reset_apply_state, tmp_path,
    ):
        """Helper post-verify found zero active paths after SDC_APPLY — no displays.

        The helper writes a sentinel before applying and signals
        ``sentinel_written: True``; the service answers with a defensive revert
        helper. Both invocations land at our mock.
        """
        # tmp sentinel so the cleanup branch never touches real ProgramData.
        sentinel = tmp_path / '.display_revert_pending'
        monkeypatch.setattr(dm, '_SENTINEL_PATH', str(sentinel))
        # Pre-create it so the failure branch's os.path.exists check fires the
        # defensive revert exactly as in production.
        sentinel.write_text('{"version": 1, "snapshot": {}}', encoding='utf-8')

        spawn_calls = []

        def _fake_spawn(helper_args, out_path, timeout):
            spawn_calls.append(list(helper_args))
            if helper_args[0] == '--apply-json':
                return {
                    'ok': False,
                    'error': 'post-verify: zero active paths after apply',
                    'code': DisplayErrorCode.ZERO_ACTIVE_PATHS_POST,
                    'sentinel_written': True,
                }
            # --revert-json — defensive revert succeeded
            return {'ok': True}

        monkeypatch.setattr(dm, '_spawn_user_session_helper', _fake_spawn)

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='zero-paths-id',
        )

        assert result['success'] is False
        assert result['code'] == DisplayErrorCode.ZERO_ACTIVE_PATHS_POST
        # The defensive revert ran (apply + revert helper invocations).
        assert any(args[0] == '--apply-json' for args in spawn_calls)
        assert any(args[0] == '--revert-json' for args in spawn_calls)
        # Sentinel cleaned up because the defensive revert succeeded.
        assert not sentinel.exists()
        assert dm._apply_in_flight is False

    # 4. Helper timeout

    def test_helper_timeout_returns_helper_failed_code(
        self, monkeypatch, force_session_0, enable_remote_apply,
        mock_mosaic_inactive, stub_resync, reset_apply_state,
    ):
        """``DisplayEnumerationError`` from the spawn (e.g. WaitForSingleObject timed
        out and the process was terminated) bubbles through
        ``_apply_via_user_session`` as HELPER_FAILED; the state machine surfaces
        that code unchanged.
        """
        def _fake_spawn(helper_args, out_path, timeout):
            raise dm.DisplayEnumerationError(
                f'display helper timed out after {timeout:.1f}s (process terminated)'
            )

        monkeypatch.setattr(dm, '_spawn_user_session_helper', _fake_spawn)

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='timeout-id',
        )

        assert result['success'] is False
        assert result['code'] == DisplayErrorCode.HELPER_FAILED
        assert 'timed out' in result['error']
        assert fb.log_event.called
        assert (
            fb.log_event.call_args.kwargs['action'] == 'display_apply_failed'
        )
        assert dm._apply_in_flight is False

    # 5. Helper crash (non-DisplayEnumerationError exception)

    def test_helper_crash_bubbles_to_unexpected_failure(
        self, monkeypatch, force_session_0, enable_remote_apply,
        mock_mosaic_inactive, stub_resync, reset_apply_state,
    ):
        """An exception that is NOT a ``DisplayEnumerationError`` (those are caught
        inside ``_apply_via_user_session``) escapes to the outer ``except
        Exception`` and returns the ``unexpected failure`` shape.

        Safety net: a refactored spawner raising some new error class still yields
        a structured failure rather than crashing the calling thread.
        """
        def _fake_spawn(helper_args, out_path, timeout):
            raise RuntimeError('helper subprocess died unexpectedly')

        monkeypatch.setattr(dm, '_spawn_user_session_helper', _fake_spawn)

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='crash-id',
        )

        assert result['success'] is False
        assert 'unexpected failure' in result['error']
        # The outer except path emits a generic display_apply_failed with no code
        # (the exception isn't a known taxonomy entry).
        assert fb.log_event.called
        assert (
            fb.log_event.call_args.kwargs['action'] == 'display_apply_failed'
        )
        assert dm._apply_in_flight is False

    # 6. Concurrent apply gate (lock contention)

    def test_concurrent_apply_returns_in_progress_error(
        self, monkeypatch, force_session_0, enable_remote_apply,
        mock_mosaic_inactive, stub_resync, reset_apply_state,
    ):
        """``_apply_lock`` is a non-blocking acquire: a second apply while the first
        holds it returns ``apply already in progress`` without crossing the helper
        boundary or emitting an audit event — a pre-apply gate, not an attempt.
        """
        # Catches a state machine that ever skips the gate.
        spawn_called = []

        def _fake_spawn(*_a, **_kw):
            spawn_called.append(True)
            return {'ok': True, 'changes': []}

        monkeypatch.setattr(dm, '_spawn_user_session_helper', _fake_spawn)

        # Simulate an in-flight apply by holding the lock.
        assert dm._apply_lock.acquire(blocking=False), 'precondition: lock free'
        # Lets us verify the contention path doesn't clobber the holder's flag.
        dm._apply_in_flight = True
        try:
            fb = MagicMock()
            result = dm.apply_topology(
                SAMPLE_DESIRED, firebase_client=fb, apply_id='contention-id',
            )
            assert result['success'] is False
            assert 'apply already in progress' in result['error']
            assert spawn_called == [], 'helper must not be invoked under contention'
            assert fb.log_event.call_count == 0
            # The contention-return path must NOT touch _apply_in_flight —
            # the existing apply's holder owns its lifecycle.
            assert dm._apply_in_flight is True
        finally:
            dm._apply_lock.release()

    # 7. Cooldown gate

    def test_cooldown_gate_returns_rate_limited(
        self, monkeypatch, force_session_0, enable_remote_apply,
        mock_mosaic_inactive, stub_resync, reset_apply_state,
    ):
        """An apply within ``_APPLY_COOLDOWN_SECONDS`` of the previous one is rate
        limited: ``rate limited`` error, no ``code`` field (transient back pressure,
        not a failure) and no audit event.
        """
        spawn_called = []

        def _fake_spawn(*_a, **_kw):
            spawn_called.append(True)
            return {'ok': True, 'changes': []}

        monkeypatch.setattr(dm, '_spawn_user_session_helper', _fake_spawn)

        # Gate compares time.time() - _last_apply_time < _APPLY_COOLDOWN_SECONDS.
        dm._last_apply_time = time.time()

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='cooldown-id',
        )

        assert result['success'] is False
        assert 'rate limited' in result['error']
        # No code on rate-limit — distinguishes transient from taxonomy failures.
        assert 'code' not in result
        # Helper never reached, no audit emitted (pre-apply gate).
        assert spawn_called == []
        assert fb.log_event.call_count == 0
        assert dm._apply_in_flight is False

    # 8. Feature-flag-off gate (Wave 6.1 master kill switch)

    def test_remote_apply_disabled_returns_disabled_error(
        self, monkeypatch, force_session_0, mock_mosaic_inactive,
        stub_resync, reset_apply_state,
    ):
        """``displays.remoteApplyEnabled`` not True rejects before any lock, audit
        event, or helper invocation. Master kill switch for the Wave 6 rollout — a
        fresh agent defaults OFF until the operator opts in.
        """
        # remoteApplyEnabled False here, vs the enable_remote_apply fixture's True.
        import shared_utils

        def _read(keys=None, **_kw):
            if keys == ['displays', 'remoteApplyEnabled']:
                return False
            return None

        monkeypatch.setattr(shared_utils, 'read_config', _read)

        spawn_called = []
        monkeypatch.setattr(
            dm, '_spawn_user_session_helper',
            lambda *a, **kw: spawn_called.append(True),
        )

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='killswitch-id',
        )

        assert result == {
            'success': False,
            'error': 'remote apply disabled by config',
        }
        assert spawn_called == []
        assert fb.log_event.call_count == 0
        # Pre-lock gate — flag never armed, never needs clearing.
        assert dm._apply_in_flight is False

    def test_displays_feature_disabled_returns_feature_off_error(
        self, monkeypatch, force_session_0, mock_mosaic_inactive,
        stub_resync, reset_apply_state,
    ):
        """The ``displays.enabled`` kill switch rejects with its own message. Pinning
        both switches here documents that they're independent: disabling the whole
        feature is distinct from disabling only the write path.
        """
        import shared_utils

        def _read(keys=None, **_kw):
            if keys == ['displays', 'enabled']:
                return False
            return None

        monkeypatch.setattr(shared_utils, 'read_config', _read)

        spawn_called = []
        monkeypatch.setattr(
            dm, '_spawn_user_session_helper',
            lambda *a, **kw: spawn_called.append(True),
        )

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='feature-off-id',
        )

        assert result == {
            'success': False,
            'error': 'displays feature disabled by config',
        }
        assert spawn_called == []
        assert fb.log_event.call_count == 0
        assert dm._apply_in_flight is False

    # 9. Mosaic-active refuse

    def test_mosaic_active_refuses_with_mosaic_active_code(
        self, monkeypatch, force_session_0, enable_remote_apply,
        stub_resync, reset_apply_state,
    ):
        """NVIDIA Mosaic active refuses cleanly with the ``mosaic_active`` code so
        the operator gets a specific error, not a driver-induced surprise. Emits
        ``display_apply_refused_mosaic``, not the generic ``display_apply_failed``.
        """
        import nvapi_display
        monkeypatch.setattr(
            # the shape detect_mosaic really returns: the guard once read a
            # `mosaicActive` key that only this mock ever carried, and never fired
            nvapi_display, 'detect_mosaic', lambda: {'active': True, 'grids': []},
        )

        spawn_called = []
        monkeypatch.setattr(
            dm, '_spawn_user_session_helper',
            lambda *a, **kw: spawn_called.append(True),
        )

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='mosaic-id',
        )

        assert result['success'] is False
        assert result['code'] == DisplayErrorCode.MOSAIC_ACTIVE
        assert 'Mosaic' in result['error']
        # Helper never reached — refuse-guard fires before the lock.
        assert spawn_called == []
        # Mosaic-specific audit event (not display_apply_failed).
        assert fb.log_event.called
        assert (
            fb.log_event.call_args.kwargs['action']
            == 'display_apply_refused_mosaic'
        )
        # Pre-lock gate — flag never armed.
        assert dm._apply_in_flight is False
