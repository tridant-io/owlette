"""Task 3.2 wiring: the swoop streamer started through the desktop app, off Windows.

The POSIX twin of test_swoop_wiring.py, and it keeps that file's rule: nothing
here mocks the wiring it is testing. The SwoopManager is the real one over the
real swoop_spawn, which hands over to swoop_spawn_posix; the launch job goes
through the real osadapter.run_job into ``<data_root>/ipc/jobs``; the streamer
is a real child process (fake_streamer.py) whose stdin and stdout are the unix
socket the daemon bound; the ConnectionManager is the real one.

The desktop app is fake_runner.py on a thread. It plays the runner's transport
(desktop/src-tauri/src/jobrunner.rs) and none of its security rules.

What is replaced, and nothing else:

* the bundle fetch (``swoop_spawn.fetch_bundle``): there is no api here, so it
  answers a sentinel bundle that carries a host token;
* ``verify_install`` (``swoop_spawn_posix.verify_install``): the fake streamer
  is not root's and has no version to probe;
* what osadapter reads to decide the desktop app is running
  (``osadapter.posix._desktop_pid``, the app's tray.pid checked against the
  process name owlette-desktop): it answers this process's pid while the fake
  runner serves and None once it is stopped;
* the console user (``osadapter.console_user``): the streamer runs as the
  test's own user, the daemon admits only a peer that is the console user, and
  a CI runner may have nobody at the console.

The data root is a short link under /tmp to ``tmp_path``, as in
test_swoop_spawn_posix.py: a unix socket's path is limited to 104 bytes on
macOS and ``tmp_path`` there runs past it.
"""

import json
import os
import signal
import time
import uuid

import pytest

if os.name == 'nt':
    pytest.skip('the POSIX swoop wiring: a unix socket, the job seam and the desktop '
                'runner; test_swoop_wiring.py is the Windows twin', allow_module_level=True)

import pwd

import osadapter
import swoop_manager
import swoop_spawn
import swoop_spawn_posix
from connection_manager import ConnectionManager, ConnectionState
from osadapter import posix as osadapter_posix

from .fake_runner import FAKE_STREAMER, FakeRunner

BUNDLE_SENTINEL = 'BUNDLESENTINEL-POSIX-WIRING'
HOST_TOKEN = 'host-token-POSIX-WIRING-nevereverlogged-5521'


