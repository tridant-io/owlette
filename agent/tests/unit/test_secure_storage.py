r"""Unit tests for the token file DACL that secure_storage sets after each write.

Every Win32 security call is mocked: ``acl_hardening.apply``, ``matches`` and
``console_user_sid`` and secure_storage's ``_writer_user_sid`` are patched, or
the pywin32 token calls underneath it. The token file is a real file under
pytest's ``tmp_path`` holding dummy values only; the MachineGuid read is
patched. SID conversions use the real pywin32, a pure operation.

Manual check against a real DACL (not run by pytest). Use an empty scratch
folder, never the live install. Save this as ``<scratch>\save.py``:

    import sys
    sys.path.insert(0, r'<repo>\agent\src')
    import secure_storage
    secure_storage.SecureStorage(config_dir=r'<scratch>').save_site_id('dummy')

Then run it with the agent's python:

1. As the unelevated console user: ``icacls <scratch>\.tokens.enc`` lists
   SYSTEM (F), Administrators (F) and the console user (M), none inherited.
2. As SYSTEM, from a one-shot ``schtasks /ru SYSTEM`` task: the rewrite
   succeeds, and the owner and DACL are unchanged.
3. Remove only ``<scratch>\.tokens.enc``, then run step 2 before step 1: the
   console user's rewrite succeeds, the DACL is unchanged, and nothing is
   logged at warning level.
4. As a second standard account, ``type <scratch>\.tokens.enc`` is denied.
"""

import logging
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest
import win32security as ws

import acl_hardening
import secure_storage

_SYSTEM = 'S-1-5-18'
_ADMINISTRATORS = 'S-1-5-32-544'
_CONSOLE = 'S-1-5-21-11-22-33-1001'
_OTHER_USER = 'S-1-5-21-11-22-33-1002'

# icacls F and M: full control, and read + write + execute + delete.
_FULL = 0x1F01FF
_MODIFY = 0x1301BF

_SECRET = 'dummy-refresh-token'


def _sid(sid_str):
    return ws.ConvertStringSidToSid(sid_str)


def _aces(spec):
    return [(ws.ConvertSidToStringSid(sid), mask, flags) for sid, mask, flags in spec]


@pytest.fixture
def storage(tmp_path):
    with patch.object(
        secure_storage.SecureStorage, '_get_machine_guid',
        return_value='00000000-0000-0000-0000-000000000000',
    ):
        return secure_storage.SecureStorage(config_dir=tmp_path)


@contextmanager
def _dacl(writer=None, console=None, matches=False, apply_error=None):
    """Patch every seam the DACL step touches; yields the ``apply`` mock."""
    with patch.object(secure_storage, '_writer_user_sid', return_value=writer), \
         patch.object(acl_hardening, 'console_user_sid', return_value=console), \
         patch.object(acl_hardening, 'matches', return_value=matches), \
         patch.object(acl_hardening, 'apply', side_effect=apply_error) as apply_fn:
        yield apply_fn


def _applied(apply_fn):
    apply_fn.assert_called_once()
    path, spec = apply_fn.call_args[0]
    return path, _aces(spec)


class TestTokenFileSpec:
    def test_system_writer_grants_the_console_user_modify(self, storage):
        with _dacl(writer=None, console=_sid(_CONSOLE)) as apply_fn:
            assert storage.save_refresh_token(_SECRET) is True
        path, aces = _applied(apply_fn)
        assert path == str(storage.token_file)
        assert aces == [
            (_SYSTEM, _FULL, 0),
            (_ADMINISTRATORS, _FULL, 0),
            (_CONSOLE, _MODIFY, 0),
        ]

    def test_no_session_is_system_and_administrators_only(self, storage, caplog):
        caplog.set_level(logging.DEBUG, logger='secure_storage')
        with _dacl(writer=None, console=None) as apply_fn:
            assert storage.save_refresh_token(_SECRET) is True
        _path, aces = _applied(apply_fn)
        assert aces == [(_SYSTEM, _FULL, 0), (_ADMINISTRATORS, _FULL, 0)]
        assert any(
            r.levelno == logging.DEBUG and 'adds the console user' in r.getMessage()
            for r in caplog.records
        )
        assert not [r for r in caplog.records if r.levelno >= logging.WARNING]

    def test_user_writer_outside_the_console_session_grants_itself(self, storage):
        # an rdp session finds no console user; the pairing account must keep
        # its access or its second save fails.
        with _dacl(writer=_sid(_OTHER_USER), console=None) as apply_fn:
            assert storage.save_refresh_token(_SECRET) is True
        _path, aces = _applied(apply_fn)
        assert aces == [
            (_SYSTEM, _FULL, 0),
            (_ADMINISTRATORS, _FULL, 0),
            (_OTHER_USER, _MODIFY, 0),
        ]

    def test_user_writer_grants_itself_not_another_console_user(self, storage):
        with _dacl(writer=_sid(_OTHER_USER), console=_sid(_CONSOLE)) as apply_fn:
            assert storage.save_refresh_token(_SECRET) is True
        _path, aces = _applied(apply_fn)
        assert [sid for sid, _, _ in aces] == [_SYSTEM, _ADMINISTRATORS, _OTHER_USER]


class TestTokenFileDaclStep:
    def test_every_pairing_save_sets_the_dacl_after_writing(self, storage):
        sizes = []

        def record_size(path, _spec):
            with open(path, 'rb') as f:
                sizes.append(len(f.read()))

        with _dacl(writer=_sid(_CONSOLE)) as apply_fn:
            apply_fn.side_effect = record_size
            assert storage.save_refresh_token(_SECRET) is True
            assert storage.save_access_token('dummy-access-token', 1.0) is True
            assert storage.save_site_id('dummy-site') is True
            assert storage.is_configured() is True
        assert apply_fn.call_count == 3
        assert all(size > 0 for size in sizes)

    def test_matching_dacl_is_left_alone(self, storage):
        with _dacl(writer=None, console=_sid(_CONSOLE), matches=True) as apply_fn:
            assert storage.save_refresh_token(_SECRET) is True
        apply_fn.assert_not_called()

    def test_dacl_failure_does_not_fail_the_write(self, storage, caplog):
        caplog.set_level(logging.DEBUG, logger='secure_storage')
        denied = acl_hardening.AclApplyError('access denied')
        with _dacl(writer=_sid(_CONSOLE), apply_error=denied):
            assert storage.save_refresh_token(_SECRET) is True
            assert storage.get_refresh_token() == _SECRET
        warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert len(warnings) == 1
        assert 'access denied' in warnings[0].getMessage()
        assert _SECRET not in caplog.text

    def test_missing_spec_table_does_not_fail_the_write(self, storage, caplog):
        # no pywin32: acl_hardening builds an empty table.
        with _dacl(writer=None, console=None) as apply_fn, \
             patch.object(acl_hardening, 'SPECS', []):
            assert storage.save_refresh_token(_SECRET) is True
        apply_fn.assert_not_called()
        assert len([r for r in caplog.records if r.levelno >= logging.WARNING]) == 1

    def test_failed_write_sets_no_dacl(self, tmp_path):
        not_a_dir = tmp_path / 'file'
        not_a_dir.write_text('x')
        with patch.object(
            secure_storage.SecureStorage, '_get_machine_guid',
            return_value='00000000-0000-0000-0000-000000000000',
        ):
            storage = secure_storage.SecureStorage(config_dir=not_a_dir)
        with _dacl(writer=_sid(_CONSOLE)) as apply_fn:
            assert storage.save_refresh_token(_SECRET) is False
        apply_fn.assert_not_called()


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
