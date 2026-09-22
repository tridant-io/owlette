"""Display topology enumeration via the Windows CCD API.

Read side: ``build_display_profile()``. Write side: ``apply_topology()`` /
``ack_apply()`` / ``apply_revert_from_sentinel()`` — validate the desired layout
against the live topology, ``SetDisplayConfig``, persist a revert snapshot to a
sentinel file, then a watchdog thread rolls back unless acked within
``ack_timeout``.

Mosaic detection lives in ``nvapi_display.py``; this module always emits
``mosaicActive: False`` for that layer to flip.

Session 0 caveat: CCD requires the calling *process* — not the thread, so
impersonation does not help — to be in the interactive session. As LocalSystem
in Session 0, ``GetDisplayConfigBufferSizes`` returns paths=0/modes=0 and
``QueryDisplayConfig`` then fails rc=87 (ERROR_INVALID_PARAMETER). So Session 0
delegates to a helper subprocess spawned into the console user's session via
``CreateProcessAsUser``.
"""

import ctypes
import ctypes.wintypes as wt
import enum
import hashlib
import json
import logging
import os
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from typing import Optional

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1


class DisplayEnumerationError(Exception):
    """Raised when CCD enumeration times out or fails internally.

    Distinct from "zero monitors connected", which returns an empty list —
    don't conflate a transient driver stall with a genuinely empty topology.
    """
    pass


class DisplayIpcError(DisplayEnumerationError):
    """Raised when display helper file IPC cannot be created or read."""
    pass


class DisplayErrorCode(str, enum.Enum):
    """Failure codes for the apply / revert paths.

    snake_case so they serialise into helper↔service IPC JSON and Firestore
    audit events. Single source of truth — no ad-hoc strings at call sites.
    """

    # Input / protocol
    BAD_REQUEST = 'bad_request'
    INVALID_INPUT = 'invalid_input'
    ZERO_PRIMARY = 'zero_primary'
    MULTIPLE_PRIMARY = 'multiple_primary'
    INVALID_ROTATION = 'invalid_rotation'

    # CCD query / validate / apply
    QUERY_FAILED = 'query_failed'
    VALIDATE_REJECTED = 'validate_rejected'
    MISSING_MONITORS = 'missing_monitors'
    ZERO_ACTIVE_PATHS_PRE = 'zero_active_paths_pre'
    ZERO_ACTIVE_PATHS_POST = 'zero_active_paths_post'
    SNAPSHOT_FAILED = 'snapshot_failed'
    APPLY_FAILED = 'apply_failed'
    APPLY_TIMEOUT = 'apply_timeout'
    POST_VERIFY_QUERY_FAILED = 'post_verify_query_failed'
    UNSUPPORTED_MODE = 'unsupported_mode'

    # Sentinel I/O
    SENTINEL_WRITE_FAILED = 'sentinel_write_failed'
    SENTINEL_READ_FAILED = 'sentinel_read_failed'
    SENTINEL_NO_SNAPSHOT = 'sentinel_no_snapshot'
    SENTINEL_MALFORMED = 'sentinel_malformed'
    UNSUPPORTED_SENTINEL_VERSION = 'unsupported_sentinel_version'

    # Preconditions / kill switches
    MOSAIC_ACTIVE = 'mosaic_active'

    # Auto-restore skip reasons (not failures)
    AUTO_RESTORE_SKIPPED_UNFIXABLE = 'auto_restore_skipped_unfixable'
    AUTO_RESTORE_RATE_LIMITED = 'auto_restore_rate_limited'

    # Helper lifecycle
    HELPER_FAILED = 'helper_failed'
    IPC_FAILURE = 'ipc_failure'

    # Ack lifecycle
    STALE_ACK = 'stale_ack'
    NO_PENDING_APPLY = 'no_pending_apply'

    # Fallback
    UNEXPECTED = 'unexpected'


# CCD API constants

QDC_ALL_PATHS = 0x00000001
QDC_ONLY_ACTIVE_PATHS = 0x00000002
QDC_DATABASE_CURRENT = 0x00000004

DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME = 1
DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME = 2
DISPLAYCONFIG_DEVICE_INFO_GET_ADAPTER_NAME = 4
DISPLAYCONFIG_DEVICE_INFO_GET_DPI_SCALE = -3  # undocumented but stable

DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE = 1
DISPLAYCONFIG_MODE_INFO_TYPE_TARGET = 2

DISPLAYCONFIG_ROTATION_IDENTITY = 1
DISPLAYCONFIG_ROTATION_ROTATE90 = 2
DISPLAYCONFIG_ROTATION_ROTATE180 = 3
DISPLAYCONFIG_ROTATION_ROTATE270 = 4

_ROTATION_DEGREES = {
    DISPLAYCONFIG_ROTATION_IDENTITY: 0,
    DISPLAYCONFIG_ROTATION_ROTATE90: 90,
    DISPLAYCONFIG_ROTATION_ROTATE180: 180,
    DISPLAYCONFIG_ROTATION_ROTATE270: 270,
}

DISPLAYCONFIG_PATH_ACTIVE = 0x00000001

# DISPLAYCONFIG_VIDEO_OUTPUT_TECHNOLOGY values we care about
_OUTPUT_TECH_HD15 = 0
_OUTPUT_TECH_DVI = 4
_OUTPUT_TECH_HDMI = 5
_OUTPUT_TECH_LVDS = 6
_OUTPUT_TECH_DP_EXTERNAL = 10
_OUTPUT_TECH_DP_EMBEDDED = 11
_OUTPUT_TECH_UDI_EXTERNAL = 12
_OUTPUT_TECH_UDI_EMBEDDED = 13
_OUTPUT_TECH_INTERNAL = 0x80000000

_CONNECTION_TYPE_MAP = {
    _OUTPUT_TECH_HD15: 'vga',
    _OUTPUT_TECH_DVI: 'dvi',
    _OUTPUT_TECH_HDMI: 'hdmi',
    _OUTPUT_TECH_LVDS: 'internal',
    _OUTPUT_TECH_DP_EXTERNAL: 'dp',
    _OUTPUT_TECH_DP_EMBEDDED: 'dp',
    _OUTPUT_TECH_UDI_EXTERNAL: 'udi',
    _OUTPUT_TECH_UDI_EMBEDDED: 'udi',
    _OUTPUT_TECH_INTERNAL: 'internal',
}

# Virtual / indirect output techs (Miracast, IddCx Remote Display Adapter,
# Indirect Virtual). Dropped at enumeration: they appear/disappear with RDP and
# dummy-plug drivers, churning the topology signature with phantom
# added/removed monitors. 18 (DISPLAYPORT_USB_TUNNEL) is real USB-C — kept.
_INDIRECT_OUTPUT_TECHS = frozenset({15, 16, 17})

ERROR_SUCCESS = 0
ERROR_INSUFFICIENT_BUFFER = 122
ERROR_GEN_FAILURE = 31  # SetDisplayConfig may return this during GPU TDR
ERROR_BAD_CONFIGURATION = 1610  # driver rejected the config — usually an
                                 # unsupported resolution / refresh combo.

# rcs meaning "panel can't do this mode". Everything else stays generic —
# rc=87 is as likely a bad struct as a bad mode.
_UNSUPPORTED_MODE_RCS = frozenset({ERROR_GEN_FAILURE, ERROR_BAD_CONFIGURATION})


def _ccd_failure_code(rc: int, stage: str):
    """Translate a SetDisplayConfig rc into a DisplayErrorCode.

    ``stage`` ('validate' | 'apply') picks the generic fallback. Pure so the
    mapping is testable without building real ctypes path arrays.
    """
    if rc in _UNSUPPORTED_MODE_RCS:
        return DisplayErrorCode.UNSUPPORTED_MODE
    if stage == 'validate':
        return DisplayErrorCode.VALIDATE_REJECTED
    return DisplayErrorCode.APPLY_FAILED

# SetDisplayConfig flags
SDC_TOPOLOGY_INTERNAL = 0x00000001
SDC_TOPOLOGY_CLONE = 0x00000002
SDC_TOPOLOGY_EXTEND = 0x00000004
SDC_TOPOLOGY_EXTERNAL = 0x00000008
SDC_TOPOLOGY_SUPPLIED = 0x00000010
SDC_USE_SUPPLIED_DISPLAY_CONFIG = 0x00000020
SDC_VALIDATE = 0x00000040
SDC_APPLY = 0x00000080
SDC_NO_OPTIMIZATION = 0x00000100
SDC_SAVE_TO_DATABASE = 0x00000200
SDC_ALLOW_CHANGES = 0x00000400
SDC_PATH_PERSIST_IF_REQUIRED = 0x00000800
SDC_FORCE_MODE_ENUMERATION = 0x00001000
SDC_ALLOW_PATH_ORDER_CHANGES = 0x00002000
SDC_USE_DATABASE_CURRENT = (
    SDC_TOPOLOGY_INTERNAL | SDC_TOPOLOGY_CLONE | SDC_TOPOLOGY_EXTEND | SDC_TOPOLOGY_EXTERNAL
)

_CCD_ENUMERATE_TIMEOUT = 2.0
_CCD_APPLY_TIMEOUT = 10.0

# apply_topology module state

_apply_lock = threading.Lock()
_ack_event = threading.Event()  # set by ack_apply() to cancel the revert timer
_apply_in_flight = False  # True between watchdog arm and watchdog exit; gates ack_apply
_current_apply_id = None  # UUID of the in-flight apply; ack must match it.
                          # Prevents stale acks for a prior apply from cancelling
                          # the watchdog of a newer apply.
_last_apply_time = 0.0
_last_apply_finished_at = 0.0  # wall-clock secs of the last apply success; 0.0
                                # = none yet. _emit_display_change_events stamps
                                # events inside the window `suppressAlert` +
                                # `correlatedApplyId` so routing skips the email
                                # but still fires the webhook for audit.
_APPLY_SUPPRESS_WINDOW_S = 90.0  # suppression window for post-apply display
                                  # events; module constant so tests override.
_APPLY_COOLDOWN_SECONDS = 10  # min gap between applies to prevent rapid-fire
_SENTINEL_PATH = None  # lazy-init via shared_utils.get_data_path('.display_revert_pending')
# In-process only: serialises sentinel I/O across the ack / watchdog / startup-
# recovery / apply threads. The helper subprocess deliberately skips it —
# helpers run synchronously (service blocks) so never concurrently with a
# service-side writer, and its write is atomic (.tmp + os.replace).
_sentinel_lock = threading.Lock()
_SENTINEL_SCHEMA_VERSION = 1  # bump when the on-disk sentinel shape changes

_IPC_TEMP_DIR = None  # lazy-init via shared_utils.get_data_path('ipc/display')
_IPC_TEMPDIR_LOCK = threading.Lock()
_IPC_SWEEP_DONE = False
_IPC_STALE_SECONDS = 60 * 60

# Deferred-revert state: startup recovery found a sentinel but no console user,
# so the helper (Session 1+ only) can't run. Preserve the sentinel and let
# _check_display_topology retry once a session appears. `_deferred_revert_alerted`
# fires `display_revert_deferred` once per sentinel; cleared in _cleanup_sentinel().
_deferred_revert_pending = False
_deferred_revert_alerted = False

_ROTATION_FROM_DEGREES = {
    0: DISPLAYCONFIG_ROTATION_IDENTITY,
    90: DISPLAYCONFIG_ROTATION_ROTATE90,
    180: DISPLAYCONFIG_ROTATION_ROTATE180,
    270: DISPLAYCONFIG_ROTATION_ROTATE270,
}


def _get_sentinel_path():
    global _SENTINEL_PATH
    if _SENTINEL_PATH is None:
        import shared_utils
        _SENTINEL_PATH = shared_utils.get_data_path('.display_revert_pending')
    return _SENTINEL_PATH


def _ipc_tempdir() -> str:
    """Return the display helper IPC directory, creating and hardening it.

    The service runs as LocalSystem, so the process temp directory points at
    ``C:\\Windows\\Temp`` and files created there are not readable by a standard
    console user. Display helpers cross from Session 0 into that user session,
    so they need a purpose-built directory with an explicit DACL.
    """
    global _IPC_TEMP_DIR, _IPC_SWEEP_DONE
    with _IPC_TEMPDIR_LOCK:
        if _IPC_TEMP_DIR is None:
            import shared_utils
            _IPC_TEMP_DIR = shared_utils.get_data_path(
                os.path.join('ipc', 'display')
            )
        ipc_dir = _IPC_TEMP_DIR
        try:
            os.makedirs(ipc_dir, exist_ok=True)
        except OSError as e:
            raise DisplayIpcError(
                f'display IPC directory unavailable {ipc_dir}: {e}'
            ) from e

        _ensure_ipc_dir_acl(ipc_dir)

        if not _IPC_SWEEP_DONE:
            _sweep_ipc_tempdir(ipc_dir)
            _IPC_SWEEP_DONE = True
        return ipc_dir


def _sweep_ipc_tempdir(
    ipc_dir: str,
    max_age_s: int = _IPC_STALE_SECONDS,
    now: Optional[float] = None,
) -> None:
    """Remove orphaned display IPC files older than ``max_age_s`` seconds."""
    cutoff = (time.time() if now is None else now) - max_age_s
    try:
        filenames = os.listdir(ipc_dir)
    except OSError as e:
        logger.debug('display IPC sweep: could not list %s: %s', ipc_dir, e)
        return

    for filename in filenames:
        if not (filename.startswith('owlette_display_') or filename.endswith('.tmp')):
            continue
        path = os.path.join(ipc_dir, filename)
        try:
            if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                os.remove(path)
        except OSError as e:
            logger.debug('display IPC sweep: could not remove %s: %s', path, e)


def _ensure_ipc_dir_acl(ipc_dir: str) -> None:
    """Apply the protected display IPC DACL on Windows.

    Expected directory DACL:
      - SYSTEM: Full
      - Administrators: Full
      - active console user: Modify, when a console user is detectable

    The ACEs are inheritable so request, response, stderr, and ``*.tmp`` files
    created under this directory receive the same access envelope. Parent
    inheritance is disabled to avoid inheriting the installer-level
    ``users-modify`` grant from ``C:\\ProgramData\\Owlette``.
    """
    if os.name != 'nt':
        return

    try:
        import win32security as ws
        import ntsecuritycon as ntcon
    except ImportError as e:
        raise DisplayIpcError(
            f'pywin32 unavailable for display IPC DACL setup: {e}'
        ) from e

    try:
        expected = _build_ipc_dacl_entries(ws, ntcon)
        if _ipc_dir_dacl_matches(ipc_dir, expected, ws, ntcon):
            return

        dacl = ws.ACL()
        for _label, access_mask, sid in expected:
            dacl.AddAccessAllowedAceEx(
                ws.ACL_REVISION,
                _ipc_ace_inherit_flags(ntcon),
                access_mask,
                sid,
            )

        protected_dacl = getattr(
            ws, 'PROTECTED_DACL_SECURITY_INFORMATION', None,
        )
        if protected_dacl is None:
            protected_dacl = -2147483648  # 0x80000000 as signed C long
        ws.SetNamedSecurityInfo(
            ipc_dir,
            ws.SE_FILE_OBJECT,
            ws.DACL_SECURITY_INFORMATION | protected_dacl,
            None,
            None,
            dacl,
            None,
        )
    except DisplayIpcError:
        raise
    except Exception as e:
        raise DisplayIpcError(
            f'failed to apply display IPC DACL to {ipc_dir}: {e}'
        ) from e


def _build_ipc_dacl_entries(ws, ntcon) -> list:
    """Build ``(label, mask, sid)`` entries for the display IPC DACL."""
    # well-known sids, not names: account names are localized, so a name lookup
    # fails on non-english windows ("Administratoren").
    system_sid = ws.ConvertStringSidToSid('S-1-5-18')
    admins_sid = ws.ConvertStringSidToSid('S-1-5-32-544')
    full = getattr(ntcon, 'FILE_ALL_ACCESS', ntcon.GENERIC_ALL)
    modify = (
        ntcon.FILE_GENERIC_READ
        | ntcon.FILE_GENERIC_WRITE
        | ntcon.FILE_GENERIC_EXECUTE
        | ntcon.DELETE
    )

    entries = [
        ('SYSTEM', full, system_sid),
        ('Administrators', full, admins_sid),
    ]
    user_sid = _active_console_user_sid(ws)
    if user_sid is not None:
        entries.append(('ConsoleUser', modify, user_sid))
    return entries


def _ipc_ace_inherit_flags(ntcon) -> int:
    return (
        getattr(ntcon, 'OBJECT_INHERIT_ACE', 0x01)
        | getattr(ntcon, 'CONTAINER_INHERIT_ACE', 0x02)
    )


