"""Unit tests for display_manager write path.

CCD calls (`_SetDisplayConfig`, `_query_active_paths_safe`, `_snapshot_live_config`,
`_apply_snapshot`) are patched — no real monitor or Windows session needed.
"""

import json
import os
import sys
import threading
import time
from unittest.mock import patch, MagicMock

import pytest

import display_manager as dm
from display_manager import DisplayErrorCode


SAMPLE_DESIRED = {
    'monitors': [
        {'edidHash': 'aaaaaaaa', 'primary': True, 'position': {'x': 0, 'y': 0}},
        {'edidHash': 'bbbbbbbb', 'primary': False, 'position': {'x': 1920, 'y': 0}},
    ],
}

SAMPLE_SNAPSHOT = {'paths': [], 'modes': []}


@pytest.fixture
def tmp_sentinel(tmp_path):
    """Point _get_sentinel_path at a per-test tmp file."""
    sentinel = tmp_path / '.display_revert_pending'
    with patch.object(dm, '_SENTINEL_PATH', str(sentinel)):
        yield str(sentinel)


@pytest.fixture
def reset_apply_state():
    """Clear apply_topology globals between tests so flag state doesn't leak."""
    yield
    dm._apply_in_flight = False
    dm._ack_event.clear()
    dm._current_apply_id = None
    dm._last_apply_time = 0.0


class TestDisplayErrorCode:
    """The enum is the IPC vocabulary; regressions here break the helper contract."""

    def test_enum_members_serialize_as_strings(self):
        # `DisplayErrorCode(str, Enum)` subclasses str, so JSON round-trips cleanly.
        payload = json.dumps({'code': DisplayErrorCode.APPLY_FAILED})
        assert '"apply_failed"' in payload

    @pytest.mark.parametrize('name,value', [
        ('BAD_REQUEST', 'bad_request'),
        ('QUERY_FAILED', 'query_failed'),
        ('MISSING_MONITORS', 'missing_monitors'),
        ('VALIDATE_REJECTED', 'validate_rejected'),
        ('APPLY_FAILED', 'apply_failed'),
        ('APPLY_TIMEOUT', 'apply_timeout'),
        ('SENTINEL_WRITE_FAILED', 'sentinel_write_failed'),
        ('UNSUPPORTED_SENTINEL_VERSION', 'unsupported_sentinel_version'),
        ('MOSAIC_ACTIVE', 'mosaic_active'),
        ('STALE_ACK', 'stale_ack'),
        ('NO_PENDING_APPLY', 'no_pending_apply'),
        ('HELPER_FAILED', 'helper_failed'),
        ('IPC_FAILURE', 'ipc_failure'),
        ('UNEXPECTED', 'unexpected'),
        ('ZERO_PRIMARY', 'zero_primary'),
        ('MULTIPLE_PRIMARY', 'multiple_primary'),
        ('INVALID_ROTATION', 'invalid_rotation'),
        ('UNSUPPORTED_MODE', 'unsupported_mode'),
        ('AUTO_RESTORE_SKIPPED_UNFIXABLE', 'auto_restore_skipped_unfixable'),
        ('AUTO_RESTORE_RATE_LIMITED', 'auto_restore_rate_limited'),
    ])
    def test_required_codes_present(self, name, value):
        assert getattr(DisplayErrorCode, name).value == value


class TestValidateDesiredLayout:
    """`_validate_desired_layout` shape-checks before the helper runs. Returns
    ``(ok, err, code)`` so the dashboard can tell 'no primary' from 'unknown field'."""

    def _monitor(self, **overrides):
        base = {
            'edidHash': 'aaaaaaaa',
            'position': {'x': 0, 'y': 0},
            'primary': False,
            'rotation': 0,
        }
        base.update(overrides)
        return base

    def test_accepts_canonical_layout(self):
        desired = {
            'monitors': [
                self._monitor(primary=True),
                self._monitor(edidHash='bbbbbbbb', position={'x': 1920, 'y': 0}),
            ],
        }
        ok, err, code = dm._validate_desired_layout(desired)
        assert ok is True
        assert err is None
        assert code is None

    def test_rejects_non_dict(self):
        ok, _, code = dm._validate_desired_layout('not a dict')
        assert ok is False
        assert code == DisplayErrorCode.INVALID_INPUT

    def test_rejects_empty_monitors(self):
        ok, _, code = dm._validate_desired_layout({'monitors': []})
        assert ok is False
        assert code == DisplayErrorCode.INVALID_INPUT

    def test_rejects_missing_edid_hash(self):
        desired = {'monitors': [self._monitor(primary=True, edidHash='')]}
        ok, _, code = dm._validate_desired_layout(desired)
        assert ok is False
        assert code == DisplayErrorCode.INVALID_INPUT

    def test_rejects_missing_position(self):
        m = self._monitor(primary=True)
        m.pop('position')
        ok, _, code = dm._validate_desired_layout({'monitors': [m]})
        assert ok is False
        assert code == DisplayErrorCode.INVALID_INPUT

    def test_rejects_zero_primary(self):
        desired = {'monitors': [self._monitor(), self._monitor(edidHash='bbbbbbbb')]}
        ok, err, code = dm._validate_desired_layout(desired)
        assert ok is False
        assert code == DisplayErrorCode.ZERO_PRIMARY
        assert 'primary' in err

    def test_rejects_multiple_primary(self):
        desired = {
            'monitors': [
                self._monitor(primary=True),
                self._monitor(edidHash='bbbbbbbb', primary=True),
            ],
        }
        ok, err, code = dm._validate_desired_layout(desired)
        assert ok is False
        assert code == DisplayErrorCode.MULTIPLE_PRIMARY
        assert '2' in err

    @pytest.mark.parametrize('bad_rotation', [1, 45, 91, 360, -90])
    def test_rejects_non_canonical_rotation(self, bad_rotation):
        desired = {'monitors': [self._monitor(primary=True, rotation=bad_rotation)]}
        ok, _, code = dm._validate_desired_layout(desired)
        assert ok is False
        assert code == DisplayErrorCode.INVALID_ROTATION

    @pytest.mark.parametrize('good_rotation', [0, 90, 180, 270])
    def test_accepts_canonical_rotations(self, good_rotation):
        desired = {'monitors': [self._monitor(primary=True, rotation=good_rotation)]}
        ok, _, code = dm._validate_desired_layout(desired)
        assert ok is True
        assert code is None

    def test_accepts_missing_rotation(self):
        # Legacy captures may omit `rotation` entirely — default to no check.
        m = self._monitor(primary=True)
        m.pop('rotation')
        ok, _, code = dm._validate_desired_layout({'monitors': [m]})
        assert ok is True
        assert code is None


class TestAckApply:
    """`ack_apply(apply_id)` gates on both `_apply_in_flight` and matching id."""

    def test_rejects_when_no_apply_in_flight(self, reset_apply_state):
        dm._apply_in_flight = False
        result = dm.ack_apply(apply_id='anything')
        assert result['success'] is False
        assert result['code'] == DisplayErrorCode.NO_PENDING_APPLY

    def test_rejects_stale_apply_id(self, reset_apply_state):
        dm._apply_in_flight = True
        dm._current_apply_id = 'current-apply-uuid'
        result = dm.ack_apply(apply_id='a-different-uuid')
        assert result['success'] is False
        assert result['code'] == DisplayErrorCode.STALE_ACK
        assert not dm._ack_event.is_set(), 'event must not fire on stale ack'

    def test_accepts_matching_apply_id(self, reset_apply_state):
        dm._apply_in_flight = True
        dm._current_apply_id = 'matching-uuid'
        dm._ack_event.clear()
        result = dm.ack_apply(apply_id='matching-uuid')
        assert result['success'] is True
        assert result['applyId'] == 'matching-uuid'
        assert dm._ack_event.is_set()

    def test_legacy_none_applyid_accepted(self, reset_apply_state):
        # Backwards-compat: callers that don't pass apply_id still ack.
        dm._apply_in_flight = True
        dm._current_apply_id = 'any-uuid'
        dm._ack_event.clear()
        result = dm.ack_apply(apply_id=None)
        assert result['success'] is True
        assert dm._ack_event.is_set()


class TestApplyCore:
    """`_apply_core` is the shared CCD sequence — helper and S1 both call it."""

    def _patch_ccd(self, monkeypatch, query_return, snapshot_return=SAMPLE_SNAPSHOT,
                   validate_rc=0, apply_rc=0, post_query_return=None):
        """Install stubs for the CCD operations."""
        monkeypatch.setattr(dm, '_query_active_paths_safe',
                            lambda: query_return if post_query_return is None
                            else post_query_return if getattr(self, '_call_count', 0) > 0
                            else query_return)

        def _edid_hash(*args, **kwargs):
            return 'aaaaaaaa'  # every path maps to the primary monitor
        monkeypatch.setattr(dm, '_edid_hash_for_target', _edid_hash)
        monkeypatch.setattr(dm, '_apply_desired_to_paths',
                            lambda *a, **kw: [{'monitorId': 'x', 'field': 'primary'}])
        monkeypatch.setattr(dm, '_count_active_paths', lambda paths: 1)
        monkeypatch.setattr(dm, '_snapshot_live_config', lambda: snapshot_return)
        # Return an rc per-call: first call = validate, subsequent = apply
        rcs = iter([validate_rc, apply_rc, apply_rc])
        monkeypatch.setattr(dm, '_SetDisplayConfig', lambda *a, **kw: next(rcs))

    def test_query_failure(self, monkeypatch, tmp_sentinel):
        monkeypatch.setattr(dm, '_query_active_paths_safe', lambda: None)
        result = dm._apply_core(SAMPLE_DESIRED, tmp_sentinel, 30, 'test-id')
        assert result['ok'] is False
        assert result['code'] == DisplayErrorCode.QUERY_FAILED
        assert not os.path.exists(tmp_sentinel), 'no sentinel on query failure'

    def test_missing_monitors(self, monkeypatch, tmp_sentinel):
        # Live topology only has 'aaaaaaaa'; desired includes 'bbbbbbbb'.
        mock_path = MagicMock()
        mock_path.flags = dm.DISPLAYCONFIG_PATH_ACTIVE
        monkeypatch.setattr(dm, '_query_active_paths_safe',
                            lambda: ([mock_path], []))
        monkeypatch.setattr(dm, '_edid_hash_for_target',
                            lambda *a, **kw: 'aaaaaaaa')
        result = dm._apply_core(SAMPLE_DESIRED, tmp_sentinel, 30, 'test-id')
        assert result['ok'] is False
        assert result['code'] == DisplayErrorCode.MISSING_MONITORS
        assert 'bbbbbbbb' in result['missing']
        assert not os.path.exists(tmp_sentinel)



