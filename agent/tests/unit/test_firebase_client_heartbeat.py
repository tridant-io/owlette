"""
tests for the heartbeat-honesty contract of FirebaseClient._upload_metrics.

regression guard for the false "machine offline" alerts: _upload_metrics IS the
periodic heartbeat (it writes online + lastHeartbeat). Previously it swallowed a
failed write and the metrics loop / start() then called
connection_manager.report_success() unconditionally — which reset the circuit
breaker and the self-restart watchdog's "last success" clock, leaving a machine
stuck online=true with a frozen lastHeartbeat (and never reconnecting). The cron
health-check then emailed a spurious offline alert.

Contract now enforced:
  - _upload_metrics returns True when the Firestore write lands, False when it raises.
  - on failure it reports the error to the connection manager (so reconnect can fire).
  - it never reports SUCCESS itself — that is the caller's job, gated on the bool.

We bypass __init__ (FirebaseClient.__new__) so we don't pull in real auth /
connection setup; only the handful of attributes _upload_metrics touches are stubbed.

The same write also carries the swoop capability handshake (capabilities.swoop)
and cross-plan rule C3's osFamily/arch keys; those are pinned at the bottom.
"""
import sys
from unittest.mock import MagicMock, patch

import pytest

import shared_utils

# pre-mock win32 so the import works on non-windows CI as well as locally.
_MOCK_MODULES = {
    "win32api": MagicMock(),
    "win32con": MagicMock(),
    "win32event": MagicMock(),
    "win32service": MagicMock(),
    "win32serviceutil": MagicMock(),
    "servicemanager": MagicMock(),
    "win32ts": MagicMock(),
    "win32process": MagicMock(),
    "win32gui": MagicMock(),
    "win32security": MagicMock(),
    "pywintypes": MagicMock(),
    "wmi": MagicMock(),
}
_patches = {m: mock for m, mock in _MOCK_MODULES.items() if m not in sys.modules}

try:
    with patch.dict("sys.modules", _patches):
        from firebase_client import FirebaseClient
except ImportError as exc:
    pytest.skip(f"firebase_client not importable: {exc}", allow_module_level=True)
except Exception as exc:
    pytest.skip(f"firebase_client import failed: {exc}", allow_module_level=True)


def _make_client():
    """A FirebaseClient with only the attributes _upload_metrics reads stubbed."""
    fc = FirebaseClient.__new__(FirebaseClient)
    # `connected` is a read-only property -> connection_manager.is_connected.
    fc.db = MagicMock()
    fc.logger = MagicMock()
    fc.connection_manager = MagicMock()
    fc.connection_manager.is_connected = True
    fc.machine_id = "INF-FLEX-3"
    fc.site_id = "node-pa"
    fc._last_primary = None
    fc._cached_display_profile = None
    # Profile lookups are not under test — stub them to no-ops.
    fc._ensure_profile = MagicMock(return_value=None)
    fc._ensure_display_profile = MagicMock(return_value=None)
    return fc


def _metrics():
    return {"memory": {}, "processes": {}}


def test_returns_true_when_write_lands():
    fc = _make_client()

    assert fc._upload_metrics(_metrics()) is True

    # the heartbeat doc was written, and we did NOT touch the connection manager
    # (reporting *success* is the caller's responsibility, gated on the return).
    metrics_ref = (
        fc.db.collection.return_value.document.return_value
        .collection.return_value.document.return_value
    )
    metrics_ref.update.assert_called_once()
    fc.connection_manager.report_error.assert_not_called()
    fc.connection_manager.report_success.assert_not_called()


def test_returns_false_and_reports_error_when_write_raises():
    fc = _make_client()
    metrics_ref = (
        fc.db.collection.return_value.document.return_value
        .collection.return_value.document.return_value
    )
    metrics_ref.update.side_effect = RuntimeError("firestore unavailable")

    assert fc._upload_metrics(_metrics()) is False

    # a failed heartbeat write must surface as an error (so reconnect can fire) and
    # must NOT be reported as a success.
    fc.connection_manager.report_error.assert_called_once()
    fc.connection_manager.report_success.assert_not_called()


def test_returns_false_when_not_connected():
    fc = _make_client()
    fc.connection_manager.is_connected = False

    assert fc._upload_metrics(_metrics()) is False
    fc.connection_manager.report_error.assert_not_called()
    fc.connection_manager.report_success.assert_not_called()


# The machine document's OS identity — osFamily / arch / osVersion — rides the
# two writes the agent already makes: the presence write that registers a fresh
# machine, and the metrics write that IS the heartbeat. The dashboard labels a
# machine from these, and reads an absent osFamily as windows.

