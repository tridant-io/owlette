"""Unit tests for shared_utils' install-tree hardening (agent 3.3.6).

Covers is_system_process(), the protected DACL the atomic JSON writer gives a
file's temp copy before the rename, and the fail-closed creation of the cortex
IPC trio. Win32 is mocked at shared_utils' seams (_process_user_sid,
_write_new_file_with_dacl, acl_hardening.console_user_sid,
acl_hardening.create_private_dir); SID conversions use the real pywin32, a pure
operation. Two tests run the native seam for real on a scratch file under
pytest's tmp_path, granting only the current account, so the pywin32 calls
themselves are exercised before the VM matrix.
"""

import json
import logging
import os

import pytest
import pywintypes
import win32file
import win32security as ws

import acl_hardening
import shared_utils


FULL = 0x1F01FF
READ = 0x120089
MODIFY = 0x1301BF

CONSOLE_STR = 'S-1-5-21-11-22-33-1001'
CONSOLE = ws.ConvertStringSidToSid(CONSOLE_STR)
OTHER_USER_STR = 'S-1-5-21-11-22-33-1002'

# SYSTEM full, Administrators full, Users read: every protected json file.
BASE = [
    ('S-1-5-18', FULL, 0),
    ('S-1-5-32-544', FULL, 0),
    ('S-1-5-32-545', READ, 0),
]

TRIO = [
    shared_utils.CORTEX_IPC_CMD_DIR,
    shared_utils.CORTEX_IPC_RESULT_DIR,
    shared_utils.CORTEX_IPC_EVENTS_DIR,
]

_REAL_PROCESS_USER_SID = shared_utils._process_user_sid


@pytest.fixture(autouse=True)
def _fresh_state(monkeypatch):
    # the token answer is cached for the process; never leak a faked one.
    _REAL_PROCESS_USER_SID.cache_clear()
    monkeypatch.setattr(shared_utils, '_json_dacl_failures', set())
    yield
    _REAL_PROCESS_USER_SID.cache_clear()


def _run_as(monkeypatch, sid_string):
    monkeypatch.setattr(shared_utils, '_process_user_sid', lambda: sid_string)


def _console_user(monkeypatch, sid):
    calls = []

    def fake():
        calls.append(True)
        return sid

    monkeypatch.setattr(acl_hardening, 'console_user_sid', fake)
    return calls


def _described(dacl):
    return [(ws.ConvertSidToStringSid(sid), mask, flags) for sid, mask, flags in dacl]


# ----- is_system_process ----------------------------------------------------

class TestIsSystemProcess:
    @pytest.fixture
    def token(self, monkeypatch):
        state = {'sid': 'S-1-5-18', 'error': None, 'opens': 0}

        class _Token:
            def Close(self):
                pass

        def open_token(process, access):
            state['opens'] += 1
            if state['error'] is not None:
                raise state['error']
            return _Token()

        monkeypatch.setattr(ws, 'OpenProcessToken', open_token)
        monkeypatch.setattr(
            ws, 'GetTokenInformation',
            lambda token, info_class: (ws.ConvertStringSidToSid(state['sid']), 0),
        )
        return state

    def test_true_for_localsystem(self, token):
        assert shared_utils.is_system_process() is True

    def test_false_for_a_user_account(self, token):
        token['sid'] = OTHER_USER_STR
        assert shared_utils.is_system_process() is False

    def test_unreadable_token_counts_as_not_system(self, token):
        token['error'] = pywintypes.error(5, 'OpenProcessToken', 'Access is denied.')
        assert shared_utils.is_system_process() is False

    def test_token_is_read_once_per_process(self, token):
        assert shared_utils.is_system_process() is True
        token['sid'] = OTHER_USER_STR
        assert shared_utils.is_system_process() is True
        assert token['opens'] == 1


# ----- the dacl a json writer gives each file -------------------------------