class TestCcdFailureCode:
    """`_ccd_failure_code(rc, stage)` maps SetDisplayConfig rcs so the dashboard can
    tell an unsupported-mode rejection from a generic config-rejected failure."""

    @pytest.mark.parametrize('rc', [dm.ERROR_GEN_FAILURE, dm.ERROR_BAD_CONFIGURATION])
    @pytest.mark.parametrize('stage', ['validate', 'apply'])
    def test_mode_rcs_map_to_unsupported_mode(self, rc, stage):
        # 31 (post-TDR-retry) and 1610 (driver rejection) both mean unsupported mode.
        assert dm._ccd_failure_code(rc, stage) == DisplayErrorCode.UNSUPPORTED_MODE

    def test_other_rc_at_validate_stays_generic(self):
        # ERROR_INVALID_PARAMETER is ambiguous; keep it generic so UNSUPPORTED_MODE stays precise.
        assert (
            dm._ccd_failure_code(87, 'validate')
            == DisplayErrorCode.VALIDATE_REJECTED
        )

    def test_other_rc_at_apply_stays_generic(self):
        assert dm._ccd_failure_code(87, 'apply') == DisplayErrorCode.APPLY_FAILED

    def test_zero_rc_not_called_in_practice_but_maps_to_generic(self):
        # rc 0 never reaches this helper; guard against a refactor tagging success
        # as UNSUPPORTED_MODE.
        assert (
            dm._ccd_failure_code(0, 'validate') == DisplayErrorCode.VALIDATE_REJECTED
        )
        assert dm._ccd_failure_code(0, 'apply') == DisplayErrorCode.APPLY_FAILED


class TestApplyRevertFromSentinel:
    """Startup recovery must fail loud on corruption; preserve sentinel on transient errors."""

    def test_no_sentinel_returns_cleanly(self, tmp_sentinel):
        result = dm.apply_revert_from_sentinel()
        assert result['success'] is False
        assert 'no sentinel' in result['error']

    def test_malformed_json_preserves_sentinel(self, tmp_sentinel):
        # Write garbage; apply_revert_from_sentinel should NOT delete it.
        with open(tmp_sentinel, 'w') as f:
            f.write('not valid json {{{')
        result = dm.apply_revert_from_sentinel()
        assert result['success'] is False
        assert result['code'] == DisplayErrorCode.SENTINEL_MALFORMED
        assert os.path.exists(tmp_sentinel), 'malformed sentinel preserved for operator'

    def test_unsupported_version_preserves_sentinel(self, tmp_sentinel):
        with open(tmp_sentinel, 'w') as f:
            json.dump({'version': 999, 'snapshot': {}}, f)
        result = dm.apply_revert_from_sentinel()
        assert result['success'] is False
        assert result['code'] == DisplayErrorCode.UNSUPPORTED_SENTINEL_VERSION
        assert os.path.exists(tmp_sentinel), 'future-version sentinel preserved'

    def test_missing_snapshot_cleans_sentinel(self, tmp_sentinel):
        # Well-formed JSON but no `snapshot` field — not transient, cleanup.
        with open(tmp_sentinel, 'w') as f:
            json.dump({'version': 1}, f)
        result = dm.apply_revert_from_sentinel()
        assert result['success'] is False
        assert not os.path.exists(tmp_sentinel)

    def test_transient_oserror_preserves_sentinel(self, tmp_sentinel):
        # Simulate a file-read hiccup; sentinel must stay on disk for retry.
        with open(tmp_sentinel, 'w') as f:
            json.dump({'version': 1, 'snapshot': {}}, f)

        real_open = open
        call_count = {'n': 0}

        def flaky_open(path, *args, **kwargs):
            if str(path) == tmp_sentinel and 'r' in (args[0] if args else kwargs.get('mode', 'r')):
                call_count['n'] += 1
                if call_count['n'] == 1:
                    raise OSError('transient read failure')
            return real_open(path, *args, **kwargs)

        with patch('builtins.open', flaky_open):
            result = dm.apply_revert_from_sentinel()
        assert result['success'] is False
        assert result.get('deferred') is True
        assert os.path.exists(tmp_sentinel), 'OSError preserves sentinel for retry'


class TestMakeRevertWatchdog:
    """The shared watchdog factory dedupes S0 + S1 paths."""

    def test_ack_cancels_revert(self, reset_apply_state):
        revert_called = threading.Event()
        dm._apply_in_flight = True
        dm._ack_event.clear()

        def _revert():
            revert_called.set()
            return {'ok': True}

        watchdog = dm._make_revert_watchdog(_revert, 1, None)
        t = threading.Thread(target=watchdog, daemon=True)
        t.start()
        # Ack immediately — watchdog should exit before calling revert.
        dm._ack_event.set()
        t.join(timeout=0.5)
        assert not revert_called.is_set(), 'revert must not run when ack fires'
        assert dm._apply_in_flight is False

    def test_timeout_fires_revert(self, reset_apply_state):
        revert_called = threading.Event()
        dm._apply_in_flight = True
        dm._ack_event.clear()

        def _revert():
            revert_called.set()
            return {'ok': True}

        watchdog = dm._make_revert_watchdog(_revert, 0.05, None)  # 50ms timeout
        t = threading.Thread(target=watchdog, daemon=True)
        t.start()
        t.join(timeout=1.0)
        assert revert_called.is_set(), 'revert fires on ack timeout'
        assert dm._apply_in_flight is False

    def test_failed_revert_preserves_apply_in_flight_clear(self, reset_apply_state):
        # Even if revert_fn raises, the finally block must clear _apply_in_flight.
        dm._apply_in_flight = True
        dm._ack_event.clear()

        def _revert_raises():
            raise RuntimeError('boom')

        watchdog = dm._make_revert_watchdog(_revert_raises, 0.05, None)
        t = threading.Thread(target=watchdog, daemon=True)
        t.start()
        t.join(timeout=1.0)
        assert dm._apply_in_flight is False



def _make_enum_mock(specs):
    """Fake ``_EnumDisplaySettingsExW`` serving synthetic modes by index; a ``None``
    entry or an index past the list ends enumeration (FALSE), as Win32 does.

    Writes into the caller's DEVMODEW via the byref's ``._obj`` — a CPython detail,
    but stable, and the alternative distorts production code for test scaffolding.
    """
    def _mock(device_name, mode_num, dev_ref, flags):
        if mode_num >= len(specs) or specs[mode_num] is None:
            return 0  # FALSE — end of enumeration
        spec = specs[mode_num]
        dev = dev_ref._obj
        dev.dmBitsPerPel = spec.get('bpp', 32)
        dev._u2.dmDisplayFlags = spec.get('flags', 0)
        dev.dmDisplayFrequency = spec.get('hz', 60)
        dev.dmPelsWidth = spec.get('w', 1920)
        dev.dmPelsHeight = spec.get('h', 1080)
        return 1  # TRUE
    return _mock


