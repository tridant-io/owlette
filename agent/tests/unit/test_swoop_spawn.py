"""Unit tests for the swoop spawn helper.

Every win32 call is faked through ``sys.modules`` -- ``swoop_spawn`` imports
pywin32 lazily inside its functions precisely so these tests need no service, no
console session and no installed streamer.
"""

import sys
import types

import pytest
from unittest.mock import MagicMock, patch

import swoop_spawn


SYSTEM_SID = 'S-1-5-18'
ADMINS_SID = 'S-1-5-32-544'
USERS_SID = 'S-1-5-32-545'
FULL = 0x1F01FF
READ_EXECUTE = 0x120089 | 0x1200A0
INHERIT = 0x03

GOOD_ACES = [
    ((0, INHERIT), FULL, SYSTEM_SID),
    ((0, INHERIT), FULL, ADMINS_SID),
    ((0, INHERIT), READ_EXECUTE, USERS_SID),
]


def _fake_win32security(aces, protected=True):
    """A win32security stand-in serving one directory's security descriptor."""
    dacl = MagicMock()
    dacl.GetAceCount.return_value = len(aces)
    dacl.GetAce.side_effect = lambda index: aces[index]

    sd = MagicMock()
    sd.GetSecurityDescriptorControl.return_value = (0x1000 if protected else 0, 1)
    sd.GetSecurityDescriptorDacl.return_value = dacl

    module = types.ModuleType('win32security')
    module.SE_FILE_OBJECT = 1
    module.DACL_SECURITY_INFORMATION = 4
    module.SE_DACL_PROTECTED = 0x1000
    module.ACCESS_ALLOWED_ACE_TYPE = 0
    module.GetNamedSecurityInfo = MagicMock(return_value=sd)
    module.ConvertSidToStringSid = lambda sid: sid
    return module


@pytest.fixture
def on_windows(monkeypatch):
    """install_dir_is_protected is a no-op off Windows; pin it on for the test."""
    monkeypatch.setattr(swoop_spawn.os, 'name', 'nt')


class TestInstallDirCheck:
    """The pre-spawn gate. It refuses; it never repairs."""

    def test_installer_layout_passes(self, on_windows):
        with patch.dict(sys.modules, {'win32security': _fake_win32security(GOOD_ACES)}):
            assert swoop_spawn.install_dir_is_protected(r'C:\x\swoop') is True

    def test_extra_ace_refused(self, on_windows):
        aces = GOOD_ACES + [((0, INHERIT), FULL, 'S-1-5-21-1-2-3-1001')]
        with patch.dict(sys.modules, {'win32security': _fake_win32security(aces)}):
            assert swoop_spawn.install_dir_is_protected(r'C:\x\swoop') is False

    def test_wrong_mask_refused(self, on_windows):
        aces = list(GOOD_ACES)
        aces[2] = ((0, INHERIT), FULL, USERS_SID)
        with patch.dict(sys.modules, {'win32security': _fake_win32security(aces)}):
            assert swoop_spawn.install_dir_is_protected(r'C:\x\swoop') is False

    def test_inheritance_enabled_refused(self, on_windows):
        fake = _fake_win32security(GOOD_ACES, protected=False)
        with patch.dict(sys.modules, {'win32security': fake}):
            assert swoop_spawn.install_dir_is_protected(r'C:\x\swoop') is False

    def test_unreadable_descriptor_refused(self, on_windows):
        fake = _fake_win32security(GOOD_ACES)
        fake.GetNamedSecurityInfo.side_effect = OSError('denied')
        with patch.dict(sys.modules, {'win32security': fake}):
            assert swoop_spawn.install_dir_is_protected(r'C:\x\swoop') is False

    def test_check_never_creates_the_directory(self, on_windows, tmp_path):
        """An absent {app}\\swoop is the 'swoop not installed' signal."""
        missing = str(tmp_path / 'swoop')
        fake = _fake_win32security(GOOD_ACES)
        fake.GetNamedSecurityInfo.side_effect = OSError('not found')
        with patch.dict(sys.modules, {'win32security': fake}):
            assert swoop_spawn.install_dir_is_protected(missing) is False
        assert not (tmp_path / 'swoop').exists()


class TestVerifyInstall:
    """Both gates, in order: installed, ownership, version."""

    def test_absent_exe_refuses(self):
        with patch.object(swoop_spawn.shared_utils, 'get_swoop_exe_path', return_value=None):
            with pytest.raises(swoop_spawn.SwoopSpawnError) as exc:
                swoop_spawn.verify_install()
        assert exc.value.reason == swoop_spawn.REFUSAL_NOT_INSTALLED

    def test_unverified_install_refuses_before_running_the_exe(self):
        with patch.object(swoop_spawn, 'install_dir_is_protected', return_value=False), \
             patch.object(swoop_spawn, 'read_streamer_version') as version_probe:
            with pytest.raises(swoop_spawn.SwoopSpawnError) as exc:
                swoop_spawn.verify_install(r'C:\x\swoop\owlette-swoop.exe')
        assert exc.value.reason == swoop_spawn.REFUSAL_INSTALL_UNVERIFIED
        version_probe.assert_not_called()

    def test_version_mismatch_refuses(self):
        with patch.object(swoop_spawn, 'install_dir_is_protected', return_value=True), \
             patch.object(swoop_spawn, 'read_streamer_version', return_value='9.9.9'), \
             patch.object(swoop_spawn.shared_utils, 'APP_VERSION', '3.3.5'):
            with pytest.raises(swoop_spawn.SwoopSpawnError) as exc:
                swoop_spawn.verify_install(r'C:\x\swoop\owlette-swoop.exe')
        assert exc.value.reason == swoop_spawn.REFUSAL_VERSION_MISMATCH

    def test_unreadable_version_refuses(self):
        with patch.object(swoop_spawn, 'install_dir_is_protected', return_value=True), \
             patch.object(swoop_spawn, 'read_streamer_version', return_value=None):
            with pytest.raises(swoop_spawn.SwoopSpawnError) as exc:
                swoop_spawn.verify_install(r'C:\x\swoop\owlette-swoop.exe')
        assert exc.value.reason == swoop_spawn.REFUSAL_VERSION_MISMATCH

    def test_matching_version_returns_the_path(self):
        exe = r'C:\x\swoop\owlette-swoop.exe'
        with patch.object(swoop_spawn, 'install_dir_is_protected', return_value=True), \
             patch.object(swoop_spawn, 'read_streamer_version', return_value='3.3.5'), \
             patch.object(swoop_spawn.shared_utils, 'APP_VERSION', '3.3.5'):
            assert swoop_spawn.verify_install(exe) == exe


