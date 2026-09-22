"""Self-update staging hardening (agent 3.3.6), on the split self-update.

The Windows arm of _run_self_update downloads the installer into
update-staging\\, which the service creates fail-closed and only SYSTEM and
Administrators can write; the rename-on-lock fallback is off for that download;
the SHA-256 is read through a handle that shares read access only, still held
after the schtasks calls; the scheduled task runs the fixed staging path; and
the update marker is created new, with a protected DACL - once before the
download, so the guard brackets the whole operation, and again once the hold is
in place. The POSIX arm keeps its own staging directory and calls no Windows
helper.

No security descriptor is written (acl_hardening.apply and shared_utils'
_write_new_file_with_dacl are recorders, owners come from a mocked
_native_read_owner), schtasks and Popen are recorders and the download is
faked, so nothing touches the live install or Task Scheduler. The staged file is
real, in tmp_path, and the hold is the real CreateFile: while it is held, another
open for writing must fail.
"""

import hashlib
import json
import os
import shutil
from types import SimpleNamespace
from unittest.mock import MagicMock

import _winapi
import pytest
import win32file
import win32security as ws

import installer_utils
import osadapter


_SYSTEM = 'S-1-5-18'
_ADMINS = 'S-1-5-32-544'
_USERS = 'S-1-5-32-545'
_OTHER_USER = 'S-1-5-21-111-222-333-1002'

_FULL = 0x1F01FF
_READ = 0x120089
_INHERIT = 0x3

# passes the service's 1 MB size check and its MZ check.
_PAYLOAD = b'MZ' + b'\0' * 1_000_000
_SHA256 = hashlib.sha256(_PAYLOAD).hexdigest()

_OK = 'Self-update initiated via Task Scheduler'
_COMMAND = {
    'installer_url': 'https://example.invalid/Owlette-Installer-v9.9.9.exe',
    'checksum_sha256': _SHA256,
    'deployment_id': 'deploy-1',
}


def _described(spec):
    return [(ws.ConvertSidToStringSid(sid), mask, flags) for sid, mask, flags in spec]


def _owned_by(monkeypatch, sid_str):
    """Every path reads as owned by sid_str. is_trusted_owner's link checks
    still run on the real files."""
    import acl_hardening
    monkeypatch.setattr(acl_hardening, '_native_read_owner',
                        lambda path: ws.ConvertStringSidToSid(sid_str))


def _writable(path):
    """True when another open of path for writing succeeds right now, None when
    there is no file there yet."""
    try:
        with open(path, 'r+b'):
            return True
    except PermissionError:
        return False
    except FileNotFoundError:
        return None


def _service():
    """An OwletteService with only the state the update path reads (what
    _init_state declares for it); nothing else is constructed."""
    from owlette_service import OwletteService
    svc = object.__new__(OwletteService)
    svc.firebase_client = None
    svc._update_image_handle = None
    return svc


# ----- installer_utils ------------------------------------------------------

def test_a_locked_download_target_raises_instead_of_being_renamed(tmp_path, monkeypatch):
    path = tmp_path / 'owlette-Update.exe'
    path.write_bytes(b'MZ from an earlier attempt')
    get = MagicMock()
    monkeypatch.setattr(installer_utils.requests, 'get', get)

    with open(path, 'rb'):  # any open handle keeps the file from being deleted
        with pytest.raises(PermissionError):
            installer_utils.download_file(
                'https://example.invalid/Owlette-Installer.exe', str(path), strict_path=True)

    get.assert_not_called()
    assert [p.name for p in tmp_path.iterdir()] == ['owlette-Update.exe']


class TestOpenVerified:
    @pytest.fixture
    def staged(self, tmp_path):
        path = tmp_path / 'owlette-Update.exe'
        path.write_bytes(_PAYLOAD)
        return path

    def test_the_hash_is_read_through_the_returned_handle(self, staged, monkeypatch):
        reads = []
        real_read = win32file.ReadFile

        def spy(handle, size):
            result = real_read(handle, size)
            reads.append((int(handle), len(result[1])))
            return result

        monkeypatch.setattr(win32file, 'ReadFile', spy)

        handle = installer_utils.open_verified(str(staged), _SHA256.upper())
        try:
            assert handle is not None
            assert {h for h, _ in reads} == {int(handle)}
            assert sum(n for _, n in reads) == len(_PAYLOAD)
        finally:
            handle.Close()

    def test_while_held_it_can_be_read_but_not_changed_moved_or_deleted(self, staged, tmp_path):
        other = tmp_path / 'other.exe'
        other.write_bytes(b'MZ other')

        handle = installer_utils.open_verified(str(staged), _SHA256)
        try:
            # the scheduled installer opens it read-only, as this does.
            with open(staged, 'rb') as f:
                assert f.read(2) == b'MZ'
            assert not _writable(staged)
            with pytest.raises(PermissionError):
                os.remove(staged)
            with pytest.raises(PermissionError):
                os.rename(staged, tmp_path / 'moved.exe')
            with pytest.raises(PermissionError):
                os.replace(other, staged)
        finally:
            handle.Close()

        assert staged.read_bytes() == _PAYLOAD
        assert _writable(staged)

    def test_a_mismatch_or_a_missing_file_returns_none_and_holds_nothing(self, staged, tmp_path):
        assert installer_utils.open_verified(str(staged), 'b' * 64) is None
        assert _writable(staged)
        assert installer_utils.open_verified(str(tmp_path / 'absent.exe'), _SHA256) is None


