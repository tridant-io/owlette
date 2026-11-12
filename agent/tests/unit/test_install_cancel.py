"""A cancel_installation stops the install it names at any point before its
installer launches: while it waits on the slow lane, during its download, or
while its processes are being closed. An installer that has launched is left
to finish. A cancel that names nothing the agent holds stops nothing, then or
later.

Both lanes are real here: FirebaseClient's dispatch, slow worker and terminal
write, and OwletteService's install and cancel arms. The slow worker runs
inline, and a cancel arrives from inside the step it interrupts, the way the
fast lane's thread runs beside the worker.
"""

import queue
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import installer_utils
import owlette_service

INSTALLED = 'Installation completed successfully (exit code 0)'


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


def cancel_command(**fields):
    return {'type': 'cancel_installation', 'installer_name': 'app.exe',
            'deployment_id': 'dep-1', **fields}


class DrainingQueue(queue.Queue):
    """The slow queue; it stops the worker loop when it runs dry, so a test can
    run the loop inline."""

    def __init__(self, client):
        super().__init__()
        self.client = client

    def get(self, block=True, timeout=None):
        if self.empty():
            self.client.running = False
            raise queue.Empty
        return super().get(block=False)


class InlineThread:
    """The fast lane's thread, run where it is started."""

    def __init__(self, target, args=(), **kwargs):
        self.start = lambda: target(*args)


@pytest.fixture(autouse=True)
def _no_held_installs():
    """The held-install registry is process-global: empty around each test."""
    installer_utils._held_installs.clear()
    yield
    installer_utils._held_installs.clear()


def make_lanes(monkeypatch, slow_queue):
    """A client's two command lanes, with nothing behind them, over a service."""
    # imported here, like the other lane tests: see test_cancel_sync_fastlane
    import firebase_client
    from firebase_client import FirebaseClient

    client = SimpleNamespace(
        logger=MagicMock(), running=False,
        _FAST_COMMAND_TYPES=FirebaseClient._FAST_COMMAND_TYPES,
        _cancelled_commands=set(), _slow_command_queue=slow_queue,
        _mark_command_running=MagicMock(), _mark_command_completed=MagicMock(),
        _mark_command_failed=MagicMock(), _mark_command_cancelled=MagicMock(),
        _upload_metrics=MagicMock(), log_event=MagicMock(),
        update_command_progress=MagicMock(), is_connected=lambda: False,
    )
    for name in ('_process_command', '_execute_command', 'finish_command',
                 '_slow_command_worker_loop'):
        setattr(client, name, getattr(FirebaseClient, name).__get__(client, FirebaseClient))
    monkeypatch.setattr(firebase_client.shared_utils, 'get_system_metrics', lambda: {})

    service = object.__new__(owlette_service.OwletteService)
    service.firebase_client = client
    service._command_rate_limits = {}
    service.COMMAND_RATE_LIMIT_SECONDS = 0
    service._command_router = SimpleNamespace(has_handler=lambda cmd_type: False)
    service.install_locks = {}
    service.active_installations = {}
    service.last_started = {}
    client.command_callback = service.handle_firebase_command
    monkeypatch.setattr(owlette_service, '_inside_active_hours', lambda: None)
    return client, service


@pytest.fixture
def lanes(monkeypatch, tmp_path):
    """Both lanes over a service whose install steps are recorded. `on[step]`
    runs once when that step is reached."""
    import firebase_client

    utils = owlette_service.installer_utils
    lanes = SimpleNamespace(steps=[], cleaned=[], on={}, download_ok=True, checksum_ok=True)
    client, service = make_lanes(monkeypatch, slow_queue=None)
    client._slow_command_queue = DrainingQueue(client)
    monkeypatch.setattr(firebase_client.threading, 'Thread', InlineThread)

    def reach(name):
        lanes.steps.append(name)
        lanes.on.pop(name, lambda: None)()

    def download(url, path, should_stop=None):
        reach('download')
        if should_stop is not None and should_stop():
            return False, ''
        return (True, path) if lanes.download_ok else (False, '')

    def close(close_processes, suppress_projects, deployment_id, cmd_id, locked=None):
        for project_id in suppress_projects:
            service.install_locks[project_id] = deployment_id
            if locked is not None:
                locked.append(project_id)
        reach('close')
        return list(suppress_projects)

    service._terminate_processes_for_install = close
    service._get_elevated_install_token = lambda: reach('token') or ('token', {})
    monkeypatch.setattr(utils, 'get_temp_installer_path', lambda name: str(tmp_path / name))
    monkeypatch.setattr(utils, 'download_file', download)
    monkeypatch.setattr(utils, 'verify_checksum',
                        lambda path, expected: reach('checksum') or lanes.checksum_ok)
    monkeypatch.setattr(utils, 'hide_registry_keys', lambda name: reach('hide') or [])
    monkeypatch.setattr(utils, 'execute_installer',
                        lambda *args, **kwargs: reach('installer') or (True, 0, ''))
    monkeypatch.setattr(utils, 'cleanup_installer',
                        lambda path, force=False: lanes.cleaned.append(path) or True)

    def work():
        client.running = True
        client._slow_command_worker_loop()

    lanes.client, lanes.service = client, service
    lanes.queue, lanes.work = client._process_command, work
    lanes.cancel = lambda cmd_id='cancel-1', **fields: client._process_command(
        cmd_id, cancel_command(**fields))
    return lanes