class TestFetchBundle:
    """The bundle is a mutable buffer and never reaches a log record."""

    def _requests(self, content, status_ok=True):
        module = types.ModuleType('requests')
        response = MagicMock()
        response.content = content
        response.raise_for_status = (
            MagicMock() if status_ok else MagicMock(side_effect=Exception('401'))
        )
        module.post = MagicMock(return_value=response)
        return module

    def test_returns_a_mutable_single_line_buffer(self):
        module = self._requests(b'{"sid":"sid_1"}\n')
        auth = MagicMock()
        auth.get_valid_token.return_value = 'tok'
        with patch.dict(sys.modules, {'requests': module}):
            buf = swoop_spawn.fetch_bundle('sid_1', 's', 'm', auth)
        assert isinstance(buf, bytearray)
        assert bytes(buf) == b'{"sid":"sid_1"}'

    def test_multi_line_body_rejected(self):
        module = self._requests(b'{"a":1}\n{"b":2}')
        auth = MagicMock()
        auth.get_valid_token.return_value = 'tok'
        with patch.dict(sys.modules, {'requests': module}):
            with pytest.raises(swoop_spawn.SwoopSpawnError) as exc:
                swoop_spawn.fetch_bundle('sid_1', 's', 'm', auth)
        assert exc.value.reason == swoop_spawn.REFUSAL_BUNDLE_UNAVAILABLE

    def test_no_token_refuses(self):
        auth = MagicMock()
        auth.get_valid_token.return_value = None
        with pytest.raises(swoop_spawn.SwoopSpawnError) as exc:
            swoop_spawn.fetch_bundle('sid_1', 's', 'm', auth)
        assert exc.value.reason == swoop_spawn.REFUSAL_BUNDLE_UNAVAILABLE

    def test_failure_never_logs_the_body_or_the_token(self, caplog):
        caplog.set_level('DEBUG')
        secret = 'SUPERSECRETBUNDLE'
        module = self._requests(secret.encode(), status_ok=False)
        auth = MagicMock()
        auth.get_valid_token.return_value = 'TOKENVALUE'
        with patch.dict(sys.modules, {'requests': module}):
            with pytest.raises(swoop_spawn.SwoopSpawnError):
                swoop_spawn.fetch_bundle('sid_1', 's', 'm', auth)
        assert secret not in caplog.text
        assert 'TOKENVALUE' not in caplog.text


class TestSwoopProcess:
    """Pipe writes: the bundle line first, then control lines."""

    def _proc_with_fake_win32file(self):
        module = types.ModuleType('win32file')
        module.written = []
        module.WriteFile = lambda handle, data: module.written.append(bytes(data))
        proc = swoop_spawn.SwoopProcess(4321, MagicMock(), MagicMock(), 'stdin', 'stdout')
        return proc, module

    def test_write_bundle_terminates_the_line_and_wipes_the_buffer(self):
        proc, module = self._proc_with_fake_win32file()
        buf = bytearray(b'{"sessionKey":"secret"}')
        with patch.dict(sys.modules, {'win32file': module}):
            proc.write_bundle(buf)
        assert module.written == [b'{"sessionKey":"secret"}\n']
        assert bytes(buf) == b'\x00' * len(buf)

    def test_write_line_is_one_json_line(self):
        proc, module = self._proc_with_fake_win32file()
        with patch.dict(sys.modules, {'win32file': module}):
            proc.write_line({'type': 'kill'})
        assert module.written == [b'{"type": "kill"}\n']

    def test_iter_lines_splits_on_newlines_and_stops_at_eof(self):
        proc, module = self._proc_with_fake_win32file()
        chunks = [(0, b'{"type":"ready"}\n{"type":"sta'), (0, b'tus"}\n'), (0, b'')]
        module.ReadFile = lambda handle, size: chunks.pop(0)
        with patch.dict(sys.modules, {'win32file': module}):
            lines = list(proc.iter_lines())
        assert lines == ['{"type":"ready"}', '{"type":"status"}']

    def test_close_is_idempotent(self):
        proc, _module = self._proc_with_fake_win32file()
        proc.close()
        proc.close()


class TestExitCodes:
    """PROTOCOL.md section 6's table, pinned so a rename cannot drift."""

    def test_named_codes(self):
        assert swoop_spawn.EXIT_VERSION_MISMATCH == 11
        assert swoop_spawn.EXIT_REASONS[10] == 'bundle_invalid'
        assert set(swoop_spawn.EXIT_REASONS) == {0, 10, 11, 12, 13, 14, 20}
