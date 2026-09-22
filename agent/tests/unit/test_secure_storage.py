r"""Unit tests for the token store's protected write path.

Win32 is mocked: ``shared_utils``' protected writer is replaced by a recorder
that creates the file the way ``CREATE_NEW`` does, and ``console_user_sid`` and
``secure_storage._writer_user_sid`` are patched, or the pywin32 token calls
underneath the latter. Two classes use the real thing where the real thing is
the point: the file attributes on the replaced file (plain ``SetFileAttributesW``
on a ``tmp_path`` file), and the writer seam itself. The token file is a real
file under pytest's ``tmp_path`` holding dummy values only; the MachineGuid read
is patched. SID conversions use the real pywin32, a pure operation.

Manual check against a real DACL (not run by pytest). Use an empty scratch
folder, never the live install. Save this as ``<scratch>\save.py``:

    import sys
    sys.path.insert(0, r'<repo>\agent\src')
    import secure_storage
    secure_storage.SecureStorage(config_dir=r'<scratch>').save_site_id('dummy')

Then run it with the agent's python:

1. As the unelevated console user: ``icacls <scratch>\.tokens.enc`` lists
   SYSTEM (F), Administrators (F) and the console user (M), none inherited, and
   ``dir /a`` shows the file hidden. No ``.tokens.enc.tmp`` is left behind.
2. As SYSTEM, from a one-shot ``schtasks /ru SYSTEM`` task: the save succeeds,
   the file's owner is now SYSTEM and its DACL still lists those three.
3. Remove only ``<scratch>\.tokens.enc``, then run step 2 before step 1: the
   console user's save succeeds, the DACL is the same, and nothing is logged at
   warning level.
4. As a second standard account, ``type <scratch>\.tokens.enc`` is denied.
"""

import builtins
import ctypes
import logging
import os
import re
import stat
from collections import namedtuple
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest
import win32security as ws

import acl_hardening
import secure_storage
import shared_utils

_SYSTEM = 'S-1-5-18'
_ADMINISTRATORS = 'S-1-5-32-544'
_CONSOLE = 'S-1-5-21-11-22-33-1001'
_OTHER_USER = 'S-1-5-21-11-22-33-1002'

# icacls F and M: full control, and read + write + execute + delete.
_FULL = 0x1F01FF
_MODIFY = 0x1301BF

_HIDDEN = 0x02
_ARCHIVE = 0x20

_SECRET = 'dummy-refresh-token'
_GUID = '00000000-0000-0000-0000-000000000000'


def _sid(sid_str):
    return ws.ConvertStringSidToSid(sid_str)


def _aces(spec):
    return [(ws.ConvertSidToStringSid(sid), mask, flags) for sid, mask, flags in spec]


def _attributes(path):
    attrs = ctypes.windll.kernel32.GetFileAttributesW(str(path))
    assert attrs != -1, f'GetFileAttributesW failed for {path}'
    return attrs


def _set_hidden(path):
    assert ctypes.windll.kernel32.SetFileAttributesW(str(path), _HIDDEN | _ARCHIVE)


_Call = namedtuple('_Call', 'path payload aces dacl_first')


class _Writer:
    """Stands in for shared_utils' protected writer.

    Creates the file new, as ``CREATE_NEW`` does, and records the call.
    ``dacl_error`` leaves the file created and empty, the way the real writer
    leaves it when the DACL it sets before the first byte fails.
    """

    def __init__(self, create_error=None, dacl_error=None):
        self.calls = []
        self.create_error = create_error
        self.dacl_error = dacl_error

    def __call__(self, path, payload, dacl, dacl_first=False):
        self.calls.append(_Call(path, payload, _aces(dacl), dacl_first))
        if self.create_error is not None:
            raise self.create_error
        with open(path, 'xb') as f:
            if self.dacl_error is None:
                f.write(payload)
        if self.dacl_error is not None:
            raise self.dacl_error

    @property
    def one(self):
        assert len(self.calls) == 1
        return self.calls[0]


@pytest.fixture
def storage(tmp_path):
    with patch.object(
        secure_storage.SecureStorage, '_get_machine_guid', return_value=_GUID,
    ):
        return secure_storage.SecureStorage(config_dir=tmp_path)


def _temp_names(storage, recorder):
    """The paths the writer was given, each checked for the random temp shape."""
    shape = re.compile(re.escape(str(storage.token_file)) + r'\.[0-9a-f]{8}\.tmp$')
    for call in recorder.calls:
        assert shape.match(call.path), call.path
    return [call.path for call in recorder.calls]


@contextmanager
def _writer(writer=None, console=None, create_error=None, dacl_error=None):
    """Patch the identity seams and the protected writer; yields the recorder."""
    recorder = _Writer(create_error=create_error, dacl_error=dacl_error)
    with patch.object(secure_storage, '_writer_user_sid', return_value=writer), \
         patch.object(acl_hardening, 'console_user_sid', return_value=console), \
         patch.object(shared_utils, '_write_new_file_with_dacl', recorder):
        yield recorder