class TestJsonFileDacl:
    def test_system_gives_app_states_console_user_modify(self, monkeypatch):
        _run_as(monkeypatch, 'S-1-5-18')
        _console_user(monkeypatch, CONSOLE)
        dacl = shared_utils._json_file_dacl(shared_utils.RESULT_FILE_PATH)
        assert _described(dacl) == BASE + [(CONSOLE_STR, MODIFY, 0)]

    def test_system_without_a_console_user_keeps_app_states_readable(self, monkeypatch):
        _run_as(monkeypatch, 'S-1-5-18')
        _console_user(monkeypatch, None)
        dacl = shared_utils._json_file_dacl(shared_utils.RESULT_FILE_PATH)
        assert _described(dacl) == BASE

    @pytest.mark.parametrize('name', [
        'tmp/service_status.json', 'tmp/profile_hash.json', '.display_profile_hash',
    ])
    def test_system_gives_other_json_users_read_only(self, monkeypatch, name):
        _run_as(monkeypatch, 'S-1-5-18')
        calls = _console_user(monkeypatch, CONSOLE)
        dacl = shared_utils._json_file_dacl(shared_utils.get_data_path(name))
        assert _described(dacl) == BASE
        assert calls == []

    @pytest.mark.parametrize('sid', ['S-1-5-18', CONSOLE_STR])
    def test_config_json_keeps_its_inherited_acl(self, monkeypatch, sid):
        # the desktop app and pairing replace config.json as the console user.
        _run_as(monkeypatch, sid)
        assert shared_utils._json_file_dacl(shared_utils.CONFIG_PATH) is None
        assert shared_utils._json_file_dacl(shared_utils.CONFIG_PATH.upper()) is None

    def test_user_process_protects_app_states_for_itself(self, monkeypatch):
        _run_as(monkeypatch, CONSOLE_STR)
        calls = _console_user(monkeypatch, None)
        dacl = shared_utils._json_file_dacl(shared_utils.RESULT_FILE_PATH)
        assert _described(dacl) == BASE + [(CONSOLE_STR, MODIFY, 0)]
        assert calls == []

    def test_user_process_leaves_other_json_alone(self, monkeypatch):
        _run_as(monkeypatch, CONSOLE_STR)
        path = shared_utils.get_data_path('tmp/profile_hash.json')
        assert shared_utils._json_file_dacl(path) is None

    def test_unreadable_token_leaves_app_states_alone(self, monkeypatch):
        _run_as(monkeypatch, None)
        assert shared_utils._json_file_dacl(shared_utils.RESULT_FILE_PATH) is None


# ----- write_json_to_file ---------------------------------------------------

class _FakeNative:
    """Stands in for _write_new_file_with_dacl: creates the file new, as
    CREATE_NEW does, and records the DACL it was given."""

    def __init__(self, dacl_error=None):
        self.calls = []
        self.dacl_error = dacl_error

    def __call__(self, path, payload, dacl):
        with open(path, 'xb') as f:
            f.write(payload)
        self.calls.append((path, _described(dacl)))
        if self.dacl_error is not None:
            raise self.dacl_error


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    """Classify tmp_path's app_states.json and config.json as the real ones."""
    monkeypatch.setattr(
        shared_utils, '_CONSOLE_WRITABLE_JSON',
        os.path.normcase(str(tmp_path / 'app_states.json')),
    )
    monkeypatch.setattr(
        shared_utils, '_USER_EDITED_JSON',
        os.path.normcase(str(tmp_path / 'config.json')),
    )
    return tmp_path


@pytest.fixture
def native(monkeypatch):
    fake = _FakeNative()
    monkeypatch.setattr(shared_utils, '_write_new_file_with_dacl', fake)
    return fake


DATA = {'4242': {'id': 'proc-1', 'status': 'RUNNING'}}