def cancelled(client, cmd_id='inst-1', deployment_id='dep-1'):
    """Whether an install's terminal record is `cancelled`."""
    record = ((cmd_id, 'cancelled by user', deployment_id, 'install_software'),)
    return record in client._mark_command_cancelled.call_args_list


def site_log(client):
    return [call.args for call in client.log_event.call_args_list]


# the lane

def test_cancel_installation_runs_on_the_fast_lane(lanes):
    lanes.queue('inst-1', install())

    lanes.cancel()

    # answered now, not behind the install it is meant to stop
    lanes.client._mark_command_cancelled.assert_called_once_with(
        'cancel-1', 'Installation cancelled: app.exe', 'dep-1', 'cancel_installation')
    assert lanes.client._slow_command_queue.qsize() == 1


def test_an_install_is_held_from_the_queue_to_its_end(lanes):
    lanes.queue('inst-1', install())
    assert list(installer_utils._held_installs) == ['inst-1']

    lanes.work()

    assert lanes.steps[-1] == 'installer'
    assert installer_utils._held_installs == {}


def test_an_install_the_queue_refuses_is_not_held(lanes):
    lanes.client._slow_command_queue = MagicMock()
    lanes.client._slow_command_queue.put_nowait.side_effect = queue.Full

    lanes.queue('inst-1', install())

    lanes.client._mark_command_failed.assert_called_once()
    assert installer_utils._held_installs == {}


def test_two_cancels_inside_five_seconds_both_land(lanes):
    lanes.service.COMMAND_RATE_LIMIT_SECONDS = 5
    lanes.queue('inst-1', install())
    lanes.queue('inst-2', install(deployment_id='dep-2'))

    lanes.cancel('cancel-1')
    lanes.cancel('cancel-2', deployment_id='dep-2')

    assert installer_utils.cancel_requested('inst-1')
    assert installer_utils.cancel_requested('inst-2')


# where the cancel finds the install

def test_a_cancel_while_queued_stops_the_install_before_it_starts(lanes):
    lanes.queue('inst-1', install())
    lanes.cancel()

    lanes.work()

    assert lanes.steps == []
    # the install never wrote a running marker: the one marker is the cancel's own
    lanes.client._mark_command_running.assert_called_once_with(
        'cancel-1', 'dep-1', 'cancel_installation')
    assert cancelled(lanes.client)
    assert site_log(lanes.client) == [(
        'deployment_cancelled', 'warning', 'app.exe',
        'Deployment dep-1 cancelled: Error: Installation cancelled before it started')]
    assert installer_utils._held_installs == {}


def test_a_cancel_during_the_download_stops_the_download(lanes, tmp_path):
    lanes.on['download'] = lanes.cancel
    lanes.queue('inst-1', install())

    lanes.work()

    # no checksum, no session check, nothing closed, nothing installed
    assert lanes.steps == ['download']
    assert lanes.service.install_locks == {}
    assert lanes.cleaned == [str(tmp_path / 'app.exe')]
    assert cancelled(lanes.client)
    lanes.client._mark_command_failed.assert_not_called()
    assert site_log(lanes.client) == [(
        'deployment_cancelled', 'warning', 'app.exe',
        'Deployment dep-1 cancelled: Error: Installation cancelled during the download')]


def test_a_cancel_after_the_download_closes_nothing(lanes, tmp_path):
    lanes.on['checksum'] = lanes.cancel
    lanes.queue('inst-1', install())

    lanes.work()

    assert lanes.steps == ['download', 'checksum', 'token']
    assert lanes.service.install_locks == {}
    assert lanes.cleaned == [str(tmp_path / 'app.exe')]
    assert cancelled(lanes.client)
    assert site_log(lanes.client) == [(
        'deployment_cancelled', 'warning', 'app.exe',
        'Deployment dep-1 cancelled: Error: Installation cancelled before anything was closed')]


