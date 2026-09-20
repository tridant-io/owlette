"""The self-update's two guards: what it will install, and what it blocks.

`update_owlette` carries MACHINE_EXEC_COMMAND, which the `cortex_autonomous`
and `talon_runner` system actors hold as well as an operator, and a three-OS
fleet means three artifact kinds behind one command. The family check is what
stops a correctly-checksummed `.pkg` from being handed to a Windows kiosk's
installer, and the pre-check is what stops a `.deb` this machine cannot satisfy
from being half-installed.

The second half is the lane: `update_owlette` shares the slow-command worker
with every install, uninstall and roost job, so the install must not run inside
the command callback.
"""

import os
import plistlib
import stat
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import pytest

import installer_utils
import shared_utils
from command_router import COMMAND_DEFERRED

posix_only = pytest.mark.skipif(sys.platform == 'win32', reason='posix file locks')

# One valid-looking artifact per family: the magic each one is identified by,
# padded past the size floor so the floor is never what refuses it here.
PAYLOADS = {
    'windows': b'MZ',
    'macos': b'xar!',
    'linux': b'!<arch>',
}
FAMILIES = tuple(PAYLOADS)


@pytest.fixture
def artifacts(tmp_path):
    """One payload file per family, each large enough to pass the size floor."""
    paths = {}
    for family, magic in PAYLOADS.items():
        path = tmp_path / f'owlette-update-{family}'
        path.write_bytes(magic + b'\0' * installer_utils.MIN_ARTIFACT_BYTES)
        paths[family] = str(path)
    return paths


# what the agent will install

@pytest.mark.parametrize('agent_family', FAMILIES)
@pytest.mark.parametrize('payload_family', FAMILIES)
def test_only_this_machines_own_artifact_is_accepted(
        artifacts, payload_family, agent_family):
    """Three accepted, six refused, decided before anything is executed."""
    path = artifacts[payload_family]

    if payload_family == agent_family:
        installer_utils.verify_artifact_family(path, agent_family)
        return

    with pytest.raises(ValueError) as refusal:
        installer_utils.verify_artifact_family(path, agent_family)
    assert agent_family in str(refusal.value)


def test_a_family_with_no_arm_is_refused_outright():
    """An artifact whose family the table does not know is not installable:
    there is nothing to recognise it by, so there is nothing to accept."""
    with pytest.raises(ValueError, match='No installer format is known'):
        installer_utils.verify_artifact_family(__file__, 'plan9')


def test_removing_the_family_arm_stops_the_match(artifacts, monkeypatch):
    # Negative control for the table itself: with the linux arm gone, the
    # agent's own .deb no longer verifies at all. The arm is what identifies an
    # artifact — remove it and every one of the assertions above changes.
    monkeypatch.delitem(installer_utils.ARTIFACT_MAGIC, 'linux')

    with pytest.raises(ValueError):
        installer_utils.verify_artifact_family(artifacts['linux'], 'linux')


def test_the_size_floor_refuses_before_the_magic_is_read(tmp_path):
    """A two-byte file that starts with the right magic is still not an
    installer — an error page or a redirect body reaches the disk the same
    way a download does."""
    stub = tmp_path / 'owlette-Update.exe'
    stub.write_bytes(b'MZ')

    with pytest.raises(ValueError, match='too small'):
        installer_utils.verify_artifact_family(str(stub), 'windows')


# what the agent hands the package to

class FakeRun:
    """A recorded subprocess result."""

    def __init__(self, returncode=0, stdout='', stderr=''):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


@pytest.fixture
def commands(monkeypatch):
    """Record every command the handoff issues and script their results.

    The dpkg lock is answered here too: it is a property of the machine
    running the suite, and a CI runner three minutes into its own unattended
    upgrade would otherwise defer every one of these.
    """
    issued = []
    results = {}

    def fake_run(command, timeout_seconds):
        issued.append(list(command))
        for key, result in results.items():
            if key in command:
                return result
        return FakeRun()

    monkeypatch.setattr(installer_utils, '_run_update_command', fake_run)
    monkeypatch.setattr(installer_utils, '_dpkg_frontend_lock_held', lambda: False)
    return SimpleNamespace(issued=issued, results=results)