class TestEnumerateModes:
    """`_enum_modes_for_monitor` filter/dedup/sort plus `_build_display_modes_catalogue`
    byEdidHash keying — the shape the dashboard resolution/refresh dropdowns read."""

    def test_filters_interlaced_and_16bpp_and_low_hz(self, monkeypatch):
        # One interlaced, one 16bpp, one <24Hz (all dropped) plus one valid.
        monkeypatch.setattr(dm, '_EnumDisplaySettingsExW', _make_enum_mock([
            {'bpp': 32, 'flags': dm.DM_INTERLACED, 'hz': 60, 'w': 1920, 'h': 1080},
            {'bpp': 16, 'flags': 0, 'hz': 60, 'w': 1920, 'h': 1080},
            {'bpp': 32, 'flags': 0, 'hz': 10, 'w': 1920, 'h': 1080},
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 1920, 'h': 1080},
        ]))
        out = dm._enum_modes_for_monitor(r'\\.\DISPLAY1')
        assert out == [{'w': 1920, 'h': 1080, 'hz': 60}]

    def test_dedupes_repeated_tuples(self, monkeypatch):
        # Same (w, h, hz) offered four times under different BPPs/flags — dedupe to one.
        monkeypatch.setattr(dm, '_EnumDisplaySettingsExW', _make_enum_mock([
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 1920, 'h': 1080},
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 1920, 'h': 1080},
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 1920, 'h': 1080},
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 1920, 'h': 1080},
        ]))
        out = dm._enum_modes_for_monitor(r'\\.\DISPLAY1')
        assert out == [{'w': 1920, 'h': 1080, 'hz': 60}]

    def test_sorts_descending_w_h_hz(self, monkeypatch):
        # Shuffled input — expect strictly descending (w, h, hz) output.
        monkeypatch.setattr(dm, '_EnumDisplaySettingsExW', _make_enum_mock([
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 1920, 'h': 1080},
            {'bpp': 32, 'flags': 0, 'hz': 120, 'w': 1920, 'h': 1080},
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 3840, 'h': 2160},
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 2560, 'h': 1440},
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 2560, 'h': 1080},  # same w, smaller h
        ]))
        out = dm._enum_modes_for_monitor(r'\\.\DISPLAY1')
        assert out == [
            {'w': 3840, 'h': 2160, 'hz': 60},
            {'w': 2560, 'h': 1440, 'hz': 60},
            {'w': 2560, 'h': 1080, 'hz': 60},
            {'w': 1920, 'h': 1080, 'hz': 120},
            {'w': 1920, 'h': 1080, 'hz': 60},
        ]

    def test_empty_device_name_short_circuits(self):
        # Guard at the top of _enum_modes_for_monitor — never calls Win32.
        assert dm._enum_modes_for_monitor('') == []
        assert dm._enum_modes_for_monitor(None) == []

    def test_catalogue_keys_one_per_edidhash(self, monkeypatch):
        # Stub everything the catalogue builder calls: two active paths, distinct
        # edidHashes, canned modes each.

        # 1. Skip the profile walk (we only need its signatureHash surfaced).
        monkeypatch.setattr(dm, 'build_display_profile', lambda: {
            'schemaVersion': dm.SCHEMA_VERSION,
            'signatureHash': 'deadbeef' * 4,  # 32 chars
            'capturedAt': 1_700_000_000,
            'monitors': [],
            'mosaicActive': False,
            'enumerationFailed': False,
        })

        # 2. Two stub paths with distinct (adapterId, sourceId, targetId) tuples.
        def _stub_path(adapter_id, source_id, target_id):
            p = MagicMock()
            p.flags = dm.DISPLAYCONFIG_PATH_ACTIVE
            p.sourceInfo.adapterId = adapter_id
            p.sourceInfo.id = source_id
            p.targetInfo.adapterId = adapter_id
            p.targetInfo.id = target_id
            return p

        paths = [_stub_path('A1', 0, 100), _stub_path('A1', 1, 101)]
        monkeypatch.setattr(dm, '_query_active_paths_safe', lambda: (paths, []))

        # 3. Fake target-device-name returns shaped like the real one.
        def _fake_target_name(adapter, target):
            info = MagicMock()
            info.monitorFriendlyDeviceName = f'MON{target}'
            info.flags.bits.edidIdsValid = 1
            # Distinct mfg/product per target so the edidHashes differ.
            info.edidManufactureId = 0x1000 + target
            info.edidProductCodeId = target
            info.monitorDevicePath = f'\\\\?\\DISPLAY#TST{target}#5&abc&0&UID{target}#{{x}}'
            return info
        monkeypatch.setattr(dm, '_get_target_device_name', _fake_target_name)

        # 4. Source-name lookup — deterministic per sourceId.
        def _fake_source_name(adapter, source_id):
            return f'\\\\.\\DISPLAY{source_id + 1}'
        monkeypatch.setattr(dm, '_get_source_device_name', _fake_source_name)

        # 5. Canned modes per monitor — keyed on the gdi name.
        modes_by_gdi = {
            r'\\.\DISPLAY1': [{'w': 3840, 'h': 2160, 'hz': 60}],
            r'\\.\DISPLAY2': [
                {'w': 2560, 'h': 1440, 'hz': 144},
                {'w': 1920, 'h': 1080, 'hz': 60},
            ],
        }
        monkeypatch.setattr(dm, '_enum_modes_for_monitor',
                            lambda name: list(modes_by_gdi.get(name, [])))

        cat = dm._build_display_modes_catalogue()
        assert cat['schemaVersion'] == dm.SCHEMA_VERSION
        assert cat['signatureHash'] == 'deadbeef' * 4
        assert len(cat['byEdidHash']) == 2, 'one key per distinct edidHash'
        # Modes land under their monitor's edidHash — spot-check the counts.
        counts = sorted(len(info['modes']) for info in cat['byEdidHash'].values())
        assert counts == [1, 2]
        # Every entry carries the full DPI scale table.
        for info in cat['byEdidHash'].values():
            assert info['dpiScales'] == list(dm._DPI_SCALE_TABLE)

    def test_catalogue_tolerates_empty_modes(self, monkeypatch):
        # EnumDisplaySettings returning nothing must still yield the edidHash with
        # modes: [] — don't fail the whole catalogue.
        monkeypatch.setattr(dm, 'build_display_profile', lambda: {
            'schemaVersion': dm.SCHEMA_VERSION,
            'signatureHash': 'cafe' * 8,
            'capturedAt': 1_700_000_000,
            'monitors': [],
            'mosaicActive': False,
            'enumerationFailed': False,
        })
        p = MagicMock()
        p.flags = dm.DISPLAYCONFIG_PATH_ACTIVE
        p.sourceInfo.adapterId = 'A'
        p.sourceInfo.id = 0
        p.targetInfo.adapterId = 'A'
        p.targetInfo.id = 77
        monkeypatch.setattr(dm, '_query_active_paths_safe', lambda: ([p], []))

        info = MagicMock()
        info.monitorFriendlyDeviceName = 'HEADLESS'
        info.flags.bits.edidIdsValid = 1
        info.edidManufactureId = 0x1077
        info.edidProductCodeId = 77
        info.monitorDevicePath = r'\\?\DISPLAY#HDL#0&0&0&UID77#{x}'
        monkeypatch.setattr(dm, '_get_target_device_name', lambda *a, **kw: info)
        monkeypatch.setattr(dm, '_get_source_device_name',
                            lambda *a, **kw: r'\\.\DISPLAY1')
        monkeypatch.setattr(dm, '_enum_modes_for_monitor', lambda name: [])

        cat = dm._build_display_modes_catalogue()
        assert len(cat['byEdidHash']) == 1
        only_entry = next(iter(cat['byEdidHash'].values()))
        assert only_entry['modes'] == []
        assert only_entry['dpiScales'] == list(dm._DPI_SCALE_TABLE)

    def test_catalogue_surfaces_enumeration_failed(self, monkeypatch):
        # enumerationFailed short-circuits to an empty byEdidHash with the flag set;
        # A3.2 reads it and skips the Firestore upload.
        monkeypatch.setattr(dm, 'build_display_profile', lambda: {
            'schemaVersion': dm.SCHEMA_VERSION,
            'signatureHash': '0' * 32,
            'capturedAt': 1_700_000_000,
            'monitors': [],
            'mosaicActive': False,
            'enumerationFailed': True,
        })
        cat = dm._build_display_modes_catalogue()
        assert cat['enumerationFailed'] is True
        assert cat['byEdidHash'] == {}



@pytest.fixture
def reset_suppression_state():
    """Restore `_last_apply_finished_at` after each test. Default 0.0 = no apply
    since startup."""
    yield
    dm._last_apply_finished_at = 0.0


class TestSuppressionWindow:
    """`is_within_apply_suppression_window(now, window_s)` backs owlette_service's
    `suppressAlert` stamping. Default 90s; the initial 0.0 timestamp returns False."""

    def test_initial_state_is_not_suppressed(self, reset_suppression_state):
        # No apply yet — drift in the first 90s of uptime must not be misclassified
        # as apply-correlated, or real bootup drift is never surfaced.
        dm._last_apply_finished_at = 0.0
        assert dm.is_within_apply_suppression_window(now=1_700_000_000.0) is False

    def test_event_within_window_is_suppressed(self, reset_suppression_state):
        # 30s after apply: the OS-settling drift events that always follow get tagged.
        dm._last_apply_finished_at = 1_700_000_000.0
        assert (
            dm.is_within_apply_suppression_window(now=1_700_000_030.0) is True
        )

    def test_event_at_window_edge_is_suppressed(self, reset_suppression_state):
        # Strictly-less-than gate: 89.999s still qualifies (off-by-one guard).
        dm._last_apply_finished_at = 1_700_000_000.0
        assert (
            dm.is_within_apply_suppression_window(now=1_700_000_089.999) is True
        )

    def test_event_after_window_is_not_suppressed(self, reset_suppression_state):
        # 91s after apply — real operator-relevant drift, route it as a normal alert.
        dm._last_apply_finished_at = 1_700_000_000.0
        assert (
            dm.is_within_apply_suppression_window(now=1_700_000_091.0) is False
        )

    def test_window_boundary_exactly_90s_is_not_suppressed(
        self, reset_suppression_state,
    ):
        # `<` not `<=`: 90.0 exactly falls OUTSIDE the window.
        dm._last_apply_finished_at = 1_700_000_000.0
        assert (
            dm.is_within_apply_suppression_window(now=1_700_000_090.0) is False
        )

    def test_custom_window_s_overrides_default(self, reset_suppression_state):
        # Caller override: 30s window with a 60s gap → not suppressed.
        dm._last_apply_finished_at = 1_700_000_000.0
        assert (
            dm.is_within_apply_suppression_window(
                now=1_700_000_060.0, window_s=30.0,
            ) is False
        )
        # Same gap, 90s window → suppressed (sanity-check the override).
        assert (
            dm.is_within_apply_suppression_window(
                now=1_700_000_060.0, window_s=90.0,
            ) is True
        )

    def test_now_defaults_to_wall_clock(self, reset_suppression_state):
        # Omitted `now` reads time.time(); set the timestamp from the same source.
        import time as _time
        dm._last_apply_finished_at = _time.time()
        assert dm.is_within_apply_suppression_window() is True
        # Converse: an old apply timestamp is outside the window on the default-now path.
        dm._last_apply_finished_at = _time.time() - 3600
        assert dm.is_within_apply_suppression_window() is False



