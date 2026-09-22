"""Unit tests for acl_hardening.

Every Win32 call is mocked at a module-level seam (`_native_read_dacl`,
`_native_read_owner`, `_native_write_dacl`, `_mkdir`, `_is_plain_object`,
`_read_dev_mode_value`), by patching the public function under test, or (for the
function-local pywin32 imports) by patching `sys.modules`, so no real
security descriptor, registry key or interactive session is required. SID
conversions use the real (installed) pywin32, which is a pure, side-effect-free
operation, and the link checks read real files in tmp_path. Mirrors
test_display_manager.py's patch-the-seams style.
"""

import os
import stat
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
import win32security as ws

import acl_hardening as ah


# ----- fakes ---------------------------------------------------------------

_OTHER_SID = ws.ConvertStringSidToSid('S-1-5-21-11-22-33-1001')
# an entra id user sid: not an account sid to windows, so nothing may filter on it.
_ENTRA_SID = ws.ConvertStringSidToSid('S-1-12-1-111-222-333-444')

_SE_DACL_PROTECTED = 0x1000
_ACCESS_ALLOWED = 0


class _FakeDacl:
    def __init__(self, aces):
        self._aces = aces

    def GetAceCount(self):
        return len(self._aces)

    def GetAce(self, index):
        return self._aces[index]


class _FakeSD:
    def __init__(self, control, aces, ace_type=_ACCESS_ALLOWED):
        self._control = control
        self._aces = aces
        self._ace_type = ace_type

    def GetSecurityDescriptorControl(self):
        return (self._control, 0)

    def GetSecurityDescriptorDacl(self):
        if self._aces is None:
            return None
        return _FakeDacl([
            ((self._ace_type, flags), mask, sid)
            for sid, mask, flags in self._aces
        ])


def _sd_from_spec(spec, protected=True, ace_type=_ACCESS_ALLOWED):
    control = _SE_DACL_PROTECTED if protected else 0
    return _FakeSD(control, list(spec), ace_type=ace_type)


def _sids(spec):
    return [ws.ConvertSidToStringSid(sid) for sid, _, _ in spec]


def _code_dir_spec():
    return [
        (ah.SID_SYSTEM, ah._FULL, ah._INHERIT),
        (ah.SID_ADMINISTRATORS, ah._FULL, ah._INHERIT),
        (ah.SID_USERS, ah._READ_EXECUTE, ah._INHERIT),
    ]


# ----- access-mask contract -------------------------------------------------

class TestMaskConstants:
    def test_modify_mask_is_icacls_M(self):
        # 0x1301bf is the mask icacls writes for modify (plus synchronize); the
        # developer grant uses exactly this and the devmode tolerance compares it.
        assert ah._MODIFY == 0x1301BF

    def test_full_and_readexec_masks(self):
        assert ah._FULL == 0x1F01FF
        assert ah._READ_EXECUTE == 0x1200A9

    def test_inherit_flags_are_object_and_container(self):
        assert ah._INHERIT == 0x03
        assert ah._NO_INHERIT == 0


# ----- matches --------------------------------------------------------------