# ----- update_owlette -------------------------------------------------------

@pytest.fixture
def update(tmp_path, monkeypatch):
    """_handle_update_owlette on the Windows arm, in a sandboxed data root, with
    the DACL writes, the download, schtasks and Popen replaced by recorders."""
    import acl_hardening
    import owlette_service
    import shared_utils

    root = tmp_path / 'Owlette'
    monkeypatch.setenv(osadapter.DATA_ROOT_ENV, str(root))
    (root / 'logs').mkdir(parents=True)
    staging = root / 'update-staging'
    assert shared_utils.get_data_path('update-staging') == str(staging)
    installer = str(staging / 'owlette-Update.exe')

    state = SimpleNamespace(
        root=root, staging=staging, installer=installer,
        marker=root / 'logs' / 'update_in_progress.json',
        events=[], applied=[], downloads=[], markers=[], runs=[])

    monkeypatch.setattr(shutil, 'disk_usage', lambda path: SimpleNamespace(free=10 * 1024 ** 3))
    monkeypatch.setattr(acl_hardening, 'console_user_sid', lambda: None)

    def record_apply(path, spec):
        state.events.append('staging dacl')
        state.applied.append((path, _described(spec)))

    monkeypatch.setattr(acl_hardening, 'apply', record_apply)
    # in production the service creates the staging directory and the marker.
    _owned_by(monkeypatch, _SYSTEM)

    def fake_download(url, dest_path, **kwargs):
        state.events.append('download')
        state.downloads.append((dest_path, kwargs))
        with open(dest_path, 'wb') as f:
            f.write(_PAYLOAD)
        return True, dest_path

    monkeypatch.setattr(owlette_service.installer_utils, 'download_file', fake_download)
    monkeypatch.setattr(owlette_service.installer_utils, 'verify_checksum',
                        MagicMock(side_effect=AssertionError('a second, shared open')))

    def fake_create_new(path, payload, dacl):
        """CREATE_NEW, as the real seam does, without the DACL write."""
        with open(path, 'xb') as f:
            f.write(payload)
        state.events.append('marker')
        state.markers.append((path, _described(dacl), _writable(installer)))

    monkeypatch.setattr(shared_utils, '_write_new_file_with_dacl', fake_create_new)

    def fake_run(cmd, **kwargs):
        state.runs.append((cmd, _writable(installer)))
        return SimpleNamespace(returncode=0, stdout='', stderr='')

    monkeypatch.setattr(owlette_service.subprocess, 'run', fake_run)
    monkeypatch.setattr(owlette_service.subprocess, 'Popen', MagicMock())

    svc = _service()
    state.svc = svc
    state.run = lambda sha256=_SHA256: svc._handle_update_owlette(
        'cmd-1', {**_COMMAND, 'checksum_sha256': sha256})
    yield state
    if svc._update_image_handle is not None:
        svc._update_image_handle.Close()


def _stale_marker(update, **fields):
    update.marker.write_text(json.dumps({'started_at': '2000-01-01 00:00:00', **fields}))