class TestApplyTopologyAutoRestore:
    """`apply_topology(..., auto_restore=True)`: unattended drift correction driven by
    the topology checker. Success skips the watchdog (no operator to ack), removes the
    sentinel, and emits ``display_auto_restore_fired``."""

    def _patch_auto_restore_success_path(self, monkeypatch, changes=None):
        """Force the S1 in-process branch with `_apply_core` returning success.
        Stubs session probe, Mosaic detect, read_config, CCD apply, resync trigger."""
        if changes is None:
            changes = [{'monitorId': 'aaaaaaaa', 'field': 'primary'}]

        # Force S1 (in-process) so `_apply_core` is the success-path stub point.
        monkeypatch.setattr(dm, '_is_session_0', lambda: False)

        # `displays.enabled` absent → enabled by default; `remoteApplyEnabled` must
        # read True or the master kill switch rejects the apply.
        import shared_utils

        def _read_config(keys=None, **kw):
            if keys == ['displays', 'remoteApplyEnabled']:
                return True
            return None
        monkeypatch.setattr(shared_utils, 'read_config', _read_config)

        # Mosaic refuse-guard inactive on the test host.
        import nvapi_display
        monkeypatch.setattr(
            nvapi_display, 'detect_mosaic', lambda: {'mosaicActive': False},
        )

        # `_apply_core` is the only CCD-touching call on S1; stub it so we never hit Win32.
        monkeypatch.setattr(
            dm,
            '_apply_core',
            lambda *a, **kw: {'ok': True, 'changes': changes, '_snapshot': SAMPLE_SNAPSHOT},
        )
        # `_trigger_profile_resync` is fire-and-forget; stub it off the firebase client.
        monkeypatch.setattr(dm, '_trigger_profile_resync', lambda fb: None)

        return changes

    def test_no_watchdog_thread_started_on_success(
        self, monkeypatch, tmp_sentinel, reset_apply_state,
    ):
        self._patch_auto_restore_success_path(monkeypatch)
        # Pre-test sanity: no leftover watchdog from a prior test in this proc.
        assert not any(
            t.name == 'display-apply-watchdog' and t.is_alive()
            for t in threading.enumerate()
        )
        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='test-apply-1',
            auto_restore=True,
        )
        assert result['success'] is True
        # Watchdog is the only thing that holds `_apply_in_flight` past return.
        assert dm._apply_in_flight is False
        assert not any(
            t.name == 'display-apply-watchdog' and t.is_alive()
            for t in threading.enumerate()
        ), 'auto-restore success path must not arm a revert watchdog'

    def test_sentinel_cleaned_up_on_success(
        self, monkeypatch, tmp_sentinel, reset_apply_state,
    ):
        self._patch_auto_restore_success_path(monkeypatch)
        # Auto-restore success must remove an orphaned sentinel — drift re-fires from
        # a fresh state on the next checker tick.
        with open(tmp_sentinel, 'w') as f:
            json.dump({'version': 1, 'snapshot': {}}, f)
        assert os.path.exists(tmp_sentinel)
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=MagicMock(),
            apply_id='test-apply-2', auto_restore=True,
        )
        assert result['success'] is True
        assert not os.path.exists(tmp_sentinel), \
            'auto-restore success must clean up any sentinel on disk'

    def test_audit_event_shape(
        self, monkeypatch, tmp_sentinel, reset_apply_state,
    ):
        changes = [
            {'monitorId': 'aaaaaaaa', 'field': 'primary'},
            {'monitorId': 'bbbbbbbb', 'field': 'position'},
        ]
        self._patch_auto_restore_success_path(monkeypatch, changes=changes)
        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb,
            apply_id='audit-id-xyz', auto_restore=True,
        )
        assert result['success'] is True
        # Exactly one audit event on the auto-restore success path.
        assert fb.log_event.call_count == 1
        kwargs = fb.log_event.call_args.kwargs
        assert kwargs['action'] == 'display_auto_restore_fired'
        assert kwargs['level'] == 'info'
        extras = kwargs['extra_fields']
        assert extras['eventType'] == 'display_auto_restore_fired'
        assert extras['autoRestore'] is True
        assert extras['applyId'] == 'audit-id-xyz'
        assert extras['monitorCount'] == len(SAMPLE_DESIRED['monitors'])
        assert extras['changes'] == changes

    def test_lock_contention_returns_graceful_error(
        self, monkeypatch, tmp_sentinel, reset_apply_state,
    ):
        self._patch_auto_restore_success_path(monkeypatch)
        # Hold the apply lock to simulate contention; the holder owns the in-flight flag.
        dm._apply_in_flight = True
        assert dm._apply_lock.acquire(blocking=False), 'precondition: lock free'
        try:
            fb = MagicMock()
            result = dm.apply_topology(
                SAMPLE_DESIRED, firebase_client=fb,
                apply_id='contention-id', auto_restore=True,
            )
            assert result['success'] is False
            assert 'apply already in progress' in result['error']
            # Contention path emits no audit event — it's a pre-apply gate.
            assert fb.log_event.call_count == 0
            # The contention return must NOT touch `_apply_in_flight` — the in-flight apply owns it.
            assert dm._apply_in_flight is True
        finally:
            dm._apply_lock.release()

    def test_rate_limit_returns_cooldown_response(
        self, monkeypatch, tmp_sentinel, reset_apply_state,
    ):
        import time as _time
        self._patch_auto_restore_success_path(monkeypatch)
        # Simulate an apply that finished < cooldown ago.
        original_last = dm._last_apply_time
        dm._last_apply_time = _time.time()
        try:
            fb = MagicMock()
            result = dm.apply_topology(
                SAMPLE_DESIRED, firebase_client=fb,
                apply_id='cooldown-id', auto_restore=True,
            )
            assert result['success'] is False
            assert 'rate limited' in result['error']
            # No `code` field — C2 distinguishes rate-limit (transient) from a failure.
            assert 'code' not in result
            # No audit event on rate-limit return.
            assert fb.log_event.call_count == 0
        finally:
            dm._last_apply_time = original_last

    def test_killswitch_returns_disabled_error(
        self, monkeypatch, tmp_sentinel, reset_apply_state,
    ):
        # Only displays.enabled reads False; Mosaic stub stays in case the killswitch
        # gate ever moves.
        import shared_utils
        import nvapi_display
        monkeypatch.setattr(dm, '_is_session_0', lambda: False)
        monkeypatch.setattr(
            nvapi_display, 'detect_mosaic', lambda: {'mosaicActive': False},
        )

        def _fake_read_config(keys=None, **kw):
            if keys == ['displays', 'enabled']:
                return False
            return None
        monkeypatch.setattr(shared_utils, 'read_config', _fake_read_config)

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb,
            apply_id='killswitch-id', auto_restore=True,
        )
        assert result == {
            'success': False,
            'error': 'displays feature disabled by config',
        }
        # Killswitch returns before any audit emit — no event on disable.
        assert fb.log_event.call_count == 0

    def test_return_shape_on_success(
        self, monkeypatch, tmp_sentinel, reset_apply_state,
    ):
        changes = [{'monitorId': 'aaaaaaaa', 'field': 'primary'}]
        self._patch_auto_restore_success_path(monkeypatch, changes=changes)
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=MagicMock(),
            apply_id='shape-id', auto_restore=True,
        )
        # C2's `_maybe_auto_restore` reads each of these fields; pin the shape.
        assert result['success'] is True
        assert result['autoRestore'] is True
        assert result['applyId'] == 'shape-id'
        assert result['changes'] == changes



class _FakeService:
    """Minimum surface to bind `OwletteService._maybe_auto_restore` and
    `_run_auto_restore` as bound methods; a real OwletteService drags in pywin32,
    watchdogs and Firestore listeners. Bind via ``.__get__(fake, OwletteService)``."""

    _DISPLAY_DRIFT_FIELDS = (
        ('position.x',        lambda m: (m.get('position') or {}).get('x')),
        ('position.y',        lambda m: (m.get('position') or {}).get('y')),
        ('resolution.width',  lambda m: (m.get('resolution') or {}).get('width')),
        ('resolution.height', lambda m: (m.get('resolution') or {}).get('height')),
        ('refreshHz',         lambda m: m.get('refreshHz')),
        ('rotation',          lambda m: m.get('rotation')),
        ('scalePct',          lambda m: m.get('scalePct')),
        ('primary',           lambda m: m.get('primary')),
    )

    def __init__(self):
        # Both methods reach `self._emit_display_event` via the unfixable /
        # breaker-trip branches.
        self.firebase_client = MagicMock()
        # Drift-persistence gate (gate 6): default at the firing threshold.
        self._drift_pending_tick_count = 2
        self._drift_pending_key = None
        self._last_auto_restore_success_key = None
        # Mocked so tests can assert call_args_list against real production payloads.
        self._emit_display_event = MagicMock()