class TestMatches:
    def test_true_when_dacl_equals_spec(self):
        spec = _code_dir_spec()
        with patch.object(ah, '_native_read_dacl', return_value=_sd_from_spec(spec)):
            assert ah.matches('X', spec) is True

    def test_true_regardless_of_ace_order(self):
        spec = _code_dir_spec()
        shuffled = [spec[2], spec[0], spec[1]]
        with patch.object(ah, '_native_read_dacl', return_value=_sd_from_spec(shuffled)):
            assert ah.matches('X', spec) is True

    def test_false_when_not_protected(self):
        spec = _code_dir_spec()
        sd = _sd_from_spec(spec, protected=False)
        with patch.object(ah, '_native_read_dacl', return_value=sd):
            assert ah.matches('X', spec) is False

    def test_false_on_ace_count_mismatch(self):
        spec = _code_dir_spec()
        sd = _sd_from_spec(spec[:2])  # only two aces on disk
        with patch.object(ah, '_native_read_dacl', return_value=sd):
            assert ah.matches('X', spec) is False

    def test_false_on_wrong_mask(self):
        spec = _code_dir_spec()
        drifted = [(ah.SID_USERS, ah._MODIFY, ah._INHERIT)] + spec[1:]
        sd = _sd_from_spec(drifted)
        with patch.object(ah, '_native_read_dacl', return_value=sd):
            assert ah.matches('X', spec) is False

    def test_false_on_wrong_sid(self):
        spec = _code_dir_spec()
        drifted = [(_OTHER_SID, ah._READ_EXECUTE, ah._INHERIT)] + spec[1:]
        sd = _sd_from_spec(drifted)
        with patch.object(ah, '_native_read_dacl', return_value=sd):
            assert ah.matches('X', spec) is False

    def test_false_on_deny_ace(self):
        spec = _code_dir_spec()
        # a deny ace (type 1) is never part of an allow-only spec.
        sd = _sd_from_spec(spec, ace_type=1)
        with patch.object(ah, '_native_read_dacl', return_value=sd):
            assert ah.matches('X', spec) is False

    def test_false_on_null_dacl(self):
        sd = _FakeSD(_SE_DACL_PROTECTED, None)
        with patch.object(ah, '_native_read_dacl', return_value=sd):
            assert ah.matches('X', _code_dir_spec()) is False

    def test_false_and_no_raise_on_read_error(self):
        with patch.object(ah, '_native_read_dacl', side_effect=OSError('boom')):
            assert ah.matches('X', _code_dir_spec()) is False


# ----- apply ----------------------------------------------------------------

class TestApply:
    def test_builds_dacl_with_every_ace(self):
        spec = _code_dir_spec()
        with patch.object(ah, '_native_write_dacl') as write:
            ah.apply('X', spec)
        write.assert_called_once()
        path_arg, dacl = write.call_args[0]
        assert path_arg == 'X'
        assert dacl.GetAceCount() == 3
        seen = set()
        for i in range(dacl.GetAceCount()):
            ace = dacl.GetAce(i)
            seen.add((int(ace[0][1]), int(ace[1]), ws.ConvertSidToStringSid(ace[-1])))
        expected = {
            (int(flags), int(mask), ws.ConvertSidToStringSid(sid))
            for sid, mask, flags in spec
        }
        assert seen == expected

    def test_file_spec_has_no_inherit_flags(self):
        spec = [(ah.SID_SYSTEM, ah._FULL, ah._NO_INHERIT)]
        with patch.object(ah, '_native_write_dacl') as write:
            ah.apply('X', spec)
        dacl = write.call_args[0][1]
        assert dacl.GetAce(0)[0][1] == 0  # no inherit flags on a file ace

    def test_raises_acl_apply_error_on_failure(self):
        with patch.object(ah, '_native_write_dacl', side_effect=RuntimeError('denied')):
            with pytest.raises(ah.AclApplyError):
                ah.apply('X', _code_dir_spec())


# ----- is_trusted_owner -----------------------------------------------------