class TestWriteJsonToFile:
    def test_system_sets_the_dacl_on_the_temp_before_the_rename(self, sandbox, native, monkeypatch):
        _run_as(monkeypatch, 'S-1-5-18')
        _console_user(monkeypatch, CONSOLE)
        target = sandbox / 'app_states.json'

        shared_utils.write_json_to_file(DATA, str(target))

        assert native.calls == [
            (str(target) + '.tmp', BASE + [(CONSOLE_STR, MODIFY, 0)]),
        ]
        assert json.loads(target.read_text()) == DATA
        assert not (sandbox / 'app_states.json.tmp').exists()

    def test_system_gives_other_json_users_read(self, sandbox, native, monkeypatch):
        _run_as(monkeypatch, 'S-1-5-18')
        calls = _console_user(monkeypatch, CONSOLE)
        target = sandbox / 'profile_hash.json'

        shared_utils.write_json_to_file(DATA, str(target))

        assert native.calls == [(str(target) + '.tmp', BASE)]
        assert calls == []
        assert json.loads(target.read_text()) == DATA

    def test_protected_write_has_the_plain_writers_bytes(self, sandbox, native, monkeypatch):
        _run_as(monkeypatch, CONSOLE_STR)
        plain = sandbox / 'plain.json'
        shared_utils.write_json_to_file(DATA, str(plain))
        assert native.calls == []

        _run_as(monkeypatch, 'S-1-5-18')
        protected = sandbox / 'protected.json'
        shared_utils.write_json_to_file(DATA, str(protected))

        assert len(native.calls) == 1
        assert protected.read_bytes() == plain.read_bytes()

    def test_a_planted_temp_is_removed_not_reused(self, sandbox, native, monkeypatch):
        # a reused file keeps its creator as owner, who can rewrite any dacl.
        _run_as(monkeypatch, 'S-1-5-18')
        _console_user(monkeypatch, CONSOLE)
        target = sandbox / 'app_states.json'
        (sandbox / 'app_states.json.tmp').write_text('planted')

        shared_utils.write_json_to_file(DATA, str(target))

        assert len(native.calls) == 1
        assert json.loads(target.read_text()) == DATA

    def test_dacl_failure_is_non_fatal_and_warned_once(self, sandbox, monkeypatch, caplog):
        _run_as(monkeypatch, 'S-1-5-18')
        _console_user(monkeypatch, CONSOLE)
        monkeypatch.setattr(
            shared_utils, '_write_new_file_with_dacl',
            _FakeNative(acl_hardening.AclApplyError('failed to apply DACL to x: denied')),
        )
        target = sandbox / 'app_states.json'

        with caplog.at_level(logging.DEBUG):
            shared_utils.write_json_to_file(DATA, str(target))
            shared_utils.write_json_to_file({'1': {}}, str(target))

        assert json.loads(target.read_text()) == {'1': {}}
        warned = [
            r for r in caplog.records
            if r.levelno == logging.WARNING and 'inherited permissions' in r.getMessage()
        ]
        assert len(warned) == 1

    def test_a_locked_temp_retries(self, sandbox, monkeypatch):
        _run_as(monkeypatch, 'S-1-5-18')
        fake = _FakeNative()
        attempts = []

        def flaky(path, payload, dacl):
            attempts.append(path)
            if len(attempts) == 1:
                raise PermissionError(13, 'sharing violation', path)
            fake(path, payload, dacl)

        monkeypatch.setattr(shared_utils, '_write_new_file_with_dacl', flaky)
        monkeypatch.setattr(shared_utils.time, 'sleep', lambda seconds: None)
        target = sandbox / 'profile_hash.json'

        shared_utils.write_json_to_file(DATA, str(target))

        assert len(attempts) == 2
        assert json.loads(target.read_text()) == DATA

    def test_user_process_writes_other_json_without_a_dacl(self, sandbox, native, monkeypatch):
        _run_as(monkeypatch, CONSOLE_STR)
        for name in ('config.json', 'profile_hash.json'):
            shared_utils.write_json_to_file(DATA, str(sandbox / name))
            assert json.loads((sandbox / name).read_text()) == DATA
        assert native.calls == []

    def test_system_writes_config_json_without_a_dacl(self, sandbox, native, monkeypatch):
        _run_as(monkeypatch, 'S-1-5-18')
        target = sandbox / 'config.json'

        shared_utils.write_json_to_file(DATA, str(target))

        assert native.calls == []
        assert json.loads(target.read_text()) == DATA

    def test_user_process_protects_app_states_for_itself(self, sandbox, native, monkeypatch):
        # owlette_scout rewrites app_states.json as the console user.
        _run_as(monkeypatch, CONSOLE_STR)
        target = sandbox / 'app_states.json'

        shared_utils.write_json_to_file(DATA, str(target))

        assert native.calls == [
            (str(target) + '.tmp', BASE + [(CONSOLE_STR, MODIFY, 0)]),
        ]
        assert json.loads(target.read_text()) == DATA


# ----- the native seam ------------------------------------------------------

class TestWriteNewFileWithDacl:
    def test_real_file_gets_a_protected_dacl(self, tmp_path):
        me = _REAL_PROCESS_USER_SID()
        path = str(tmp_path / 'probe.json')

        shared_utils._write_new_file_with_dacl(
            path, b'{}', [(ws.ConvertStringSidToSid(me), FULL, 0)],
        )

        with open(path, 'rb') as f:
            assert f.read() == b'{}'
        sd = ws.GetNamedSecurityInfo(path, ws.SE_FILE_OBJECT, ws.DACL_SECURITY_INFORMATION)
        control, _revision = sd.GetSecurityDescriptorControl()
        assert control & ws.SE_DACL_PROTECTED
        dacl = sd.GetSecurityDescriptorDacl()
        assert dacl.GetAceCount() == 1
        _header, mask, sid = dacl.GetAce(0)
        assert (mask, ws.ConvertSidToStringSid(sid)) == (FULL, me)

    def test_real_create_refuses_an_existing_file(self, tmp_path):
        path = tmp_path / 'probe.json'
        path.write_text('planted')

        with pytest.raises(FileExistsError):
            shared_utils._write_new_file_with_dacl(str(path), b'{}', [])

        assert path.read_text() == 'planted'

    def test_real_create_refuses_a_link_and_creates_nothing_at_its_target(self, tmp_path):
        me = _REAL_PROCESS_USER_SID()
        path = tmp_path / 'probe.json'
        target = tmp_path / 'elsewhere.json'
        try:
            os.symlink(target, path)
        except OSError:
            pytest.skip('this account cannot create symbolic links')

        with pytest.raises(FileExistsError):
            shared_utils._write_new_file_with_dacl(
                str(path), b'{}', [(ws.ConvertStringSidToSid(me), FULL, 0)],
            )

        assert not target.exists()
        assert os.path.islink(path)

    def test_sharing_violation_raises_permission_error(self, monkeypatch):
        def busy(*args):
            raise pywintypes.error(32, 'CreateFile', 'The file is in use.')

        monkeypatch.setattr(win32file, 'CreateFile', busy)
        with pytest.raises(PermissionError):
            shared_utils._write_new_file_with_dacl('unused.json.tmp', b'{}', [])