class TestAutoRestoreCycle:
    """Full auto-restore cycle: drift -> apply -> failure-counter -> breaker trip ->
    skip-while-tripped -> manual reset re-enables. Mocks at the I/O boundary only; the
    real methods bind to `_FakeService` so the orchestration logic runs unmodified."""

    @pytest.fixture
    def fake_service(self):
        from owlette_service import OwletteService
        svc = _FakeService()
        # Bind the production methods via the descriptor protocol so the real branches
        # and call shapes execute against the fake's attributes.
        svc._maybe_auto_restore = OwletteService._maybe_auto_restore.__get__(
            svc, OwletteService,
        )
        svc._AUTO_RESTORE_DRIFT_FIELDS = OwletteService._AUTO_RESTORE_DRIFT_FIELDS
        svc._AUTO_RESTORE_REFRESH_TOLERANCE_HZ = (
            OwletteService._AUTO_RESTORE_REFRESH_TOLERANCE_HZ
        )
        svc._auto_restore_values_equal = OwletteService._auto_restore_values_equal
        svc._auto_restore_field_is_enforceable = (
            OwletteService._auto_restore_field_is_enforceable
        )
        svc._auto_restore_key_value = OwletteService._auto_restore_key_value
        svc._auto_restore_apply_was_skip = OwletteService._auto_restore_apply_was_skip
        svc._assigned_drift_details = (
            OwletteService._assigned_drift_details.__get__(svc, OwletteService)
        )
        svc._assigned_drift_hashes = OwletteService._assigned_drift_hashes.__get__(
            svc, OwletteService,
        )
        svc._assigned_drift_key = OwletteService._assigned_drift_key
        svc._maybe_auto_restore_assigned_drift = (
            OwletteService._maybe_auto_restore_assigned_drift.__get__(
                svc, OwletteService,
            )
        )
        svc._run_auto_restore = OwletteService._run_auto_restore.__get__(
            svc, OwletteService,
        )
        return svc

    @pytest.fixture
    def assigned_layout(self):
        # Same shape the gates pull from `displays.assigned` in a real config.
        return {
            'monitors': [
                {'edidHash': 'aaaaaaaa', 'primary': True,
                 'position': {'x': 0, 'y': 0}},
                {'edidHash': 'bbbbbbbb', 'primary': False,
                 'position': {'x': 1920, 'y': 0}},
            ],
        }

    def _make_config_reader(self, config_state):
        """`shared_utils.read_config` stub resolving dotted-key paths from a nested
        ``config_state``; returns None on a missing key, like production."""
        def _read(keys=None, **kw):
            if not keys:
                return config_state
            cur = config_state
            for k in keys:
                if not isinstance(cur, dict):
                    return None
                cur = cur.get(k)
                if cur is None:
                    return None
            return cur
        return _read

    def test_full_cycle(
        self, monkeypatch, fake_service, assigned_layout, reset_apply_state,
    ):
        """End-to-end: 3 consecutive failures trip the breaker, the next drift is
        skipped while tripped, a manual reset re-enables firing. Failure steps call
        `_run_auto_restore` directly so assertions don't race the thread spawn."""
        import shared_utils
        import display_manager as dm_mod

        # Mutable config state driving both read_config and the breaker counter; tests
        # mutate it to simulate the Firestore -> config.json sync.
        config_state = {
            'displays': {
                'enabled': True,
                'autoRestore': {
                    'enabled': True,
                    'circuitBreaker': {'failures': 0, 'tripped': False},
                },
                'assigned': assigned_layout,
            },
        }
        monkeypatch.setattr(
            shared_utils, 'read_config', self._make_config_reader(config_state),
        )

        # `update_display_autorestore_state` is the only Firestore write for breaker
        # bookkeeping; writes propagate back into config_state to mirror the sync tick.
        def _record_state_write(patch):
            cb = config_state['displays']['autoRestore']['circuitBreaker']
            cb.update(patch)
        fake_service.firebase_client.update_display_autorestore_state.side_effect = (
            _record_state_write
        )

        # fail, fail, fail — generic apply-failure codes (not skips, which don't increment).
        apply_results = [
            {'success': False, 'error': 'ccd rejected layout',
             'code': dm_mod.DisplayErrorCode.APPLY_FAILED},
            {'success': False, 'error': 'set-display-config rc=87',
             'code': dm_mod.DisplayErrorCode.VALIDATE_REJECTED},
            {'success': False, 'error': 'unsupported mode',
             'code': dm_mod.DisplayErrorCode.UNSUPPORTED_MODE},
        ]
        apply_calls = []

        def _mock_apply_topology(layout, **kw):
            apply_calls.append({'layout': layout, 'kwargs': kw})
            return apply_results[len(apply_calls) - 1]

        monkeypatch.setattr(dm_mod, 'apply_topology', _mock_apply_topology)

        # Failure 1: counter -> 1, breaker untripped.
        fake_service._run_auto_restore(assigned_layout)
        cb = config_state['displays']['autoRestore']['circuitBreaker']
        assert cb['failures'] == 1
        assert cb.get('tripped') is False
        # No trip event yet — only fires when failures >= 3.
        assert fake_service._emit_display_event.call_count == 0

        # Failure 2: counter -> 2, breaker still untripped.
        fake_service._run_auto_restore(assigned_layout)
        cb = config_state['displays']['autoRestore']['circuitBreaker']
        assert cb['failures'] == 2
        assert cb.get('tripped') is False
        assert fake_service._emit_display_event.call_count == 0

        # Failure 3: counter -> 3, breaker trips, audit event fires.
        fake_service._run_auto_restore(assigned_layout)
        cb = config_state['displays']['autoRestore']['circuitBreaker']
        assert cb['failures'] == 3
        assert cb['tripped'] is True
        assert 'trippedAt' in cb
        # The trip event must fire exactly once at the trip moment.
        assert fake_service._emit_display_event.call_count == 1
        trip_call = fake_service._emit_display_event.call_args_list[0]
        # _emit_display_event(event_type, severity, payload) — positional.
        assert trip_call.args[0] == 'display_auto_restore_circuit_breaker_tripped'
        assert trip_call.args[1] == 'error'
        trip_payload = trip_call.args[2]
        assert trip_payload['eventType'] == (
            'display_auto_restore_circuit_breaker_tripped'
        )
        assert trip_payload['failures'] == 3
        assert trip_payload['lastError'] == 'unsupported mode'

        # 3 apply_topology calls so far; no more while tripped.
        assert len(apply_calls) == 3

        # New drift while tripped: gate 3 short-circuits before the thread spawn.
        # Live topology carries the assigned monitors so the post-reset apply isn't
        # blocked by gate 5b.
        new_profile = {
            'monitors': [
                {'edidHash': 'aaaaaaaa', 'primary': True,
                 'position': {'x': 0, 'y': 0}},
                {'edidHash': 'bbbbbbbb', 'primary': False,
                 'position': {'x': 1920, 'y': 0}},
            ],
            'signatureHash': 'abc',
        }
        drifted_hashes = ['aaaaaaaa']
        fake_service._maybe_auto_restore(new_profile, drifted_hashes)
        # Apply count unchanged, no new audit events.
        assert len(apply_calls) == 3
        assert fake_service._emit_display_event.call_count == 1

        # Manual reset: dashboard writes tripped=False and clears failures (the endpoint
        # clears both atomically); the Firestore listener propagates it into config.json.
        config_state['displays']['autoRestore']['circuitBreaker'] = {
            'failures': 0, 'tripped': False,
        }
        # Next apply succeeds; `_run_auto_restore` is called manually so the test doesn't
        # depend on thread-spawn timing.
        success_changes = [{'monitorId': 'aaaaaaaa', 'field': 'primary'}]
        success_result = {
            'success': True,
            'applyId': 'reset-apply-id',
            'autoRestore': True,
            'changes': success_changes,
        }
        post_reset_calls = []

        def _mock_apply_success(layout, **kw):
            post_reset_calls.append({'layout': layout, 'kwargs': kw})
            return success_result

        monkeypatch.setattr(dm_mod, 'apply_topology', _mock_apply_success)

        # Capture the spawned thread so we can join deterministically instead of racing.
        spawned = []
        real_thread_cls = threading.Thread

        def _capture_thread(target, args=(), daemon=False, name=None, **kw):
            t = real_thread_cls(
                target=target, args=args, daemon=daemon, name=name, **kw,
            )
            spawned.append(t)
            return t
        monkeypatch.setattr(threading, 'Thread', _capture_thread)

        fake_service._maybe_auto_restore(new_profile, drifted_hashes)
        # Exactly one worker spawned (already .start()ed by `_maybe_auto_restore`).
        assert len(spawned) == 1
        assert spawned[0].name == 'display-auto-restore'
        spawned[0].join(timeout=2.0)
        assert not spawned[0].is_alive(), 'auto-restore worker must complete'

        # The worker called apply_topology and wrote the success state.
        assert len(post_reset_calls) == 1
        cb = config_state['displays']['autoRestore']['circuitBreaker']
        assert cb['failures'] == 0
        assert cb['tripped'] is False
        assert 'lastSuccessAt' in cb
        # No additional breaker-trip events from the success path.
        assert fake_service._emit_display_event.call_count == 1

    def test_stable_assigned_drift_fires_after_two_display_ticks(
        self, monkeypatch, fake_service, assigned_layout, reset_apply_state,
    ):
        """Auto-restore must catch stable live-vs-assigned drift, not only topology-change
        events. First tick records persistence; second tick spawns the worker."""
        import shared_utils
        import display_manager as dm_mod

        config_state = {
            'displays': {
                'enabled': True,
                'autoRestore': {
                    'enabled': True,
                    'circuitBreaker': {'failures': 0, 'tripped': False},
                },
                'assigned': assigned_layout,
            },
        }
        monkeypatch.setattr(
            shared_utils, 'read_config', self._make_config_reader(config_state),
        )

        live_profile = {
            'monitors': [
                {'edidHash': 'aaaaaaaa', 'primary': True,
                 'position': {'x': 0, 'y': 0}},
                {'edidHash': 'bbbbbbbb', 'primary': False,
                 'position': {'x': 1920, 'y': 100}},
            ],
        }

        apply_calls = []

        def _mock_apply_success(layout, **kw):
            apply_calls.append({'layout': layout, 'kwargs': kw})
            return {'success': True, 'changes': [], 'autoRestore': True}

        monkeypatch.setattr(dm_mod, 'apply_topology', _mock_apply_success)

        spawned = []
        real_thread_cls = threading.Thread

        def _capture_thread(target, args=(), daemon=False, name=None, **kw):
            t = real_thread_cls(
                target=target, args=args, daemon=daemon, name=name, **kw,
            )
            spawned.append(t)
            return t

        monkeypatch.setattr(threading, 'Thread', _capture_thread)
        fake_service._drift_pending_tick_count = 0

        fake_service._maybe_auto_restore_assigned_drift(live_profile)
        assert fake_service._drift_pending_tick_count == 1
        assert spawned == []

        fake_service._maybe_auto_restore_assigned_drift(live_profile)
        assert fake_service._drift_pending_tick_count == 2
        assert len(spawned) == 1
        spawned[0].join(timeout=2.0)
        assert len(apply_calls) == 1
        assert apply_calls[0]['layout'] == assigned_layout
        assert (
            fake_service._last_auto_restore_success_key
            == fake_service._drift_pending_key
        )

        # If Windows accepts the apply but live still reports the same drift, don't
        # re-apply every tick — users see the repeated SetDisplayConfig as a flash.
        fake_service._maybe_auto_restore_assigned_drift(live_profile)
        assert len(spawned) == 1
        assert len(apply_calls) == 1

        matching_profile = {'monitors': assigned_layout['monitors']}
        fake_service._maybe_auto_restore_assigned_drift(matching_profile)
        assert fake_service._drift_pending_tick_count == 0
        assert fake_service._last_auto_restore_success_key is None

        # After convergence the same drift is a new event and gets the two-tick treatment.
        fake_service._maybe_auto_restore_assigned_drift(live_profile)
        assert len(spawned) == 1
        fake_service._maybe_auto_restore_assigned_drift(live_profile)
        assert len(spawned) == 2
        spawned[1].join(timeout=2.0)
        assert len(apply_calls) == 2

    def test_drift_key_change_restarts_persistence_gate(
        self, monkeypatch, fake_service, assigned_layout, reset_apply_state,
    ):
        """Two different one-tick drifts must not combine into persistence."""
        import shared_utils
        import display_manager as dm_mod

        config_state = {
            'displays': {
                'enabled': True,
                'autoRestore': {
                    'enabled': True,
                    'circuitBreaker': {'failures': 0, 'tripped': False},
                },
                'assigned': assigned_layout,
            },
        }
        monkeypatch.setattr(
            shared_utils, 'read_config', self._make_config_reader(config_state),
        )

        spawned = []
        real_thread_cls = threading.Thread

        def _capture_thread(target, args=(), daemon=False, name=None, **kw):
            t = real_thread_cls(
                target=target, args=args, daemon=daemon, name=name, **kw,
            )
            spawned.append(t)
            return t

        monkeypatch.setattr(threading, 'Thread', _capture_thread)
        monkeypatch.setattr(
            dm_mod, 'apply_topology',
            lambda layout, **kw: {'success': True, 'changes': [], 'autoRestore': True},
        )
        fake_service._drift_pending_tick_count = 0

        y_drift_profile = {
            'monitors': [
                {'edidHash': 'aaaaaaaa', 'primary': True,
                 'position': {'x': 0, 'y': 0}},
                {'edidHash': 'bbbbbbbb', 'primary': False,
                 'position': {'x': 1920, 'y': 100}},
            ],
        }
        x_drift_profile = {
            'monitors': [
                {'edidHash': 'aaaaaaaa', 'primary': True,
                 'position': {'x': 0, 'y': 0}},
                {'edidHash': 'bbbbbbbb', 'primary': False,
                 'position': {'x': 2000, 'y': 0}},
            ],
        }

        fake_service._maybe_auto_restore_assigned_drift(y_drift_profile)
        assert fake_service._drift_pending_tick_count == 1
        fake_service._maybe_auto_restore_assigned_drift(x_drift_profile)
        assert fake_service._drift_pending_tick_count == 1
        assert spawned == []

        fake_service._maybe_auto_restore_assigned_drift(x_drift_profile)
        assert fake_service._drift_pending_tick_count == 2
        assert len(spawned) == 1
        spawned[0].join(timeout=2.0)

    def test_enumeration_failure_does_not_clear_success_suppression(
        self, fake_service,
    ):
        fake_service._last_auto_restore_success_key = 'same-drift'
        fake_service._drift_pending_key = 'pending'
        fake_service._drift_pending_tick_count = 2

        fake_service._maybe_auto_restore_assigned_drift({
            'enumerationFailed': True,
            'monitors': [],
        })

        assert fake_service._last_auto_restore_success_key == 'same-drift'
        assert fake_service._drift_pending_key is None
        assert fake_service._drift_pending_tick_count == 0

    def test_scale_only_and_tiny_refresh_drift_do_not_auto_restore(
        self, monkeypatch, fake_service, reset_apply_state,
    ):
        """Auto-restore ignores drift it cannot or should not apply: DPI scale isn't
        enforced by apply_topology(), and refresh readbacks differ by harmless rounding."""
        import shared_utils
        import display_manager as dm_mod

        assigned_layout = {
            'monitors': [
                {'edidHash': 'aaaaaaaa', 'primary': True,
                 'position': {'x': 0, 'y': 0},
                 'resolution': {'width': 1920, 'height': 1080},
                 'refreshHz': 60.0, 'rotation': 0, 'scalePct': 100},
                {'edidHash': 'bbbbbbbb', 'primary': False,
                 'position': {'x': 1920, 'y': 0},
                 'resolution': {'width': 1920, 'height': 1080},
                 'refreshHz': 60.0, 'rotation': 0, 'scalePct': 100},
            ],
        }
        config_state = {
            'displays': {
                'enabled': True,
                'autoRestore': {
                    'enabled': True,
                    'circuitBreaker': {'failures': 0, 'tripped': False},
                },
                'assigned': assigned_layout,
            },
        }
        monkeypatch.setattr(
            shared_utils, 'read_config', self._make_config_reader(config_state),
        )

        live_profile = {
            'monitors': [
                {'edidHash': 'aaaaaaaa', 'primary': True,
                 'position': {'x': 0, 'y': 0},
                 'resolution': {'width': 1920, 'height': 1080},
                 'refreshHz': 60.0, 'rotation': 0, 'scalePct': 125},
                {'edidHash': 'bbbbbbbb', 'primary': False,
                 'position': {'x': 1920, 'y': 0},
                 'resolution': {'width': 1920, 'height': 1080},
                 'refreshHz': 59.995, 'rotation': 0, 'scalePct': 100},
            ],
        }

        apply_calls = []

        def _mock_apply_success(layout, **kw):
            apply_calls.append({'layout': layout, 'kwargs': kw})
            return {'success': True, 'changes': [], 'autoRestore': True}

        monkeypatch.setattr(dm_mod, 'apply_topology', _mock_apply_success)

        spawned = []
        real_thread_cls = threading.Thread

        def _capture_thread(target, args=(), daemon=False, name=None, **kw):
            t = real_thread_cls(
                target=target, args=args, daemon=daemon, name=name, **kw,
            )
            spawned.append(t)
            return t

        monkeypatch.setattr(threading, 'Thread', _capture_thread)

        assert fake_service._assigned_drift_hashes(
            live_profile, assigned_layout,
        ) == []
        fake_service._maybe_auto_restore_assigned_drift(live_profile)
        fake_service._maybe_auto_restore_assigned_drift(live_profile)

        assert fake_service._drift_pending_tick_count == 0
        assert spawned == []
        assert apply_calls == []

    def test_auto_restore_transient_apply_skips_do_not_increment_breaker(
        self, monkeypatch, fake_service, assigned_layout, reset_apply_state,
    ):
        import shared_utils
        import display_manager as dm_mod

        config_state = {
            'displays': {
                'autoRestore': {
                    'circuitBreaker': {'failures': 0, 'tripped': False},
                },
            },
        }
        monkeypatch.setattr(
            shared_utils, 'read_config', self._make_config_reader(config_state),
        )

        def _record_state_write(patch):
            config_state['displays']['autoRestore']['circuitBreaker'].update(
                patch,
            )

        fake_service.firebase_client.update_display_autorestore_state.side_effect = (
            _record_state_write
        )

        apply_results = [
            {'success': False, 'error': 'rate limited - 7s cooldown remaining'},
            {'success': False, 'error': 'apply already in progress'},
            # Powered-off assigned monitor: apply_topology rejects pre-SetDisplayConfig
            # and must NOT increment the breaker, or a monitor power-off trips it.
            {'success': False,
             'error': "desired monitors not present in live topology: ['1d7d7cc72281ed07']",
             'code': dm_mod.DisplayErrorCode.MISSING_MONITORS,
             'missing': ['1d7d7cc72281ed07']},
            {'success': False, 'error': 'ccd rejected layout',
             'code': dm_mod.DisplayErrorCode.APPLY_FAILED},
        ]
        apply_calls = []

        def _mock_apply_topology(layout, **kw):
            apply_calls.append({'layout': layout, 'kwargs': kw})
            return apply_results[len(apply_calls) - 1]

        monkeypatch.setattr(dm_mod, 'apply_topology', _mock_apply_topology)

        # Three transient skips (rate-limited, in-progress, missing-monitors).
        fake_service._run_auto_restore(assigned_layout, drift_key='same-drift')
        fake_service._run_auto_restore(assigned_layout, drift_key='same-drift')
        fake_service._run_auto_restore(assigned_layout, drift_key='same-drift')

        cb = config_state['displays']['autoRestore']['circuitBreaker']
        assert cb['failures'] == 0
        assert fake_service._last_auto_restore_success_key is None

        # A genuine apply failure still counts.
        fake_service._run_auto_restore(assigned_layout, drift_key='same-drift')
        assert cb['failures'] == 1
        assert fake_service._last_auto_restore_success_key is None

    def test_assigned_monitor_absent_from_live_skips_without_apply(
        self, monkeypatch, fake_service, assigned_layout, reset_apply_state,
    ):
        """Gate 5b: a powered-off / disconnected assigned monitor must not trigger an
        apply attempt — apply_topology would reject with MISSING_MONITORS and emit a
        `display_apply_failed` audit every tick. Skip before dispatching the worker."""
        import shared_utils
        import display_manager as dm_mod

        config_state = {
            'displays': {
                'enabled': True,
                'autoRestore': {
                    'enabled': True,
                    'circuitBreaker': {'failures': 0, 'tripped': False},
                },
                'assigned': assigned_layout,
            },
        }
        monkeypatch.setattr(
            shared_utils, 'read_config', self._make_config_reader(config_state),
        )

        apply_calls = []

        def _mock_apply(layout, **kw):
            apply_calls.append(layout)
            return {'success': True, 'changes': [], 'autoRestore': True}

        monkeypatch.setattr(dm_mod, 'apply_topology', _mock_apply)

        spawned = []
        real_thread_cls = threading.Thread

        def _capture_thread(target, args=(), daemon=False, name=None, **kw):
            t = real_thread_cls(
                target=target, args=args, daemon=daemon, name=name, **kw,
            )
            spawned.append(t)
            return t

        monkeypatch.setattr(threading, 'Thread', _capture_thread)

        # Primary 'aaaaaaaa' powered off; surviving 'bbbbbbbb' drifted to primary at origin.
        live_profile = {
            'monitors': [
                {'edidHash': 'bbbbbbbb', 'primary': True,
                 'position': {'x': 0, 'y': 0}},
            ],
        }
        fake_service._drift_pending_tick_count = 2
        fake_service._maybe_auto_restore(
            live_profile, ['bbbbbbbb'], 'drift-key', assigned_layout,
        )

        assert apply_calls == [], 'no apply attempted while a monitor is absent'
        assert spawned == [], 'no auto-restore worker spawned'
        cb = config_state['displays']['autoRestore']['circuitBreaker']
        assert cb['failures'] == 0
        assert cb.get('tripped') is False
        fake_service._emit_display_event.assert_not_called()

    def test_apply_was_skip_classifies_both_enum_and_helper_string_codes(
        self, fake_service,
    ):
        """The Session-0 helper path returns `code` as a JSON-deserialized plain string
        (e.g. 'missing_monitors'), not the enum member. Both forms must classify
        identically or the MISSING_MONITORS skip is a silent no-op in production."""
        from display_manager import DisplayErrorCode
        was_skip = fake_service._auto_restore_apply_was_skip
        # Plain-string (helper / JSON) form — every skip code must classify True.
        assert was_skip({'success': False, 'code': 'missing_monitors'}) is True
        assert was_skip({'success': False, 'code': 'auto_restore_rate_limited'}) is True
        assert was_skip(
            {'success': False, 'code': 'auto_restore_skipped_unfixable'}
        ) is True
        # Enum form — same classification.
        assert was_skip(
            {'success': False, 'code': DisplayErrorCode.MISSING_MONITORS}
        ) is True
        # Genuine failures (both forms) must still trip the breaker.
        assert was_skip({'success': False, 'code': 'apply_failed'}) is False
        assert was_skip(
            {'success': False, 'code': DisplayErrorCode.VALIDATE_REJECTED}
        ) is False


