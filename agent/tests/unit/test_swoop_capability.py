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
  * capabilities.swoop is binary presence only: the exe is there AND this OS has
    a streamer backend. No probe, no process spawn — this runs on the 5-second
    loop.
"""

import platform
import sys

import pytest

import shared_utils
import swoop_capability


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

class TestStreamerCapable:
    """Local until tri-platform's Wave 4 folds it into osadapter."""

    def test_windows_is_capable(self, monkeypatch):
        monkeypatch.setattr(sys, 'platform', 'win32')

        assert swoop_capability.streamer_capable() is True

    @pytest.mark.parametrize('sys_platform', ['darwin', 'linux', 'freebsd14'])
    def test_no_other_platform_is_capable_yet(self, monkeypatch, sys_platform):
        monkeypatch.setattr(sys, 'platform', sys_platform)

        assert swoop_capability.streamer_capable() is False


class TestSwoopCapabilityValue:
    """1 only when the exe exists and this OS has a backend."""

    @pytest.fixture(autouse=True)
    def on_windows(self, monkeypatch):
        monkeypatch.setattr(sys, 'platform', 'win32')

    def test_one_when_installed(self, monkeypatch):
        monkeypatch.setattr(
            shared_utils, 'get_swoop_exe_path',
            lambda: r'C:\ProgramData\Owlette\swoop\owlette-swoop.exe',
        )

        assert swoop_capability.swoop_capability_value() == 1

    def test_zero_when_the_exe_is_absent(self, monkeypatch):
        monkeypatch.setattr(shared_utils, 'get_swoop_exe_path', lambda: None)

        assert swoop_capability.swoop_capability_value() == 0

    def test_zero_when_the_platform_has_no_backend(self, monkeypatch):
        monkeypatch.setattr(sys, 'platform', 'linux')
        monkeypatch.setattr(
            shared_utils, 'get_swoop_exe_path',
            lambda: '/opt/owlette/swoop/owlette-swoop',
        )

        assert swoop_capability.swoop_capability_value() == 0

    def test_a_stat_failure_is_zero_not_an_exception(self, monkeypatch):
        """It must not escape into the heartbeat's handler.

        _upload_metrics reports any exception to ConnectionManager as a
        Firestore error, which would cycle the connection over a bad path.
        """
        def boom():
            raise OSError('drive not ready')

        monkeypatch.setattr(shared_utils, 'get_swoop_exe_path', boom)

        assert swoop_capability.swoop_capability_value() == 0

    def test_does_not_spawn_the_streamer(self, monkeypatch):
        """No probe on the 5-second loop."""
        import subprocess

        def fail(*args, **kwargs):
            raise AssertionError('swoop_capability must not run a subprocess')

        monkeypatch.setattr(subprocess, 'Popen', fail)
        monkeypatch.setattr(subprocess, 'run', fail)
        monkeypatch.setattr(
            shared_utils, 'get_swoop_exe_path',
            lambda: r'C:\ProgramData\Owlette\swoop\owlette-swoop.exe',
        )

        assert swoop_capability.swoop_capability_value() == 1