class TestIsTrustedOwner:
    @pytest.fixture
    def plain(self):
        with patch.object(ah, '_is_plain_object', return_value=True):
            yield

    def test_system_owner_is_trusted(self, plain):
        with patch.object(ah, '_native_read_owner', return_value=ah.SID_SYSTEM):
            assert ah.is_trusted_owner('X') is True

    def test_administrators_owner_is_trusted(self, plain):
        with patch.object(ah, '_native_read_owner', return_value=ah.SID_ADMINISTRATORS):
            assert ah.is_trusted_owner('X') is True

    def test_other_owner_is_untrusted(self, plain):
        with patch.object(ah, '_native_read_owner', return_value=_OTHER_SID):
            assert ah.is_trusted_owner('X') is False

    def test_the_given_user_is_trusted_and_no_one_else(self, plain):
        with patch.object(ah, '_native_read_owner', return_value=_OTHER_SID):
            assert ah.is_trusted_owner('X', _OTHER_SID) is True
            assert ah.is_trusted_owner('X', _ENTRA_SID) is False

    def test_read_error_is_untrusted(self, plain):
        with patch.object(ah, '_native_read_owner', side_effect=OSError('no access')):
            assert ah.is_trusted_owner('X') is False

    def test_a_hard_link_to_a_system_owned_file_is_untrusted(self, tmp_path):
        # a local user can hard-link a control-file name to a system-owned
        # log they can write attributes on; the link carries its owner.
        log = tmp_path / 'service.log'
        log.write_text('log line')
        link = tmp_path / 'stop_signal.json'
        os.link(log, link)
        with patch.object(ah, '_native_read_owner', return_value=ah.SID_SYSTEM):
            assert ah.is_trusted_owner(str(link)) is False
            assert ah.is_trusted_owner(str(link), _OTHER_SID) is False

    def test_a_reparse_point_is_untrusted(self):
        reparse = SimpleNamespace(
            st_nlink=1, st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT)
        with patch.object(ah.os, 'lstat', return_value=reparse), \
             patch.object(ah, '_native_read_owner', return_value=ah.SID_SYSTEM):
            assert ah.is_trusted_owner('X') is False

    def test_plain_files_and_directories_pass_the_link_check(self, tmp_path):
        plain_file = tmp_path / 'marker.json'
        plain_file.write_text('{}')
        directory = tmp_path / 'update-staging'
        (directory / 'child').mkdir(parents=True)
        with patch.object(ah, '_native_read_owner', return_value=ah.SID_SYSTEM):
            assert ah.is_trusted_owner(str(plain_file)) is True
            assert ah.is_trusted_owner(str(directory)) is True

    def test_a_missing_path_is_untrusted(self, tmp_path):
        with patch.object(ah, '_native_read_owner', return_value=ah.SID_SYSTEM):
            assert ah.is_trusted_owner(str(tmp_path / 'absent')) is False


# ----- create_private_dir ---------------------------------------------------

class TestCreatePrivateDir:
    def test_fresh_create_applies_spec(self):
        spec = [(ah.SID_SYSTEM, ah._FULL, ah._INHERIT)]
        with patch.object(ah, '_mkdir') as mkdir, \
             patch.object(ah, 'apply') as apply_fn, \
             patch.object(ah, 'console_user_sid', return_value=None):
            ah.create_private_dir('X', spec)
        mkdir.assert_called_once_with('X')
        apply_fn.assert_called_once()
        assert apply_fn.call_args[0][0] == 'X'

    def test_adopts_existing_trusted_non_reparse(self):
        spec = [(ah.SID_SYSTEM, ah._FULL, ah._INHERIT)]
        with patch.object(ah, '_mkdir', side_effect=FileExistsError), \
             patch.object(ah, 'is_trusted_owner', return_value=True), \
             patch.object(ah, 'apply') as apply_fn, \
             patch.object(ah, 'console_user_sid', return_value=None):
            ah.create_private_dir('X', spec)
        apply_fn.assert_called_once()

    def test_rejects_existing_untrusted(self):
        with patch.object(ah, '_mkdir', side_effect=FileExistsError), \
             patch.object(ah, 'is_trusted_owner', return_value=False), \
             patch.object(ah, 'apply') as apply_fn:
            with pytest.raises(ah.UntrustedDirectory):
                ah.create_private_dir('X', [(ah.SID_SYSTEM, ah._FULL, ah._INHERIT)])
        apply_fn.assert_not_called()

    def test_rejects_existing_reparse_point(self):
        # system-owned, but a junction: is_trusted_owner's link check refuses it.
        reparse = SimpleNamespace(
            st_nlink=1, st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT)
        with patch.object(ah, '_mkdir', side_effect=FileExistsError), \
             patch.object(ah.os, 'lstat', return_value=reparse), \
             patch.object(ah, '_native_read_owner', return_value=ah.SID_SYSTEM), \
             patch.object(ah, 'apply') as apply_fn:
            with pytest.raises(ah.UntrustedDirectory):
                ah.create_private_dir('X', [(ah.SID_SYSTEM, ah._FULL, ah._INHERIT)])
        apply_fn.assert_not_called()

    def test_resolves_console_marker(self):
        spec = [(ah.SID_SYSTEM, ah._FULL, ah._NO_INHERIT),
                (ah.CONSOLE_USER, ah._MODIFY, ah._NO_INHERIT)]
        with patch.object(ah, '_mkdir'), \
             patch.object(ah, 'apply') as apply_fn, \
             patch.object(ah, 'console_user_sid', return_value=_OTHER_SID):
            ah.create_private_dir('X', spec)
        applied = apply_fn.call_args[0][1]
        assert _sids(applied) == ['S-1-5-18', ws.ConvertSidToStringSid(_OTHER_SID)]

    def test_drops_console_marker_when_no_session(self):
        spec = [(ah.SID_SYSTEM, ah._FULL, ah._NO_INHERIT),
                (ah.CONSOLE_USER, ah._MODIFY, ah._NO_INHERIT)]
        with patch.object(ah, '_mkdir'), \
             patch.object(ah, 'apply') as apply_fn, \
             patch.object(ah, 'console_user_sid', return_value=None):
            ah.create_private_dir('X', spec)
        applied = apply_fn.call_args[0][1]
        assert _sids(applied) == ['S-1-5-18']