class TestEdidHashStability:
    """Identity hash must NOT shift when only the friendly name changes. `friendly` used
    to be in the hash payload and Windows reports it inconsistently across driver state
    transitions, so stored monitors read as "not connected" after a remote session."""

    def test_friendly_name_not_in_hash(self):
        # Same identity, different friendlyName → identical hash.
        base_identity = {
            'manufacturerId': 'DEL',
            'productCode': '40F2',
            'serialNumber': '5&abcdef&0&UID257',
        }
        m_dell = {**base_identity, 'friendlyName': 'DELL U2415'}
        m_samsung_glitch = {**base_identity, 'friendlyName': 'SAMSUNG'}
        m_blank = {**base_identity, 'friendlyName': ''}
        h_dell = dm.canonical_edid_hash_for_monitor(m_dell)
        h_samsung = dm.canonical_edid_hash_for_monitor(m_samsung_glitch)
        h_blank = dm.canonical_edid_hash_for_monitor(m_blank)
        assert h_dell == h_samsung == h_blank
        # And it equals the raw _edid_hash too — friendlyName is purely cosmetic.
        assert h_dell == dm._edid_hash('DEL', 0x40F2, '5&abcdef&0&UID257')

    def test_different_identity_produces_different_hash(self):
        h1 = dm._edid_hash('DEL', 0x40F2, '5&abcdef&0&UID257')
        h2 = dm._edid_hash('SAM', 0x40F2, '5&abcdef&0&UID257')
        h3 = dm._edid_hash('DEL', 0xFFFF, '5&abcdef&0&UID257')
        h4 = dm._edid_hash('DEL', 0x40F2, '5&different&0&UID257')
        assert len({h1, h2, h3, h4}) == 4

    def test_hash_is_16_hex_chars(self):
        h = dm._edid_hash('DEL', 0x40F2, '5&abc&0&UID257')
        assert len(h) == 16
        assert all(c in '0123456789abcdef' for c in h)


