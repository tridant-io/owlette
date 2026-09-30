"""
Unit tests for swoop_capability — the heartbeat's capability + platform keys.

Three contracts are pinned here:

  * cross-plan rule C3's normalisation tables. The tri-platform agent plan
    writes the same osFamily/arch spellings, so a change on either side that
    isn't a change on both is a fleet-wide reporting split.
  * an ABSENT osFamily means 'windows'. Every agent in the field predates the
    key, so a reader that defaults to anything else marks the whole fleet
    unknown. The default belongs to the reader — the agent never writes it as a
    stand-in for Windows.
  * capabilities.swoop is the exe being there AND this OS's osadapter arm
    saying the machine can stream — on macOS, the desktop app's fresh Screen
    Recording report. No probe, no process spawn — this runs on the 5-second
    loop — and no exception, since the heartbeat's handler would book it as a
    Firestore error.
"""

import importlib
import json
import os
import platform
import sys
import time
from types import SimpleNamespace

import pytest

import osadapter
import shared_utils
import swoop_capability

if sys.platform != 'win32':
    import pwd


darwin_only = pytest.mark.skipif(
    sys.platform != 'darwin', reason='the macOS arm reads the app report',
)

WINDOWS_STREAMER = r'C:\ProgramData\Owlette\swoop\owlette-swoop.exe'
MAC_STREAMER = '/Applications/owlette.app/Contents/MacOS/owlette-swoop'


# C3 normalisation tables

class TestOsFamily:
    """sys.platform -> osFamily, plus the absent-means-windows contract."""

    @pytest.mark.parametrize('sys_platform,expected', [
        ('win32', 'windows'),
        ('darwin', 'macos'),
        ('linux', 'linux'),
    ])
    def test_every_c3_mapping(self, monkeypatch, sys_platform, expected):
        monkeypatch.setattr(sys, 'platform', sys_platform)

        assert swoop_capability.os_family() == expected

    def test_unknown_platform_falls_back_without_raising(self, monkeypatch):
        monkeypatch.setattr(sys, 'platform', 'freebsd14')

        assert swoop_capability.os_family() == 'unknown'

    def test_table_holds_exactly_the_c3_entries(self):
        """A fourth entry here is a cross-plan change, not a local one."""
        assert swoop_capability.OS_FAMILY_BY_PLATFORM == {
            'win32': 'windows',
            'darwin': 'macos',
            'linux': 'linux',
        }

    def test_absent_os_family_reads_as_windows(self):
        """The documented reader contract for pre-swoop agents.

        The agent never writes 'windows' to stand in for a missing key, so the
        default lives with whoever reads the machine document.
        """
        machine_doc = {'machineId': 'INF-FLEX-3'}

        assert machine_doc.get('osFamily', 'windows') == 'windows'
        assert 'osFamily' not in machine_doc


class TestArch:
    """platform.machine() -> arch."""

    @pytest.mark.parametrize('machine,expected', [
        ('AMD64', 'x64'),
        ('x86_64', 'x64'),
        ('arm64', 'arm64'),
        ('aarch64', 'arm64'),
    ])
    def test_every_c3_mapping(self, monkeypatch, machine, expected):
        monkeypatch.setattr(platform, 'machine', lambda: machine)

        assert swoop_capability.arch() == expected

    def test_unknown_machine_falls_back_without_raising(self, monkeypatch):
        monkeypatch.setattr(platform, 'machine', lambda: 'riscv64')

        assert swoop_capability.arch() == 'unknown'

    def test_undeterminable_machine_falls_back(self, monkeypatch):
        """platform.machine() returns '' rather than raising when it can't tell."""
        monkeypatch.setattr(platform, 'machine', lambda: '')

        assert swoop_capability.arch() == 'unknown'

    def test_table_holds_exactly_the_c3_entries(self):
        assert swoop_capability.ARCH_BY_MACHINE == {
            'AMD64': 'x64',
            'x86_64': 'x64',
            'arm64': 'arm64',
            'aarch64': 'arm64',
        }


# streamer_capable / swoop_capability_value

def _the_real_arm(monkeypatch, root):
    """Whatever osadapter.get() answers on the machine running the suite."""