# ----- dev_mode_enabled -----------------------------------------------------

class TestDevModeEnabled:
    def test_true_when_value_is_one(self):
        with patch.object(ah, '_read_dev_mode_value', return_value=1):
            assert ah.dev_mode_enabled() is True

    def test_false_when_value_is_zero(self):
        with patch.object(ah, '_read_dev_mode_value', return_value=0):
            assert ah.dev_mode_enabled() is False

    def test_false_when_value_is_other(self):
        with patch.object(ah, '_read_dev_mode_value', return_value=2):
            assert ah.dev_mode_enabled() is False

    def test_false_when_key_absent(self):
        with patch.object(ah, '_read_dev_mode_value', side_effect=FileNotFoundError):
            assert ah.dev_mode_enabled() is False


# ----- dev tolerance surface (only app) -------------------------------------

class TestDevTolerantPaths:
    def test_agent_src_is_not_tolerant(self):
        # agent\src is a child of agent and never re-asserted, so it needs none.
        assert ah._is_dev_tolerant(os.path.join(ah._APP_ROOT, 'agent', 'src')) is False

    def test_app_is_tolerant(self):
        assert ah._is_dev_tolerant(os.path.join(ah._APP_ROOT, 'app')) is True

    def test_comparison_is_case_insensitive(self):
        assert ah._is_dev_tolerant(os.path.join(ah._APP_ROOT, 'APP')) is True

    @pytest.mark.parametrize('name', ['python', 'tools', 'scripts', 'agent', 'content'])
    def test_other_code_dirs_are_not_tolerant(self, name):
        assert ah._is_dev_tolerant(os.path.join(ah._APP_ROOT, name)) is False

    def test_token_file_is_not_tolerant(self):
        assert ah._is_dev_tolerant(
            os.path.join(ah._DATA_ROOT, '.tokens.enc')
        ) is False


# ----- console_user_sid -----------------------------------------------------

class TestConsoleUserSid:
    def test_none_when_no_interactive_session(self):
        mock_ts = MagicMock()
        mock_ts.WTSGetActiveConsoleSessionId.return_value = 0xFFFFFFFF
        with patch.dict(sys.modules, {'win32ts': mock_ts}):
            assert ah.console_user_sid() is None

    def test_returns_token_user_sid(self):
        mock_ts = MagicMock()
        mock_ts.WTSGetActiveConsoleSessionId.return_value = 2
        token = MagicMock()
        mock_ts.WTSQueryUserToken.return_value = token
        mock_ws = MagicMock()
        mock_ws.GetTokenInformation.return_value = (_ENTRA_SID, 7)
        with patch.dict(sys.modules, {'win32ts': mock_ts, 'win32security': mock_ws}):
            assert ah.console_user_sid() is _ENTRA_SID
        token.Close.assert_called_once()


# ----- repair_all -----------------------------------------------------------

def _entry(path, aces, app_root=False):
    return ah._SpecEntry(path, aces, app_root)