def test_apt_resolves_the_package_before_anything_is_installed(commands):
    started, detail = installer_utils.start_self_update('/tmp/owlette.deb', 'linux')

    assert started, detail
    # Negative control against `dpkg -i`, which resolves no dependencies: an
    # implementation that shelled it would run neither of these commands.
    assert commands.issued[0] == [
        'apt-get', 'install', '--simulate', '/tmp/owlette.deb']
    handoff = commands.issued[1]
    assert handoff[0] == 'systemd-run'
    assert f'--unit={installer_utils.UPDATE_UNIT_NAME}' in handoff
    assert '--collect' in handoff
    assert '--setenv=DEBIAN_FRONTEND=noninteractive' in handoff
    assert handoff[-4:] == ['install', '-y', '--allow-downgrades', '/tmp/owlette.deb']
    assert 'dpkg' not in handoff


def test_an_unsatisfiable_package_leaves_this_version_running(commands):
    commands.results['--simulate'] = FakeRun(
        returncode=100,
        stdout='The following packages have unmet dependencies:\n libva2\n',
        stderr='E: Unable to correct problems, you have held broken packages.',
    )

    started, detail = installer_utils.start_self_update('/tmp/owlette.deb', 'linux')

    assert not started
    assert detail.startswith('update_unsatisfiable:')
    assert 'libva2' in detail
    # Nothing was installed: the only command issued was the simulation.
    assert [command[0] for command in commands.issued] == ['apt-get']


def test_a_held_dpkg_lock_is_a_deferred_failure_not_a_broken_package(
        commands, monkeypatch):
    monkeypatch.setattr(installer_utils, '_dpkg_frontend_lock_held', lambda: True)

    started, detail = installer_utils.start_self_update('/tmp/owlette.deb', 'linux')

    assert not started
    # The distinction is the whole point: an unsatisfiable package needs a new
    # build, a held lock needs the same command again in a minute.
    assert detail.startswith('update_deferred:')
    # THE negative control for reading the lock off apt rather than probing
    # for it: `--simulate` takes no lock and exits 0 with one held, so an
    # implementation waiting for apt to complain runs both commands and
    # reports the update as started.
    assert commands.issued == []