def test_a_cancel_during_the_close_stops_before_the_installer(lanes, tmp_path):
    lanes.on['close'] = lanes.cancel
    lanes.queue('inst-1', install(parallel_install=True))

    lanes.work()

    # no registry hide and no installer
    assert lanes.steps == ['download', 'checksum', 'token', 'close']
    # released, so the monitor relaunches what was closed
    assert lanes.service.install_locks == {}
    assert lanes.cleaned == [str(tmp_path / 'app.exe')]
    assert cancelled(lanes.client)
    assert site_log(lanes.client) == [(
        'deployment_cancelled', 'warning', 'app.exe',
        'Deployment dep-1 cancelled: Error: Installation cancelled before the installer ran')]


@pytest.mark.parametrize('moment', ['hide', 'installer'])
def test_a_cancel_once_the_installer_is_launching_leaves_it_to_finish(lanes, moment):
    """`hide` is the step between the last look and the launch: the installer
    is already claimed there, so a cancel must not be recorded as one."""
    lanes.on[moment] = lanes.cancel
    lanes.queue('inst-1', install(parallel_install=True))

    lanes.work()

    assert lanes.steps[-1] == 'installer'
    lanes.client._mark_command_cancelled.assert_called_once_with(
        'cancel-1', 'Cancellation failed: app.exe is already installing and will finish',
        'dep-1', 'cancel_installation')
    lanes.client._mark_command_completed.assert_called_once_with(
        'inst-1', INSTALLED, 'dep-1', 'install_software')
    assert site_log(lanes.client) == [(
        'deployment_completed', 'info', 'app.exe', f'Deployment dep-1: {INSTALLED}')]


def test_an_install_cancelled_during_the_hash_that_fails_its_checksum_is_failed(lanes):
    """The record follows what the install did: it stopped on its checksum,
    not for the cancel."""
    lanes.checksum_ok = False
    lanes.on['checksum'] = lanes.cancel
    lanes.queue('inst-1', install())

    lanes.work()

    error = 'Error: Checksum verification failed for app.exe. Installation aborted for security.'
    lanes.client._mark_command_failed.assert_called_once_with(
        'inst-1', error, 'dep-1', 'install_software')
    assert not cancelled(lanes.client)
    assert site_log(lanes.client) == [(
        'deployment_failed', 'error', 'app.exe', f'Deployment dep-1 failed: {error}')]


@pytest.mark.parametrize('download_ok', [False, True], ids=['failed', 'completed'])
def test_a_cancel_after_the_install_has_reported_finds_nothing_held(lanes, download_ok):
    """The hold ends where the terminal status is decided, so a cancel that
    lands after it is not answered as if the install were still there."""
    lanes.download_ok = download_ok
    reported = []

    def after_the_terminal_write(metrics):
        if not reported:
            reported.append(True)
            lanes.cancel()

    lanes.client._upload_metrics.side_effect = after_the_terminal_write
    lanes.queue('inst-1', install())

    lanes.work()

    lanes.client._mark_command_cancelled.assert_called_once_with(
        'cancel-1', 'Cancellation failed: No active installation found for app.exe',
        'dep-1', 'cancel_installation')


# which install a cancel names

def test_a_cancel_that_matches_nothing_leaves_the_next_install_alone(lanes):
    lanes.cancel()

    # its own answer is `cancelled` whatever happened, as it always was
    lanes.client._mark_command_cancelled.assert_called_once_with(
        'cancel-1', 'Cancellation failed: No active installation found for app.exe',
        'dep-1', 'cancel_installation')
    assert installer_utils._held_installs == {}

    # the same deployment, retried
    lanes.queue('inst-2', install())
    lanes.work()

    assert lanes.steps[-1] == 'installer'
    lanes.client._mark_command_completed.assert_called_once_with(
        'inst-2', INSTALLED, 'dep-1', 'install_software')


def test_a_cancel_stops_only_the_install_of_its_own_deployment(lanes):
    # two deployments of one installer: dep-1 is installing, dep-2 waits behind it
    lanes.on['installer'] = lambda: lanes.cancel(deployment_id='dep-2')
    lanes.queue('inst-1', install())
    lanes.queue('inst-2', install(deployment_id='dep-2'))

    lanes.work()

    assert lanes.steps.count('installer') == 1
    lanes.client._mark_command_completed.assert_called_once_with(
        'inst-1', INSTALLED, 'dep-1', 'install_software')
    assert cancelled(lanes.client, 'inst-2', 'dep-2')