class TestRepairAll:
    def test_repairs_drift_and_reports_path(self):
        entry = _entry('A', _code_dir_spec())
        log = MagicMock()
        with patch.object(ah, 'specs', return_value=[entry]), \
             patch.object(ah, 'dev_mode_enabled', return_value=False), \
             patch.object(ah, 'console_user_sid', return_value=None), \
             patch.object(ah.os.path, 'exists', return_value=True), \
             patch.object(ah, 'matches', return_value=False), \
             patch.object(ah, 'apply') as apply_fn:
            repaired = ah.repair_all(log)
        assert repaired == ['A']
        apply_fn.assert_called_once()
        assert apply_fn.call_args[0][0] == 'A'
        log.warning.assert_called()

    def test_skips_paths_already_matching(self):
        entry = _entry('A', _code_dir_spec())
        with patch.object(ah, 'specs', return_value=[entry]), \
             patch.object(ah, 'dev_mode_enabled', return_value=False), \
             patch.object(ah, 'console_user_sid', return_value=None), \
             patch.object(ah.os.path, 'exists', return_value=True), \
             patch.object(ah, 'matches', return_value=True), \
             patch.object(ah, 'apply') as apply_fn:
            assert ah.repair_all(MagicMock()) == []
        apply_fn.assert_not_called()

    def test_skips_absent_paths_silently(self):
        entry = _entry('A', _code_dir_spec())
        with patch.object(ah, 'specs', return_value=[entry]), \
             patch.object(ah, 'dev_mode_enabled', return_value=False), \
             patch.object(ah, 'console_user_sid', return_value=None), \
             patch.object(ah.os.path, 'exists', return_value=False), \
             patch.object(ah, 'matches') as matches_fn, \
             patch.object(ah, 'apply') as apply_fn:
            assert ah.repair_all(MagicMock()) == []
        matches_fn.assert_not_called()
        apply_fn.assert_not_called()

    def test_never_raises_when_apply_fails(self):
        entry = _entry('A', _code_dir_spec())
        log = MagicMock()
        with patch.object(ah, 'specs', return_value=[entry]), \
             patch.object(ah, 'dev_mode_enabled', return_value=False), \
             patch.object(ah, 'console_user_sid', return_value=None), \
             patch.object(ah.os.path, 'exists', return_value=True), \
             patch.object(ah, 'matches', return_value=False), \
             patch.object(ah, 'apply', side_effect=ah.AclApplyError('denied')):
            repaired = ah.repair_all(log)
        assert repaired == []  # a failed apply is not reported as repaired
        log.warning.assert_called()

    def test_never_raises_on_unexpected_error(self):
        entry = _entry('A', _code_dir_spec())
        with patch.object(ah, 'specs', return_value=[entry]), \
             patch.object(ah, 'dev_mode_enabled', return_value=False), \
             patch.object(ah, 'console_user_sid', return_value=None), \
             patch.object(ah.os.path, 'exists', return_value=True), \
             patch.object(ah, 'matches', side_effect=RuntimeError('boom')):
            assert ah.repair_all(MagicMock()) == []

    def test_tolerates_dev_ace_only_on_app(self):
        python_path = os.path.join(ah._APP_ROOT, 'python')
        app_path = os.path.join(ah._APP_ROOT, 'app')
        specs = [_entry(python_path, _code_dir_spec(), app_root=True),
                 _entry(app_path, _code_dir_spec(), app_root=True)]

        # matches only the augmented variant: base plus one developer ace.
        def only_augmented(path, spec):
            return len(spec) == 4

        with patch.object(ah, 'specs', return_value=specs), \
             patch.object(ah, '_is_installed_tree', return_value=True), \
             patch.object(ah, 'dev_mode_enabled', return_value=True), \
             patch.object(ah, 'console_user_sid', return_value=_ENTRA_SID), \
             patch.object(ah.os.path, 'exists', return_value=True), \
             patch.object(ah, 'matches', side_effect=only_augmented), \
             patch.object(ah, 'apply') as apply_fn:
            repaired = ah.repair_all(MagicMock())
        # app is tolerated (its augmented variant matched); python gets no
        # augmented variant, so it never matches and is repaired.
        assert repaired == [python_path]
        apply_fn.assert_called_once()
        assert apply_fn.call_args[0][0] == python_path

    def test_dev_ace_is_the_exact_devgrant_shape(self):
        app_path = os.path.join(ah._APP_ROOT, 'app')
        captured = []

        def capture(path, spec):
            captured.append(list(spec))
            return len(spec) == 4  # accept the augmented variant

        with patch.object(ah, 'specs', return_value=[_entry(app_path, _code_dir_spec(), app_root=True)]), \
             patch.object(ah, '_is_installed_tree', return_value=True), \
             patch.object(ah, 'dev_mode_enabled', return_value=True), \
             patch.object(ah, 'console_user_sid', return_value=_ENTRA_SID), \
             patch.object(ah.os.path, 'exists', return_value=True), \
             patch.object(ah, 'matches', side_effect=capture), \
             patch.object(ah, 'apply') as apply_fn:
            ah.repair_all(MagicMock())
        apply_fn.assert_not_called()
        augmented = [s for s in captured if len(s) == 4][0]
        dev_ace = augmented[-1]
        # exactly: the interactive account's sid, mask 0x1301bf, object|container inherit.
        assert dev_ace[0] is _ENTRA_SID
        assert dev_ace[1] == 0x1301BF
        assert dev_ace[2] == (0x01 | 0x02)

    def test_no_tolerance_without_console_sid(self):
        app_path = os.path.join(ah._APP_ROOT, 'app')

        def only_augmented(path, spec):
            return len(spec) == 4

        with patch.object(ah, 'specs', return_value=[_entry(app_path, _code_dir_spec(), app_root=True)]), \
             patch.object(ah, '_is_installed_tree', return_value=True), \
             patch.object(ah, 'dev_mode_enabled', return_value=True), \
             patch.object(ah, 'console_user_sid', return_value=None), \
             patch.object(ah.os.path, 'exists', return_value=True), \
             patch.object(ah, 'matches', side_effect=only_augmented), \
             patch.object(ah, 'apply') as apply_fn:
            repaired = ah.repair_all(MagicMock())
        # no console sid, so no augmented variant: app is repaired.
        assert repaired == [app_path]
        apply_fn.assert_called_once()

    def test_no_tolerance_when_dev_mode_off(self):
        app_path = os.path.join(ah._APP_ROOT, 'app')

        def only_augmented(path, spec):
            return len(spec) == 4

        with patch.object(ah, 'specs', return_value=[_entry(app_path, _code_dir_spec(), app_root=True)]), \
             patch.object(ah, '_is_installed_tree', return_value=True), \
             patch.object(ah, 'dev_mode_enabled', return_value=False), \
             patch.object(ah, 'console_user_sid', return_value=_ENTRA_SID), \
             patch.object(ah.os.path, 'exists', return_value=True), \
             patch.object(ah, 'matches', side_effect=only_augmented), \
             patch.object(ah, 'apply') as apply_fn:
            repaired = ah.repair_all(MagicMock())
        assert repaired == [app_path]
        apply_fn.assert_called_once()

    def test_resolves_console_marker_before_apply(self):
        token_path = os.path.join(ah._DATA_ROOT, '.tokens.enc')
        token_spec = [(ah.SID_SYSTEM, ah._FULL, ah._NO_INHERIT),
                      (ah.SID_ADMINISTRATORS, ah._FULL, ah._NO_INHERIT),
                      (ah.CONSOLE_USER, ah._MODIFY, ah._NO_INHERIT)]
        with patch.object(ah, 'specs', return_value=[_entry(token_path, token_spec)]), \
             patch.object(ah, 'dev_mode_enabled', return_value=False), \
             patch.object(ah, 'console_user_sid', return_value=_OTHER_SID), \
             patch.object(ah.os.path, 'exists', return_value=True), \
             patch.object(ah, 'matches', return_value=False), \
             patch.object(ah, 'apply') as apply_fn:
            ah.repair_all(MagicMock())
        applied = apply_fn.call_args[0][1]
        assert _sids(applied) == [
            'S-1-5-18', 'S-1-5-32-544', ws.ConvertSidToStringSid(_OTHER_SID),
        ]

    def test_drops_console_marker_when_no_session(self):
        token_path = os.path.join(ah._DATA_ROOT, '.tokens.enc')
        token_spec = [(ah.SID_SYSTEM, ah._FULL, ah._NO_INHERIT),
                      (ah.CONSOLE_USER, ah._MODIFY, ah._NO_INHERIT)]
        with patch.object(ah, 'specs', return_value=[_entry(token_path, token_spec)]), \
             patch.object(ah, 'dev_mode_enabled', return_value=False), \
             patch.object(ah, 'console_user_sid', return_value=None), \
             patch.object(ah.os.path, 'exists', return_value=True), \
             patch.object(ah, 'matches', return_value=False), \
             patch.object(ah, 'apply') as apply_fn:
            ah.repair_all(MagicMock())
        applied = apply_fn.call_args[0][1]
        assert _sids(applied) == ['S-1-5-18']

    def test_accepts_none_logger(self):
        with patch.object(ah, 'specs', return_value=[]), \
             patch.object(ah, 'dev_mode_enabled', return_value=False), \
             patch.object(ah, 'console_user_sid', return_value=None):
            assert ah.repair_all() == []