def _stub_os_identity(monkeypatch):
    """Pin the two probes on the shared_utils module firebase_client holds.

    Never patch('firebase_client.<name>') here: resolving that target imports a
    second firebase_client, which is exactly what the module header warns about.
    """
    monkeypatch.setattr(shared_utils, 'get_os_family_arch', lambda: ('linux', 'x64'))
    monkeypatch.setattr(shared_utils, 'get_os_version_string', lambda: 'Ubuntu 24.04.5 LTS')


def test_the_heartbeat_write_carries_the_os_identity(monkeypatch):
    fc = _make_client()
    _stub_os_identity(monkeypatch)

    assert fc._upload_metrics(_metrics()) is True
    metrics_ref = (
        fc.db.collection.return_value.document.return_value
        .collection.return_value.document.return_value
    )
    payload = metrics_ref.update.call_args[0][0]

    assert payload['osFamily'] == 'linux'
    assert payload['arch'] == 'x64'
    assert payload['osVersion'] == 'Ubuntu 24.04.5 LTS'
    # Beside the fields it has always carried, on the same write.
    assert payload['lastHeartbeat'] is not None
    assert 'agent_version' in payload
    # update() patches the named fields; a set() would replace the document and
    # drop everything the server and the dashboard wrote onto it.
    metrics_ref.set.assert_not_called()


def test_the_registration_write_carries_the_os_identity(monkeypatch):
    fc = _make_client()
    fc._last_heartbeat_time = 0.0
    _stub_os_identity(monkeypatch)

    fc._update_presence(True)

    presence_ref = (
        fc.db.collection.return_value.document.return_value
        .collection.return_value.document.return_value
    )
    args, kwargs = presence_ref.set.call_args

    assert args[0]['osFamily'] == 'linux'
    assert args[0]['arch'] == 'x64'
    assert args[0]['osVersion'] == 'Ubuntu 24.04.5 LTS'
    assert 'lastHeartbeat' in args[0]
    # merge=True, never a bare set: this write must not drop a field it does
    # not name.
    assert kwargs == {'merge': True}


def test_the_os_string_is_probed_once_across_ticks(monkeypatch):
    """The metrics loop runs every 5s at its fastest; the Windows arm of the
    probe reads the registry. Negative control for the cache: without it this
    counts one build per tick."""
    fc = _make_client()
    builds = []

    def _build():
        builds.append(1)
        return 'Ubuntu 24.04.5 LTS'

    monkeypatch.setattr(shared_utils, '_os_version_string', None)
    monkeypatch.setattr(shared_utils, '_build_os_version_string', _build)

    fc._upload_metrics(_metrics())
    fc._upload_metrics(_metrics())

    assert len(builds) == 1


# Swoop capability + C3 platform keys


def _heartbeat_payload(fc):
    """The dict handed to metrics_ref.update() by one heartbeat."""
    assert fc._upload_metrics(_metrics()) is True
    metrics_ref = (
        fc.db.collection.return_value.document.return_value
        .collection.return_value.document.return_value
    )
    return metrics_ref.update.call_args[0][0]




def test_heartbeat_carries_the_swoop_and_platform_keys(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(
        shared_utils, "get_swoop_exe_path",
        lambda: r"C:\ProgramData\Owlette\swoop\owlette-swoop.exe",
    )

    payload = _heartbeat_payload(_make_client())

    assert payload["capabilities.swoop"] == 1
    assert payload["osFamily"] == "windows"
    assert payload["arch"] in ("x64", "arm64", "unknown")
    # dotted keys only: a whole-map capabilities write would drop this sibling.
    assert payload["capabilities.displayRemoteApply"] == 1
    assert "capabilities" not in payload


def test_swoop_capability_is_zero_when_the_streamer_is_absent(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(shared_utils, "get_swoop_exe_path", lambda: None)

    payload = _heartbeat_payload(_make_client())

    assert payload["capabilities.swoop"] == 0
    assert payload["capabilities.displayRemoteApply"] == 1


def test_swoop_command_types_are_on_the_fast_lane():
    """The slow lane queues behind an in-flight install — minutes, not seconds.

    swoop_kill is the kill switch's last-resort path; it cannot wait on an msi.
    """
    fast = FirebaseClient._FAST_COMMAND_TYPES

    assert {"swoop_session_requested", "swoop_kill", "swoop_refresh"} <= fast
    # the pre-existing lane members must stay (OWL-06).
    assert {"mcp_tool_call", "capture_screenshot", "cancel_sync", "cancel_mcp_tool"} <= fast
