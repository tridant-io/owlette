"""
Swoop capability + platform normalisation for the heartbeat.

Everything here runs on the 5-second heartbeat path, so it stays to dict
lookups plus the single exe-path check that answers "is the streamer
installed". The streamer's own `probe` verb is the source of encoder truth and
is deliberately NOT run here — it would be a process spawn per heartbeat.

`capabilities.swoop == 1` is the gate the dashboard reads; the minimum-version
constant in web/lib/versionUtils.ts is advisory copy only.
"""

import platform
import sys

import shared_utils


# Cross-plan rule C3: one spelling per platform, shared with the tri-platform
# agent plan. Readers treat an ABSENT osFamily as 'windows' — every agent in the
# field predates the key, and they are all Windows.
OS_FAMILY_BY_PLATFORM = {
    'win32': 'windows',
    'darwin': 'macos',
    'linux': 'linux',
}

ARCH_BY_MACHINE = {
    'AMD64': 'x64',
    'x86_64': 'x64',
    'arm64': 'arm64',
    'aarch64': 'arm64',
}

UNKNOWN = 'unknown'


def os_family():
    """C3 osFamily for this machine, or 'unknown' on an unmapped platform."""
    return OS_FAMILY_BY_PLATFORM.get(sys.platform, UNKNOWN)


def arch():
    """C3 arch for this machine, or 'unknown' on an unmapped machine type."""
    # platform.machine() returns '' rather than raising when it can't tell.
    return ARCH_BY_MACHINE.get(platform.machine(), UNKNOWN)


def streamer_capable():
    """True when a swoop streamer backend exists for this OS.

    Local on purpose: agent/src/osadapter does not exist on dev. The
    tri-platform plan's Wave 4 folds this into osadapter.streamer_capable()
    when the macOS/Linux backends land; until then Windows is the only one.
    """
    return os_family() == 'windows'


def swoop_capability_value():
    """1 when this machine can be swooped into, else 0.

    Binary presence only. get_swoop_exe_path() -> None is how "swoop is not
    installed" reaches the heartbeat.
    """
    try:
        installed = shared_utils.get_swoop_exe_path() is not None
    except Exception:
        # A stat failure here must not escape: the heartbeat's own handler would
        # report it to ConnectionManager as a Firestore error and cycle the
        # connection. Absent is the safe answer.
        return 0

    return 1 if installed and streamer_capable() else 0