@contextmanager
def _open_calls():
    """Record every ``open`` while the block runs, as (path, mode)."""
    real = builtins.open
    calls = []

    def spy(file, mode='r', *args, **kwargs):
        if not isinstance(file, int):
            calls.append((os.fspath(file), mode))
        return real(file, mode, *args, **kwargs)

    with patch.object(builtins, 'open', spy):
        yield calls


class TestProtectedWritePath:
    def test_a_save_never_opens_the_target_and_replaces_a_fresh_temp(self, storage):
        with _writer(writer=_sid(_CONSOLE)) as recorder, _open_calls() as opens:
            assert storage.save_refresh_token(_SECRET) is True

        target = str(storage.token_file)
        assert [mode for path, mode in opens if path == target] == []
        call = recorder.one
        assert _temp_names(storage, recorder) == [call.path]
        assert call.dacl_first is True
        assert not os.path.exists(call.path)
        assert storage.get_refresh_token() == _SECRET

    def test_each_save_names_its_temp_file_at_random(self, storage):
        with _writer(writer=_sid(_CONSOLE)) as recorder:
            assert storage.save_refresh_token(_SECRET) is True
            assert storage.save_site_id('dummy-site') is True

        names = _temp_names(storage, recorder)
        assert len(set(names)) == 2
        assert storage._leftover_temp_files() == []
        assert storage.is_configured() is True

    def test_every_pairing_save_goes_through_the_writer(self, storage):
        with _writer(writer=_sid(_CONSOLE)) as recorder:
            assert storage.save_refresh_token(_SECRET) is True
            assert storage.save_access_token('dummy-access-token', 1.0) is True
            assert storage.save_site_id('dummy-site') is True
            assert storage.is_configured() is True

        assert len(set(_temp_names(storage, recorder))) == 3
        assert all(len(call.payload) > 0 for call in recorder.calls)

    def test_clearing_the_store_clears_the_temp_files_saves_left(self, storage, tmp_path):
        with _writer(writer=_sid(_CONSOLE)):
            assert storage.save_refresh_token(_SECRET) is True
        for name in ('.tokens.enc.0011aabb.tmp', '.tokens.enc.ffeedd99.tmp'):
            (tmp_path / name).write_bytes(b'interrupted-save')

        assert storage.clear_tokens() is True
        assert list(tmp_path.iterdir()) == []

    def test_a_save_replaces_the_previous_store(self, storage):
        with _writer(writer=_sid(_CONSOLE)):
            assert storage.save_refresh_token('first-dummy-token') is True
            first = storage.token_file.read_bytes()
            assert storage.save_refresh_token(_SECRET) is True

        assert storage.token_file.read_bytes() != first
        assert storage.get_refresh_token() == _SECRET


class TestTokenFileSpec:
    def test_a_user_writer_grants_itself_modify(self, storage):
        with _writer(writer=_sid(_OTHER_USER), console=None) as recorder:
            assert storage.save_refresh_token(_SECRET) is True
        assert recorder.one.aces == [
            (_SYSTEM, _FULL, 0),
            (_ADMINISTRATORS, _FULL, 0),
            (_OTHER_USER, _MODIFY, 0),
        ]

    def test_a_user_writer_grants_itself_not_another_console_user(self, storage):
        with _writer(writer=_sid(_OTHER_USER), console=_sid(_CONSOLE)) as recorder:
            assert storage.save_refresh_token(_SECRET) is True
        assert [sid for sid, _, _ in recorder.one.aces] == [
            _SYSTEM, _ADMINISTRATORS, _OTHER_USER,
        ]

    def test_a_system_writer_grants_the_console_user_modify(self, storage):
        with _writer(writer=None, console=_sid(_CONSOLE)) as recorder:
            assert storage.save_refresh_token(_SECRET) is True
        assert recorder.one.aces == [
            (_SYSTEM, _FULL, 0),
            (_ADMINISTRATORS, _FULL, 0),
            (_CONSOLE, _MODIFY, 0),
        ]

    def test_a_system_writer_without_a_session_grants_no_user(self, storage, caplog):
        caplog.set_level(logging.DEBUG, logger='secure_storage')
        with _writer(writer=None, console=None) as recorder:
            assert storage.save_refresh_token(_SECRET) is True
        assert recorder.one.aces == [(_SYSTEM, _FULL, 0), (_ADMINISTRATORS, _FULL, 0)]
        assert any(
            r.levelno == logging.DEBUG and 'adds the console user' in r.getMessage()
            for r in caplog.records
        )
        assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