class TestSessionChangeRepair:
    """A console session change is expected to change the console-user
    entries; anything else it finds is still drift."""

    TOKEN = [(ah.SID_SYSTEM, ah._FULL, ah._NO_INHERIT),
             (ah.CONSOLE_USER, ah._MODIFY, ah._NO_INHERIT)]

    def _repair(self, entries, session_change, dev=False):
        log = MagicMock()
        with patch.object(ah, 'specs', return_value=entries), \
             patch.object(ah, 'dev_mode_enabled', return_value=dev), \
             patch.object(ah, 'console_user_sid', return_value=_OTHER_SID), \
             patch.object(ah.os.path, 'exists', return_value=True), \
             patch.object(ah, 'matches', return_value=False), \
             patch.object(ah, 'apply'):
            repaired = ah.repair_all(log, session_change=session_change)
        return repaired, log

    def test_a_console_user_entry_is_updated_at_info(self):
        repaired, log = self._repair([_entry('T', self.TOKEN)], session_change=True)
        assert repaired == ['T']
        log.info.assert_called_once()
        assert 'console session' in log.info.call_args[0][0]
        log.warning.assert_not_called()

    def test_a_fixed_entry_is_still_drift(self):
        repaired, log = self._repair([_entry('P', _code_dir_spec())], session_change=True)
        assert repaired == ['P']
        assert 'drifted' in log.warning.call_args[0][0]

    def test_start_up_keeps_the_drift_warning_for_every_entry(self):
        repaired, log = self._repair([_entry('T', self.TOKEN)], session_change=False)
        assert repaired == ['T']
        assert 'drifted' in log.warning.call_args[0][0]
        log.info.assert_not_called()

    def test_the_dev_mode_warning_is_left_to_start_up(self):
        _, at_start_up = self._repair([], session_change=False, dev=True)
        _, at_login = self._repair([], session_change=True, dev=True)
        assert 'DevMode' in at_start_up.warning.call_args[0][0]
        at_login.warning.assert_not_called()