def _active_console_user_sid(ws):
    """Resolve the active console user's SID, or ``None`` if unavailable."""
    try:
        import win32ts
    except ImportError:
        return None

    token = None
    try:
        session_id = win32ts.WTSGetActiveConsoleSessionId()
        if session_id == 0xFFFFFFFF:
            return None
        try:
            token = win32ts.WTSQueryUserToken(session_id)
            token_user = ws.GetTokenInformation(token, ws.TokenUser)
            return token_user[0] if isinstance(token_user, tuple) else token_user
        except Exception as e:
            logger.debug(
                'display IPC: WTSQueryUserToken failed (%s); trying session name',
                e,
            )
            return _active_console_user_sid_from_session_name(ws, win32ts, session_id)
    finally:
        if token is not None:
            try:
                token.Close()
            except Exception as e:
                logger.debug(
                    'display IPC: console user token close failed: %s', e,
                    exc_info=True,
                )


def _active_console_user_sid_from_session_name(ws, win32ts, session_id):
    """Fallback SID lookup that works in non-LocalSystem test runs."""
    try:
        username = win32ts.WTSQuerySessionInformation(
            None, session_id, win32ts.WTSUserName,
        )
        if not username:
            return None
        domain = win32ts.WTSQuerySessionInformation(
            None, session_id, win32ts.WTSDomainName,
        )
        account = f'{domain}\\{username}' if domain else username
        user_sid, _, _ = ws.LookupAccountName('', account)
        return user_sid
    except Exception as e:
        logger.debug('display IPC: console user SID lookup failed: %s', e)
        return None


def _ipc_dir_dacl_matches(ipc_dir: str, expected: list, ws, ntcon) -> bool:
    """Return True if ``ipc_dir`` already has the expected protected DACL."""
    try:
        sd = ws.GetNamedSecurityInfo(
            ipc_dir, ws.SE_FILE_OBJECT, ws.DACL_SECURITY_INFORMATION,
        )
        control, _revision = sd.GetSecurityDescriptorControl()
        se_dacl_protected = getattr(ws, 'SE_DACL_PROTECTED', 0x1000)
        if not (control & se_dacl_protected):
            return False
        dacl = sd.GetSecurityDescriptorDacl()
        if dacl is None or dacl.GetAceCount() != len(expected):
            return False

        expected_aces = {
            (
                _ipc_ace_inherit_flags(ntcon),
                int(mask),
                ws.ConvertSidToStringSid(sid),
            )
            for _label, mask, sid in expected
        }
        actual_aces = set()
        access_allowed_ace_type = getattr(ws, 'ACCESS_ALLOWED_ACE_TYPE', 0)
        for index in range(dacl.GetAceCount()):
            ace = dacl.GetAce(index)
            ace_header = ace[0]
            ace_type = ace_header[0]
            ace_flags = ace_header[1]
            access_mask = ace[1]
            sid = ace[-1]
            if ace_type != access_allowed_ace_type:
                return False
            actual_aces.add((
                int(ace_flags),
                int(access_mask),
                ws.ConvertSidToStringSid(sid),
            ))
        return actual_aces == expected_aces
    except Exception as e:
        logger.debug('display IPC: DACL comparison failed for %s: %s', ipc_dir, e)
        return False

# ctypes structs


class LUID(ctypes.Structure):
    _fields_ = [
        ('LowPart', wt.DWORD),
        ('HighPart', wt.LONG),
    ]


class POINTL(ctypes.Structure):
    _fields_ = [
        ('x', wt.LONG),
        ('y', wt.LONG),
    ]


class DISPLAYCONFIG_RATIONAL(ctypes.Structure):
    _fields_ = [
        ('Numerator', wt.UINT),
        ('Denominator', wt.UINT),
    ]


class DISPLAYCONFIG_2DREGION(ctypes.Structure):
    _fields_ = [
        ('cx', wt.UINT),
        ('cy', wt.UINT),
    ]


class _DISPLAYCONFIG_PATH_SOURCE_INFO_MODE_BITS(ctypes.Structure):
    _fields_ = [
        ('cloneGroupId', wt.WORD),
        ('sourceModeInfoIdx', wt.WORD),
    ]


class _DISPLAYCONFIG_PATH_SOURCE_INFO_MODE_UNION(ctypes.Union):
    _fields_ = [
        ('modeInfoIdx', wt.UINT),
        ('bits', _DISPLAYCONFIG_PATH_SOURCE_INFO_MODE_BITS),
    ]


class DISPLAYCONFIG_PATH_SOURCE_INFO(ctypes.Structure):
    _anonymous_ = ('u',)
    _fields_ = [
        ('adapterId', LUID),
        ('id', wt.UINT),
        ('u', _DISPLAYCONFIG_PATH_SOURCE_INFO_MODE_UNION),
        ('statusFlags', wt.UINT),
    ]


class _DISPLAYCONFIG_PATH_TARGET_INFO_MODE_BITS(ctypes.Structure):
    _fields_ = [
        ('desktopModeInfoIdx', wt.WORD),
        ('targetModeInfoIdx', wt.WORD),
    ]


class _DISPLAYCONFIG_PATH_TARGET_INFO_MODE_UNION(ctypes.Union):
    _fields_ = [
        ('modeInfoIdx', wt.UINT),
        ('bits', _DISPLAYCONFIG_PATH_TARGET_INFO_MODE_BITS),
    ]


class DISPLAYCONFIG_PATH_TARGET_INFO(ctypes.Structure):
    _anonymous_ = ('u',)
    _fields_ = [
        ('adapterId', LUID),
        ('id', wt.UINT),
        ('u', _DISPLAYCONFIG_PATH_TARGET_INFO_MODE_UNION),
        ('outputTechnology', wt.UINT),
        ('rotation', wt.UINT),
        ('scaling', wt.UINT),
        ('refreshRate', DISPLAYCONFIG_RATIONAL),
        ('scanLineOrdering', wt.UINT),
        ('targetAvailable', wt.BOOL),
        ('statusFlags', wt.UINT),
    ]


class DISPLAYCONFIG_PATH_INFO(ctypes.Structure):
    _fields_ = [
        ('sourceInfo', DISPLAYCONFIG_PATH_SOURCE_INFO),
        ('targetInfo', DISPLAYCONFIG_PATH_TARGET_INFO),
        ('flags', wt.UINT),
    ]


class DISPLAYCONFIG_SOURCE_MODE(ctypes.Structure):
    _fields_ = [
        ('width', wt.UINT),
        ('height', wt.UINT),
        ('pixelFormat', wt.UINT),
        ('position', POINTL),
    ]


class _DISPLAYCONFIG_VIDEO_SIGNAL_INFO_ADDITIONAL_BITS(ctypes.Structure):
    _fields_ = [
        ('videoStandard', wt.UINT, 16),
        ('vSyncFreqDivider', wt.UINT, 6),
        ('reserved', wt.UINT, 10),
    ]


class _DISPLAYCONFIG_VIDEO_SIGNAL_INFO_ADDITIONAL_UNION(ctypes.Union):
    _fields_ = [
        ('AdditionalSignalInfo', _DISPLAYCONFIG_VIDEO_SIGNAL_INFO_ADDITIONAL_BITS),
        ('videoStandard', wt.UINT),
    ]


class DISPLAYCONFIG_VIDEO_SIGNAL_INFO(ctypes.Structure):
    _anonymous_ = ('u',)
    _fields_ = [
        ('pixelRate', ctypes.c_uint64),
        ('hSyncFreq', DISPLAYCONFIG_RATIONAL),
        ('vSyncFreq', DISPLAYCONFIG_RATIONAL),
        ('activeSize', DISPLAYCONFIG_2DREGION),
        ('totalSize', DISPLAYCONFIG_2DREGION),
        ('u', _DISPLAYCONFIG_VIDEO_SIGNAL_INFO_ADDITIONAL_UNION),
        ('scanLineOrdering', wt.UINT),
    ]


class DISPLAYCONFIG_TARGET_MODE(ctypes.Structure):
    _fields_ = [
        ('targetVideoSignalInfo', DISPLAYCONFIG_VIDEO_SIGNAL_INFO),
    ]


class DISPLAYCONFIG_DESKTOP_IMAGE_INFO(ctypes.Structure):
    # Unused, but keeps the mode union large enough on all Windows 10+ SDKs
    # (48 bytes on x64, asserted below).
    _fields_ = [
        ('PathSourceSize', POINTL),
        ('DesktopImageRegion', ctypes.c_int32 * 4),
        ('DesktopImageClip', ctypes.c_int32 * 4),
    ]


class _DISPLAYCONFIG_MODE_INFO_UNION(ctypes.Union):
    _fields_ = [
        ('targetMode', DISPLAYCONFIG_TARGET_MODE),
        ('sourceMode', DISPLAYCONFIG_SOURCE_MODE),
        ('desktopImageInfo', DISPLAYCONFIG_DESKTOP_IMAGE_INFO),
    ]


class DISPLAYCONFIG_MODE_INFO(ctypes.Structure):
    _anonymous_ = ('u',)
    _fields_ = [
        ('infoType', wt.UINT),
        ('id', wt.UINT),
        ('adapterId', LUID),
        ('u', _DISPLAYCONFIG_MODE_INFO_UNION),
    ]


class DISPLAYCONFIG_DEVICE_INFO_HEADER(ctypes.Structure):
    _fields_ = [
        ('type', ctypes.c_int32),
        ('size', wt.UINT),
        ('adapterId', LUID),
        ('id', wt.UINT),
    ]


class _DISPLAYCONFIG_TARGET_DEVICE_NAME_FLAGS_BITS(ctypes.Structure):
    _fields_ = [
        ('friendlyNameFromEdid', wt.UINT, 1),
        ('friendlyNameForced', wt.UINT, 1),
        ('edidIdsValid', wt.UINT, 1),
        ('reserved', wt.UINT, 29),
    ]


class _DISPLAYCONFIG_TARGET_DEVICE_NAME_FLAGS(ctypes.Union):
    _fields_ = [
        ('bits', _DISPLAYCONFIG_TARGET_DEVICE_NAME_FLAGS_BITS),
        ('value', wt.UINT),
    ]


class DISPLAYCONFIG_TARGET_DEVICE_NAME(ctypes.Structure):
    _fields_ = [
        ('header', DISPLAYCONFIG_DEVICE_INFO_HEADER),
        ('flags', _DISPLAYCONFIG_TARGET_DEVICE_NAME_FLAGS),
        ('outputTechnology', wt.UINT),
        ('edidManufactureId', wt.WORD),
        ('edidProductCodeId', wt.WORD),
        ('connectorInstance', wt.UINT),
        ('monitorFriendlyDeviceName', wt.WCHAR * 64),
        ('monitorDevicePath', wt.WCHAR * 128),
    ]


class _DISPLAYCONFIG_GET_DPI_SCALE(ctypes.Structure):
    """Undocumented struct used with DISPLAYCONFIG_DEVICE_INFO_GET_DPI_SCALE.

    ``curScaleRel`` / ``minScaleRel`` / ``maxScaleRel`` are indices into the
    fixed DPI table below. ``curScaleRel`` of 0 always maps to 100%.
    """
    _fields_ = [
        ('header', DISPLAYCONFIG_DEVICE_INFO_HEADER),
        ('minScaleRel', ctypes.c_int32),
        ('curScaleRel', ctypes.c_int32),
        ('maxScaleRel', ctypes.c_int32),
    ]


class DISPLAYCONFIG_SOURCE_DEVICE_NAME(ctypes.Structure):
    """Return shape of DisplayConfigGetDeviceInfo(GET_SOURCE_NAME).

    ``viewGdiDeviceName`` is the ``\\\\.\\DISPLAYn`` device-name string that
    ``EnumDisplaySettingsExW`` accepts as ``lpszDeviceName``. Mirrors
    ``DISPLAYCONFIG_TARGET_DEVICE_NAME`` in structure — both are (header +
    fixed-width WCHAR payload). Win32 size: 20 + 32*2 = 84 bytes.
    """
    _fields_ = [
        ('header', DISPLAYCONFIG_DEVICE_INFO_HEADER),
        ('viewGdiDeviceName', wt.WCHAR * 32),
    ]


# DEVMODEW — required by EnumDisplaySettingsExW / ChangeDisplaySettingsEx.
# It's a tagged union: printer vs display layout. We mirror the printer arm
# purely for ABI padding; only the display fields are read. Canonical x64 size
# is 220 bytes, asserted in `_EXPECTED_SIZES` so SDK ABI drift fails loudly.


class _DEVMODEW_DISPLAY(ctypes.Structure):
    """Display-context arm of the first DEVMODEW union."""
    _fields_ = [
        ('dmPosition', POINTL),
        ('dmDisplayOrientation', wt.DWORD),
        ('dmDisplayFixedOutput', wt.DWORD),
    ]


class _DEVMODEW_PRINTER(ctypes.Structure):
    """Printer-context arm — present only so the union width matches the ABI."""
    _fields_ = [
        ('dmOrientation', ctypes.c_short),
        ('dmPaperSize', ctypes.c_short),
        ('dmPaperLength', ctypes.c_short),
        ('dmPaperWidth', ctypes.c_short),
        ('dmScale', ctypes.c_short),
        ('dmCopies', ctypes.c_short),
        ('dmDefaultSource', ctypes.c_short),
        ('dmPrintQuality', ctypes.c_short),
    ]


class _DEVMODEW_UNION1(ctypes.Union):
    _fields_ = [
        ('printer', _DEVMODEW_PRINTER),
        ('display', _DEVMODEW_DISPLAY),
    ]


class _DEVMODEW_UNION2(ctypes.Union):
    _fields_ = [
        ('dmDisplayFlags', wt.DWORD),
        ('dmNup', wt.DWORD),
    ]


# dmDisplayFlags interlaced bit; `_enum_modes_for_monitor` drops these from the
# supported-modes catalogue — nobody wants interlaced on a modern panel.
DM_INTERLACED = 0x00000002


class DEVMODEW(ctypes.Structure):
    _fields_ = [
        ('dmDeviceName', wt.WCHAR * 32),
        ('dmSpecVersion', wt.WORD),
        ('dmDriverVersion', wt.WORD),
        ('dmSize', wt.WORD),
        ('dmDriverExtra', wt.WORD),
        ('dmFields', wt.DWORD),
        ('_u1', _DEVMODEW_UNION1),
        ('dmColor', ctypes.c_short),
        ('dmDuplex', ctypes.c_short),
        ('dmYResolution', ctypes.c_short),
        ('dmTTOption', ctypes.c_short),
        ('dmCollate', ctypes.c_short),
        ('dmFormName', wt.WCHAR * 32),
        ('dmLogPixels', wt.WORD),
        ('dmBitsPerPel', wt.DWORD),
        ('dmPelsWidth', wt.DWORD),
        ('dmPelsHeight', wt.DWORD),
        ('_u2', _DEVMODEW_UNION2),
        ('dmDisplayFrequency', wt.DWORD),
        ('dmICMMethod', wt.DWORD),
        ('dmICMIntent', wt.DWORD),
        ('dmMediaType', wt.DWORD),
        ('dmDitherType', wt.DWORD),
        ('dmReserved1', wt.DWORD),
        ('dmReserved2', wt.DWORD),
        ('dmPanningWidth', wt.DWORD),
        ('dmPanningHeight', wt.DWORD),
    ]


# DPI scale percentages exposed by Windows settings (maps relative index → %).
_DPI_SCALE_TABLE = [100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500]

# Struct size sanity checks — everything here depends on an exact C ABI match.
# Fail loud at import rather than read garbage out of a mis-sized buffer.

_EXPECTED_SIZES = {
    'LUID': (LUID, 8),
    'POINTL': (POINTL, 8),
    'DISPLAYCONFIG_RATIONAL': (DISPLAYCONFIG_RATIONAL, 8),
    'DISPLAYCONFIG_2DREGION': (DISPLAYCONFIG_2DREGION, 8),
    'DISPLAYCONFIG_PATH_SOURCE_INFO': (DISPLAYCONFIG_PATH_SOURCE_INFO, 20),
    'DISPLAYCONFIG_PATH_TARGET_INFO': (DISPLAYCONFIG_PATH_TARGET_INFO, 48),
    'DISPLAYCONFIG_PATH_INFO': (DISPLAYCONFIG_PATH_INFO, 72),
    'DISPLAYCONFIG_SOURCE_MODE': (DISPLAYCONFIG_SOURCE_MODE, 20),
    'DISPLAYCONFIG_VIDEO_SIGNAL_INFO': (DISPLAYCONFIG_VIDEO_SIGNAL_INFO, 48),
    'DISPLAYCONFIG_TARGET_MODE': (DISPLAYCONFIG_TARGET_MODE, 48),
    'DISPLAYCONFIG_MODE_INFO': (DISPLAYCONFIG_MODE_INFO, 64),
    'DISPLAYCONFIG_DEVICE_INFO_HEADER': (DISPLAYCONFIG_DEVICE_INFO_HEADER, 20),
    'DISPLAYCONFIG_TARGET_DEVICE_NAME': (DISPLAYCONFIG_TARGET_DEVICE_NAME, 420),
    'DISPLAYCONFIG_SOURCE_DEVICE_NAME': (DISPLAYCONFIG_SOURCE_DEVICE_NAME, 84),
    'DEVMODEW': (DEVMODEW, 220),
}