def wait_for(predicate, timeout=10.0):
    """Poll ``predicate``; the manager, the runner and the streamer are all on
    their own threads or processes."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def relayed(manager, seen, kind):
    """Whether the manager has relayed a ``kind`` event; collects them in ``seen``."""
    seen.extend(manager.drain_events())
    return any(event.get('type') == kind for event in seen)


def ended(manager):
    status = manager.status()
    return status['state'] == swoop_manager.STATE_IDLE and status['lastExit'] is not None


# ─── doubles ──────────────────────────────────────────────────────────────


class FakeFirebaseClient:
    """The surface SwoopManager reads, over a real ConnectionManager."""

    def __init__(self, connection_manager):
        self.connection_manager = connection_manager
        self.site_id = 'site-1'
        self.machine_id = 'machine-1'
        self.events = []

    def log_event(self, action, level, details=None, **kwargs):
        self.events.append((action, level, details))


def watched_connection_manager():
    """A real, CONNECTED ConnectionManager whose supervision entry points
    record instead of acting. Nothing swoop does may reach them."""
    cm = ConnectionManager()
    cm.report_success()  # CONNECTED without a network call
    calls = []

    def trap(name):
        def _trap(*args, **kwargs):
            calls.append(name)
        return _trap

    for name in ('register_thread', 'report_error', 'force_reconnect'):
        setattr(cm, name, trap(name))
    return cm, calls


@pytest.fixture
def data_root(tmp_path, monkeypatch):
    link = f'/tmp/ows-{uuid.uuid4().hex[:8]}'
    os.symlink(tmp_path, link)
    monkeypatch.setenv('OWLETTE_DATA_ROOT', link)
    # what the package lays down; the job seam makes its own directories.
    (tmp_path / 'ipc' / 'swoop').mkdir(parents=True)
    (tmp_path / 'logs' / 'swoop').mkdir(parents=True)
    try:
        yield link
    finally:
        os.unlink(link)


@pytest.fixture
def runner(data_root, monkeypatch):
    fake = FakeRunner(data_root)
    monkeypatch.setattr(osadapter_posix, '_desktop_pid', fake.pid)
    fake.start()
    yield fake
    fake.close()


@pytest.fixture
def wired(data_root, runner, monkeypatch):
    """A manager with the four replacements in place and the runner serving."""
    user = pwd.getpwuid(os.getuid()).pw_name
    monkeypatch.setattr(osadapter, 'console_user', lambda: user)
    monkeypatch.setattr(swoop_spawn_posix, 'verify_install',
                        lambda exe_path=None: str(FAKE_STREAMER))
    fetched = []

    def fetch_bundle(sid, site_id, machine_id, auth_manager):
        fetched.append(sid)
        return bytearray(json.dumps(
            {'sid': sid, 'sessionKey': BUNDLE_SENTINEL, 'hostToken': HOST_TOKEN}).encode())

    monkeypatch.setattr(swoop_spawn, 'fetch_bundle', fetch_bundle)

    cm, cm_calls = watched_connection_manager()
    client = FakeFirebaseClient(cm)
    manager = swoop_manager.SwoopManager(firebase_client=client)

    yield {'manager': manager, 'runner': runner, 'client': client, 'cm': cm,
           'cm_calls': cm_calls, 'fetched': fetched,
           'ipc': os.path.join(data_root, 'ipc', 'swoop')}

    # a session the test left running ends while the replacements still stand.
    manager.kill('teardown')
    wait_for(lambda: manager.status()['pid'] is None)


def start_session(manager, events):
    manager.ensure_streamer('sid-1')
    assert wait_for(lambda: relayed(manager, events, 'ready')), 'the streamer never said ready'


# ─── tests ────────────────────────────────────────────────────────────────


def test_a_request_reaches_ready_through_the_launch_job(wired):
    manager, runner = wired['manager'], wired['runner']

    start_session(manager, [])

    status = manager.status()
    assert status['state'] == swoop_manager.STATE_RUNNING
    assert status['sid'] == 'sid-1'
    assert wired['fetched'] == ['sid-1']
    # the process the manager holds is the one the app started for the job.
    [job] = runner.jobs
    assert job['type'] == 'launch' and job['program'] == 'owlette-swoop'
    assert status['pid'] == runner.children[0].pid


def test_kill_ends_it_with_exiting_and_books_a_clean_exit(wired):
    manager = wired['manager']
    events = []
    start_session(manager, events)

    # the one kill whose line carries its reason to the streamer.
    manager.kill(swoop_manager.KILL_SERVICE_STOP)

    assert wait_for(lambda: relayed(manager, events, 'exiting')), 'no exiting line'
    assert wait_for(lambda: ended(manager)), 'the kill never ended the session'
    assert manager.status()['lastExit'] == {'reason': 'service_stop', 'code': 0}
    assert wired['runner'].children[0].wait(10) == 0
    # the socket went at the accept, and the exit file with the session.
    assert os.listdir(wired['ipc']) == []


def test_a_streamer_that_dies_without_exiting_is_booked_from_the_exit_file(wired):
    manager = wired['manager']
    events = []
    start_session(manager, events)

    wired['runner'].children[0].kill()

    assert wait_for(lambda: ended(manager)), 'the crash was never booked'
    # with no exiting line and no exit file it would be internal_error (20);
    # this is what the runner recorded for the child SIGKILL ended.
    assert manager.status()['lastExit'] == {'reason': 'unknown', 'code': 128 + signal.SIGKILL}
    assert not relayed(manager, events, 'exiting')


def test_with_the_runner_stopped_the_spawn_is_refused_and_the_manager_is_idle(wired):
    manager, runner = wired['manager'], wired['runner']
    runner.stop()

    manager.ensure_streamer('sid-1')

    assert wait_for(lambda: manager.status()['lastRefusal'] is not None)
    status = manager.status()
    assert status['lastRefusal'] == swoop_spawn.REFUSAL_DESKTOP_NOT_RUNNING
    assert status['state'] == swoop_manager.STATE_IDLE
    assert status['sid'] is None and status['pid'] is None
    refusals = [details for action, _, details in wired['client'].events
                if action == 'swoop_spawn_refused']
    assert len(refusals) == 1 and refusals[0].startswith('reason=desktop_not_running')
    # refused before a job was written, and the socket it bound is gone.
    assert runner.jobs == []
    assert os.listdir(wired['ipc']) == []


def test_a_token_line_reaches_the_streamer(wired, monkeypatch):
    # the refresh is armed a lead ahead of the token's lifetime, so a lifetime
    # one second past the lead writes a token line a second into the session.
    monkeypatch.setattr(swoop_manager, 'TOKEN_TTL_DEFAULT_S',
                        swoop_manager.TOKEN_REFRESH_LEAD_S + 1)
    manager = wired['manager']
    events = []
    start_session(manager, events)

    assert wait_for(lambda: any(action == 'swoop_token_refreshed'
                                for action, _, _ in wired['client'].events)), \
        'no token line was written'
    # fake_streamer.py answers only a kill, so the token line shows itself by
    # the kill behind it: had it not arrived as a whole line of its own, the
    # kill would reach the streamer glued to it and go unanswered.
    manager.kill()

    assert wait_for(lambda: relayed(manager, events, 'exiting')), \
        'the kill behind the token went unanswered'
    assert wait_for(lambda: ended(manager))
    assert manager.status()['lastExit'] == {'reason': 'kill', 'code': 0}


def test_a_session_and_a_refusal_never_touch_connection_manager(wired):
    manager = wired['manager']
    start_session(manager, [])
    manager.kill()
    assert wait_for(lambda: ended(manager))
    wired['runner'].stop()
    manager.ensure_streamer('sid-2')
    assert wait_for(lambda: manager.status()['lastRefusal'] is not None)

    assert wired['cm_calls'] == [], f"swoop reached ConnectionManager: {wired['cm_calls']}"
    assert wired['cm'].state is ConnectionState.CONNECTED