# ----- ensure_data_directories ----------------------------------------------

def _base_dirs():
    return [shared_utils.get_data_path()] + [
        shared_utils.get_data_path(name)
        for name in ('config', 'logs', 'cache', 'tmp', 'ipc')
    ]


class TestEnsureDataDirectories:
    @pytest.fixture
    def created(self, monkeypatch):
        made, private = [], []
        monkeypatch.setattr(
            shared_utils.os, 'makedirs',
            lambda path, exist_ok=False: made.append(path),
        )
        monkeypatch.setattr(
            acl_hardening, 'create_private_dir',
            lambda path, spec: private.append((path, spec)),
        )
        return made, private

    def test_system_creates_the_trio_fail_closed(self, created, monkeypatch):
        _run_as(monkeypatch, 'S-1-5-18')
        made, private = created

        assert shared_utils.ensure_data_directories() is True

        assert made == _base_dirs()
        assert [path for path, _ in private] == TRIO
        specs = {os.path.normcase(e.path): e.aces for e in acl_hardening.SPECS}
        for path, spec in private:
            assert spec is specs[os.path.normcase(path)]
            assert acl_hardening.CONSOLE_USER in [sid for sid, _, _ in spec]

    def test_user_session_skips_the_trio(self, created, monkeypatch):
        _run_as(monkeypatch, CONSOLE_STR)
        made, private = created

        assert shared_utils.ensure_data_directories() is True

        assert made == _base_dirs()
        assert private == []

    def test_untrusted_existing_dir_is_logged_and_the_rest_created(self, created, monkeypatch, caplog):
        _run_as(monkeypatch, 'S-1-5-18')
        made_private = []

        def create(path, spec):
            if path == shared_utils.CORTEX_IPC_CMD_DIR:
                raise acl_hardening.UntrustedDirectory(
                    f'refusing to use existing untrusted directory: {path}'
                )
            made_private.append(path)

        monkeypatch.setattr(acl_hardening, 'create_private_dir', create)

        with caplog.at_level(logging.WARNING):
            assert shared_utils.ensure_data_directories() is True

        assert made_private == TRIO[1:]
        assert any(
            r.levelno == logging.WARNING and 'untrusted' in r.getMessage()
            for r in caplog.records
        )

    def test_dacl_failure_is_logged_and_the_rest_created(self, created, monkeypatch, caplog):
        _run_as(monkeypatch, 'S-1-5-18')
        made_private = []

        def create(path, spec):
            if path == shared_utils.CORTEX_IPC_RESULT_DIR:
                raise acl_hardening.AclApplyError(f'failed to apply DACL to {path}: denied')
            made_private.append(path)

        monkeypatch.setattr(acl_hardening, 'create_private_dir', create)

        with caplog.at_level(logging.ERROR):
            assert shared_utils.ensure_data_directories() is True

        assert made_private == [TRIO[0], TRIO[2]]
        assert any(r.levelno == logging.ERROR for r in caplog.records)

    def test_base_failure_returns_false_before_the_trio(self, created, monkeypatch):
        _run_as(monkeypatch, 'S-1-5-18')
        _made, private = created

        def refuse(path, exist_ok=False):
            raise PermissionError(13, 'Access is denied', path)

        monkeypatch.setattr(shared_utils.os, 'makedirs', refuse)

        assert shared_utils.ensure_data_directories() is False
        assert private == []


# ----- initialize_logging ---------------------------------------------------

def test_directory_creation_logs_reach_the_log_file(tmp_path, monkeypatch):
    monkeypatch.setenv('PROGRAMDATA', str(tmp_path))
    monkeypatch.setattr(shared_utils, '_log_startup_banner', lambda level, path: None)
    monkeypatch.setattr(
        shared_utils, 'ensure_data_directories',
        lambda: logging.warning('directory probe'),
    )
    root = logging.getLogger()
    handlers, level = list(root.handlers), root.level
    try:
        shared_utils.initialize_logging('hardening_probe')
    finally:
        for handler in [h for h in root.handlers if h not in handlers]:
            root.removeHandler(handler)
            handler.close()
        root.setLevel(level)

    log_file = tmp_path / 'Owlette' / 'logs' / 'hardening_probe.log'
    assert 'directory probe' in log_file.read_text(encoding='utf-8')