for _name, (_cls, _expected) in _EXPECTED_SIZES.items():
    _actual = ctypes.sizeof(_cls)
    assert _actual == _expected, (
        '{0} size mismatch: expected {1} bytes, got {2}. '
        'CCD bindings rely on the Windows x64 ABI.'.format(_name, _expected, _actual)
    )

# user32.dll function prototypes

_user32 = ctypes.windll.user32

_GetDisplayConfigBufferSizes = _user32.GetDisplayConfigBufferSizes
_GetDisplayConfigBufferSizes.argtypes = [wt.UINT, ctypes.POINTER(wt.UINT), ctypes.POINTER(wt.UINT)]
_GetDisplayConfigBufferSizes.restype = wt.LONG

_QueryDisplayConfig = _user32.QueryDisplayConfig
_QueryDisplayConfig.argtypes = [
    wt.UINT,
    ctypes.POINTER(wt.UINT),
    ctypes.POINTER(DISPLAYCONFIG_PATH_INFO),
    ctypes.POINTER(wt.UINT),
    ctypes.POINTER(DISPLAYCONFIG_MODE_INFO),
    ctypes.c_void_p,
]
_QueryDisplayConfig.restype = wt.LONG

_DisplayConfigGetDeviceInfo = _user32.DisplayConfigGetDeviceInfo
_DisplayConfigGetDeviceInfo.argtypes = [ctypes.POINTER(DISPLAYCONFIG_DEVICE_INFO_HEADER)]
_DisplayConfigGetDeviceInfo.restype = wt.LONG

_SetDisplayConfig = _user32.SetDisplayConfig
_SetDisplayConfig.argtypes = [
    wt.UINT,
    ctypes.POINTER(DISPLAYCONFIG_PATH_INFO),
    wt.UINT,
    ctypes.POINTER(DISPLAYCONFIG_MODE_INFO),
    wt.UINT,
]
_SetDisplayConfig.restype = wt.LONG

_EnumDisplaySettingsExW = _user32.EnumDisplaySettingsExW
_EnumDisplaySettingsExW.argtypes = [
    wt.LPCWSTR,
    wt.DWORD,
    ctypes.POINTER(DEVMODEW),
    wt.DWORD,
]
_EnumDisplaySettingsExW.restype = wt.BOOL


# Low-level CCD calls


def _query_active_paths():
    """Return (paths, modes) for all currently active display paths.

    Retries once on ERROR_INSUFFICIENT_BUFFER because the topology can change
    between the size probe and the actual query (hot-plug race).
    """
    # QDC_ONLY_ACTIVE_PATHS queries the live topology. QDC_DATABASE_CURRENT is
    # a mutually exclusive query mode (saved database) — do NOT OR them.
    flags = QDC_ONLY_ACTIVE_PATHS
    for attempt in range(2):
        path_count = wt.UINT(0)
        mode_count = wt.UINT(0)
        rc = _GetDisplayConfigBufferSizes(flags, ctypes.byref(path_count), ctypes.byref(mode_count))
        if rc != ERROR_SUCCESS:
            raise OSError('GetDisplayConfigBufferSizes failed (rc={0})'.format(rc))

        paths = (DISPLAYCONFIG_PATH_INFO * path_count.value)()
        modes = (DISPLAYCONFIG_MODE_INFO * mode_count.value)()
        rc = _QueryDisplayConfig(
            flags,
            ctypes.byref(path_count),
            paths,
            ctypes.byref(mode_count),
            modes,
            None,
        )
        if rc == ERROR_SUCCESS:
            return list(paths[:path_count.value]), list(modes[:mode_count.value])
        if rc == ERROR_INSUFFICIENT_BUFFER and attempt == 0:
            continue
        raise OSError('QueryDisplayConfig failed (rc={0})'.format(rc))
    raise OSError('QueryDisplayConfig retry exhausted')


def _get_target_device_name(adapter_id: LUID, target_id: int):
    info = DISPLAYCONFIG_TARGET_DEVICE_NAME()
    info.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME
    info.header.size = ctypes.sizeof(DISPLAYCONFIG_TARGET_DEVICE_NAME)
    info.header.adapterId = adapter_id
    info.header.id = target_id
    rc = _DisplayConfigGetDeviceInfo(ctypes.cast(ctypes.byref(info), ctypes.POINTER(DISPLAYCONFIG_DEVICE_INFO_HEADER)))
    if rc != ERROR_SUCCESS:
        return None
    return info


def _get_source_device_name(adapter_id: LUID, source_id: int):
    """Resolve ``\\\\.\\DISPLAYn`` for a CCD source via DisplayConfigGetDeviceInfo.

    Returns the device-name string on success, ``None`` if the query fails or
    the driver returns an empty name. Mirrors ``_get_target_device_name`` —
    same header boilerplate, different info-type + output struct. The returned
    string is the exact ``lpszDeviceName`` argument EnumDisplaySettingsExW
    expects for walking that source's supported display modes.
    """
    info = DISPLAYCONFIG_SOURCE_DEVICE_NAME()
    info.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME
    info.header.size = ctypes.sizeof(DISPLAYCONFIG_SOURCE_DEVICE_NAME)
    info.header.adapterId = adapter_id
    info.header.id = source_id
    rc = _DisplayConfigGetDeviceInfo(
        ctypes.cast(ctypes.byref(info), ctypes.POINTER(DISPLAYCONFIG_DEVICE_INFO_HEADER))
    )
    if rc != ERROR_SUCCESS:
        return None
    name = info.viewGdiDeviceName
    return name if name else None


# `_enum_modes_for_monitor` filters: high-refresh panels enumerate 50+ modes;
# dropping interlaced / non-32bpp / sub-24Hz keeps the dashboard dropdown usable.
_MODE_MIN_REFRESH_HZ = 24
_MODE_REQUIRED_BPP = 32


def _enum_modes_for_monitor(device_name: str) -> list:
    """Walk supported display modes for a CCD source via EnumDisplaySettingsExW.

    ``device_name`` is a ``\\\\.\\DISPLAYn`` string from ``_get_source_device_name``.
    Drops interlaced / non-32bpp / sub-24Hz modes, dedupes on (w, h, hz), sorts
    descending. Wrapped in ``_with_timeout`` so a stuck driver can't hang the
    helper; on timeout returns [] and the catalogue emits ``modes: []``.

    Returns ``[{'w': int, 'h': int, 'hz': int}, ...]``.
    """
    if not device_name:
        return []

    def _walk():
        seen = set()
        out = []
        mode_num = 0
        # Bound the loop against a driver that returns TRUE forever; real GPUs
        # expose a few hundred modes at most.
        while mode_num < 4096:
            dev = DEVMODEW()
            dev.dmSize = ctypes.sizeof(DEVMODEW)
            ok = _EnumDisplaySettingsExW(device_name, mode_num, ctypes.byref(dev), 0)
            if not ok:
                break
            mode_num += 1
            if dev._u2.dmDisplayFlags & DM_INTERLACED:
                continue
            if int(dev.dmBitsPerPel) != _MODE_REQUIRED_BPP:
                continue
            hz = int(dev.dmDisplayFrequency)
            if hz < _MODE_MIN_REFRESH_HZ:
                continue
            w = int(dev.dmPelsWidth)
            h = int(dev.dmPelsHeight)
            key = (w, h, hz)
            if key in seen:
                continue
            seen.add(key)
            out.append({'w': w, 'h': h, 'hz': hz})
        out.sort(key=lambda m: (m['w'], m['h'], m['hz']), reverse=True)
        return out

    try:
        return _with_timeout(_walk, _CCD_ENUMERATE_TIMEOUT)
    except FuturesTimeoutError:
        logger.warning(
            'EnumDisplaySettingsExW enumeration timed out for %s', device_name
        )
        return []
    except Exception as e:  # pragma: no cover — defensive
        logger.warning(
            'EnumDisplaySettingsExW enumeration failed for %s: %s', device_name, e
        )
        return []


def _get_dpi_scale_percent(adapter_id: LUID, source_id: int) -> int:
    """Resolve the current DPI scale percent for a source via the undocumented
    DISPLAYCONFIG_DEVICE_INFO_GET_DPI_SCALE query. Defaults to 100 on failure.
    """
    try:
        req = _DISPLAYCONFIG_GET_DPI_SCALE()
        req.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_DPI_SCALE
        req.header.size = ctypes.sizeof(_DISPLAYCONFIG_GET_DPI_SCALE)
        req.header.adapterId = adapter_id
        req.header.id = source_id
        rc = _DisplayConfigGetDeviceInfo(
            ctypes.cast(ctypes.byref(req), ctypes.POINTER(DISPLAYCONFIG_DEVICE_INFO_HEADER))
        )
        if rc != ERROR_SUCCESS:
            return 100
        # curScaleRel is signed; the 100% entry sits at index -minScaleRel.
        # Clamp to table bounds so a bogus value can't crash.
        idx = req.curScaleRel - req.minScaleRel
        if idx < 0 or idx >= len(_DPI_SCALE_TABLE):
            return 100
        return int(_DPI_SCALE_TABLE[idx])
    except Exception as e:  # pragma: no cover — defensive
        logger.debug('DPI scale query failed: %s', e)
        return 100


# Helpers


def _luid_to_str(luid: LUID) -> str:
    # Mirrors Windows LUID display conventions; safe as a stable key.
    return '{0:08X}-{1:08X}'.format(luid.HighPart & 0xFFFFFFFF, luid.LowPart)


def _decode_edid_manufacturer(mfg_id: int) -> str:
    """EDID packs the 3-letter PNP vendor ID into a big-endian WORD."""
    if not mfg_id:
        return ''
    # Bytes arrive little-endian on the wire but the EDID layout is
    # big-endian; swap before unpacking.
    raw = ((mfg_id & 0xFF) << 8) | ((mfg_id >> 8) & 0xFF)
    letters = []
    for shift in (10, 5, 0):
        v = (raw >> shift) & 0x1F
        if v == 0:
            return ''
        letters.append(chr(ord('A') + v - 1))
    return ''.join(letters)


def _serial_from_device_path(device_path: str) -> str:
    """Extract a stable serial/instance token from the monitor device path.

    CCD doesn't expose the EDID serial, but the device path
    (``\\\\?\\DISPLAY#GSM5B09#5&abcdef&0&UID256#{...}``) encodes a per-instance
    id. The middle ``5&...`` segment is stable across boots for a given
    port+cable and separates otherwise-identical monitors.
    """
    if not device_path:
        return ''
    parts = device_path.split('#')
    # parts[0] = '\\?\DISPLAY', parts[1] = mfg+product, parts[2] = instance id
    if len(parts) >= 3:
        return parts[2]
    return ''


def _edid_hash(manufacturer: str, product_code: int, serial: str) -> str:
    # Identity fields only — deliberately excludes the friendly name, which
    # Windows reports inconsistently across driver state transitions (RDP
    # attach/detach, sleep, EDID re-read). Including it made every stored
    # monitor read "not connected" after a remote session.
    payload = '{0}|{1}|{2}'.format(manufacturer, product_code, serial)
    return hashlib.sha1(payload.encode('utf-8')).hexdigest()[:16]


def _product_code_to_int(product_code) -> int:
    # Live enumeration hashes the raw int, but Firestore-stored monitors carry
    # a zero-padded hex string ("000A"). Round-trip so recomputed hashes match.
    if product_code is None or product_code == '':
        return 0
    if isinstance(product_code, int):
        return product_code
    try:
        return int(str(product_code), 16)
    except (TypeError, ValueError):
        return 0


def canonical_edid_hash_for_monitor(monitor: dict) -> str:
    """Recompute a monitor's `edidHash` from its raw identity fields.

    For dicts persisted under an older hashing scheme. Falls back to the stored
    `edidHash` when the raw fields are missing.
    """
    if not isinstance(monitor, dict):
        return ''
    manufacturer = monitor.get('manufacturerId') or ''
    product_code = _product_code_to_int(monitor.get('productCode'))
    serial = monitor.get('serialNumber') or ''
    if not (manufacturer or product_code or serial):
        return monitor.get('edidHash') or ''
    return _edid_hash(manufacturer, product_code, serial)


def canonicalize_monitor_hashes(monitors):
    """Re-derive each monitor's `edidHash` from its raw identity fields.

    Idempotent. Non-dict entries and None input are filtered out.
    """
    if not monitors:
        return []
    out = []
    for m in monitors:
        if not isinstance(m, dict):
            continue
        canonical = dict(m)
        canonical['edidHash'] = canonical_edid_hash_for_monitor(m)
        out.append(canonical)
    return out


def canonicalize_assigned_layout(layout):
    """Apply `canonicalize_monitor_hashes` to a layout's `monitors` list.

    Returns the input unchanged if it isn't a dict with a monitor list.
    """
    if not isinstance(layout, dict):
        return layout
    monitors = layout.get('monitors')
    if not isinstance(monitors, list):
        return layout
    out = dict(layout)
    out['monitors'] = canonicalize_monitor_hashes(monitors)
    return out


def _refresh_hz(rate: DISPLAYCONFIG_RATIONAL) -> float:
    if not rate.Denominator:
        return 0.0
    return round(rate.Numerator / rate.Denominator, 2)


def _connection_type(tech: int) -> str:
    return _CONNECTION_TYPE_MAP.get(tech, 'unknown')


def _rotation_degrees(rotation: int) -> int:
    return _ROTATION_DEGREES.get(rotation, 0)


# ---------------------------------------------------------------------------
# Session 0 delegation — CCD needs the interactive session. In the service
# (LocalSystem / Session 0) CCD returns zero buffer sizes and QueryDisplayConfig
# fails rc=87, so we re-run in a subprocess launched into the console user's
# session via CreateProcessAsUser. Helper mode = the ``--enumerate-json`` /
# ``--apply-json`` CLI flags at the bottom of this file; one script, both roles.

_ENUM_HELPER_TIMEOUT = 4.0  # secs; ~1-2s typical, spawn can spike. Must stay under
                            # the 5s watchdog in _check_display_topology so we
                            # report a specific error instead of a silent cancel.

_ENUM_MODES_HELPER_TIMEOUT = 6.0  # secs; N monitors × K modes, so more headroom
                                   # than the single-walk enumerate helper.

_APPLY_HELPER_TIMEOUT = 20.0  # secs; spawn + query + validate + SDC_APPLY (with TDR
                              # retry) + post-verify. Must exceed
                              # 2 × _CCD_APPLY_TIMEOUT + 2s TDR sleep + spawn.


def _current_session_id() -> int:
    """Return the Windows session ID of the current process. ``-1`` on error."""
    try:
        kernel32 = ctypes.windll.kernel32
        sid = wt.DWORD(0)
        if not kernel32.ProcessIdToSessionId(kernel32.GetCurrentProcessId(), ctypes.byref(sid)):
            return -1
        return int(sid.value)
    except Exception:  # pragma: no cover — defensive
        return -1


def _is_session_0() -> bool:
    """True when running in Windows Session 0 (the services session).

    CCD always returns an empty topology there regardless of thread token, so
    callers must delegate to a helper in the user's session.
    """
    return _current_session_id() == 0


