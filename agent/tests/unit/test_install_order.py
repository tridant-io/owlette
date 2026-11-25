"""install_software closes nothing until the installer is known to be good.

The order: download, checksum, install token, and only then the close, right
before the installer. A refusal on the way there leaves the show running, and
whatever the close shuts stays shut until the install ends.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import owlette_service
import shared_utils

NO_SESSION = ('Error: No interactive user session available for installation. '
              'A user must be logged in.')


def install(**fields):
    return {
        'type': 'install_software',
        'installer_url': 'https://example.invalid/app.exe',
        'installer_name': 'app.exe',
        'sha256_checksum': 'ab' * 32,
        'close_processes': ['TouchDesigner.exe'],
        'suppress_projects': ['proc-1'],
        'deployment_id': 'dep-1',
        **fields,
    }


class PhaseClient:
    """The progress phases the install writes, in order."""

    def __init__(self):
        self.phases = []

    def update_command_progress(self, cmd_id, status, deployment_id=None):
        self.phases.append(status)

    def is_connected(self):
        return False


@pytest.fixture
def rig(monkeypatch, tmp_path):
    """An install whose every step is recorded and can be made to fail."""
    utils = owlette_service.installer_utils
    rig = SimpleNamespace(
        steps=[], cleaned=[], locks_during_install=None, during_install=lambda: None,
        download=True, checksum=True, token=('token', {}), exit=(True, 0, ''))

    service = object.__new__(owlette_service.OwletteService)
    service.firebase_client = None
    service._command_rate_limits = {}
    service._command_router = SimpleNamespace(has_handler=lambda cmd_type: False)
    service.install_locks = {}
    service.active_installations = {}
    service.last_started = {}
    rig.service = service
    rig.run = lambda command: service.handle_firebase_command('cmd-1', command)

    def step(name, answer):
        def record(*args, **kwargs):
            rig.steps.append(name)
            return answer()
        return record

    def close(close_processes, suppress_projects, deployment_id, cmd_id, locked=None):
        rig.steps.append('close')
        for project_id in suppress_projects:
            service.install_locks[project_id] = deployment_id
            if locked is not None:
                locked.append(project_id)
        return list(suppress_projects)

    def execute_installer(*args, **kwargs):
        rig.steps.append('installer')
        rig.locks_during_install = dict(service.install_locks)
        rig.during_install()
        return rig.exit

    service._terminate_processes_for_install = close
    service._get_elevated_install_token = step('token', lambda: rig.token)
    monkeypatch.setattr(owlette_service, '_inside_active_hours', lambda: None)
    monkeypatch.setattr(utils, 'get_temp_installer_path', lambda name: str(tmp_path / name))
    monkeypatch.setattr(utils, 'download_file', lambda url, path, should_stop=None:
                        rig.steps.append('download') or (rig.download, path))
    monkeypatch.setattr(utils, 'verify_checksum', step('checksum', lambda: rig.checksum))
    monkeypatch.setattr(utils, 'hide_registry_keys', step('hide', lambda: [{'original': 'k', 'hidden': 'h'}]))
    monkeypatch.setattr(utils, 'restore_registry_keys', step('restore', lambda: None))
    monkeypatch.setattr(utils, 'execute_installer', execute_installer)
    monkeypatch.setattr(utils, 'cleanup_installer',
                        lambda path, force=False: rig.cleaned.append(path) or True)
    return rig


@pytest.fixture
def managed(rig, monkeypatch):
    """One managed entry with a running instance, shut by the real close."""
    entry = {'id': 'proc-1', 'name': 'show', 'exe_path': 'C:/apps/touchdesigner.exe',
             'launch_mode': 'always'}
    service = rig.service
    service.last_started = {'proc-1': {'pid': 4242}}
    service._terminate_processes_for_install = (
        owlette_service.OwletteService._terminate_processes_for_install.__get__(service))
    monkeypatch.setattr(shared_utils, 'read_config', lambda *args, **kwargs: {'processes': [entry]})
    monkeypatch.setattr(shared_utils, 'graceful_terminate', lambda pid, exe_path=None: True)
    monkeypatch.setattr(shared_utils, 'update_process_status_in_json', lambda *args, **kwargs: None)
    monkeypatch.setattr(owlette_service, '_identity_gate', lambda pid, entry_id: (True, None))
    monkeypatch.setattr(owlette_service, '_resolve_recorded_pid', lambda entry_id: None)
    monkeypatch.setattr(owlette_service.time, 'sleep', lambda seconds: None)
    return entry


# nothing is closed for an install that was never going to run

def test_a_failed_download_closes_nothing(rig):
    rig.download = False

    result = rig.run(install())

    assert result.startswith('Error: Failed to download installer')
    assert rig.steps == ['download']
    assert rig.service.install_locks == {}


def test_a_failed_download_names_the_link_without_its_query_string(rig):
    rig.download = False

    result = rig.run(install(installer_url='https://example.invalid/app.exe?key=abc123'))

    assert result == ('Error: Failed to download installer from '
                      'https://example.invalid/app.exe?<redacted>')


def test_a_checksum_mismatch_closes_nothing(rig):
    rig.checksum = False

    result = rig.run(install())

    assert result.startswith('Error: Checksum verification failed for app.exe')
    assert rig.steps == ['download', 'checksum']
    assert rig.service.install_locks == {}


def test_a_command_with_no_checksum_closes_nothing_and_downloads_nothing(rig):
    result = rig.run(install(sha256_checksum=None))

    assert result == ('Error: Refusing to install app.exe without sha256_checksum. '
                      'Re-issue the command with a checksum.')
    assert rig.steps == []
    assert rig.service.install_locks == {}


def test_no_user_session_closes_nothing(rig):
    rig.token = (None, None)

    result = rig.run(install())

    assert result == NO_SESSION
    assert rig.steps == ['download', 'checksum', 'token']
    assert rig.service.install_locks == {}


def test_the_close_comes_after_every_check_right_before_the_installer(rig):
    result = rig.run(install(parallel_install=True))

    assert result == 'Installation completed successfully (exit code 0)'
    # the registry hide stays wrapped around the installer alone, as it was
    assert rig.steps == ['download', 'checksum', 'token', 'close',
                         'hide', 'installer', 'restore']


def test_the_phases_read_downloading_closing_installing(rig, monkeypatch):
    """The names a fielded dashboard already shows, in the new order."""
    client = PhaseClient()
    rig.service.firebase_client = client
    monkeypatch.setattr(shared_utils, 'read_config', lambda *args, **kwargs: {'processes': []})
    # the real close: it is what writes closing_processes
    rig.service._terminate_processes_for_install = (
        owlette_service.OwletteService._terminate_processes_for_install.__get__(rig.service))

    rig.run(install(suppress_projects=[]))

    assert client.phases == ['downloading', 'closing_processes', 'installing']


# what the close shuts stays shut until the install ends, and no longer

def test_a_process_closed_by_name_stays_closed_until_the_install_ends(rig, managed):
    """A name in close_processes carries no project id, so the lock the close
    takes is all that keeps the monitor's next tick from relaunching the entry
    under the installer."""
    service = rig.service
    launches = []
    service.first_start = True
    service._find_running_process_by_exe = lambda exe_path, file_path: None
    service.handle_process_launch = lambda process, **kwargs: launches.append(process['id'])
    # the monitor's tick for this entry
    rig.during_install = lambda: service.handle_process(managed)

    rig.run(install(close_processes=['touchdesigner.exe'], suppress_projects=[]))

    assert rig.locks_during_install == {'proc-1': 'dep-1'}
    assert launches == []

    service.handle_process(managed)

    assert launches == ['proc-1']


@pytest.mark.parametrize('chosen', [
    {'suppress_projects': ['proc-1'], 'close_processes': []},
    {'suppress_projects': [], 'close_processes': ['touchdesigner.exe']},
], ids=['ticked', 'by name'])
def test_a_close_that_fails_part_way_releases_what_it_locked(rig, managed, monkeypatch, chosen):
    locks_at_the_failure = {}

    def gate(pid, entry_id):
        locks_at_the_failure.update(rig.service.install_locks)
        raise OSError('app_states.json could not be read')

    monkeypatch.setattr(owlette_service, '_identity_gate', gate)

    result = rig.run(install(**chosen))

    assert result == ('Error: executing command install_software: '
                      'app_states.json could not be read')
    assert locks_at_the_failure == {'proc-1': 'dep-1'}
    assert 'installer' not in rig.steps
    assert rig.service.install_locks == {}


def test_a_lock_dropped_while_the_monitor_looks_at_it_does_not_break_the_tick():
    """The slow worker drops a lock the moment its install ends, so the monitor
    reads it once: a test followed by a second read can find it gone."""
    class LocksTheWorkerDrops(dict):
        def __contains__(self, key):
            found = super().__contains__(key)
            self.pop(key, None)
            return found

    service = SimpleNamespace(
        install_locks=LocksTheWorkerDrops({'proc-1': 'dep-1'}),
        handle_process_launch=MagicMock())

    owlette_service.OwletteService.handle_process(service, {'id': 'proc-1', 'name': 'show'})

    service.handle_process_launch.assert_not_called()


# guards: these held before the order changed, and must keep holding

def test_the_locks_are_held_while_the_installer_runs_and_released_after(rig):
    rig.run(install())

    assert rig.locks_during_install == {'proc-1': 'dep-1'}
    assert rig.service.install_locks == {}


def test_a_failed_installer_releases_the_locks_and_removes_the_download(rig, tmp_path):
    rig.exit = (False, 1, 'Installer failed with exit code 1')

    result = rig.run(install())

    assert result == ('Error: Installation failed with exit code 1. '
                      'Installer failed with exit code 1')
    assert rig.service.install_locks == {}
    assert rig.cleaned == [str(tmp_path / 'app.exe')]