def test_follows_console_user_marks_the_token_file_and_the_cortex_queues():
    names = sorted(os.path.basename(e.path) for e in ah.specs() if ah.follows_console_user(e))
    assert names == ['.tokens.enc', '.tokens.enc.v1',
                     'cortex_commands', 'cortex_events', 'cortex_results']


class TestInstalledTreeGate:
    """app-root entries are only re-asserted on an installed tree (the
    uninstaller is present); a source checkout's files are never touched."""

    def _tree(self, tmp_path, installed):
        repo = tmp_path / 'repo'
        data = tmp_path / 'data'
        for name in ('agent', 'python', 'tools', 'app', 'scripts'):
            (repo / name).mkdir(parents=True)
        for name in ('README.md', 'LICENSE', 'CLAUDE.md'):
            (repo / name).write_text('x')
        if installed:
            (repo / 'unins000.exe').write_text('x')
        (data / 'content').mkdir(parents=True)
        with patch.object(ah, '_APP_ROOT', str(repo)), \
             patch.object(ah, '_DATA_ROOT', str(data)):
            specs = ah._build_specs()
        return repo, data, specs

    def _run(self, repo, specs):
        with patch.object(ah, '_APP_ROOT', str(repo)), \
             patch.object(ah, 'specs', return_value=specs), \
             patch.object(ah, 'dev_mode_enabled', return_value=False), \
             patch.object(ah, 'console_user_sid', return_value=None), \
             patch.object(ah, 'matches', return_value=False) as matches_fn, \
             patch.object(ah, 'apply') as apply_fn:
            repaired = ah.repair_all(MagicMock())
        touched = [c[0][0] for c in matches_fn.call_args_list + apply_fn.call_args_list]
        return repaired, touched

    def test_checkout_tree_touches_no_app_root_path(self, tmp_path):
        repo, data, specs = self._tree(tmp_path, installed=False)
        repaired, touched = self._run(repo, specs)
        repo_prefix = os.path.normcase(str(repo))
        assert [p for p in touched if os.path.normcase(p).startswith(repo_prefix)] == []
        # data-root entries are unaffected by the gate.
        assert repaired == [os.path.join(str(data), 'content')]

    def test_installed_tree_still_hardens_app_root(self, tmp_path):
        repo, data, specs = self._tree(tmp_path, installed=True)
        repaired, _touched = self._run(repo, specs)
        assert os.path.join(str(repo), 'agent') in repaired
        assert os.path.join(str(repo), 'unins000.exe') in repaired
        assert os.path.join(str(data), 'content') in repaired