def _spawn_user_session_helper(
    helper_args: list,
    out_path: str,
    timeout: float,
) -> dict:
    """Spawn ``display_manager.py`` in the console user's session and read back JSON.

    ``helper_args`` are extra CLI args, e.g. ``['--enumerate-json', out_path]``.
    Caller owns the request file and ``out_path``. Helper stderr is redirected to
    a temp log and drained into the service log so failures aren't invisible.

    Raises ``DisplayEnumerationError`` on timeout, no console session, token
    failure, crash, or malformed response. Never returns partial data.
    """
    try:
        import win32ts
        import win32security
        import win32profile
        import win32process
        import win32con
        import win32event
    except ImportError as e:
        raise DisplayEnumerationError(
            f'pywin32 not available for user-session delegation: {e}'
        ) from e

    session_id = win32ts.WTSGetActiveConsoleSessionId()
    if session_id == 0xFFFFFFFF:
        raise DisplayEnumerationError(
            'no active console session; display helper requires an interactive user'
        )

    # Best-effort: WTSQueryUserToken needs SE_TCB_PRIVILEGE.
    try:
        priv_token = win32security.OpenProcessToken(
            ctypes.windll.kernel32.GetCurrentProcess(),
            win32security.TOKEN_ADJUST_PRIVILEGES | win32security.TOKEN_QUERY,
        )
        try:
            luid = win32security.LookupPrivilegeValue('', 'SeTcbPrivilege')
            win32security.AdjustTokenPrivileges(
                priv_token, False, [(luid, win32security.SE_PRIVILEGE_ENABLED)]
            )
        finally:
            priv_token.Close()
    except Exception as e:
        logger.debug('display helper: could not enable SeTcbPrivilege (%s)', e)

    user_token = None
    environment = None
    try:
        try:
            user_token = win32ts.WTSQueryUserToken(session_id)
            environment = win32profile.CreateEnvironmentBlock(user_token, False)
        except Exception as e:
            logger.debug(
                'display helper: WTSQueryUserToken failed (%s); trying token clone', e,
            )
            user_token, environment = _clone_user_token_from_explorer(session_id)
            if user_token is None:
                raise DisplayEnumerationError(
                    f'could not obtain console user token for session {session_id}'
                )

        tmp_dir = _ipc_tempdir()
        stderr_path = os.path.join(
            tmp_dir, f'owlette_display_helper_{uuid.uuid4().hex}.stderr.log',
        )

        python_exe = _resolve_python_exe()
        script_path = os.path.abspath(__file__)
        # list2cmdline implements CreateProcess's own quoting rules — handles
        # spaces, embedded quotes and trailing backslashes correctly.
        import subprocess as _sub
        cmd = _sub.list2cmdline([
            python_exe,
            script_path,
            *[str(a) for a in helper_args],
            '--stderr-log',
            stderr_path,
        ])

        startup_info = win32process.STARTUPINFO()
        startup_info.lpDesktop = 'WinSta0\\Default'

        DETACHED_PROCESS = 0x00000008
        CREATE_UNICODE_ENVIRONMENT = 0x00000400

        hProcess, hThread, pid, _ = win32process.CreateProcessAsUser(
            user_token,
            None,
            cmd,
            None,
            None,
            0,
            win32con.NORMAL_PRIORITY_CLASS | DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT,
            environment,
            None,
            startup_info,
        )
        logger.debug('display helper launched (pid=%s, session=%s)', pid, session_id)

        # hThread isn't needed for Wait/Terminate — close promptly.
        try:
            hThread.Close()
        except Exception as e:
            logger.debug('display helper: hThread.Close failed: %s', e, exc_info=True)

        timed_out = False
        exit_code = None
        try:
            # On WAIT_TIMEOUT we must kill it, or the zombie races future
            # helpers on the same CCD.
            rc = win32event.WaitForSingleObject(hProcess, int(timeout * 1000))
            if rc != 0:  # WAIT_OBJECT_0 == 0
                timed_out = True
                try:
                    win32process.TerminateProcess(hProcess, 1)
                except Exception as term_err:
                    logger.debug(
                        'display helper: TerminateProcess failed: %s', term_err,
                        exc_info=True,
                    )
            else:
                try:
                    exit_code = win32process.GetExitCodeProcess(hProcess)
                except Exception as e:
                    logger.debug(
                        'display helper: GetExitCodeProcess failed: %s', e,
                        exc_info=True,
                    )
        finally:
            try:
                hProcess.Close()
            except Exception as e:
                logger.debug('display helper: hProcess.Close failed: %s', e, exc_info=True)

        # Drain helper stderr into the service log; capped so a wedged helper
        # can't OOM the service.
        _STDERR_MAX_BYTES = 64 * 1024
        try:
            if os.path.exists(stderr_path):
                total = os.path.getsize(stderr_path)
                if total > 0:
                    with open(stderr_path, 'r', encoding='utf-8', errors='replace') as f:
                        stderr_content = f.read(_STDERR_MAX_BYTES)
                    if total > _STDERR_MAX_BYTES:
                        dropped = total - _STDERR_MAX_BYTES
                        stderr_content += f'\n[truncated — {dropped} bytes dropped]'
                    if stderr_content.strip():
                        logger.warning('display helper stderr:\n%s', stderr_content.rstrip())
            else:
                logger.warning(
                    'display helper stderr redirect did not create log file: %s',
                    stderr_path,
                )
        except OSError as drain_err:
            logger.debug('display helper: stderr drain failed: %s', drain_err)
        finally:
            try:
                if os.path.exists(stderr_path):
                    os.remove(stderr_path)
            except OSError:
                pass

        if timed_out:
            raise DisplayEnumerationError(
                f'display helper timed out after {timeout:.1f}s (process terminated)'
            )

        # Helper writes via atomic rename: file is whole or absent, never partial.
        if not os.path.exists(out_path):
            if exit_code == 2:
                raise DisplayIpcError(
                    f'display helper failed to write IPC response {out_path}'
                )
            raise DisplayEnumerationError(
                'display helper exited without writing response file'
            )
        try:
            with open(out_path, 'r', encoding='utf-8') as f:
                payload = json.load(f)
        except OSError as e:
            raise DisplayIpcError(
                f'display helper response unreadable {out_path}: {e}'
            ) from e
        except ValueError as e:
            raise DisplayEnumerationError(
                f'display helper response unreadable: {e}'
            ) from e

        if not isinstance(payload, dict):
            raise DisplayEnumerationError('display helper returned non-dict payload')
        return payload

    finally:
        # Must free the env block before closing its owning token.
        if environment is not None:
            try:
                import win32profile
                win32profile.DestroyEnvironmentBlock(environment)
            except Exception as e:
                logger.debug(
                    'display helper: DestroyEnvironmentBlock failed: %s', e,
                    exc_info=True,
                )
        if user_token is not None:
            try:
                user_token.Close()
            except Exception as e:
                logger.debug(
                    'display helper: user_token.Close failed: %s', e,
                    exc_info=True,
                )


def _enumerate_monitors_via_user_session() -> list:
    """Spawn a helper process in the active console user's session to run
    ``_enumerate_monitors`` and return the resulting list.

    Raises ``DisplayEnumerationError`` if no console user session is available
    or the helper fails / times out. Never returns partial data.
    """
    tmp_dir = _ipc_tempdir()
    out_path = os.path.join(tmp_dir, f'owlette_display_enum_{uuid.uuid4().hex}.json')
    try:
        payload = _spawn_user_session_helper(
            helper_args=['--enumerate-json', out_path],
            out_path=out_path,
            timeout=_ENUM_HELPER_TIMEOUT,
        )
        if payload.get('ok') is not True:
            err = payload.get('error', 'unknown error')
            raise DisplayEnumerationError(f'display helper error: {err}')
        monitors = payload.get('monitors')
        if not isinstance(monitors, list):
            raise DisplayEnumerationError('display helper returned no monitors list')
        return monitors
    finally:
        try:
            if os.path.exists(out_path):
                os.remove(out_path)
        except OSError:
            pass


def enumerate_modes_via_user_session() -> dict:
    """Spawn a helper in the active console user's session to build the
    supported-display-modes catalogue. Never raises — returns a plain dict so
    the caller (service command dispatch, wave A3.2 Firestore writer) can
    surface the result directly to the dashboard without additional try/except.

    Shape on success::

        {'ok': True, 'schemaVersion', 'signatureHash', 'capturedAt',
         'byEdidHash', 'enumerationFailed'}

    Shape on failure::

        {'ok': False, 'error': '...', 'code': DisplayErrorCode.HELPER_FAILED}

    ``HELPER_FAILED`` covers spawn failure, timeout, and any ``ok: False``
    payload emitted by the helper itself. An ``enumerationFailed: True`` flag
    inside a successful response signals a transient CCD stall inside the
    helper (A3.2 will treat that as "skip upload, try next cycle") — distinct
    from a hard helper failure.
    """
    out_path = None
    try:
        tmp_dir = _ipc_tempdir()
        out_path = os.path.join(tmp_dir, f'owlette_display_modes_{uuid.uuid4().hex}.json')
        try:
            payload = _spawn_user_session_helper(
                helper_args=['--enumerate-modes-json', out_path],
                out_path=out_path,
                timeout=_ENUM_MODES_HELPER_TIMEOUT,
            )
        except DisplayIpcError as e:
            logger.warning(
                'enumerate_modes_via_user_session: helper IPC failed: %s', e
            )
            return {
                'ok': False,
                'error': str(e),
                'code': DisplayErrorCode.IPC_FAILURE,
            }
        except Exception as e:
            logger.warning(
                'enumerate_modes_via_user_session: helper spawn failed: %s', e
            )
            return {
                'ok': False,
                'error': f'{type(e).__name__}: {e}',
                'code': DisplayErrorCode.HELPER_FAILED,
            }
        if payload.get('ok') is not True:
            err = payload.get('error', 'unknown error')
            logger.warning(
                'enumerate_modes_via_user_session: helper reported failure: %s', err
            )
            return {
                'ok': False,
                'error': str(err),
                'code': DisplayErrorCode.HELPER_FAILED,
            }
        return {
            'ok': True,
            'schemaVersion': payload.get('schemaVersion'),
            'signatureHash': payload.get('signatureHash'),
            'capturedAt': payload.get('capturedAt'),
            'byEdidHash': payload.get('byEdidHash', {}),
            'enumerationFailed': bool(payload.get('enumerationFailed', False)),
        }
    except DisplayIpcError as e:
        logger.warning(
            'enumerate_modes_via_user_session: helper IPC setup failed: %s', e
        )
        return {
            'ok': False,
            'error': str(e),
            'code': DisplayErrorCode.IPC_FAILURE,
        }
    finally:
        try:
            if out_path and os.path.exists(out_path):
                os.remove(out_path)
        except OSError:
            pass


def _clone_user_token_from_explorer(session_id: int):
    """Fallback when WTSQueryUserToken fails. Duplicates explorer.exe's primary
    token and builds an environment block. Returns ``(token, env)`` or
    ``(None, None)`` if no suitable process is found.
    """
    try:
        import psutil
        import win32security
        import win32profile
    except ImportError:
        return None, None

    PROCESS_QUERY_INFORMATION = 0x0400
    kernel32 = ctypes.windll.kernel32

    for candidate in ('explorer.exe', 'sihost.exe', 'taskhostw.exe', 'dwm.exe'):
        for proc in psutil.process_iter(['pid', 'name']):
            try:
                name = proc.info.get('name') or ''
                if name.lower() != candidate:
                    continue
                pid = proc.info['pid']
                proc_sid = ctypes.c_ulong(0)
                if not kernel32.ProcessIdToSessionId(pid, ctypes.byref(proc_sid)):
                    continue
                if proc_sid.value != session_id:
                    continue
                handle = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION, False, pid)
                if not handle:
                    continue
                try:
                    token = win32security.OpenProcessToken(
                        handle,
                        win32security.TOKEN_DUPLICATE | win32security.TOKEN_QUERY,
                    )
                    dup = win32security.DuplicateTokenEx(
                        token,
                        win32security.TOKEN_ALL_ACCESS,
                        None,
                        win32security.SecurityImpersonation,
                        win32security.TokenPrimary,
                    )
                    token.Close()
                    env = win32profile.CreateEnvironmentBlock(dup, False)
                    return dup, env
                finally:
                    kernel32.CloseHandle(handle)
            except Exception as e:
                logger.debug(
                    '_clone_user_token_from_explorer: candidate %r failed: %s',
                    candidate, e, exc_info=True,
                )
                continue
    return None, None


def _resolve_python_exe() -> str:
    """Resolve the Python executable to run the helper with. Prefer the
    service's bundled interpreter via ``shared_utils``, fall back to the
    currently running interpreter.
    """
    try:
        import shared_utils
        exe = shared_utils.get_python_exe_path()
        if exe and os.path.exists(exe):
            return exe
    except Exception as e:
        logger.debug('shared_utils.get_python_exe_path unavailable (%s)', e)
    return sys.executable


# Monitor enumeration


def _enumerate_monitors_ccd() -> list:
    """Enumerate monitors via direct CCD calls.

    Interactive session only — Session 0 reports zero paths and yields [].
    """
    paths, modes = _query_active_paths()
    monitors = []

    for path in paths:
        if not (path.flags & DISPLAYCONFIG_PATH_ACTIVE):
            continue

        source = path.sourceInfo
        target = path.targetInfo

        if int(target.outputTechnology) in _INDIRECT_OUTPUT_TECHS:
            logger.debug(
                'skipping indirect/virtual display path (tech=%s, targetId=%s)',
                int(target.outputTechnology), int(target.id),
            )
            continue

        source_mode = None
        source_mode_idx = source.modeInfoIdx
        if 0 <= source_mode_idx < len(modes):
            mi = modes[source_mode_idx]
            if mi.infoType == DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE:
                source_mode = mi.sourceMode
        if source_mode is None:
            logger.debug('path missing source mode, skipping (sourceId=%s)', source.id)
            continue

        device_name = _get_target_device_name(target.adapterId, target.id)
        friendly_name = ''
        manufacturer = ''
        product_code = 0
        serial = ''
        if device_name is not None:
            friendly_name = (device_name.monitorFriendlyDeviceName or '').strip()
            if device_name.flags.bits.edidIdsValid:
                manufacturer = _decode_edid_manufacturer(device_name.edidManufactureId)
                product_code = int(device_name.edidProductCodeId)
            serial = _serial_from_device_path(device_name.monitorDevicePath or '')

        adapter_str = _luid_to_str(target.adapterId)
        target_id = int(target.id)
        monitor_id = '{0}:{1}'.format(adapter_str, target_id)
        edid_hash = _edid_hash(manufacturer, product_code, serial)

        x = int(source_mode.position.x)
        y = int(source_mode.position.y)
        width = int(source_mode.width)
        height = int(source_mode.height)

        scale_pct = _get_dpi_scale_percent(source.adapterId, source.id)

        monitors.append({
            'id': monitor_id,
            'edidHash': edid_hash,
            'manufacturerId': manufacturer,
            'productCode': '{0:04X}'.format(product_code) if product_code else '',
            'serialNumber': serial,
            'friendlyName': friendly_name,
            'position': {'x': x, 'y': y},
            'resolution': {'width': width, 'height': height},
            'refreshHz': _refresh_hz(target.refreshRate),
            'rotation': _rotation_degrees(target.rotation),
            'scalePct': scale_pct,
            'primary': (x == 0 and y == 0),
            'connectionType': _connection_type(target.outputTechnology),
            'adapterLuid': adapter_str,
            'targetId': target_id,
        })

    # Stable order: primary first, then left-to-right, top-to-bottom.
    monitors.sort(key=lambda m: (not m['primary'], m['position']['x'], m['position']['y']))
    return monitors


def _enumerate_monitors() -> list:
    """Enumerate active monitors; delegates to a user-session helper in Session 0."""
    if _is_session_0():
        return _enumerate_monitors_via_user_session()
    return _enumerate_monitors_ccd()


def _enumerate_with_timeout(timeout: float = _CCD_ENUMERATE_TIMEOUT) -> list:
    """Run monitor enumeration under a watchdog — CCD calls can stall behind
    driver work after a hot-plug event.

    Returns the monitor list on success (possibly empty if zero monitors are
    connected). Raises ``DisplayEnumerationError`` on timeout or internal
    failure so callers can distinguish "no monitors" from "CCD call failed".

    In Session 0 the enumeration round-trip includes CreateProcessAsUser +
    subprocess startup + CCD call, so we extend this watchdog above the helper's
    own timeout. The 0.5s margin ensures _enumerate_monitors_via_user_session
    raises its own DisplayEnumerationError (with a descriptive message) before
    this outer ThreadPool kills it with an opaque FuturesTimeoutError.
    """
    if _is_session_0() and timeout < _ENUM_HELPER_TIMEOUT + 0.5:
        timeout = _ENUM_HELPER_TIMEOUT + 0.5
    # Manual lifecycle, not `with`: the default shutdown(wait=True) on block exit
    # blocks for the worker's FULL duration, defeating the very timeout this
    # watchdog exists to enforce. Same fix, same reason, as
    # _disk_usage_with_timeout in hardware_profile.py and
    # _wmi_logical_disk_with_timeout in shared_utils.py.
    #
    # This matters more here than at those two sites: this is the only watchdog
    # on the HEARTBEAT path. firebase_client._upload_metrics ->
    # _ensure_display_profile -> build_display_profile reaches it with no outer
    # pool, so a wedged console session stalled the heartbeat thread and the
    # machine read offline in the dashboard.
    #
    # Abandoning the worker is safe: its only external write is its own
    # uuid-named IPC file, removed by that helper's own finally, and the spawned
    # helper process is still killed by the TerminateProcess in the spawn path.
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        future = pool.submit(_enumerate_monitors)
        try:
            return future.result(timeout=timeout)
        except FuturesTimeoutError as e:
            logger.warning('display enumeration timed out after %.1fs', timeout)
            raise DisplayEnumerationError(
                f'CCD enumeration timed out after {timeout:.1f}s'
            ) from e
        except Exception as e:
            logger.warning('display enumeration failed: %s', e)
            raise DisplayEnumerationError(
                f'CCD enumeration failed: {e}'
            ) from e
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


# Public API