class TestStagingDirectory:
    def test_the_installer_is_staged_in_a_directory_created_fail_closed(self, update):
        assert update.run() == _OK

        assert update.staging.is_dir()
        assert update.applied == [
            (str(update.staging), [(_SYSTEM, _FULL, _INHERIT), (_ADMINS, _FULL, _INHERIT)])]
        [(path, kwargs)] = update.downloads
        assert path == update.installer
        assert kwargs['strict_path'] is True
        # the guard's marker brackets the whole operation; the second names the
        # verified installer.
        assert update.events == ['marker', 'staging dacl', 'download', 'marker']
        # nothing is staged in the user-writable tmp\ or the posix cache\.
        assert not (update.root / 'tmp').exists()
        assert not (update.root / 'cache').exists()

    def test_a_directory_another_account_owns_aborts_before_the_download_and_marker(
            self, update, monkeypatch):
        update.staging.mkdir()
        _owned_by(monkeypatch, _OTHER_USER)

        result = update.run()

        assert result.startswith('Error:')
        assert 'untrusted directory' in result
        assert update.events == ['marker']
        assert not update.marker.exists()
        assert update.runs == []

    def test_a_planted_junction_is_refused_even_when_it_reads_as_system_owned(
            self, update, tmp_path):
        target = tmp_path / 'elsewhere'
        target.mkdir()
        _winapi.CreateJunction(str(target), str(update.staging))
        try:
            result = update.run()
        finally:
            os.rmdir(update.staging)  # removes the junction, not its target

        assert 'untrusted directory' in result
        assert update.events == ['marker']
        assert list(target.iterdir()) == []
        assert not update.marker.exists()
        assert update.runs == []

    def test_the_posix_arm_keeps_its_own_staging_and_calls_no_windows_helper(
            self, update, monkeypatch):
        import acl_hardening
        import shared_utils

        def never(*args, **kwargs):
            raise AssertionError('create_private_dir is the windows arm')

        monkeypatch.setattr(acl_hardening, 'create_private_dir', never)

        staging = update.svc._update_staging_dir('linux')

        assert staging == shared_utils.get_data_path('cache/update')
        assert os.path.isdir(staging)
        assert update.applied == []
        assert not update.staging.exists()


class TestHeldImage:
    def test_the_task_runs_the_fixed_staging_path_while_the_hold_is_kept(self, update):
        assert update.run() == _OK

        create = next(cmd for cmd, _ in update.runs
                      if cmd[:2] == ['schtasks', '/Create'] and cmd[3].startswith('OwletteUpdate_'))
        assert create[create.index('/TR') + 1].startswith(f'"{update.installer}" /VERYSILENT ')
        # held through every schtasks call and after them: the task starts the
        # installer after /Run has returned.
        assert len(update.runs) == 4
        assert not any(writable for _, writable in update.runs)
        assert int(update.svc._update_image_handle) != 0
        assert not _writable(update.installer)

    def test_a_second_attempt_releases_the_first_hold_before_downloading(self, update):
        assert update.run() == _OK
        first = update.svc._update_image_handle
        # the first installer never took over.
        _stale_marker(update)

        # the fake download rewrites the file, which the first hold would refuse.
        assert update.run() == _OK

        assert int(first) == 0
        assert int(update.svc._update_image_handle) != 0
        assert not _writable(update.installer)

    def test_a_checksum_mismatch_holds_marks_and_runs_nothing(self, update):
        result = update.run(sha256='b' * 64)

        assert 'Checksum verification FAILED' in result
        assert not os.path.exists(update.installer)
        assert update.svc._update_image_handle is None
        # only the guard's marker was written, and the failure cleared it.
        assert len(update.markers) == 1
        assert not update.marker.exists()
        assert update.runs == []


class TestUpdateMarker:
    def test_it_is_created_new_with_a_protected_dacl_once_the_image_is_held(self, update):
        assert update.run() == _OK

        [(_, _, before_download), (path, dacl, installer_writable)] = update.markers
        assert before_download is None
        assert os.path.normcase(path) == os.path.normcase(str(update.marker))
        # users keep read: the desktop app reads the marker.
        assert dacl == [(_SYSTEM, _FULL, 0), (_ADMINS, _FULL, 0), (_USERS, _READ, 0)]
        assert installer_writable is False
        marker = json.loads(update.marker.read_text())
        assert marker['installer_path'] == update.installer
        assert marker['command_id'] == 'cmd-1'

    def test_a_stale_marker_of_ours_is_replaced_not_reused(self, update):
        _stale_marker(update, command_id='an-earlier-command')

        assert update.run() == _OK

        assert len(update.markers) == 2
        assert json.loads(update.marker.read_text())['command_id'] == 'cmd-1'

    def test_a_file_planted_between_the_remove_and_the_create_fails_the_update(
            self, update, monkeypatch):
        import owlette_service
        _stale_marker(update)
        real_remove = os.remove

        def remove_then_plant(path):
            real_remove(path)
            if os.path.normcase(str(path)) == os.path.normcase(str(update.marker)):
                update.marker.write_text('planted by another account')

        monkeypatch.setattr(owlette_service.os, 'remove', remove_then_plant)

        result = update.run()

        assert result.startswith('Error:')
        assert 'update_in_progress.json' in result
        assert update.events == []
        assert not update.staging.exists()
        assert update.runs == []