# ----- specs table ----------------------------------------------------------

def _find(suffix):
    hits = [e for e in ah.specs()
            if os.path.normcase(e.path).endswith(os.path.normcase(suffix))]
    assert len(hits) == 1, f'expected one entry ending {suffix!r}, got {len(hits)}'
    return hits[0]


class TestSpecsTable:
    def test_specs_is_populated(self):
        assert len(ah.specs()) > 0

    def test_code_dirs_grant_users_read_execute(self):
        for name in ('agent', 'python', 'tools', 'app', 'scripts'):
            entry = _find(name)
            aces = entry.aces
            assert 'S-1-5-32-545' in _sids(aces)
            users = [a for a in aces
                     if ws.ConvertSidToStringSid(a[0]) == 'S-1-5-32-545'][0]
            assert users[1] == ah._READ_EXECUTE
            assert users[2] == ah._INHERIT

    def test_code_dirs_live_under_app_root(self):
        for name in ('agent', 'python', 'tools', 'app', 'scripts'):
            entry = _find(name)
            assert entry.path == os.path.join(ah._APP_ROOT, name)
            assert entry.app_root is True

    def test_payload_files_are_read_execute_no_inherit(self):
        for name in ('unins000.exe', 'unins000.dat', 'README.md', 'LICENSE',
                     'CLAUDE.md', 'THIRD_PARTY_NOTICES.md', 'LGPL-2.1.txt'):
            entry = _find(name)
            assert entry.app_root is True
            assert _sids(entry.aces) == ['S-1-5-18', 'S-1-5-32-544', 'S-1-5-32-545']
            assert all(flags == ah._NO_INHERIT for _, _, flags in entry.aces)

    def test_service_dirs_are_system_and_admins_only(self):
        for name in ('content', 'update-staging'):
            entry = _find(name)
            assert entry.app_root is False
            assert _sids(entry.aces) == ['S-1-5-18', 'S-1-5-32-544']

    def test_cortex_trio_carries_console_marker(self):
        for name in ('cortex_commands', 'cortex_results', 'cortex_events'):
            entry = _find(os.path.join('ipc', name))
            assert entry.path == os.path.join(ah._DATA_ROOT, 'ipc', name)
            assert entry.app_root is False
            assert entry.aces[-1][0] is ah.CONSOLE_USER
            assert entry.aces[-1][1] == ah._MODIFY

    def test_token_file_lives_under_data_root_with_console_marker(self):
        entry = _find('.tokens.enc')
        assert entry.path == os.path.join(ah._DATA_ROOT, '.tokens.enc')
        assert entry.app_root is False
        assert entry.aces[-1][0] is ah.CONSOLE_USER
        assert entry.aces[-1][1] == ah._MODIFY
        assert all(flags == ah._NO_INHERIT for _, _, flags in entry.aces)