def build_display_profile() -> dict:
    """Build a display profile snapshot.

    Never raises. On enumeration failure returns ``enumerationFailed: True``
    with no monitors, so callers can tell a driver stall from an empty topology
    and skip an upload that would clobber valid Firestore data.
    """
    enumeration_failed = False
    try:
        monitors = _enumerate_with_timeout()
    except DisplayEnumerationError as e:
        logger.warning('build_display_profile: enumeration failed (%s); '
                       'emitting empty profile with enumerationFailed=True', e)
        monitors = []
        enumeration_failed = True

    profile = {
        'schemaVersion': SCHEMA_VERSION,
        'signatureHash': '',
        'capturedAt': int(time.time()),
        'monitors': monitors,
        'mosaicActive': False,
        'enumerationFailed': enumeration_failed,
    }
    profile['signatureHash'] = display_signature(profile)
    return profile


def _build_display_modes_catalogue() -> dict:
    """Per-edidHash catalogue of supported modes, for the editor's dropdowns.

    Signature-hashed against the current profile so the Firestore writer can
    skip the upload when the topology is unchanged.

    Shape::

        {
          'schemaVersion': 1,
          'signatureHash': '<32-char md5>',
          'capturedAt': <unix seconds>,
          'byEdidHash': {
            '<edid>': {'modes': [{'w', 'h', 'hz'}, ...], 'dpiScales': [...]},
          },
          'enumerationFailed': <optional: bool>,
        }

    Never raises (same contract as ``build_display_profile``): on failure emits
    an empty ``byEdidHash`` plus ``enumerationFailed: True``.
    """
    profile = build_display_profile()
    captured_at = int(time.time())
    base = {
        'schemaVersion': SCHEMA_VERSION,
        'signatureHash': profile['signatureHash'],
        'capturedAt': captured_at,
        'byEdidHash': {},
    }
    if profile.get('enumerationFailed'):
        base['enumerationFailed'] = True
        return base

    # (sourceAdapter, sourceId) per active target resolves the `\\.\DISPLAYn`
    # string for EnumDisplaySettingsExW. edidHash is re-derived from the same
    # target-device-name lookup `_enumerate_monitors_ccd` uses so both match.
    paths_result = _query_active_paths_safe()
    if paths_result is None:
        base['enumerationFailed'] = True
        return base
    paths, _unused_modes = paths_result

    by_edid = base['byEdidHash']
    for path in paths:
        if not (path.flags & DISPLAYCONFIG_PATH_ACTIVE):
            continue
        source = path.sourceInfo
        target = path.targetInfo
        if int(target.outputTechnology) in _INDIRECT_OUTPUT_TECHS:
            continue
        device_info = _get_target_device_name(target.adapterId, target.id)
        if device_info is None:
            continue

        if device_info.flags.bits.edidIdsValid:
            manufacturer = _decode_edid_manufacturer(device_info.edidManufactureId)
            product_code = int(device_info.edidProductCodeId)
        else:
            manufacturer = ''
            product_code = 0
        serial = _serial_from_device_path(device_info.monitorDevicePath or '')
        edid_hash = _edid_hash(manufacturer, product_code, serial)

        # Clone/mirror topologies point two active paths at one panel;
        # first-entry-wins avoids duplicate keys and a redundant mode walk.
        if edid_hash in by_edid:
            continue

        gdi_name = _get_source_device_name(source.adapterId, source.id)
        modes = _enum_modes_for_monitor(gdi_name) if gdi_name else []
        by_edid[edid_hash] = {
            'modes': modes,
            'dpiScales': list(_DPI_SCALE_TABLE),
        }

    return base


# Drift-detection fields. Mirrors DRIFT_FIELDS in web/hooks/useDisplayState.ts —
# keep in sync or our published count diverges from the dashboard's.
_DRIFT_FIELDS = (
    ('position.x',        lambda m: (m.get('position') or {}).get('x')),
    ('position.y',        lambda m: (m.get('position') or {}).get('y')),
    ('resolution.width',  lambda m: (m.get('resolution') or {}).get('width')),
    ('resolution.height', lambda m: (m.get('resolution') or {}).get('height')),
    ('refreshHz',         lambda m: m.get('refreshHz')),
    ('rotation',          lambda m: m.get('rotation')),
    ('scalePct',          lambda m: m.get('scalePct')),
    ('primary',           lambda m: m.get('primary')),
)


def compute_drift_count(live_monitors, assigned_monitors) -> int:
    """Count how many live monitors differ from their assigned counterpart.

    Keyed on edidHash so connector reshuffles aren't drift. Monitors on only
    one side are not counted — the dashboard handles "layout changed".
    Assigned-side hashes are re-derived so legacy-scheme layouts still match.
    """
    if not live_monitors or not assigned_monitors:
        return 0

    assigned_by_hash = {}
    for m in canonicalize_monitor_hashes(assigned_monitors):
        edid = m.get('edidHash')
        if edid:
            assigned_by_hash[edid] = m

    if not assigned_by_hash:
        return 0

    count = 0
    for live in live_monitors:
        if not isinstance(live, dict):
            continue
        edid = live.get('edidHash')
        if not edid:
            continue
        assigned = assigned_by_hash.get(edid)
        if assigned is None:
            continue
        for _label, extract in _DRIFT_FIELDS:
            if extract(live) != extract(assigned):
                count += 1
                break
    return count


def display_signature(profile: dict) -> str:
    """Deterministic md5 over the identity fields that define "same topology"."""
    monitors = []
    for m in profile.get('monitors', []) or []:
        monitors.append({
            'id': m.get('id'),
            'edidHash': m.get('edidHash'),
            'position': m.get('position'),
            'resolution': m.get('resolution'),
            'refreshHz': m.get('refreshHz'),
            'rotation': m.get('rotation'),
            'scalePct': m.get('scalePct'),
            'primary': m.get('primary'),
            'connectionType': m.get('connectionType'),
        })
    stable = {
        'schemaVersion': profile.get('schemaVersion'),
        'monitors': monitors,
        'mosaicActive': bool(profile.get('mosaicActive', False)),
    }
    payload = json.dumps(stable, sort_keys=True, separators=(',', ':'))
    return hashlib.md5(payload.encode('utf-8')).hexdigest()


# Write path — apply_topology / ack_apply / apply_revert_from_sentinel


def _with_timeout(fn, timeout: float):
    """Run ``fn`` in a worker thread under a watchdog.

    CCD calls stall behind driver work; an apply stalls longer after hot-plug/TDR.
    """
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(fn)
        return future.result(timeout=timeout)


def _query_active_paths_safe():
    """``_query_active_paths`` under the CCD watchdog. ``None`` on timeout/error."""
    try:
        return _with_timeout(_query_active_paths, _CCD_ENUMERATE_TIMEOUT)
    except FuturesTimeoutError:
        logger.warning('apply_topology: QueryDisplayConfig timed out')
        return None
    except Exception as e:
        logger.warning('apply_topology: QueryDisplayConfig failed: %s', e)
        return None


def _edid_hash_for_target(adapter_id: LUID, target_id: int) -> str:
    """edidHash for an (adapterId, targetId), matching ``_enumerate_monitors``.

    Used to match desired monitors to live paths.
    """
    device_name = _get_target_device_name(adapter_id, target_id)
    manufacturer = ''
    product_code = 0
    serial = ''
    if device_name is not None:
        if device_name.flags.bits.edidIdsValid:
            manufacturer = _decode_edid_manufacturer(device_name.edidManufactureId)
            product_code = int(device_name.edidProductCodeId)
        serial = _serial_from_device_path(device_name.monitorDevicePath or '')
    return _edid_hash(manufacturer, product_code, serial)


def _serialize_path(path: DISPLAYCONFIG_PATH_INFO) -> dict:
    """Serialise a PATH_INFO struct to a JSON-safe dict for sentinel persistence."""
    src = path.sourceInfo
    tgt = path.targetInfo
    return {
        'source': {
            'adapterLow': int(src.adapterId.LowPart),
            'adapterHigh': int(src.adapterId.HighPart),
            'id': int(src.id),
            'modeInfoIdx': int(src.modeInfoIdx),
            'statusFlags': int(src.statusFlags),
        },
        'target': {
            'adapterLow': int(tgt.adapterId.LowPart),
            'adapterHigh': int(tgt.adapterId.HighPart),
            'id': int(tgt.id),
            'modeInfoIdx': int(tgt.modeInfoIdx),
            'outputTechnology': int(tgt.outputTechnology),
            'rotation': int(tgt.rotation),
            'scaling': int(tgt.scaling),
            'refreshNum': int(tgt.refreshRate.Numerator),
            'refreshDen': int(tgt.refreshRate.Denominator),
            'scanLineOrdering': int(tgt.scanLineOrdering),
            'targetAvailable': int(tgt.targetAvailable),
            'statusFlags': int(tgt.statusFlags),
        },
        'flags': int(path.flags),
    }


def _serialize_mode(mode: DISPLAYCONFIG_MODE_INFO) -> dict:
    """Serialise a MODE_INFO struct to a JSON-safe dict."""
    base = {
        'infoType': int(mode.infoType),
        'id': int(mode.id),
        'adapterLow': int(mode.adapterId.LowPart),
        'adapterHigh': int(mode.adapterId.HighPart),
    }
    if mode.infoType == DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE:
        sm = mode.sourceMode
        base['source'] = {
            'width': int(sm.width),
            'height': int(sm.height),
            'pixelFormat': int(sm.pixelFormat),
            'positionX': int(sm.position.x),
            'positionY': int(sm.position.y),
        }
    elif mode.infoType == DISPLAYCONFIG_MODE_INFO_TYPE_TARGET:
        vsi = mode.targetMode.targetVideoSignalInfo
        base['target'] = {
            'pixelRate': int(vsi.pixelRate),
            'hSyncNum': int(vsi.hSyncFreq.Numerator),
            'hSyncDen': int(vsi.hSyncFreq.Denominator),
            'vSyncNum': int(vsi.vSyncFreq.Numerator),
            'vSyncDen': int(vsi.vSyncFreq.Denominator),
            'activeCx': int(vsi.activeSize.cx),
            'activeCy': int(vsi.activeSize.cy),
            'totalCx': int(vsi.totalSize.cx),
            'totalCy': int(vsi.totalSize.cy),
            'videoStandard': int(vsi.videoStandard),
            'scanLineOrdering': int(vsi.scanLineOrdering),
        }
    return base


def _deserialize_paths_modes(snapshot: dict):
    """Reconstruct (paths_array, modes_array) from a serialised snapshot."""
    raw_paths = snapshot.get('paths') or []
    raw_modes = snapshot.get('modes') or []

    paths = (DISPLAYCONFIG_PATH_INFO * len(raw_paths))()
    modes = (DISPLAYCONFIG_MODE_INFO * len(raw_modes))()

    for i, rp in enumerate(raw_paths):
        src = rp['source']
        tgt = rp['target']
        paths[i].sourceInfo.adapterId.LowPart = src['adapterLow']
        paths[i].sourceInfo.adapterId.HighPart = src['adapterHigh']
        paths[i].sourceInfo.id = src['id']
        paths[i].sourceInfo.modeInfoIdx = src['modeInfoIdx']
        paths[i].sourceInfo.statusFlags = src['statusFlags']
        paths[i].targetInfo.adapterId.LowPart = tgt['adapterLow']
        paths[i].targetInfo.adapterId.HighPart = tgt['adapterHigh']
        paths[i].targetInfo.id = tgt['id']
        paths[i].targetInfo.modeInfoIdx = tgt['modeInfoIdx']
        paths[i].targetInfo.outputTechnology = tgt['outputTechnology']
        paths[i].targetInfo.rotation = tgt['rotation']
        paths[i].targetInfo.scaling = tgt['scaling']
        paths[i].targetInfo.refreshRate.Numerator = tgt['refreshNum']
        paths[i].targetInfo.refreshRate.Denominator = tgt['refreshDen']
        paths[i].targetInfo.scanLineOrdering = tgt['scanLineOrdering']
        paths[i].targetInfo.targetAvailable = tgt['targetAvailable']
        paths[i].targetInfo.statusFlags = tgt['statusFlags']
        paths[i].flags = rp['flags']

    for i, rm in enumerate(raw_modes):
        modes[i].infoType = rm['infoType']
        modes[i].id = rm['id']
        modes[i].adapterId.LowPart = rm['adapterLow']
        modes[i].adapterId.HighPart = rm['adapterHigh']
        if rm['infoType'] == DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE and 'source' in rm:
            s = rm['source']
            modes[i].sourceMode.width = s['width']
            modes[i].sourceMode.height = s['height']
            modes[i].sourceMode.pixelFormat = s['pixelFormat']
            modes[i].sourceMode.position.x = s['positionX']
            modes[i].sourceMode.position.y = s['positionY']
        elif rm['infoType'] == DISPLAYCONFIG_MODE_INFO_TYPE_TARGET and 'target' in rm:
            t = rm['target']
            vsi = modes[i].targetMode.targetVideoSignalInfo
            vsi.pixelRate = t['pixelRate']
            vsi.hSyncFreq.Numerator = t['hSyncNum']
            vsi.hSyncFreq.Denominator = t['hSyncDen']
            vsi.vSyncFreq.Numerator = t['vSyncNum']
            vsi.vSyncFreq.Denominator = t['vSyncDen']
            vsi.activeSize.cx = t['activeCx']
            vsi.activeSize.cy = t['activeCy']
            vsi.totalSize.cx = t['totalCx']
            vsi.totalSize.cy = t['totalCy']
            vsi.videoStandard = t['videoStandard']
            vsi.scanLineOrdering = t['scanLineOrdering']

    return paths, modes


def _snapshot_live_config() -> dict:
    """Serialise the currently active path/mode arrays for later revert."""
    result = _query_active_paths_safe()
    if result is None:
        return None
    paths, modes = result
    return {
        'paths': [_serialize_path(p) for p in paths],
        'modes': [_serialize_mode(m) for m in modes],
    }


def _apply_snapshot(snapshot: dict) -> bool:
    """Restore a serialised snapshot via SetDisplayConfig. Never raises.

    ``SDC_SAVE_TO_DATABASE`` is required: without it the bad config Windows
    saved during the failed apply gets re-applied on the next driver reload.
    """
    try:
        paths, modes = _deserialize_paths_modes(snapshot)

        def _do_apply():
            return _SetDisplayConfig(
                len(paths), paths, len(modes), modes,
                SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG
                | SDC_SAVE_TO_DATABASE | SDC_ALLOW_CHANGES,
            )

        rc = _with_timeout(_do_apply, _CCD_APPLY_TIMEOUT)
        if rc != ERROR_SUCCESS:
            logger.error('_apply_snapshot: SetDisplayConfig failed (rc=%s)', rc)
            return False
        logger.info('_apply_snapshot: snapshot restored successfully')
        return True
    except FuturesTimeoutError:
        logger.error('_apply_snapshot: SetDisplayConfig timed out')
        return False
    except Exception as e:
        logger.error('_apply_snapshot: failed (%s)', e)
        return False


def _cleanup_sentinel():
    """Delete the sentinel file; swallow missing-file errors.

    Under ``_sentinel_lock`` — the ack, watchdog and startup-recovery paths
    otherwise race. Also clears the deferred-revert flags so a later stuck
    apply can re-defer and re-alert independently.
    """
    global _deferred_revert_pending, _deferred_revert_alerted
    with _sentinel_lock:
        try:
            path = _get_sentinel_path()
            if os.path.exists(path):
                os.remove(path)
        except OSError as e:
            logger.warning('_cleanup_sentinel: failed to delete sentinel (%s)', e)
        _deferred_revert_pending = False
        _deferred_revert_alerted = False


def _count_active_paths(paths) -> int:
    return sum(1 for p in paths if p.flags & DISPLAYCONFIG_PATH_ACTIVE)


_CANONICAL_ROTATIONS = (0, 90, 180, 270)


def _validate_desired_layout(desired_layout):
    """Return ``(ok, error_message, code)`` for a desired layout.

    Requires a non-empty ``monitors`` list, ``edidHash`` + ``position`` per
    monitor, exactly one ``primary``, and canonical rotations. The specific
    ``code`` lets the dashboard surface a targeted error without string-parsing.
    """
    if not isinstance(desired_layout, dict):
        return False, 'desired_layout must be a dict', DisplayErrorCode.INVALID_INPUT
    monitors = desired_layout.get('monitors')
    if not isinstance(monitors, list) or not monitors:
        return (
            False,
            'desired_layout.monitors must be a non-empty list',
            DisplayErrorCode.INVALID_INPUT,
        )
    primary_count = 0
    for i, m in enumerate(monitors):
        if not isinstance(m, dict):
            return False, f'monitors[{i}] must be a dict', DisplayErrorCode.INVALID_INPUT
        if not m.get('edidHash'):
            return (
                False,
                f'monitors[{i}] missing edidHash',
                DisplayErrorCode.INVALID_INPUT,
            )
        pos = m.get('position')
        if not isinstance(pos, dict) or 'x' not in pos or 'y' not in pos:
            return (
                False,
                f'monitors[{i}] missing position.x/y',
                DisplayErrorCode.INVALID_INPUT,
            )
        # Rotation optional (legacy captures omit it). CCD rejects off-tick
        # values at SDC_VALIDATE with a generic rc — catch it here instead.
        rot = m.get('rotation')
        if rot is not None and rot not in _CANONICAL_ROTATIONS:
            return (
                False,
                f'monitors[{i}] rotation {rot!r} not in {_CANONICAL_ROTATIONS}',
                DisplayErrorCode.INVALID_ROTATION,
            )
        if m.get('primary') is True:
            primary_count += 1
    if primary_count == 0:
        return (
            False,
            'no primary monitor — exactly one must be marked primary',
            DisplayErrorCode.ZERO_PRIMARY,
        )
    if primary_count > 1:
        return (
            False,
            f'{primary_count} monitors marked primary — only one may be',
            DisplayErrorCode.MULTIPLE_PRIMARY,
        )
    return True, None, None