def test_a_cancelled_install_does_not_get_the_one_behind_it_refused(lanes):
    """With the five-second limit in force: the cancelled install ends at once,
    and the one queued behind it must still run, not be refused as rate limited."""
    lanes.service.COMMAND_RATE_LIMIT_SECONDS = 5
    lanes.on['download'] = lanes.cancel
    lanes.queue('inst-1', install())
    lanes.queue('inst-2', install(deployment_id='dep-2'))

    lanes.work()

    assert cancelled(lanes.client)
    lanes.client._mark_command_failed.assert_not_called()
    lanes.client._mark_command_completed.assert_called_once_with(
        'inst-2', INSTALLED, 'dep-2', 'install_software')


def test_a_cancel_with_no_deployment_id_goes_by_installer_name(lanes):
    lanes.queue('inst-1', install())
    lanes.queue('inst-2', install(installer_name='other.exe', deployment_id='dep-2'))

    lanes.cancel(deployment_id=None)
    lanes.work()

    assert cancelled(lanes.client)
    lanes.client._mark_command_completed.assert_called_once_with(
        'inst-2', INSTALLED, 'dep-2', 'install_software')


def test_a_cancel_whose_deployment_has_no_installer_name_still_finds_it(lanes):
    lanes.queue('inst-1', install())

    lanes.cancel(installer_name='')

    assert installer_utils.cancel_requested('inst-1')


def test_a_cancel_that_names_nothing_is_refused(lanes):
    lanes.queue('inst-1', install())

    lanes.cancel(installer_name='', deployment_id=None)

    lanes.client._mark_command_cancelled.assert_called_once_with(
        'cancel-1', 'Error: No deployment id or installer name provided for cancellation',
        None, 'cancel_installation')
    assert not installer_utils.cancel_requested('inst-1')


# what a failed download leaves on record

def test_a_failed_download_is_recorded_without_the_links_query_string(lanes):
    lanes.download_ok = False
    lanes.queue('inst-1', install(installer_url='https://example.invalid/app.exe?key=abc123'))

    lanes.work()

    error = ('Error: Failed to download installer from '
             'https://example.invalid/app.exe?<redacted>')
    lanes.client._mark_command_failed.assert_called_once_with(
        'inst-1', error, 'dep-1', 'install_software')
    assert site_log(lanes.client) == [(
        'deployment_failed', 'error', 'app.exe', f'Deployment dep-1 failed: {error}')]


# both lanes on threads of their own

def test_on_real_threads_a_cancel_stops_a_download_in_flight(monkeypatch, tmp_path):
    """Nothing inline, and the real download loop: the slow worker's thread is
    between two chunks when the cancel arrives on a thread of its own."""
    utils = owlette_service.installer_utils
    target = tmp_path / 'app.exe'
    first_chunk_written, cancel_answered = threading.Event(), threading.Event()
    reached = []

    class SlowQueue(queue.Queue):
        def get(self, block=True, timeout=None):
            return super().get(timeout=0.05)

    class Response:
        headers = {}

        def raise_for_status(self):
            pass

        def close(self):
            pass

        def iter_content(self, chunk_size):
            yield b'x' * 1024
            first_chunk_written.set()
            cancel_answered.wait(30)
            # bounded: a download nothing stops still ends
            for _ in range(50):
                yield b'x' * 1024

    client, service = make_lanes(monkeypatch, SlowQueue())
    client.running = True
    client._mark_command_cancelled.side_effect = (
        lambda cmd_id, *rest: cancel_answered.set() if cmd_id == 'cancel-1' else None)
    service._get_elevated_install_token = lambda: reached.append('token') or ('token', {})
    service._terminate_processes_for_install = lambda *args: reached.append('close')
    monkeypatch.setattr(utils, 'get_temp_installer_path', lambda name: str(target))
    monkeypatch.setattr(utils.requests, 'get', lambda *args, **kwargs: Response())
    monkeypatch.setattr(utils, 'verify_checksum',
                        lambda path, expected: reached.append('checksum') or True)
    monkeypatch.setattr(utils, 'execute_installer',
                        lambda *args, **kwargs: reached.append('installer') or (True, 0, ''))

    def wait_for(condition):
        deadline = time.monotonic() + 30
        while not condition() and time.monotonic() < deadline:
            time.sleep(0.02)
        return condition()

    worker = threading.Thread(target=client._slow_command_worker_loop)
    worker.start()
    try:
        client._process_command('inst-1', install())
        assert first_chunk_written.wait(30)
        client._process_command('cancel-1', cancel_command())
        ended = wait_for(lambda: not installer_utils._held_installs)
    finally:
        client.running = False
        cancel_answered.set()
        worker.join(timeout=30)

    assert ended
    assert reached == []
    assert cancelled(client)
    client._mark_command_failed.assert_not_called()
    assert site_log(client) == [(
        'deployment_cancelled', 'warning', 'app.exe',
        'Deployment dep-1 cancelled: Error: Installation cancelled during the download')]
    assert not target.exists()
    assert service.install_locks == {}