class TestCanonicalizeMonitorHashes:
    """Re-derivation rewrites `edidHash` from raw identity fields so layouts persisted
    under the old (friendly-inclusive) scheme still match."""

    def _live_format_dell(self):
        # Shape `_enumerate_monitors_ccd` produces: hex productCode, identity-only SHA-1.
        return {
            'edidHash': dm._edid_hash('DEL', 0x40F2, '5&abc&0&UID257'),
            'manufacturerId': 'DEL',
            'productCode': '40F2',
            'serialNumber': '5&abc&0&UID257',
            'friendlyName': 'DELL U2415',
        }

    def test_old_format_assigned_normalizes_to_new_hash(self):
        # Older-agent layout: same raw fields, but edidHash folded in `friendly`.
        legacy = {
            'edidHash': 'old_scheme_hash',
            'manufacturerId': 'DEL',
            'productCode': '40F2',
            'serialNumber': '5&abc&0&UID257',
            'friendlyName': 'DELL U2415',
        }
        live = self._live_format_dell()
        canon = dm.canonicalize_monitor_hashes([legacy])
        assert canon[0]['edidHash'] == live['edidHash']

    def test_idempotent_on_canonical_input(self):
        live = self._live_format_dell()
        canon1 = dm.canonicalize_monitor_hashes([live])
        canon2 = dm.canonicalize_monitor_hashes(canon1)
        assert canon1[0]['edidHash'] == canon2[0]['edidHash'] == live['edidHash']

    def test_preserves_other_fields(self):
        legacy = {
            'edidHash': 'old',
            'manufacturerId': 'DEL', 'productCode': '40F2',
            'serialNumber': '5&abc&0&UID257', 'friendlyName': 'DELL',
            'position': {'x': 0, 'y': 0}, 'primary': True,
        }
        canon = dm.canonicalize_monitor_hashes([legacy])[0]
        assert canon['friendlyName'] == 'DELL'
        assert canon['position'] == {'x': 0, 'y': 0}
        assert canon['primary'] is True

    def test_empty_identity_preserves_existing_hash(self):
        # Monitors without raw fields keep their stored hash rather than all aliasing
        # to one zero-payload hash.
        m = {'edidHash': 'kept', 'manufacturerId': '', 'productCode': '', 'serialNumber': ''}
        canon = dm.canonicalize_monitor_hashes([m])
        assert canon[0]['edidHash'] == 'kept'

    def test_handles_none_and_non_dict(self):
        assert dm.canonicalize_monitor_hashes(None) == []
        assert dm.canonicalize_monitor_hashes([]) == []
        # Non-dict entries are filtered out, not crashed on.
        assert dm.canonicalize_monitor_hashes([None, 'not a dict', 42]) == []

    def test_canonicalize_assigned_layout_wraps_monitors(self):
        legacy_layout = {
            'capturedAt': 1700000000,
            'monitors': [{
                'edidHash': 'old', 'manufacturerId': 'DEL',
                'productCode': '40F2', 'serialNumber': '5&abc&0&UID257',
            }],
        }
        canon = dm.canonicalize_assigned_layout(legacy_layout)
        assert canon['capturedAt'] == 1700000000
        assert canon['monitors'][0]['edidHash'] == dm._edid_hash(
            'DEL', 0x40F2, '5&abc&0&UID257',
        )

    def test_compute_drift_count_matches_legacy_assigned(self):
        # compute_drift_count must canonicalise old friendly-inclusive assigned hashes
        # or the lookup misses and drift reads 0.
        live = self._live_format_dell()
        live['position'] = {'x': 0, 'y': 0}
        live['resolution'] = {'width': 1920, 'height': 1200}
        live['refreshHz'] = 60.0
        live['rotation'] = 0
        live['scalePct'] = 100
        live['primary'] = True

        assigned = {
            'edidHash': 'old_friendly_scheme',
            'manufacturerId': 'DEL', 'productCode': '40F2',
            'serialNumber': '5&abc&0&UID257',
            'position': {'x': 100, 'y': 0},  # drift on x
            'resolution': {'width': 1920, 'height': 1200},
            'refreshHz': 60.0, 'rotation': 0, 'scalePct': 100, 'primary': True,
        }
        assert dm.compute_drift_count([live], [assigned]) == 1


class TestIndirectDisplayFilter:
    """RDP / Miracast / dummy-plug paths must not pollute enumeration."""

    def test_indirect_techs_set(self):
        # These tech values are the WinSDK-documented virtual/indirect outputs.
        # 18 (DISPLAYPORT_USB_TUNNEL) is real USB-C and must stay included.
        assert 15 in dm._INDIRECT_OUTPUT_TECHS  # MIRACAST
        assert 16 in dm._INDIRECT_OUTPUT_TECHS  # INDIRECT_WIRED
        assert 17 in dm._INDIRECT_OUTPUT_TECHS  # INDIRECT_VIRTUAL
        assert 18 not in dm._INDIRECT_OUTPUT_TECHS  # DISPLAYPORT_USB_TUNNEL — real

    def _stub_path(self, source_id, target_id, output_tech):
        """MagicMock matching the ctypes path-struct attribute access."""
        p = MagicMock()
        p.flags = dm.DISPLAYCONFIG_PATH_ACTIVE
        p.sourceInfo.adapterId = 'A1'
        p.sourceInfo.id = source_id
        p.sourceInfo.modeInfoIdx = source_id  # 0, 1, 2 — match the mode array
        p.targetInfo.adapterId = 'A1'
        p.targetInfo.id = target_id
        # Real ctypes field is a uint; the code does `int(target.outputTechnology)`.
        p.targetInfo.outputTechnology = output_tech
        # _refresh_hz / _rotation_degrees read these — zero-like sentinels keep them alive.
        p.targetInfo.refreshRate.Numerator = 60
        p.targetInfo.refreshRate.Denominator = 1
        p.targetInfo.rotation = dm.DISPLAYCONFIG_ROTATION_IDENTITY
        return p

    def _stub_mode(self, source_id):
        """SOURCE-type mode info with non-zero position/size so `source_mode` resolves."""
        m = MagicMock()
        m.infoType = dm.DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE
        m.sourceMode.position.x = source_id * 1920
        m.sourceMode.position.y = 0
        m.sourceMode.width = 1920
        m.sourceMode.height = 1080
        return m

    def _stub_device_name(self, target_id):
        info = MagicMock()
        info.monitorFriendlyDeviceName = f'DELL U241{target_id}'
        info.flags.bits.edidIdsValid = 1
        info.edidManufactureId = 0x1040  # decodes to some 3-letter id
        info.edidProductCodeId = 0x40F0 + target_id
        info.monitorDevicePath = (
            f'\\\\?\\DISPLAY#DEL40F2#5&abc&0&UID{target_id}#{{x}}'
        )
        return info

    def test_indirect_paths_dropped_from_enumeration(self, monkeypatch):
        # Two physical paths (HDMI=5, DP=10) plus one RDP-injected virtual (17), which
        # must be absent from the returned monitor list.
        physical_a = self._stub_path(source_id=0, target_id=100, output_tech=5)
        virtual = self._stub_path(source_id=1, target_id=101, output_tech=17)
        physical_b = self._stub_path(source_id=2, target_id=102, output_tech=10)
        paths = [physical_a, virtual, physical_b]
        modes = [self._stub_mode(0), self._stub_mode(1), self._stub_mode(2)]

        monkeypatch.setattr(dm, '_query_active_paths', lambda: (paths, modes))
        monkeypatch.setattr(dm, '_get_target_device_name',
                            lambda adapter, tid: self._stub_device_name(tid))
        monkeypatch.setattr(dm, '_get_dpi_scale_percent', lambda *a, **kw: 100)
        monkeypatch.setattr(dm, '_luid_to_str', lambda luid: str(luid))

        monitors = dm._enumerate_monitors_ccd()
        target_ids = sorted(m['targetId'] for m in monitors)
        assert target_ids == [100, 102], (
            'expected only the two physical paths to survive; '
            f'virtual targetId=101 (tech=17) leaked through: {target_ids}'
        )
        # USB-C tunnel (18) IS kept — guards against widening the filter to real hardware.
        usb_c = self._stub_path(source_id=0, target_id=200, output_tech=18)
        monkeypatch.setattr(dm, '_query_active_paths',
                            lambda: ([usb_c], [self._stub_mode(0)]))
        monitors = dm._enumerate_monitors_ccd()
        assert [m['targetId'] for m in monitors] == [200]