def _apply_desired_to_paths(paths, modes, desired_by_hash, hash_by_path_idx):
    """Mutate the path/mode arrays in-place to reflect the desired layout.

    Re-offsets all positions so the primary sits at (0, 0) — Windows refuses a
    config with no source at origin. Returns
    ``{'monitorId', 'field', 'fromValue', 'toValue'}`` change descriptors.
    """
    changes = []

    path_lookup = {}  # path_idx -> desired monitor dict
    for path_idx, ehash in hash_by_path_idx.items():
        if ehash in desired_by_hash:
            path_lookup[path_idx] = desired_by_hash[ehash]

    offset_x, offset_y = 0, 0
    for desired in path_lookup.values():
        if desired.get('primary'):
            offset_x = int(desired['position']['x'])
            offset_y = int(desired['position']['y'])
            break

    for path_idx, desired in path_lookup.items():
        path = paths[path_idx]
        monitor_id = '{0}:{1}'.format(
            _luid_to_str(path.targetInfo.adapterId), int(path.targetInfo.id)
        )

        path.flags |= DISPLAYCONFIG_PATH_ACTIVE

        src_idx = path.sourceInfo.modeInfoIdx
        if 0 <= src_idx < len(modes) and modes[src_idx].infoType == DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE:
            sm = modes[src_idx].sourceMode

            new_x = int(desired['position']['x']) - offset_x
            new_y = int(desired['position']['y']) - offset_y
            if sm.position.x != new_x or sm.position.y != new_y:
                changes.append({
                    'monitorId': monitor_id,
                    'field': 'position',
                    'fromValue': {'x': int(sm.position.x), 'y': int(sm.position.y)},
                    'toValue': {'x': new_x, 'y': new_y},
                })
                sm.position.x = new_x
                sm.position.y = new_y

            resolution = desired.get('resolution')
            if isinstance(resolution, dict):
                new_w = int(resolution.get('width', sm.width))
                new_h = int(resolution.get('height', sm.height))
                if new_w > 0 and new_h > 0 and (sm.width != new_w or sm.height != new_h):
                    changes.append({
                        'monitorId': monitor_id,
                        'field': 'resolution',
                        'fromValue': {'width': int(sm.width), 'height': int(sm.height)},
                        'toValue': {'width': new_w, 'height': new_h},
                    })
                    sm.width = new_w
                    sm.height = new_h

        if 'rotation' in desired:
            new_rot = _ROTATION_FROM_DEGREES.get(int(desired['rotation']))
            if new_rot is not None and path.targetInfo.rotation != new_rot:
                changes.append({
                    'monitorId': monitor_id,
                    'field': 'rotation',
                    'fromValue': _rotation_degrees(path.targetInfo.rotation),
                    'toValue': int(desired['rotation']),
                })
                path.targetInfo.rotation = new_rot

        refresh = desired.get('refreshHz')
        if isinstance(refresh, (int, float)) and refresh > 0:
            current_hz = _refresh_hz(path.targetInfo.refreshRate)
            if abs(current_hz - float(refresh)) > 0.01:
                # Denominator 1000 so non-integer Hz (59.94) round-trips.
                new_num = int(round(float(refresh) * 1000))
                changes.append({
                    'monitorId': monitor_id,
                    'field': 'refreshHz',
                    'fromValue': current_hz,
                    'toValue': round(float(refresh), 2),
                })
                path.targetInfo.refreshRate.Numerator = new_num
                path.targetInfo.refreshRate.Denominator = 1000

        if desired.get('primary'):
            # Primary = source at (0, 0), already enforced by the offset above;
            # just surface it in the diff.
            changes.append({
                'monitorId': monitor_id,
                'field': 'primary',
                'fromValue': None,
                'toValue': True,
            })

    return changes


def _emit_audit(
    fb_client,
    action: str,
    level: str,
    details: str,
    extras: dict = None,
) -> None:
    """Fire-and-forget audit emission. Never raises — a broken Firestore client
    must not take down the apply path.

    Two sinks, both required:
      1. ``log_event`` → ``sites/{siteId}/logs``: dashboard feed + talon log
         bridge (``functions/src/talonLogEvents.ts``).
      2. ``send_display_alert`` → ``/api/agent/alert``: email + webhook
         delivery. Non-blocking, and it drops unrouted actions itself, so any
         audit action can be passed verbatim.

    ``details`` is merged into the alert payload because
    ``webhookSender.extractFields`` reads ``data.details``; ``extras`` wins.
    """
    if fb_client is None:
        return
    try:
        fb_client.log_event(
            action=action,
            level=level,
            details=details,
            extra_fields=extras or {},
        )
    except Exception as log_err:  # pragma: no cover — logging must never break callers
        logger.debug('_emit_audit(%s) failed: %s', action, log_err)

    try:
        alert_data = {'details': details}
        alert_data.update(extras or {})
        fb_client.send_display_alert(action, alert_data)
    except Exception as alert_err:  # alerting must never break the apply path
        logger.debug('_emit_audit(%s) alert dispatch failed: %s', action, alert_err)


def _trigger_profile_resync(firebase_client) -> None:
    """Force an immediate Firestore upload of the current display profile.

    Called after apply/revert so the dashboard canvas catches up in seconds
    rather than at the next ``_check_display_topology`` tick (~30s). Never
    raises — the tick path is the fallback.
    """
    if firebase_client is None:
        return
    try:
        firebase_client._ensure_display_profile(force=True)
    except Exception as e:  # pragma: no cover — resync must never break apply/revert
        logger.debug('_trigger_profile_resync failed: %s', e, exc_info=True)


def _make_revert_watchdog(revert_fn, ack_timeout: int, firebase_client):
    """Build the ack-or-revert watchdog (thread target; caller spawns it).

    ``revert_fn`` is zero-arg returning ``{'ok': bool, 'error'?: str}`` —
    ``_revert_via_user_session`` (S0) or ``_apply_snapshot`` (S1).

    Deletes the sentinel only on a successful revert, so a failed revert leaves
    the recovery hook for startup recovery. Always clears ``_apply_in_flight``
    in ``finally`` so a stale flag can't block later applies.
    """
    def _watchdog():
        global _apply_in_flight
        try:
            if _ack_event.wait(ack_timeout):
                _cleanup_sentinel()
                logger.info('apply_topology acked; revert canceled')
                return
            logger.warning(
                'apply_topology not acked within %ss; auto-reverting', ack_timeout,
            )
            try:
                rev = revert_fn() or {}
            except Exception as e:
                logger.exception('revert watchdog: revert_fn raised')
                rev = {'ok': False, 'error': str(e)}
            if rev.get('ok'):
                _cleanup_sentinel()
            else:
                logger.error(
                    'revert watchdog: revert failed (%s) — sentinel preserved for startup recovery',
                    rev.get('error', 'unknown'),
                )
            _trigger_profile_resync(firebase_client)
            details = (
                f'no ack received within {ack_timeout}s; auto-reverted'
                if rev.get('ok')
                else f'no ack received within {ack_timeout}s; auto-revert failed'
            )
            _emit_audit(
                firebase_client,
                'display_auto_revert_fired',
                'error',
                details,
                {
                    'eventType': 'display_auto_revert_fired',
                    'severity': 'critical',
                    'reason': 'no ack received within timeout',
                    'ackTimeoutSeconds': ack_timeout,
                    'revertOk': bool(rev.get('ok')),
                },
            )
        finally:
            _apply_in_flight = False
    return _watchdog


def _emit_success_and_build_response(
    apply_id: str,
    changes: list,
    ack_timeout: int,
    firebase_client,
    monitor_count: int,
) -> dict:
    """Shared success tail for S0 and S1: audit event + response dict.

    Called after the watchdog is armed. ``revertDeadlineEpochMs`` is currently
    unused by the dashboard (its countdown is client-local, since it doesn't
    subscribe to command-response docs) — returned for future use.
    """
    # Stamp completion so the operator-style drift events that always follow an
    # apply get correlated to it rather than alerting.
    global _last_apply_finished_at
    _last_apply_finished_at = time.time()
    revert_deadline_ms = int((time.time() + ack_timeout) * 1000)
    _emit_audit(
        firebase_client,
        'display_apply_succeeded',
        'info',
        f'{len(changes)} changes applied; revert in {ack_timeout}s unless acked',
        {
            'eventType': 'display_apply_succeeded',
            'severity': 'info',
            'monitorCount': monitor_count,
            'changes': changes,
            'revertDeadlineSeconds': ack_timeout,
            'revertDeadlineEpochMs': revert_deadline_ms,
            'applyId': apply_id,
        },
    )
    _trigger_profile_resync(firebase_client)
    return {
        'success': True,
        'applyId': apply_id,
        'changes': changes,
        'revertDeadlineSeconds': ack_timeout,
        'revertDeadlineEpochMs': revert_deadline_ms,
    }


def _apply_via_user_session(
    desired_layout: dict, sentinel_path: str, ack_timeout_s: int = 30,
    apply_id: str = None,
) -> dict:
    """Service-side wrapper: drive an apply through the user-session helper.

    The helper runs the full CCD write path (query → validate → mutate → write
    sentinel → SDC_APPLY → post-verify). On timeout/crash/malformed response
    returns ``{'ok': False, 'error': ..., 'code': 'helper_failed'}``.

    ``apply_id`` is threaded through so the helper stores it in the sentinel.
    Callers read ``ok`` + ``sentinel_written`` to decide on a defensive revert.
    """
    req_path = None
    out_path = None
    try:
        tmp_dir = _ipc_tempdir()
        uid = uuid.uuid4().hex
        req_path = os.path.join(tmp_dir, f'owlette_display_apply_{uid}.req.json')
        out_path = os.path.join(tmp_dir, f'owlette_display_apply_{uid}.out.json')
        _atomic_write_json(req_path, {
            'desired_layout': desired_layout,
            'sentinel_path': sentinel_path,
            'ack_timeout_s': int(ack_timeout_s),
            'apply_id': apply_id,
        })
        payload = _spawn_user_session_helper(
            helper_args=['--apply-json', req_path, out_path],
            out_path=out_path,
            timeout=_APPLY_HELPER_TIMEOUT,
        )
        return payload
    except DisplayIpcError as e:
        return {'ok': False, 'error': str(e), 'code': DisplayErrorCode.IPC_FAILURE}
    except OSError as e:
        return {
            'ok': False,
            'error': f'failed to write IPC request {req_path}: {e}',
            'code': DisplayErrorCode.IPC_FAILURE,
        }
    except DisplayEnumerationError as e:
        return {'ok': False, 'error': str(e), 'code': DisplayErrorCode.HELPER_FAILED}
    finally:
        for p in (req_path, out_path):
            try:
                if p and os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass


def _revert_via_user_session(
    snapshot: dict = None, sentinel_path: str = None,
) -> dict:
    """Service-side wrapper: drive a revert through the user-session helper.

    Supply exactly one of ``snapshot`` (used directly) or ``sentinel_path``
    (helper reads it from disk). Returns ``{'ok': bool, 'error'?: str}``.
    """
    if snapshot is None and not sentinel_path:
        return {'ok': False, 'error': 'must supply snapshot or sentinel_path', 'code': DisplayErrorCode.BAD_REQUEST}
    req_path = None
    out_path = None
    try:
        tmp_dir = _ipc_tempdir()
        uid = uuid.uuid4().hex
        req_path = os.path.join(tmp_dir, f'owlette_display_revert_{uid}.req.json')
        out_path = os.path.join(tmp_dir, f'owlette_display_revert_{uid}.out.json')
        req = {}
        if snapshot is not None:
            req['snapshot'] = snapshot
        if sentinel_path:
            req['sentinel_path'] = sentinel_path
        _atomic_write_json(req_path, req)
        payload = _spawn_user_session_helper(
            helper_args=['--revert-json', req_path, out_path],
            out_path=out_path,
            timeout=_APPLY_HELPER_TIMEOUT,
        )
        return payload
    except DisplayIpcError as e:
        return {'ok': False, 'error': str(e), 'code': DisplayErrorCode.IPC_FAILURE}
    except OSError as e:
        return {
            'ok': False,
            'error': f'failed to write IPC request {req_path}: {e}',
            'code': DisplayErrorCode.IPC_FAILURE,
        }
    except DisplayEnumerationError as e:
        return {'ok': False, 'error': str(e), 'code': DisplayErrorCode.HELPER_FAILED}
    finally:
        for p in (req_path, out_path):
            try:
                if p and os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass


def _self_test_via_user_session() -> dict:
    """Read-only apply self-test through the user-session helper.

    Backs the dashboard's "test apply capability" button so operators can
    verify helper IPC before enabling ``displays.remoteApplyEnabled``.
    Never mutates display state.
    """
    out_path = None
    try:
        tmp_dir = _ipc_tempdir()
        uid = uuid.uuid4().hex
        out_path = os.path.join(tmp_dir, f'owlette_display_selftest_{uid}.out.json')
        payload = _spawn_user_session_helper(
            helper_args=['--self-test', out_path],
            out_path=out_path,
            timeout=_APPLY_HELPER_TIMEOUT,
        )
        return payload
    except DisplayIpcError as e:
        return {'ok': False, 'error': str(e), 'code': DisplayErrorCode.IPC_FAILURE}
    except DisplayEnumerationError as e:
        return {'ok': False, 'error': str(e), 'code': DisplayErrorCode.HELPER_FAILED}
    finally:
        try:
            if out_path and os.path.exists(out_path):
                os.remove(out_path)
        except OSError:
            pass