@posix_only
def test_the_lock_probe_sees_the_kind_of_lock_apt_takes(tmp_path, monkeypatch):
    """apt's frontend lock is a POSIX record lock, and only a record lock
    contends with one. Held from a second process because these locks are
    per-process: a probe run here would be granted the lock it is asking
    about."""
    lock = tmp_path / 'lock-frontend'
    lock.write_bytes(b'')
    monkeypatch.setattr(installer_utils, '_DPKG_FRONTEND_LOCK', str(lock))

    assert installer_utils._dpkg_frontend_lock_held() is False

    holder = subprocess.Popen(
        [sys.executable, '-c',
         'import fcntl, os, sys\n'
         'fd = os.open(sys.argv[1], os.O_RDWR)\n'
         'fcntl.lockf(fd, fcntl.LOCK_EX)\n'
         'print("held", flush=True)\n'
         'sys.stdin.readline()\n',
         str(lock)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    with holder:
        try:
            assert holder.stdout.readline().strip() == 'held'
            assert installer_utils._dpkg_frontend_lock_held() is True
        finally:
            holder.stdin.close()

    assert installer_utils._dpkg_frontend_lock_held() is False


@posix_only
def test_a_missing_lock_file_is_not_a_held_lock(tmp_path, monkeypatch):
    """Nothing to contend with is not the same as contention: a machine with
    no dpkg at all must not defer every update forever."""
    monkeypatch.setattr(
        installer_utils, '_DPKG_FRONTEND_LOCK', str(tmp_path / 'absent'))

    assert installer_utils._dpkg_frontend_lock_held() is False


def test_an_interrupted_dpkg_is_configured_and_retried(commands, monkeypatch):
    attempts = []

    def fake_run(command, timeout_seconds):
        attempts.append(list(command))
        if '--simulate' in command and len(attempts) == 1:
            return FakeRun(
                returncode=100,
                stderr="E: dpkg was interrupted, you must manually run "
                       "'dpkg --configure -a' to correct the problem.",
            )
        return FakeRun()

    monkeypatch.setattr(installer_utils, '_run_update_command', fake_run)

    started, detail = installer_utils.start_self_update('/tmp/owlette.deb', 'linux')

    assert started, detail
    assert attempts[1] == ['dpkg', '--configure', '-a']
    assert attempts[2] == ['apt-get', 'install', '--simulate', '/tmp/owlette.deb']
    assert attempts[3][0] == 'systemd-run'


def test_a_refused_handoff_is_not_reported_as_an_update(commands):
    commands.results['systemd-run'] = FakeRun(
        returncode=1, stderr='Failed to start transient service unit.')

    started, detail = installer_utils.start_self_update('/tmp/owlette.deb', 'linux')

    assert not started
    assert detail.startswith('update_handoff_failed:')


@pytest.fixture
def launchd(monkeypatch):
    """launchctl as the macOS handoff meets it: the update job's state as
    `print` reports it, and the plist each bootstrap was handed, read while
    the file still exists."""
    record = SimpleNamespace(issued=[], jobs=[], state=None, bootstrap=FakeRun())

    def fake_run(command, timeout_seconds):
        record.issued.append(list(command))
        if command[1] == 'print':
            if record.state is None:
                return FakeRun(returncode=113)
            return FakeRun(stdout=f'system/app.owlette.update = {{\n\tstate = {record.state}\n}}\n')
        if command[1] == 'bootstrap':
            with open(command[3], 'rb') as f:
                record.jobs.append((command[3], plistlib.load(f)))
            return record.bootstrap
        return FakeRun()

    monkeypatch.setattr(installer_utils, '_run_update_command', fake_run)
    return record


def test_macos_runs_the_installer_as_a_launchd_job_that_runs_once(launchd):
    """Never `launchctl submit`: measured on macOS 26.6, a submitted command
    that exited 0 was scheduled to run again ten seconds later — an installer
    reinstalling the package, and restarting the agent, every ten seconds."""
    started, detail = installer_utils.start_self_update('/tmp/owlette.pkg', 'macos')

    assert started, detail
    assert [command[:3] for command in launchd.issued] == [
        ['launchctl', 'print', 'system/app.owlette.update'],
        ['launchctl', 'bootstrap', 'system'],
    ]
    path, job = launchd.jobs[0]
    assert job['Label'] == installer_utils.UPDATE_JOB_LABEL
    assert job['ProgramArguments'] == [
        '/usr/sbin/installer', '-pkg', '/tmp/owlette.pkg', '-target', '/']
    assert job['RunAtLoad'] is True
    assert job['KeepAlive'] is False
    assert job['StandardOutPath'] == shared_utils.get_data_path('logs/update_installer.log')
    # launchd read the plist at bootstrap; nothing of it is left behind.
    assert not os.path.exists(path)
    assert not any('submit' in command for command in launchd.issued)


def test_a_finished_update_job_is_booted_out_before_the_next(launchd):
    """The job stays loaded once the installer has exited, and a bootstrap
    under a label launchd still holds is refused."""
    launchd.state = 'not running'

    started, detail = installer_utils.start_self_update('/tmp/owlette.pkg', 'macos')

    assert started, detail
    assert [command[1] for command in launchd.issued] == ['print', 'bootout', 'bootstrap']
    assert launchd.issued[1] == ['launchctl', 'bootout', 'system/app.owlette.update']


def test_an_update_still_installing_defers_the_next(launchd):
    """Negative control for the bootout above: a bootout of a running job
    ends it, and an installer ended mid-install is a half-installed agent."""
    launchd.state = 'running'

    started, detail = installer_utils.start_self_update('/tmp/owlette.pkg', 'macos')

    assert not started
    assert detail.startswith('update_deferred:')
    assert [command[1] for command in launchd.issued] == ['print']


def test_a_refused_bootstrap_is_not_reported_as_an_update(launchd):
    launchd.bootstrap = FakeRun(returncode=5, stderr='Bootstrap failed: 5: Input/output error')

    started, detail = installer_utils.start_self_update('/tmp/owlette.pkg', 'macos')

    assert not started
    assert detail.startswith('update_handoff_failed:')


def test_there_is_no_posix_update_path_for_windows():
    with pytest.raises(ValueError, match='No POSIX self-update path'):
        installer_utils.start_self_update('/tmp/owlette.exe', 'windows')


# what the command callback is allowed to wait for

class _FakeFirebase:
    """The command lane, as much of it as the update path touches: progress on
    the way through, and exactly one terminal write at the end."""

    def __init__(self):
        self.progress = []
        self.finished = []

    def update_command_progress(self, cmd_id, status, deployment_id=None):
        self.progress.append((cmd_id, status))

    def finish_command(self, cmd_id, cmd_data, result):
        self.finished.append((cmd_id, result))


@pytest.fixture
def update_service(tmp_path, monkeypatch):
    """A service double running the real command dispatch and update body."""
    from owlette_service import OwletteService

    monkeypatch.setenv('OWLETTE_DATA_ROOT', str(tmp_path / 'Owlette'))
    # ensure_data_directories() has built the tree by the time a command can
    # arrive; the update marker is written into logs/ without creating it.
    (tmp_path / 'Owlette' / 'logs').mkdir(parents=True)
    monkeypatch.setattr(
        shared_utils, 'get_os_family_arch', lambda: ('linux', 'x64'))

    svc = SimpleNamespace(
        firebase_client=_FakeFirebase(),
        _command_rate_limits={},
        COMMAND_RATE_LIMIT_SECONDS=OwletteService.COMMAND_RATE_LIMIT_SECONDS,
        _command_router=SimpleNamespace(has_handler=lambda cmd_type: False),
    )
    for name in (
        'handle_firebase_command',
        '_handle_update_owlette',
        '_update_already_in_progress',
        '_write_update_marker',
        '_self_update_worker',
        '_run_self_update',
        '_check_update_disk_space',
        '_update_staging_dir',
        '_clear_update_marker',
        '_start_posix_update',
    ):
        setattr(svc, name, getattr(OwletteService, name).__get__(svc, OwletteService))
    return svc


def _settled(update_service, timeout=10):
    """Wait for the worker thread to write its terminal status."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if update_service.firebase_client.finished:
            return update_service.firebase_client.finished[-1]
        time.sleep(0.05)
    raise AssertionError('the self-update worker never reported a result')


def test_the_command_callback_does_not_wait_for_the_install(
        update_service, tmp_path, monkeypatch):
    """The lane, not the loop: update_owlette queues behind every other install
    and roost command on one worker, so an apt-get that waits on a lock for a
    minute would hold all of them. The callback returns on acceptance.
    """
    downloading = threading.Event()
    release = threading.Event()
    handed_off = []

    def slow_download(url, dest_path, **kwargs):
        downloading.set()
        assert release.wait(30), 'the test never released the download'
        with open(dest_path, 'wb') as f:
            f.write(PAYLOADS['linux'] + b'\0' * installer_utils.MIN_ARTIFACT_BYTES)
        return True, dest_path

    monkeypatch.setattr(installer_utils, 'download_file', slow_download)
    monkeypatch.setattr(
        installer_utils, 'verify_checksum', lambda path, expected: True)
    monkeypatch.setattr(
        installer_utils, 'start_self_update',
        lambda path, family: (handed_off.append((path, family)), (True, 'handed off'))[1])

    started = time.monotonic()
    result = update_service.handle_firebase_command('cmd-1', {
        'type': 'update_owlette',
        'installer_url': 'https://example.invalid/owlette-v9.9.9.deb',
        'checksum_sha256': 'f' * 64,
        'target_version': '9.9.9',
    })
    elapsed = time.monotonic() - started

    try:
        # THE negative control. Run the install inside the callback - as the
        # Windows arm does, where Task Scheduler is what returns immediately -
        # and this is the assertion that fails.
        assert elapsed < 2, f'the callback blocked for {elapsed:.1f}s'
        # Not a result: the lane must not write a terminal status for a
        # command whose work has not happened yet, or the worker's own
        # progress writes land on top of it.
        assert result is COMMAND_DEFERRED
        assert downloading.wait(5), 'the worker never started the download'
    finally:
        release.set()

    cmd_id, reported = _settled(update_service)
    assert handed_off == [
        (str(tmp_path / 'Owlette' / 'cache' / 'update' / 'owlette-update.deb'),
         'linux')]
    assert (cmd_id, reported) == ('cmd-1', 'Self-update initiated: handed off')
    # The order the dashboard reads: every progress write before the one
    # terminal write, never after it.
    assert [status for _, status in update_service.firebase_client.progress] == [
        'downloading', 'installing']


@pytest.mark.skipif(sys.platform == 'win32', reason='the POSIX mode table')
def test_the_artifact_is_staged_where_only_root_can_write(update_service):
    """Verified by name, then installed by name, as root - so whoever can write
    the staging directory owns the window in between. `tmp/`, where the artifact
    used to land, is 0770 root:<group> by decision 4's table so the desktop app
    can use it, and write on a directory is also the right to rename it aside.
    """
    from osadapter import posix

    staging = update_service._update_staging_dir()

    assert stat.S_IMODE(os.stat(staging).st_mode) == 0o700
    parent = os.path.relpath(
        os.path.dirname(staging), shared_utils.get_data_path())
    assert posix._DIRECTORY_MODES[parent] & 0o022 == 0
    # THE negative control: the directory it was staged in before, which the
    # same table opens to the group.
    assert posix._DIRECTORY_MODES['tmp'] & 0o020


def test_a_refused_handoff_clears_the_marker_it_wrote(
        update_service, tmp_path, monkeypatch):
    """A refusal leaves this version running, so the in-progress marker has to
    go: kept, it would report a failed update on the next start and block the
    retry the refusal is asking for."""
    monkeypatch.setattr(
        installer_utils, 'download_file',
        lambda url, dest_path, **kwargs: (
            open(dest_path, 'wb').write(
                PAYLOADS['linux'] + b'\0' * installer_utils.MIN_ARTIFACT_BYTES),
            (True, dest_path))[1])
    monkeypatch.setattr(
        installer_utils, 'verify_checksum', lambda path, expected: True)
    monkeypatch.setattr(
        installer_utils, 'start_self_update',
        lambda path, family: (False, 'update_unsatisfiable: libva2 is missing'))

    result = update_service._run_self_update(
        'cmd-1', {'installer_url': 'https://example.invalid/a.deb',
                  'checksum_sha256': 'f' * 64}, '9.9.9', 'linux')

    assert result == 'Error: update_unsatisfiable: libva2 is missing'
    assert not (tmp_path / 'Owlette' / 'logs' / 'update_in_progress.json').exists()


def test_the_worker_reports_what_the_lane_can_no_longer_see(
        update_service, tmp_path, monkeypatch):
    """The command was accepted and the lane moved on, so a refusal reached
    afterwards is the worker's to report - as this command's terminal status,
    not as a log line nobody off the machine reads."""
    monkeypatch.setattr(
        installer_utils, 'download_file',
        lambda url, dest_path, **kwargs: (
            open(dest_path, 'wb').write(
                PAYLOADS['linux'] + b'\0' * installer_utils.MIN_ARTIFACT_BYTES),
            (True, dest_path))[1])
    monkeypatch.setattr(
        installer_utils, 'verify_checksum', lambda path, expected: False)

    update_service._self_update_worker(
        'cmd-1', {'installer_url': 'https://example.invalid/a.deb',
                  'checksum_sha256': 'f' * 64}, '9.9.9', 'linux')

    cmd_id, result = update_service.firebase_client.finished[-1]
    assert cmd_id == 'cmd-1'
    # THE negative control on the prefix. The catch-all answered "Error
    # initiating update: ..." - which does not start with "Error:" - and the
    # worker read a tampered artifact as a completed update.
    assert result.startswith('Error:')
    assert 'Checksum verification FAILED' in result
    assert not (tmp_path / 'Owlette' / 'logs' / 'update_in_progress.json').exists()


def test_a_duplicate_update_command_is_refused_while_the_first_downloads(
        update_service, monkeypatch):
    """The window the guard has to cover. Off Windows the lane is free again
    the moment the first command is accepted, so the second one arrives while
    the first is still downloading - into the same file."""
    downloading = threading.Event()
    release = threading.Event()
    downloads = []

    def blocking_download(url, dest_path, **kwargs):
        downloads.append(dest_path)
        downloading.set()
        assert release.wait(30), 'the test never released the download'
        with open(dest_path, 'wb') as f:
            f.write(PAYLOADS['linux'] + b'\0' * installer_utils.MIN_ARTIFACT_BYTES)
        return True, dest_path

    monkeypatch.setattr(installer_utils, 'download_file', blocking_download)
    monkeypatch.setattr(
        installer_utils, 'verify_checksum', lambda path, expected: True)
    monkeypatch.setattr(
        installer_utils, 'start_self_update', lambda path, family: (True, 'handed off'))

    command = {
        'type': 'update_owlette',
        'installer_url': 'https://example.invalid/owlette-v9.9.9.deb',
        'checksum_sha256': 'f' * 64,
        'target_version': '9.9.9',
    }
    try:
        assert update_service.handle_firebase_command('cmd-1', command) is COMMAND_DEFERRED
        assert downloading.wait(5), 'the worker never started the download'
        # The per-type throttle would answer this one two seconds in, and a
        # re-issued fleet deployment or an operator retry arrives minutes
        # later; cleared so the guard under test is the one that answers.
        update_service._command_rate_limits.clear()
        refusal = update_service.handle_firebase_command('cmd-2', command)
    finally:
        release.set()

    _settled(update_service)
    # THE negative control. With the marker written after the download - where
    # it was - the second command passes the guard and a second worker writes
    # the same file underneath the first.
    assert refusal.startswith('Update already in progress')
    assert len(downloads) == 1