def _the_apps_report(**report):
    """The real macOS arm, reading what the desktop app wrote about its grants
    as the user running the suite, who stands in for the console user. No
    fields at all is no report: the app has not written one."""
    def arrange(monkeypatch, root):
        darwin = importlib.import_module('osadapter.darwin')
        monkeypatch.setattr(darwin, 'console_user', lambda: pwd.getpwuid(os.getuid()).pw_name)
        monkeypatch.setenv(osadapter.DATA_ROOT_ENV, str(root))
        if report:
            path = root / 'ipc' / 'tcc.json'
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({**report, 'checked_at': time.time()}), encoding='utf-8')
            os.chmod(path, 0o644)
    return arrange


def _a_stand_in_arm(answer):
    """An arm whose streamer_capable() answers `answer`, or raises it."""
    def streamer_capable():
        if isinstance(answer, Exception):
            raise answer
        return answer

    def arrange(monkeypatch, root):
        monkeypatch.setattr(
            osadapter, '_adapter', SimpleNamespace(streamer_capable=streamer_capable))
    return arrange


class TestStreamerCapable:
    """This OS's osadapter arm, and False whenever asking it fails."""

    @pytest.mark.parametrize('answer', [True, False])
    def test_it_is_the_arms_answer(self, monkeypatch, tmp_path, answer):
        _a_stand_in_arm(answer)(monkeypatch, tmp_path)

        assert swoop_capability.streamer_capable() is answer

    def test_a_platform_with_no_arm_is_not_capable(self, monkeypatch):
        """osadapter.get() raises NotImplementedError there before any arm is asked."""
        monkeypatch.setattr(osadapter, '_ARMS', {})
        monkeypatch.setattr(osadapter, '_adapter', None)

        assert swoop_capability.streamer_capable() is False


class TestSwoopCapabilityValue:
    """1 only when the exe exists and this OS's arm says it can stream."""

    @pytest.mark.parametrize('arm, exe, expected', [
        pytest.param(_the_real_arm, WINDOWS_STREAMER, 1,
                     id='windows', marks=pytest.mark.windows),
        pytest.param(_the_apps_report(screen_recording=True), MAC_STREAMER, 1,
                     id='macos-granted', marks=darwin_only),
        pytest.param(_the_apps_report(screen_recording=False), MAC_STREAMER, 0,
                     id='macos-refused', marks=darwin_only),
        pytest.param(_the_apps_report(), MAC_STREAMER, 0,
                     id='macos-no-report', marks=darwin_only),
        pytest.param(_a_stand_in_arm(True), None, 0,
                     id='linux-x11-seat-no-binary'),
        pytest.param(_a_stand_in_arm(OSError('report unreadable')), MAC_STREAMER, 0,
                     id='arm-raises'),
    ])
    def test_the_capability_per_platform(self, monkeypatch, tmp_path, arm, exe, expected):
        """Windows and macOS run their real arm where it runs: Windows must keep
        answering what the fleet answers today, and a Mac follows the app's
        report. Linux ships no streamer yet, so its arm is never reached, and
        the raising arm is a stand-in; those two rows run everywhere.
        """
        arm(monkeypatch, tmp_path)
        monkeypatch.setattr(shared_utils, 'get_swoop_exe_path', lambda: exe)

        assert swoop_capability.swoop_capability_value() == expected

    def test_a_stat_failure_is_zero_not_an_exception(self, monkeypatch):
        """It must not escape into the heartbeat's handler.

        _upload_metrics reports any exception to ConnectionManager as a
        Firestore error, which would cycle the connection over a bad path.
        """
        def boom():
            raise OSError('drive not ready')

        monkeypatch.setattr(shared_utils, 'get_swoop_exe_path', boom)

        assert swoop_capability.swoop_capability_value() == 0

    def test_does_not_spawn_the_streamer(self, monkeypatch, tmp_path):
        """No probe on the 5-second loop."""
        import subprocess

        def fail(*args, **kwargs):
            raise AssertionError('swoop_capability must not run a subprocess')

        monkeypatch.setattr(subprocess, 'Popen', fail)
        monkeypatch.setattr(subprocess, 'run', fail)
        _a_stand_in_arm(True)(monkeypatch, tmp_path)
        monkeypatch.setattr(shared_utils, 'get_swoop_exe_path', lambda: WINDOWS_STREAMER)

        assert swoop_capability.swoop_capability_value() == 1