def _apply_core(
    desired_layout: dict,
    sentinel_path: str,
    ack_timeout_s: int = 30,
    apply_id: str = None,
) -> dict:
    """Shared CCD write sequence; requires a session where CCD works.

    query → EDID coverage → mutate → pre-zero check → SDC_VALIDATE → snapshot →
    write sentinel → SDC_APPLY (TDR retry, per-call timeout) → post-verify.
    Never raises.

    Returns ``{ok, error?, code?, changes?, post_active_paths?,
    sentinel_written?}``. On failure, ``sentinel_written: True`` means the
    caller must run a defensive revert.

    Callers: ``_helper_apply_to_json`` (Session 0 delegation) and
    ``apply_topology``'s Session 1+ branch.
    """
    sentinel_written = False
    try:
        current = _query_active_paths_safe()
        if current is None:
            return {
                'ok': False,
                'error': 'failed to query current display config',
                'code': DisplayErrorCode.QUERY_FAILED,
            }
        paths, modes = current

        hash_by_path_idx = {}
        for idx, path in enumerate(paths):
            if not (path.flags & DISPLAYCONFIG_PATH_ACTIVE):
                continue
            ehash = _edid_hash_for_target(path.targetInfo.adapterId, path.targetInfo.id)
            if ehash:
                hash_by_path_idx[idx] = ehash

        # Canonicalise or every layout stored under the old (friendly-name
        # inclusive) hashing scheme fails MISSING_MONITORS after an upgrade.
        desired_by_hash = {
            m['edidHash']: m
            for m in canonicalize_monitor_hashes(desired_layout['monitors'])
            if m.get('edidHash')
        }
        live_hashes = set(hash_by_path_idx.values())
        missing = [h for h in desired_by_hash if h not in live_hashes]
        if missing:
            return {
                'ok': False,
                'error': f'desired monitors not present in live topology: {missing}',
                'code': DisplayErrorCode.MISSING_MONITORS,
                'missing': missing,
            }

        changes = _apply_desired_to_paths(paths, modes, desired_by_hash, hash_by_path_idx)

        if _count_active_paths(paths) == 0:
            return {
                'ok': False,
                'error': 'resulting config has zero active paths',
                'code': DisplayErrorCode.ZERO_ACTIVE_PATHS_PRE,
            }

        # ctypes coerces arrays to pointers but not lists, and
        # `_query_active_paths` returns lists — copy into typed arrays for
        # SetDisplayConfig. Must run AFTER `_apply_desired_to_paths`, which
        # mutates the structs in place.
        paths_arr = (DISPLAYCONFIG_PATH_INFO * len(paths))()
        for _i, _p in enumerate(paths):
            paths_arr[_i] = _p
        modes_arr = (DISPLAYCONFIG_MODE_INFO * len(modes))()
        for _i, _m in enumerate(modes):
            modes_arr[_i] = _m

        def _do_validate():
            return _SetDisplayConfig(
                len(paths_arr), paths_arr, len(modes_arr), modes_arr,
                SDC_VALIDATE | SDC_USE_SUPPLIED_DISPLAY_CONFIG,
            )
        try:
            rc = _with_timeout(_do_validate, _CCD_APPLY_TIMEOUT)
        except FuturesTimeoutError:
            return {
                'ok': False,
                'error': 'SDC_VALIDATE timed out',
                'code': DisplayErrorCode.VALIDATE_REJECTED,
            }
        if rc != ERROR_SUCCESS:
            return {
                'ok': False,
                'error': f'SDC_VALIDATE rejected config (rc={rc})',
                'code': _ccd_failure_code(rc, 'validate'),
                'rc': rc,
            }

        snapshot = _snapshot_live_config()
        if snapshot is None:
            return {
                'ok': False,
                'error': 'failed to snapshot live config for revert',
                'code': DisplayErrorCode.SNAPSHOT_FAILED,
            }

        # Sentinel BEFORE SDC_APPLY so a mid-apply crash is recoverable.
        sentinel_data = {
            'version': _SENTINEL_SCHEMA_VERSION,
            'apply_id': apply_id,
            'snapshot': snapshot,
            'deadline': int(time.time() + ack_timeout_s),
            'desired_summary': [
                {'edidHash': m['edidHash'], 'primary': bool(m.get('primary', False))}
                for m in desired_layout['monitors']
            ],
        }
        try:
            os.makedirs(os.path.dirname(sentinel_path), exist_ok=True)
            with _sentinel_lock:
                _atomic_write_json(sentinel_path, sentinel_data)
            sentinel_written = True
        except OSError as e:
            return {
                'ok': False,
                'error': f'failed to write revert sentinel: {e}',
                'code': DisplayErrorCode.SENTINEL_WRITE_FAILED,
            }

        # Per-call timeout + single TDR retry.
        def _do_apply():
            return _SetDisplayConfig(
                len(paths_arr), paths_arr, len(modes_arr), modes_arr,
                SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG
                | SDC_SAVE_TO_DATABASE | SDC_ALLOW_CHANGES,
            )
        try:
            rc = _with_timeout(_do_apply, _CCD_APPLY_TIMEOUT)
        except FuturesTimeoutError:
            return {
                'ok': False,
                'error': 'SDC_APPLY timed out',
                'code': DisplayErrorCode.APPLY_TIMEOUT,
                'sentinel_written': sentinel_written,
            }
        if rc == ERROR_GEN_FAILURE:
            logger.warning('_apply_core: ERROR_GEN_FAILURE (possible TDR); retrying in 2s')
            time.sleep(2)
            try:
                rc = _with_timeout(_do_apply, _CCD_APPLY_TIMEOUT)
            except FuturesTimeoutError:
                return {
                    'ok': False,
                    'error': 'SDC_APPLY retry timed out',
                    'code': DisplayErrorCode.APPLY_TIMEOUT,
                    'sentinel_written': sentinel_written,
                }
        if rc != ERROR_SUCCESS:
            return {
                'ok': False,
                'error': f'SDC_APPLY failed (rc={rc})',
                'code': _ccd_failure_code(rc, 'apply'),
                'rc': rc,
                'sentinel_written': sentinel_written,
            }

        # Post-apply verify: catch a config that left zero monitors active.
        post = _query_active_paths_safe()
        if post is None:
            return {
                'ok': False,
                'error': 'post-apply query failed',
                'code': DisplayErrorCode.POST_VERIFY_QUERY_FAILED,
                'sentinel_written': sentinel_written,
            }
        post_paths, _post_modes = post
        post_count = _count_active_paths(post_paths)
        if post_count == 0:
            return {
                'ok': False,
                'error': 'post-apply config has zero active paths',
                'code': DisplayErrorCode.ZERO_ACTIVE_PATHS_POST,
                'sentinel_written': sentinel_written,
            }

        return {
            'ok': True,
            'changes': changes,
            'post_active_paths': post_count,
            'sentinel_written': sentinel_written,
            # Returned so Session 1 callers can arm the watchdog without
            # re-reading the sentinel. JSON-safe (ctypes already stripped by
            # `_snapshot_live_config`), so it crosses the helper boundary too.
            '_snapshot': snapshot,
        }
    except Exception as e:
        logger.exception('_apply_core: unexpected failure')
        return {
            'ok': False,
            'error': f'unexpected: {type(e).__name__}: {e}',
            'code': DisplayErrorCode.UNEXPECTED,
            'sentinel_written': sentinel_written,
        }


def apply_topology(
    desired_layout: dict,
    ack_timeout: int = 30,
    firebase_client=None,
    apply_id: str = None,
    auto_restore: bool = False,
) -> dict:
    """Apply a desired monitor layout with ack-or-revert safety.

    SDC_VALIDATE → snapshot → sentinel → apply, then a daemon watchdog reverts
    unless ``ack_apply()`` lands within ``ack_timeout``. Never raises; returns
    ``{'success': bool, ...}``.

    ``firebase_client=None`` (tests, CLI) silently skips audit events.

    ``auto_restore=True`` marks an unattended drift-correction apply: all gates
    still run, but no watchdog is armed (nobody to ack), the sentinel is removed
    (drift re-fires auto-restore from a fresh state), and the event is
    ``display_auto_restore_fired``.
    """
    global _last_apply_time, _apply_in_flight

    monitor_count = len(desired_layout.get('monitors', [])) if isinstance(desired_layout, dict) else 0

    def _emit_auto_restore_success(changes: list) -> dict:
        # No watchdog / deadline / sentinel: the topology checker re-fires on
        # the next tick if this apply silently regressed.
        global _last_apply_finished_at
        _last_apply_finished_at = time.time()
        _cleanup_sentinel()
        _emit_audit(
            firebase_client,
            'display_auto_restore_fired',
            'info',
            f'{len(changes)} changes applied (auto-restore)',
            {
                'eventType': 'display_auto_restore_fired',
                'severity': 'info',
                'monitorCount': monitor_count,
                'changes': changes,
                'applyId': apply_id,
                'autoRestore': True,
            },
        )
        _trigger_profile_resync(firebase_client)
        return {
            'success': True,
            'applyId': apply_id,
            'changes': changes,
            'autoRestore': True,
        }

    def _emit_failure(error_str: str, code: Optional[str] = None) -> None:
        payload = {
            'eventType': 'display_apply_failed',
            'severity': 'warning',
            'error': error_str,
            'monitorCount': monitor_count,
        }
        # Specific failure class in the payload so the dashboard and alert
        # routing don't have to parse the error string.
        if code:
            payload['code'] = str(code)
        _emit_audit(
            firebase_client,
            'display_apply_failed',
            'warning',
            error_str,
            payload,
        )

    # Kill switch, checked before any lock / audit / CCD call. Missing key =
    # enabled (mirrors _check_display_topology).
    try:
        import shared_utils
        if shared_utils.read_config(['displays', 'enabled']) is False:
            return {'success': False, 'error': 'displays feature disabled by config'}
    except Exception:  # pragma: no cover — config read failures shouldn't block apply
        pass

    # Write-path-only kill switch, default OFF: a fresh agent can't be remotely
    # reconfigured until an operator opts in. `displays.enabled` gates the whole
    # feature including drift detection; this one gates only writes.
    try:
        import shared_utils
        if shared_utils.read_config(['displays', 'remoteApplyEnabled']) is not True:
            return {'success': False, 'error': 'remote apply disabled by config'}
    except Exception:  # pragma: no cover — config read failures shouldn't block apply
        pass

    # Mutating individual CCD paths under NVIDIA Mosaic can unravel the grid.
    # Refuse cleanly until Mosaic support lands.
    try:
        import nvapi_display
        if nvapi_display.detect_mosaic().get('mosaicActive'):
            error_str = 'NVIDIA Mosaic is active — remote apply not supported while Mosaic is enabled'
            _emit_audit(
                firebase_client,
                'display_apply_refused_mosaic',
                'warning',
                error_str,
                {'eventType': 'display_apply_refused_mosaic', 'severity': 'warning'},
            )
            return {'success': False, 'error': error_str, 'code': DisplayErrorCode.MOSAIC_ACTIVE}
    except Exception as e:  # pragma: no cover — nvapi probe must never block non-NV machines
        logger.debug('apply_topology: Mosaic detection failed (assuming inactive): %s', e)

    if not _apply_lock.acquire(blocking=False):
        # Contention, not an apply attempt — no audit event.
        return {'success': False, 'error': 'apply already in progress'}

    # Arm ack state early so an ack arriving *during* the apply work is still
    # accepted. `_armed` tracks whether the watchdog actually started; the
    # finally block clears `_apply_in_flight` so a stale flag can't block later
    # applies. `apply_id` is the ack generation token — prefer the caller's
    # (dashboard threads one UUID through apply + ack), else mint one.
    global _current_apply_id
    _ack_event.clear()
    _apply_in_flight = True
    _current_apply_id = apply_id if apply_id else uuid.uuid4().hex
    apply_id = _current_apply_id
    _armed = False

    try:
        # Pre-apply rate-limit gate; no audit event.
        elapsed = time.time() - _last_apply_time
        if elapsed < _APPLY_COOLDOWN_SECONDS:
            remaining = _APPLY_COOLDOWN_SECONDS - elapsed
            return {
                'success': False,
                'error': f'rate limited — {remaining:.0f}s cooldown remaining',
            }

        # Shape only. Topology-dependent checks (EDID coverage, zero active
        # paths) run in the helper — Session 0 can't query CCD.
        ok, err, validation_code = _validate_desired_layout(desired_layout)
        if not ok:
            error_str = f'invalid input: {err}'
            resolved_code = validation_code or DisplayErrorCode.INVALID_INPUT
            _emit_failure(error_str, resolved_code)
            return {
                'success': False,
                'error': error_str,
                'code': resolved_code,
            }

        sentinel_path = _get_sentinel_path()

        # Session 0: delegate the whole write path to the console-session
        # helper, which sentinels before SDC_APPLY for crash recovery.
        if _is_session_0():
            helper_result = _apply_via_user_session(
                desired_layout, sentinel_path, ack_timeout, apply_id=apply_id,
            )
            if not helper_result.get('ok'):
                error_str = helper_result.get('error', 'helper failed')
                # The helper may have sentinelled and applied before failing
                # (e.g. post-verify saw zero active paths) — revert through a
                # fresh helper to land on a known-good state.
                if helper_result.get('sentinel_written') or os.path.exists(sentinel_path):
                    logger.error(
                        'apply helper failed with sentinel on disk (%s); '
                        'spawning defensive revert', error_str,
                    )
                    try:
                        rev_result = _revert_via_user_session(sentinel_path=sentinel_path)
                    except Exception as rev_err:
                        logger.error('defensive revert also failed: %s', rev_err)
                        rev_result = {'ok': False, 'error': str(rev_err)}
                    # Keep the sentinel unless the revert succeeded — it's the
                    # recovery hook startup needs on the next boot.
                    if rev_result.get('ok'):
                        _cleanup_sentinel()
                    else:
                        logger.error(
                            'defensive revert failed (%s); sentinel preserved for startup recovery',
                            rev_result.get('error', 'unknown'),
                        )
                helper_code = helper_result.get('code')
                _emit_failure(error_str, helper_code)
                return {
                    'success': False,
                    'error': error_str,
                    'code': helper_code,
                }

            # Arm the watchdog; its revert goes through a fresh helper reading
            # the sentinel (the S0 service can't call CCD itself).
            changes = helper_result.get('changes', [])
            _last_apply_time = time.time()
            if auto_restore:
                logger.info(
                    'apply_topology (helper, auto-restore) succeeded (%s changes); '
                    'no watchdog armed', len(changes),
                )
                return _emit_auto_restore_success(changes)
            watchdog = _make_revert_watchdog(
                lambda sp=sentinel_path: _revert_via_user_session(sentinel_path=sp),
                ack_timeout,
                firebase_client,
            )
            threading.Thread(
                target=watchdog, name='display-apply-watchdog', daemon=True,
            ).start()
            _armed = True
            logger.info(
                'apply_topology (helper) succeeded (%s changes); revert in %ss unless acked',
                len(changes), ack_timeout,
            )
            return _emit_success_and_build_response(
                apply_id, changes, ack_timeout, firebase_client, monitor_count,
            )

        # Session 1+ (debug mode) — CCD works in-process, no helper needed.
        core_result = _apply_core(
            desired_layout, sentinel_path, ack_timeout, apply_id=apply_id,
        )
        if not core_result.get('ok'):
            error_str = core_result.get('error', 'apply failed')
            if core_result.get('sentinel_written'):
                try:
                    snap_data = None
                    with _sentinel_lock:
                        if os.path.exists(sentinel_path):
                            with open(sentinel_path, 'r', encoding='utf-8') as f:
                                snap_data = json.load(f).get('snapshot')
                    if snap_data:
                        rev_ok = _apply_snapshot(snap_data)
                        if rev_ok:
                            _cleanup_sentinel()
                        else:
                            logger.error(
                                'apply_topology S1: defensive revert failed — sentinel preserved'
                            )
                except Exception as rev_err:
                    logger.error('apply_topology S1: defensive revert raised: %s', rev_err)
            _emit_failure(error_str, core_result.get('code'))
            return {'success': False, 'error': error_str, 'code': core_result.get('code')}

        changes = core_result.get('changes', [])
        # In-band snapshot so the watchdog closure doesn't re-read the sentinel
        # — saves I/O and closes the window where a racing cleanup steals it.
        # Helper responses strip `_snapshot`; it never crosses IPC.
        snapshot = core_result.get('_snapshot')
        _last_apply_time = time.time()
        if auto_restore:
            logger.info(
                'apply_topology (auto-restore) succeeded (%s changes); '
                'no watchdog armed', len(changes),
            )
            return _emit_auto_restore_success(changes)
        watchdog = _make_revert_watchdog(
            lambda snap=snapshot: {'ok': _apply_snapshot(snap)},
            ack_timeout,
            firebase_client,
        )
        threading.Thread(
            target=watchdog, name='display-apply-watchdog', daemon=True,
        ).start()
        _armed = True  # watchdog owns _apply_in_flight from here
        logger.info(
            'apply_topology succeeded (%s changes); revert in %ss unless acked',
            len(changes), ack_timeout,
        )
        return _emit_success_and_build_response(
            apply_id, changes, ack_timeout, firebase_client, monitor_count,
        )

    except Exception as e:
        logger.exception('apply_topology: unexpected failure')
        error_str = f'unexpected failure: {e}'
        _emit_failure(error_str)
        _cleanup_sentinel()  # ensure no orphan sentinel on unexpected failure
        return {'success': False, 'error': error_str}
    finally:
        if not _armed:
            # Watchdog never started — clear the flag or the next apply blocks.
            _apply_in_flight = False
        _apply_lock.release()


def is_within_apply_suppression_window(
    now: float = None, window_s: float = None,
) -> bool:
    """True when ``now`` is inside the post-apply suppression window.

    ``_emit_display_change_events`` uses this to stamp ``suppressAlert: True``
    on drift events that merely follow a successful apply. Always False while
    ``_last_apply_finished_at`` is 0.0, so fresh-boot drift isn't mis-correlated.
    ``now`` / ``window_s`` are injectable for tests.
    """
    if _last_apply_finished_at == 0.0:
        return False
    current = time.time() if now is None else now
    window = _APPLY_SUPPRESS_WINDOW_S if window_s is None else window_s
    return (current - _last_apply_finished_at) < window


def ack_apply(apply_id: str = None, firebase_client=None) -> dict:
    """Acknowledge a pending apply, cancelling its auto-revert watchdog.

    ``apply_id`` must match the in-flight generation token, so a stale ack from
    a prior apply can't cancel a newer watchdog. Omitting it (legacy callers)
    accepts any in-flight apply. Returns ``{'success': False}`` on mismatch or
    when nothing is in flight.

    ``firebase_client`` emits ``display_apply_acked`` — the only honest record
    that the *agent* acked; the web toast only proves the Firestore write.
    """
    if not _apply_in_flight:
        return {
            'success': False,
            'error': 'no pending apply to ack',
            'code': DisplayErrorCode.NO_PENDING_APPLY,
        }
    if apply_id is not None and apply_id != _current_apply_id:
        logger.warning(
            'ack_apply: apply_id mismatch (got %r, expected %r) — ignoring stale ack',
            apply_id, _current_apply_id,
        )
        return {
            'success': False,
            'error': 'stale ack: apply_id does not match in-flight apply',
            'code': DisplayErrorCode.STALE_ACK,
        }
    _ack_event.set()
    acked_id = _current_apply_id
    logger.info('ack_apply: pending apply %s acknowledged', acked_id or '(unknown)')
    _emit_audit(
        firebase_client,
        'display_apply_acked',
        'info',
        f'apply {acked_id or "(unknown)"} acknowledged by operator',
        {
            'eventType': 'display_apply_acked',
            'severity': 'info',
            'applyId': acked_id,
        },
    )
    return {'success': True, 'message': 'apply acknowledged', 'applyId': acked_id}