# Display alert dispatch: the log write and the alert POST are two sinks, not one.
# `send_display_alert` had zero call sites from v2.11.0 onward, which left every routed
# display email and webhook dormant fleet-wide.


class TestEmitAuditAlertDispatch:
    """`_emit_audit` must reach BOTH sinks: `log_event` (dashboard feed + talon log
    bridge) and `send_display_alert` (email + webhook routing)."""

    def test_emits_log_and_alert(self):
        fb = MagicMock()
        dm._emit_audit(
            fb, 'display_apply_failed', 'warning', 'validate rejected',
            {'eventType': 'display_apply_failed', 'error': 'boom'},
        )

        fb.log_event.assert_called_once_with(
            action='display_apply_failed',
            level='warning',
            details='validate rejected',
            extra_fields={'eventType': 'display_apply_failed', 'error': 'boom'},
        )
        fb.send_display_alert.assert_called_once_with(
            'display_apply_failed',
            {
                'details': 'validate rejected',
                'eventType': 'display_apply_failed',
                'error': 'boom',
            },
        )

    def test_extras_win_over_the_merged_details_key(self):
        # `details` is merged in for webhook rendering, but an explicit extras key is
        # the caller's intent and must not be clobbered.
        fb = MagicMock()
        dm._emit_audit(
            fb, 'display_sync_lost', 'warning', 'positional detail',
            {'details': 'explicit detail'},
        )
        assert fb.send_display_alert.call_args[0][1]['details'] == 'explicit detail'

    def test_no_extras_still_sends_details(self):
        fb = MagicMock()
        dm._emit_audit(fb, 'display_monitor_removed', 'critical', 'panel gone')
        fb.send_display_alert.assert_called_once_with(
            'display_monitor_removed', {'details': 'panel gone'},
        )

    def test_none_client_is_a_no_op(self):
        # The user-session helper runs display_manager without a firebase client.
        dm._emit_audit(None, 'display_apply_failed', 'warning', 'x', {})

    def test_alert_failure_does_not_break_the_caller(self):
        fb = MagicMock()
        fb.send_display_alert.side_effect = RuntimeError('no thread for you')
        dm._emit_audit(fb, 'display_drift', 'warning', 'drifted', {})
        fb.log_event.assert_called_once()

    def test_log_failure_still_sends_the_alert(self):
        # A Firestore write failure must not swallow the alert — the sinks fail apart.
        fb = MagicMock()
        fb.log_event.side_effect = RuntimeError('firestore down')
        dm._emit_audit(fb, 'display_auto_revert_fired', 'error', 'reverted', {})
        fb.send_display_alert.assert_called_once()


class TestEmitDisplayEventAlertDispatch:
    """`owlette_service._emit_display_event` is the other display-event funnel (the six
    topology-observation events). Same two-sink contract."""

    @staticmethod
    def _bound_service():
        from owlette_service import OwletteService

        class _Svc:
            pass

        svc = _Svc()
        svc.firebase_client = MagicMock()
        svc._emit_display_event = OwletteService._emit_display_event.__get__(
            svc, OwletteService,
        )
        return svc

    @staticmethod
    def _bind_change_events(svc):
        from owlette_service import OwletteService

        svc._DISPLAY_DRIFT_FIELDS = OwletteService._DISPLAY_DRIFT_FIELDS
        svc._display_monitor_summary = OwletteService._display_monitor_summary
        svc._emit_display_change_events = (
            OwletteService._emit_display_change_events.__get__(svc, OwletteService)
        )
        return svc

    # One drifted field on a monitor in both profiles — minimum input for one `display_drift` event.
    _PREV = {'monitors': [{'edidHash': 'aaaa', 'refreshHz': 60}]}
    _NEW = {
        'monitors': [{'edidHash': 'aaaa', 'refreshHz': 30}],
        'signatureHash': 'sig-1',
    }

    def test_emits_log_and_alert(self):
        svc = self._bound_service()
        payload = {'signatureHash': 'abc', 'monitorCount': 2}
        svc._emit_display_event('display_drift', 'warning', payload)

        svc.firebase_client.log_event.assert_called_once_with(
            action='display_drift',
            level='warning',
            details=json.dumps(payload, separators=(',', ':'), sort_keys=True),
        )
        svc.firebase_client.send_display_alert.assert_called_once_with(
            'display_drift', payload,
        )

    def test_unserializable_payload_sends_nothing(self):
        # A serialization failure must skip BOTH sinks.
        svc = self._bound_service()
        svc._emit_display_event('display_drift', 'warning', {'bad': object()})
        svc.firebase_client.log_event.assert_not_called()
        svc.firebase_client.send_display_alert.assert_not_called()

    def test_suppress_flag_reaches_the_alert_payload(self, reset_suppression_state):
        # `suppressAlert` contract: stamped in `_emit_display_change_events` and ridden
        # into the alert payload that /api/agent/alert reads off `data`.
        import time as _time

        svc = self._bind_change_events(self._bound_service())
        dm._last_apply_finished_at = _time.time()
        with patch.object(dm, '_current_apply_id', 'apply-xyz'):
            svc._emit_display_change_events(self._PREV, self._NEW)

        event_type, data = svc.firebase_client.send_display_alert.call_args[0]
        assert event_type == 'display_drift'
        assert data['suppressAlert'] is True
        assert data['correlatedApplyId'] == 'apply-xyz'

    def test_no_suppress_flag_outside_the_window(self, reset_suppression_state):
        svc = self._bind_change_events(self._bound_service())
        dm._last_apply_finished_at = 0.0  # no apply since startup
        svc._emit_display_change_events(self._PREV, self._NEW)

        _, data = svc.firebase_client.send_display_alert.call_args[0]
        assert 'suppressAlert' not in data
        assert 'correlatedApplyId' not in data


class TestEnumerationWatchdog:
    """The watchdog must survive the stall it exists to survive.

    `_enumerate_with_timeout` is the ONLY bound on the heartbeat path —
    firebase_client's `_upload_metrics` -> `_ensure_display_profile` ->
    `build_display_profile` reaches it with no outer pool. Until 2026-09-07 it
    used `with ThreadPoolExecutor(...)`, whose implicit shutdown(wait=True) on
    block exit waited for the worker anyway, so the timeout bounded nothing and a
    wedged console session stalled the heartbeat until the machine read offline.
    """

    def test_timeout_is_enforced_when_the_worker_hangs(self):
        release = threading.Event()

        def hanging_enumeration():
            # Far longer than the watchdog. Released in the finally below so an
            # abandoned worker cannot outlive the test.
            release.wait(30)
            return []

        try:
            with patch.object(dm, '_is_session_0', return_value=False),                     patch.object(dm, '_enumerate_monitors', hanging_enumeration):
                started = time.monotonic()
                with pytest.raises(dm.DisplayEnumerationError):
                    dm._enumerate_with_timeout(timeout=0.2)
                elapsed = time.monotonic() - started
        finally:
            release.set()

        # THE negative control. Against the previous `with`-block form this is the
        # assertion that fails: exiting the block joined the worker, so the call
        # returned after ~30s rather than ~0.2s. A green here without it would
        # only prove that an exception was raised, not that it was raised in time.
        assert elapsed < 5, f'watchdog blocked on the hung worker for {elapsed:.1f}s'


class TestIpcDirAcl:
    """account names are localized ("Administratoren" on german windows), so the
    display IPC DACL must take SYSTEM and Administrators from their well-known SIDs."""

    @pytest.mark.skipif(os.name != 'nt', reason='windows ACL test')
    def test_well_known_accounts_come_from_sids(self, monkeypatch, tmp_path):
        ws = MagicMock()
        ws.ConvertStringSidToSid.side_effect = lambda sid: f'sid:{sid}'
        # a non-english box: the english account names do not resolve
        ws.LookupAccountName.side_effect = Exception('no mapping for account name')
        monkeypatch.setattr(dm, '_active_console_user_sid', lambda _ws: 'sid:console')
        monkeypatch.setattr(dm, '_ipc_dir_dacl_matches', lambda *_args: False)

        with patch.dict(sys.modules, {'win32security': ws}):
            dm._ensure_ipc_dir_acl(str(tmp_path))

        ws.LookupAccountName.assert_not_called()
        aces = ws.ACL.return_value.AddAccessAllowedAceEx.call_args_list
        assert [c.args[-1] for c in aces] == [
            'sid:S-1-5-18', 'sid:S-1-5-32-544', 'sid:console',
        ]
        ws.SetNamedSecurityInfo.assert_called_once()