class TestFailClosed:
    def _failure(self, caplog):
        records = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert len(records) == 1
        assert _SECRET not in caplog.text
        return records[0].getMessage()

    def test_a_dacl_failure_writes_no_token_bytes(self, storage, tmp_path, caplog):
        denied = acl_hardening.AclApplyError('failed to apply DACL to x: denied')
        with _writer(writer=_sid(_CONSOLE), dacl_error=denied):
            assert storage.save_refresh_token(_SECRET) is False

        assert list(tmp_path.iterdir()) == []
        assert 'denied' in self._failure(caplog)

    def test_a_dacl_failure_leaves_the_previous_store_intact(self, storage, caplog):
        with _writer(writer=_sid(_CONSOLE)):
            assert storage.save_refresh_token(_SECRET) is True
        kept = storage.token_file.read_bytes()

        denied = acl_hardening.AclApplyError('failed to apply DACL to x: denied')
        with _writer(writer=_sid(_CONSOLE), dacl_error=denied):
            assert storage.save_refresh_token('second-dummy-token') is False

        assert storage.token_file.read_bytes() == kept
        assert storage.get_refresh_token() == _SECRET
        assert storage._leftover_temp_files() == []

    @pytest.mark.parametrize('error, wanted', [
        (PermissionError(13, 'The file is in use.'), 'in use'),
        # create-new is the guard on the temp name: a name already taken fails.
        (FileExistsError(17, 'The file exists.'), 'exists'),
    ])
    def test_a_create_failure_writes_nothing(self, storage, tmp_path, caplog,
                                             error, wanted):
        with _writer(writer=_sid(_CONSOLE), create_error=error):
            assert storage.save_refresh_token(_SECRET) is False

        assert list(tmp_path.iterdir()) == []
        assert wanted in self._failure(caplog)

    def test_a_missing_spec_table_writes_nothing(self, storage, tmp_path, caplog):
        # no pywin32: acl_hardening builds an empty table, so there is no spec
        # to protect the file with.
        with _writer(writer=None, console=None) as recorder, \
             patch.object(acl_hardening, 'SPECS', []):
            assert storage.save_refresh_token(_SECRET) is False

        assert recorder.calls == []
        assert list(tmp_path.iterdir()) == []
        assert '.tokens.enc' in self._failure(caplog)


class TestFinalFileAttributes:
    """The real ``SetFileAttributesW``, on a ``tmp_path`` file."""

    def test_the_replaced_file_is_hidden_and_archived(self, storage):
        with _writer(writer=_sid(_CONSOLE)):
            assert storage.save_refresh_token(_SECRET) is True

        attrs = _attributes(storage.token_file)
        assert attrs & _HIDDEN
        assert attrs & _ARCHIVE

    def test_it_replaces_a_hidden_store_and_stays_hidden(self, storage):
        storage.token_file.write_bytes(b'previous')
        _set_hidden(storage.token_file)

        with _writer(writer=_sid(_CONSOLE)):
            assert storage.save_refresh_token(_SECRET) is True

        attrs = _attributes(storage.token_file)
        assert attrs & _HIDDEN
        assert attrs & _ARCHIVE
        assert storage.get_refresh_token() == _SECRET


class TestCrossIdentityWrite:
    def test_a_save_onto_a_store_another_identity_owns_succeeds(self, storage, caplog):
        """The store a save writes is a file that save created, so the previous
        file's owner never decides whether the save can protect it."""
        # the store as a session-less SYSTEM save leaves it: no user ACE.
        with _writer(writer=None, console=None) as first:
            assert storage.save_site_id('dummy-site') is True
        assert first.one.aces == [(_SYSTEM, _FULL, 0), (_ADMINISTRATORS, _FULL, 0)]

        with patch.object(acl_hardening, 'is_trusted_owner', return_value=False), \
             _writer(writer=_sid(_CONSOLE), console=_sid(_CONSOLE)) as recorder:
            assert storage.save_refresh_token(_SECRET) is True

        assert recorder.one.aces[-1] == (_CONSOLE, _MODIFY, 0)
        assert storage.get_refresh_token() == _SECRET
        assert storage.get_site_id() == 'dummy-site'
        assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