def apply_revert_from_sentinel(firebase_client=None) -> dict:
    """Restore the display config from a stale sentinel file.

    Called at service startup when a sentinel survives a crash/reboot mid-apply.
    Session 0 routes through the user-session helper; Session 1+ runs in-process.

    Sentinel policy (matters for headless-kiosk recovery): preserve on BOTH
    transient errors (read error, helper failure, no console user → retried) and
    terminal ones (malformed JSON, unknown schema → needs an operator, never a
    silent delete). Delete only on success.

    ``firebase_client`` emits ``display_revert_deferred`` when no console user is
    logged in — once per pending sentinel via ``_deferred_revert_alerted``.
    """
    global _deferred_revert_pending, _deferred_revert_alerted
    path = _get_sentinel_path()
    if not os.path.exists(path):
        return {'success': False, 'error': 'no sentinel file present'}

    # Under the sentinel lock so we can't interleave with a writer.
    with _sentinel_lock:
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except OSError as e:
            # Transient — preserve the sentinel for retry.
            logger.warning(
                'apply_revert_from_sentinel: OSError reading sentinel (%s) — preserved for retry',
                e,
            )
            return {'success': False, 'error': str(e), 'deferred': True}
        except (ValueError, json.JSONDecodeError) as e:
            # Unparseable sentinel points at a deeper bug — preserve for an
            # operator rather than silently nuking it.
            logger.error(
                'apply_revert_from_sentinel: malformed sentinel JSON (%s) — preserved for operator review',
                e,
            )
            return {'success': False, 'error': f'malformed sentinel: {e}', 'code': DisplayErrorCode.SENTINEL_MALFORMED}

    # Fail loud on unknown versions; never read a future format as the current one.
    version = data.get('version')
    if version != _SENTINEL_SCHEMA_VERSION:
        logger.error(
            'apply_revert_from_sentinel: unsupported sentinel version %r '
            '(expected %d) — preserved for operator review',
            version, _SENTINEL_SCHEMA_VERSION,
        )
        return {
            'success': False,
            'error': f'unsupported sentinel version {version!r}',
            'code': DisplayErrorCode.UNSUPPORTED_SENTINEL_VERSION,
        }

    snapshot = data.get('snapshot')
    if not snapshot:
        # Well-formed but snapshot-less: not transient, so clean up rather than
        # loop on it every startup.
        _cleanup_sentinel()
        return {'success': False, 'error': 'sentinel has no snapshot'}

    # Session 0 — delegate to the helper, preserving the sentinel on failure
    # (no console user at boot is the common case) so the main loop can retry.
    if _is_session_0():
        # Short-circuit before spawning: CreateProcessAsUser needs a console
        # token, so at headless boot the helper would only churn through
        # token-acquisition errors. Defer and let the main loop retry.
        try:
            import win32ts
            console_session = win32ts.WTSGetActiveConsoleSessionId()
        except Exception as e:  # pragma: no cover — defensive on import / call failure
            logger.debug(
                'apply_revert_from_sentinel: WTSGetActiveConsoleSessionId failed (%s)', e,
            )
            console_session = 0xFFFFFFFF
        if console_session == 0xFFFFFFFF:
            _deferred_revert_pending = True
            logger.warning(
                'deferring display revert — no console session '
                '(sentinel preserved for retry once a user logs in)'
            )
            # One alert per pending sentinel; flag reset in `_cleanup_sentinel()`.
            if not _deferred_revert_alerted:
                _emit_audit(
                    firebase_client,
                    action='display_revert_deferred',
                    level='warning',
                    details=(
                        'display revert deferred — no console session at startup; '
                        'will retry when a user logs in'
                    ),
                    extras={
                        'eventType': 'display_revert_deferred',
                        'severity': 'warning',
                        'sentinelVersion': version,
                    },
                )
                _deferred_revert_alerted = True
            return {'success': False, 'deferred': True, 'error': 'no console session'}

        rev = _revert_via_user_session(sentinel_path=path)
        if rev.get('ok'):
            _cleanup_sentinel()
            logger.info('reverted display config from sentinel via helper')
            return {'success': True, 'message': 'reverted from sentinel'}
        err = rev.get('error', 'helper revert failed')
        logger.warning(
            'apply_revert_from_sentinel: helper revert failed (%s) — sentinel preserved for retry',
            err,
        )
        return {'success': False, 'error': err, 'deferred': True}

    # Session 1+ — in-process (debug mode / tests).
    try:
        restored = _apply_snapshot(snapshot)
    except Exception as e:
        logger.exception('apply_revert_from_sentinel: in-process revert raised')
        return {'success': False, 'error': str(e)}
    if restored:
        _cleanup_sentinel()
        logger.info('reverted display config from sentinel (stale apply recovery)')
        return {'success': True, 'message': 'reverted from sentinel'}
    return {'success': False, 'error': 'SetDisplayConfig failed during revert'}


# CLI entry point. No args = smoke test (prints build_display_profile()).
# Helper modes, spawned by the service from Session 0 via CreateProcessAsUser:
#   --enumerate-json <out>        monitors → JSON
#   --enumerate-modes-json <out>  supported-modes catalogue → JSON
#   --apply-json <req> <out>      full CCD write path
#   --revert-json <req> <out>     restore a snapshot
#   --self-test <out>             read-only IPC + CCD reachability check
# --stderr-log <path> may follow any helper mode; the helper redirects stderr
# there so the detached process's tracebacks reach the service log.


def _atomic_write_json(out_path: str, payload: dict) -> None:
    """Write ``payload`` to ``out_path`` atomically (temp + os.replace).

    The parent must never see a partial file. Raises OSError on failure.
    """
    tmp = out_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(payload, f)
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            pass  # fsync isn't always available; best-effort
    os.replace(tmp, out_path)


def _helper_enumerate_to_json(out_path: str) -> int:
    """CCD enumeration → ``out_path`` JSON. Exit code 0 ok / 1 fail / 2 write-fail.

    Payload: ``{'ok': True, 'monitors': [...]}`` or ``{'ok': False, 'error'}``.
    """
    try:
        monitors = _enumerate_monitors_ccd()
        payload = {'ok': True, 'monitors': monitors}
        exit_code = 0
    except Exception as e:
        payload = {'ok': False, 'error': '{0}: {1}'.format(type(e).__name__, e)}
        exit_code = 1
    try:
        _atomic_write_json(out_path, payload)
    except OSError as e:
        sys.stderr.write('helper: failed to write {0}: {1}\n'.format(out_path, e))
        return 2
    return exit_code


def _helper_enumerate_modes_to_json(out_path: str) -> int:
    """Modes catalogue → JSON. Exit codes as ``_helper_enumerate_to_json``.

    Success spreads ``_build_display_modes_catalogue``. Note the two failure
    modes differ: ``ok: False`` is a hard helper failure, while
    ``ok: True`` + ``enumerationFailed: True`` (empty ``byEdidHash``) is a
    transient CCD stall.
    """
    try:
        catalogue = _build_display_modes_catalogue()
        payload = {'ok': True}
        payload.update(catalogue)
        exit_code = 0
    except Exception as e:
        payload = {'ok': False, 'error': '{0}: {1}'.format(type(e).__name__, e)}
        exit_code = 1
    try:
        _atomic_write_json(out_path, payload)
    except OSError as e:
        sys.stderr.write('helper: failed to write {0}: {1}\n'.format(out_path, e))
        return 2
    return exit_code


def _make_responder(resp_path: str):
    """Build the ``_respond`` closure shared by the helper-mode entry points.

    Writes the payload to ``resp_path`` atomically and maps it to the helper
    exit code: 0 when the payload reports success, 1 when it reports failure,
    2 when the response file itself could not be written.
    """
    def _respond(payload: dict) -> int:
        try:
            _atomic_write_json(resp_path, payload)
            return 0 if payload.get('ok') else 1
        except OSError as e:
            sys.stderr.write(
                'helper: failed to write IPC response {0}: {1}; code={2}\n'.format(
                    resp_path, e, DisplayErrorCode.IPC_FAILURE.value,
                )
            )
            return 2

    return _respond


def _helper_self_test_to_json(resp_path: str) -> int:
    """Helper-mode read-only apply self-test.

    Verifies the IPC plumbing (CreateProcessAsUser, env block, response file,
    atomic rename) and CCD reachability from the console session without ever
    calling SDC_APPLY: queries the live paths, then SDC_VALIDATEs them against
    themselves — a true no-op. Writes ``{ok, monitors_seen, query_ms,
    validate_ms}`` (+ ``error``/``code``) to ``resp_path``.
    """
    _respond = _make_responder(resp_path)

    try:
        t0 = time.time()
        current = _query_active_paths_safe()
        query_ms = int((time.time() - t0) * 1000)
        if current is None:
            return _respond({
                'ok': False,
                'error': 'failed to query current display config',
                'code': DisplayErrorCode.QUERY_FAILED,
                'query_ms': query_ms,
            })
        paths, modes = current
        monitors_seen = _count_active_paths(paths)

        # ctypes coerces arrays but not lists to pointers — same as `_apply_core`.
        paths_arr = (DISPLAYCONFIG_PATH_INFO * len(paths))()
        for _i, _p in enumerate(paths):
            paths_arr[_i] = _p
        modes_arr = (DISPLAYCONFIG_MODE_INFO * len(modes))()
        for _i, _m in enumerate(modes):
            modes_arr[_i] = _m

        def _do_validate():
            return _SetDisplayConfig(
                len(paths_arr), paths_arr, len(modes_arr), modes_arr,
                SDC_VALIDATE | SDC_USE_SUPPLIED_DISPLAY_CONFIG,
            )
        t1 = time.time()
        try:
            rc = _with_timeout(_do_validate, _CCD_APPLY_TIMEOUT)
        except FuturesTimeoutError:
            return _respond({
                'ok': False,
                'error': 'SDC_VALIDATE timed out',
                'code': DisplayErrorCode.VALIDATE_REJECTED,
                'monitors_seen': monitors_seen,
                'query_ms': query_ms,
                'validate_ms': int((time.time() - t1) * 1000),
            })
        validate_ms = int((time.time() - t1) * 1000)
        if rc != ERROR_SUCCESS:
            return _respond({
                'ok': False,
                'error': f'SDC_VALIDATE rejected live config (rc={rc})',
                'code': _ccd_failure_code(rc, 'validate'),
                'rc': rc,
                'monitors_seen': monitors_seen,
                'query_ms': query_ms,
                'validate_ms': validate_ms,
            })
        return _respond({
            'ok': True,
            'monitors_seen': monitors_seen,
            'query_ms': query_ms,
            'validate_ms': validate_ms,
        })
    except Exception as e:
        sys.stderr.write('helper: self-test unexpected failure: {0}: {1}\n'.format(type(e).__name__, e))
        return _respond({
            'ok': False,
            'error': f'unexpected: {type(e).__name__}: {e}',
            'code': DisplayErrorCode.UNEXPECTED,
        })


def _helper_apply_to_json(req_path: str, resp_path: str) -> int:
    """Helper-mode entry point for the apply path.

    Reads ``{desired_layout, sentinel_path, ack_timeout_s}`` from ``req_path``
    and delegates to ``_apply_core``. ALWAYS writes a response to ``resp_path``,
    even on unexpected failure, so the service never sees an absent file for a
    helper that actually ran; the exit code only distinguishes "never launched".
    """
    _respond = _make_responder(resp_path)

    try:
        with open(req_path, 'r', encoding='utf-8') as f:
            req = json.load(f)
    except OSError as e:
        return _respond({
            'ok': False,
            'error': f'failed to read IPC request {req_path}: {e}',
            'code': DisplayErrorCode.IPC_FAILURE,
        })
    except ValueError as e:
        return _respond({
            'ok': False,
            'error': f'failed to parse request {req_path}: {e}',
            'code': DisplayErrorCode.BAD_REQUEST,
        })

    desired_layout = req.get('desired_layout')
    sentinel_path = req.get('sentinel_path')
    ack_timeout_s = int(req.get('ack_timeout_s', 30))
    apply_id = req.get('apply_id')  # persisted into sentinel; used by ack path
    if not desired_layout or not sentinel_path:
        return _respond({
            'ok': False,
            'error': 'missing desired_layout or sentinel_path',
            'code': DisplayErrorCode.BAD_REQUEST,
        })

    # Strip `_snapshot`: the service reads it from the sentinel `_apply_core`
    # wrote, so it never needs to cross the IPC boundary.
    result = _apply_core(desired_layout, sentinel_path, ack_timeout_s, apply_id)
    result.pop('_snapshot', None)
    return _respond(result)


def _helper_revert_from_json(req_path: str, resp_path: str) -> int:
    """Helper-mode entry point for the revert path.

    Reads ``{snapshot?, sentinel_path?}`` (one or the other) from ``req_path``
    and calls ``_apply_snapshot``, which saves to the config DB so the restored
    config survives reboot. Response written to ``resp_path``.
    """
    _respond = _make_responder(resp_path)

    try:
        with open(req_path, 'r', encoding='utf-8') as f:
            req = json.load(f)
    except OSError as e:
        return _respond({
            'ok': False,
            'error': f'failed to read IPC request {req_path}: {e}',
            'code': DisplayErrorCode.IPC_FAILURE,
        })
    except ValueError as e:
        return _respond({
            'ok': False,
            'error': f'failed to parse request {req_path}: {e}',
            'code': DisplayErrorCode.BAD_REQUEST,
        })

    snapshot = req.get('snapshot')
    if snapshot is None:
        sentinel_path = req.get('sentinel_path')
        if not sentinel_path:
            return _respond({'ok': False, 'error': 'missing snapshot or sentinel_path', 'code': DisplayErrorCode.BAD_REQUEST})
        try:
            with open(sentinel_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            snapshot = data.get('snapshot')
        except (OSError, ValueError) as e:
            return _respond({'ok': False, 'error': f'sentinel read failed: {e}', 'code': DisplayErrorCode.SENTINEL_READ_FAILED})
        if not snapshot:
            return _respond({'ok': False, 'error': 'sentinel has no snapshot', 'code': DisplayErrorCode.SENTINEL_NO_SNAPSHOT})

    try:
        restored = _apply_snapshot(snapshot)
        if restored:
            return _respond({'ok': True})
        return _respond({'ok': False, 'error': 'SetDisplayConfig failed during revert', 'code': DisplayErrorCode.APPLY_FAILED})
    except Exception as e:
        sys.stderr.write('helper: revert unexpected failure: {0}: {1}\n'.format(type(e).__name__, e))
        return _respond({'ok': False, 'error': f'unexpected: {type(e).__name__}: {e}', 'code': DisplayErrorCode.UNEXPECTED})


def _maybe_redirect_stderr(argv: list) -> list:
    """Redirect sys.stderr per ``--stderr-log <path>``, returning argv stripped.

    Helper modes need this: CreateProcessAsUser runs them detached with no
    console, so tracebacks would otherwise vanish.
    """
    try:
        i = argv.index('--stderr-log')
    except ValueError:
        return argv
    if i + 1 >= len(argv):
        return argv
    path = argv[i + 1]
    try:
        sys.stderr = open(path, 'w', encoding='utf-8', buffering=1)
    except OSError as e:
        logger.warning(
            'display helper: stderr redirect failed for %s: %s', path, e
        )
    return argv[:i] + argv[i + 2:]


def _main():
    argv = _maybe_redirect_stderr(sys.argv)

    if len(argv) >= 3 and argv[1] == '--enumerate-json':
        sys.exit(_helper_enumerate_to_json(argv[2]))
    if len(argv) >= 3 and argv[1] == '--enumerate-modes-json':
        sys.exit(_helper_enumerate_modes_to_json(argv[2]))
    if len(argv) >= 4 and argv[1] == '--apply-json':
        sys.exit(_helper_apply_to_json(argv[2], argv[3]))
    if len(argv) >= 4 and argv[1] == '--revert-json':
        sys.exit(_helper_revert_from_json(argv[2], argv[3]))
    if len(argv) >= 3 and argv[1] == '--self-test':
        sys.exit(_helper_self_test_to_json(argv[2]))

    logging.basicConfig(level=logging.DEBUG, format='%(levelname)s %(name)s: %(message)s')
    profile = build_display_profile()
    print(json.dumps(profile, indent=2))
    # Non-zero on enumeration failure so this doubles as a CI smoke check.
    sys.exit(1 if profile.get('enumerationFailed') else 0)


if __name__ == '__main__':
    _main()