class TestLoadRefusesAnIndirectPath:
    def _no_tokens(self, storage, caplog):
        assert storage._load_data() == {}
        assert storage.get_refresh_token() is None
        assert storage.is_configured() is False
        warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert len(warnings) >= 1
        assert all('not a plain file' in r.getMessage() for r in warnings)

    def test_a_directory_at_the_token_path_reads_as_no_tokens(self, storage, caplog):
        os.mkdir(storage.token_file)
        self._no_tokens(storage, caplog)

    def test_a_reparse_point_is_not_followed(self, storage, tmp_path, caplog):
        elsewhere = tmp_path / 'elsewhere'
        elsewhere.mkdir()
        with patch.object(
            secure_storage.SecureStorage, '_get_machine_guid', return_value=_GUID,
        ):
            other = secure_storage.SecureStorage(config_dir=elsewhere)
        with _writer(writer=_sid(_CONSOLE)):
            assert other.save_refresh_token(_SECRET) is True
        try:
            os.symlink(other.token_file, storage.token_file)
        except OSError:
            pytest.skip('this account cannot create symbolic links')

        # the same machine key, so following the link would decrypt.
        self._no_tokens(storage, caplog)

    def test_a_reparse_attribute_reads_as_no_tokens(self, storage, caplog):
        storage.token_file.write_bytes(b'stand-in')
        real = os.lstat(storage.token_file)
        faked = MagicMock(
            st_mode=real.st_mode,
            st_file_attributes=real.st_file_attributes | stat.FILE_ATTRIBUTE_REPARSE_POINT,
        )
        with patch.object(secure_storage.os, 'lstat', return_value=faked):
            self._no_tokens(storage, caplog)


class TestPosixFallback:
    def test_a_non_windows_save_writes_the_file_directly(self, storage):
        with _writer(writer=None, console=None) as recorder, \
             patch.object(secure_storage.os, 'name', 'posix'):
            assert storage.save_refresh_token(_SECRET) is True

        assert recorder.calls == []
        assert storage.get_refresh_token() == _SECRET
        assert not _attributes(storage.token_file) & _HIDDEN


class TestWriterSeam:
    """The order ``secure_storage`` depends on, against the real writer: with
    ``dacl_first`` the DACL is set before the payload, so a DACL failure leaves
    an empty file; without it the payload stands (what the status-file writer
    needs)."""

    @pytest.fixture
    def me(self):
        sid = secure_storage._writer_user_sid()
        if sid is None:
            pytest.skip('this process runs as SYSTEM')
        return sid

    def test_a_dacl_failure_before_the_payload_leaves_an_empty_file(self, tmp_path, me):
        path = str(tmp_path / 'probe.tmp')
        with patch.object(ws, 'SetSecurityInfo', side_effect=OSError('denied')):
            with pytest.raises(acl_hardening.AclApplyError):
                shared_utils._write_new_file_with_dacl(
                    path, b'secret-payload', [(me, _FULL, 0)], dacl_first=True,
                )
        assert os.path.getsize(path) == 0

    def test_the_json_writers_order_is_unchanged(self, tmp_path, me):
        path = str(tmp_path / 'probe.json.tmp')
        with patch.object(ws, 'SetSecurityInfo', side_effect=OSError('denied')):
            with pytest.raises(acl_hardening.AclApplyError):
                shared_utils._write_new_file_with_dacl(
                    path, b'{}', [(me, _FULL, 0)],
                )
        with open(path, 'rb') as f:
            assert f.read() == b'{}'

    def test_dacl_first_writes_the_payload_under_a_protected_dacl(self, tmp_path, me):
        path = str(tmp_path / 'probe.tmp')
        shared_utils._write_new_file_with_dacl(
            path, b'payload', [(me, _FULL, 0)], dacl_first=True,
        )

        with open(path, 'rb') as f:
            assert f.read() == b'payload'
        sd = ws.GetNamedSecurityInfo(path, ws.SE_FILE_OBJECT, ws.DACL_SECURITY_INFORMATION)
        control, _revision = sd.GetSecurityDescriptorControl()
        assert control & ws.SE_DACL_PROTECTED
        dacl = sd.GetSecurityDescriptorDacl()
        assert dacl.GetAceCount() == 1
        _header, mask, sid = dacl.GetAce(0)
        assert (mask, ws.ConvertSidToStringSid(sid)) == (
            _FULL, ws.ConvertSidToStringSid(me),
        )


class TestWriterUserSid:
    @contextmanager
    def _token(self, token_user=None, open_error=None):
        token = MagicMock()
        with patch('win32api.GetCurrentProcess', return_value=-1), \
             patch('win32security.OpenProcessToken',
                   return_value=token, side_effect=open_error), \
             patch('win32security.GetTokenInformation',
                   return_value=(token_user, 0)):
            yield token

    def test_user_process_returns_its_own_sid(self):
        with self._token(token_user=_sid(_OTHER_USER)) as token:
            sid = secure_storage._writer_user_sid()
        assert ws.ConvertSidToStringSid(sid) == _OTHER_USER
        token.Close.assert_called_once()

    def test_system_process_returns_none(self):
        with self._token(token_user=_sid(_SYSTEM)) as token:
            assert secure_storage._writer_user_sid() is None
        token.Close.assert_called_once()

    def test_unreadable_token_returns_none(self):
        with self._token(open_error=OSError('denied')):
            assert secure_storage._writer_user_sid() is None
