"""Unit tests for the swoop POSIX spawn helper.

The desktop app is played by a fake ``run_job``: on a thread it does what the
runner does -- connects to the job's socket, starts a stand-in streamer with
stdin and stdout on that connection, drops its own copy -- and answers with the
stand-in's pid. Everything else is real: the socket and its mode, the peer's
credentials, the psutil pin, the exit file and the sweep.

The data root is a short link under /tmp to ``tmp_path``: a unix socket's path
is limited to 104 bytes on macOS and ``tmp_path`` there runs past it. The link
is the only thing the tests remove themselves, by its exact path.
"""

import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import threading
import uuid

import psutil
import pytest

import osadapter
import shared_utils
import swoop_spawn
import swoop_spawn_posix

pytestmark = pytest.mark.skipif(
    os.name == 'nt',
    reason='the POSIX spawn: unix sockets, peer credentials and the job seam',
)

BUNDLE_SECRET = 'BUNDLESENTINEL-POSIX-0451'

# the stand-in streamer: reads the bundle, reports its digest, echoes control
# lines, answers kill the way the streamer does, and dies silently on request.
FAKE_STREAMER = r'''
import hashlib, json, sys

def say(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()

bundle = sys.stdin.buffer.readline()
say({'type': 'ready', 'sha256': hashlib.sha256(bundle).hexdigest()})
for raw in sys.stdin.buffer:
    msg = json.loads(raw)
    if msg['type'] == 'kill':
        say({'type': 'exiting', 'code': 0, 'reason': 'kill'})
        sys.exit(0)
    if msg['type'] == 'die':
        sys.exit(msg['code'])
    say({'type': 'echo', 'line': msg})
'''


class FakeRunner:
    """The desktop app's runner, for ``launch`` jobs.

    ``result`` replaces the answer outright, the way ``run_job`` answers when
    the app is down or refuses the job.
    """

    def __init__(self, results_dir, result=None):
        self.results_dir = results_dir
        self.result = result
        self.jobs = []
        self.socket_stat = None
        self.output_dir = None
        self.child = None

    def __call__(self, job):
        self.jobs.append(job)
        if self.result is not None:
            return self.result
        thread = threading.Thread(target=self._launch, args=(job,))
        thread.start()
        thread.join(10)
        # run_job hands the caller a result directory to remove.
        self.output_dir = self.results_dir / uuid.uuid4().hex
        self.output_dir.mkdir(parents=True)
        (self.output_dir / 'result.json').write_text(json.dumps({'pid': self.child.pid}))
        return {'pid': self.child.pid, 'outputDir': str(self.output_dir)}

    def _launch(self, job):
        self.socket_stat = os.lstat(job['socket'])
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            conn.connect(job['socket'])
            self.child = subprocess.Popen(
                [sys.executable, '-c', FAKE_STREAMER], stdin=conn, stdout=conn,
            )
        finally:
            conn.close()

    def reap(self):
        if self.child is not None and self.child.poll() is None:
            self.child.kill()
        if self.child is not None:
            self.child.wait(10)


class StalePin:
    """What psutil answers for a pin whose pid now names a process with another
    create time: ``is_running()`` is its pid-plus-create-time identity check."""

    def __init__(self, pid):
        self.pid = pid
        self.kills = 0

    def is_running(self):
        return False

    def status(self):
        return psutil.STATUS_RUNNING

    def kill(self):
        self.kills += 1


@pytest.fixture
def data_root(tmp_path, monkeypatch):
    link = f'/tmp/ows-{uuid.uuid4().hex[:8]}'
    os.symlink(tmp_path, link)
    monkeypatch.setenv('OWLETTE_DATA_ROOT', link)
    (tmp_path / 'ipc' / 'swoop').mkdir(parents=True)
    (tmp_path / 'logs' / 'swoop').mkdir(parents=True)
    try:
        yield tmp_path
    finally:
        os.unlink(link)


@pytest.fixture
def console(monkeypatch):
    """The test's own user is the one at the console."""
    import pwd

    name = pwd.getpwuid(os.getuid()).pw_name
    monkeypatch.setattr(osadapter, 'console_user', lambda: name)
    monkeypatch.setattr(swoop_spawn, '_configured_log_level', lambda: 'debug')


@pytest.fixture
def runner(data_root, console, monkeypatch):
    fake = FakeRunner(data_root / 'ipc' / 'results')
    monkeypatch.setattr(osadapter, 'run_job', fake)
    yield fake
    fake.reap()


@pytest.fixture
def launched(runner):
    proc = swoop_spawn_posix.spawn('/unused', sid='sid-1')
    yield proc
    proc.close()


def bundle():
    return bytearray(json.dumps({'sid': 'sid-1', 'sessionKey': BUNDLE_SECRET}).encode())


def drain(proc):
    return [json.loads(line) for line in proc.iter_lines()]


class TestSpawn:
    def test_the_job_is_the_contracts_launch_request(self, runner, launched):
        job = runner.jobs[0]
        ipc = os.path.join(os.environ['OWLETTE_DATA_ROOT'], 'ipc', 'swoop')
        spawn_id = os.path.basename(job['socket'])[:-len('.sock')]

        assert re.fullmatch(r'[0-9a-f]{32}', spawn_id)
        assert job == {
            'type': 'launch',
            'trusted': True,
            'program': 'owlette-swoop',
            'args': ['run'],
            'socket': os.path.join(ipc, f'{spawn_id}.sock'),
            'stderr': os.path.join(os.environ['OWLETTE_DATA_ROOT'], 'logs', 'swoop',
                                   'owlette-swoop.err.log'),
            'exit_file': os.path.join(ipc, f'{spawn_id}.exit.json'),
            'env': {'OWLETTE_SWOOP_LOG': 'debug'},
            'timeout_s': 10,
        }
        assert spawn_id != 'sid-1'

    def test_the_socket_is_the_groups_and_gone_after_the_accept(self, runner, data_root,
                                                                 launched):
        mode = runner.socket_stat.st_mode
        assert oct(mode & 0o777) == oct(0o660)
        assert runner.socket_stat.st_gid == os.lstat(data_root / 'ipc' / 'swoop').st_gid
        assert not os.path.lexists(runner.jobs[0]['socket'])
        # and the result directory run_job leaves to its caller is removed.
        assert not runner.output_dir.exists()

    def test_the_bundle_arrives_whole_and_the_buffer_is_wiped(self, launched):
        buf = bundle()
        expected = hashlib.sha256(bytes(buf) + b'\n').hexdigest()

        launched.write_bundle(buf)

        assert buf == bytearray(len(buf))
        ready = json.loads(next(launched.iter_lines()))
        assert ready == {'type': 'ready', 'sha256': expected}

    def test_a_control_line_round_trips(self, runner, launched):
        launched.write_bundle(bundle())
        lines = launched.iter_lines()
        next(lines)

        line = {'type': 'token', 'host_token': 'host-token-2'}
        launched.write_line(line)

        assert json.loads(next(lines)) == {'type': 'echo', 'line': line}
        assert launched.wait(0.1) is None, 'the streamer is still running'
        launched.close()
        # close ends a streamer that is still the process it launched.
        assert runner.child.wait(10) == -9

    def test_nothing_read_or_written_reaches_a_log_record(self, launched, caplog):
        caplog.set_level('DEBUG')
        launched.write_bundle(bundle())
        launched.write_line({'type': 'kill'})
        lines = drain(launched)

        assert lines[-1]['type'] == 'exiting'
        assert BUNDLE_SECRET not in caplog.text
        assert 'sha256' not in caplog.text


class TestRefusals:
    def test_desktop_not_running_is_its_own_refusal(self, data_root, console, monkeypatch):
        fake = FakeRunner(data_root, result={
            'error': 'desktop_not_running', 'job': 'launch',
            'message': 'the desktop app did not run this job: the desktop app is not running',
        })
        monkeypatch.setattr(osadapter, 'run_job', fake)

        with pytest.raises(swoop_spawn.SwoopSpawnError) as exc:
            swoop_spawn_posix.spawn('/unused')

        assert exc.value.reason == swoop_spawn.REFUSAL_DESKTOP_NOT_RUNNING
        assert not os.path.lexists(fake.jobs[0]['socket'])

    def test_any_other_runner_error_is_a_failed_spawn_naming_its_code(self, data_root,
                                                                      console, monkeypatch):
        fake = FakeRunner(data_root, result={'error': 'socket_rejected', 'message': 'x'})
        monkeypatch.setattr(osadapter, 'run_job', fake)

        with pytest.raises(swoop_spawn.SwoopSpawnError) as exc:
            swoop_spawn_posix.spawn('/unused')

        assert exc.value.reason == swoop_spawn.REFUSAL_SPAWN_FAILED
        assert 'socket_rejected' in str(exc.value)

    def test_a_peer_of_another_uid_is_refused(self, runner, monkeypatch):
        monkeypatch.setattr(swoop_spawn_posix, '_console_uid', lambda: os.getuid() + 1)

        with pytest.raises(swoop_spawn.SwoopSpawnError) as exc:
            swoop_spawn_posix.spawn('/unused')

        assert exc.value.reason == swoop_spawn.REFUSAL_SPAWN_FAILED
        assert not os.path.lexists(runner.jobs[0]['socket'])
        # its connection was dropped, so the stand-in reads end of file and ends.
        runner.child.wait(10)


class TestExitCode:
    def test_the_exiting_code_wins_over_a_missing_exit_file(self, launched):
        launched.write_bundle(bundle())
        launched.write_line({'type': 'kill'})
        assert drain(launched)[-1] == {'type': 'exiting', 'code': 0, 'reason': 'kill'}

        assert launched.wait(10) == 0

    def test_the_exit_file_is_the_fallback(self, runner, launched):
        launched.write_bundle(bundle())
        launched.write_line({'type': 'die', 'code': 3})
        drain(launched)
        # the app's waiter thread records the child's end.
        exit_file = runner.jobs[0]['exit_file']
        with open(exit_file, 'w') as f:
            json.dump({'pid': launched.pid, 'code': 3}, f)

        assert launched.wait(10) == 3
        launched.close()
        assert not os.path.lexists(exit_file)

    def test_gone_with_neither_is_an_internal_error(self, launched, monkeypatch):
        monkeypatch.setattr(swoop_spawn_posix, 'EXIT_FILE_WAIT_S', 0.2)
        launched.write_bundle(bundle())
        launched.write_line({'type': 'die', 'code': 7})
        drain(launched)

        assert launched.wait(10) == swoop_spawn.EXIT_INTERNAL == 20


class TestClose:
    def test_close_does_not_signal_a_pid_whose_create_time_differs(self, data_root):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
        ours, theirs = socket.socketpair()
        ipc = data_root / 'ipc' / 'swoop'
        socket_path, exit_path, other = ipc / 'a.sock', ipc / 'a.exit.json', ipc / 'b.sock'
        for path in (socket_path, exit_path, other):
            path.write_text('x')
        pin = StalePin(child.pid)
        proc = swoop_spawn_posix.PosixSwoopProcess(
            child.pid, pin, ours, str(socket_path), str(exit_path))
        try:
            proc.close()

            assert pin.kills == 0
            assert child.poll() is None
            assert theirs.recv(1) == b''
            assert not socket_path.exists() and not exit_path.exists()
            assert other.exists()
        finally:
            theirs.close()
            child.kill()
            child.wait(10)


class TestVerifyInstall:
    @pytest.fixture
    def bundle_layout(self, tmp_path, monkeypatch):
        app = tmp_path / 'owlette.app'
        exe = app / 'Contents' / 'MacOS' / 'owlette-swoop'
        exe.parent.mkdir(parents=True)
        exe.write_bytes(b'\xcf\xfa\xed\xfe')
        for path in (app, app / 'Contents', exe.parent, exe):
            os.chmod(path, 0o755)
        # the test's own user stands in for root, whose files a test cannot make.
        monkeypatch.setattr(swoop_spawn_posix, '_INSTALL_OWNER_UID', os.getuid())
        probes = []
        monkeypatch.setattr(swoop_spawn, 'read_streamer_version',
                            lambda path: probes.append(path) or shared_utils.APP_VERSION)
        return exe, probes

    def test_a_layout_only_the_owner_can_write_passes(self, bundle_layout):
        exe, probes = bundle_layout

        assert swoop_spawn.verify_install(str(exe)) == str(exe)
        assert probes == [str(exe)]

    def test_a_group_writable_executable_is_refused(self, bundle_layout):
        exe, probes = bundle_layout
        os.chmod(exe, 0o775)

        with pytest.raises(swoop_spawn.SwoopSpawnError) as exc:
            swoop_spawn.verify_install(str(exe))

        assert exc.value.reason == swoop_spawn.REFUSAL_INSTALL_UNVERIFIED
        assert probes == [], 'the version probe never ran an unverified binary'

    def test_an_absent_executable_is_not_installed(self, tmp_path):
        with pytest.raises(swoop_spawn.SwoopSpawnError) as exc:
            swoop_spawn.verify_install(str(tmp_path / 'owlette-swoop'))

        assert exc.value.reason == swoop_spawn.REFUSAL_NOT_INSTALLED


class TestSweep:
    def test_the_sweep_removes_only_the_two_suffixes(self, data_root):
        ipc = data_root / 'ipc' / 'swoop'
        outside = data_root / 'outside.sock'
        outside.write_text('x')
        for name in ('a.sock', 'b.exit.json', 'c.json', 'd.sock.bak', 'notes.txt'):
            (ipc / name).write_text('x')
        (ipc / 'e.sock').mkdir()
        os.symlink(outside, ipc / 'f.sock')

        swoop_spawn_posix.sweep_stale()

        assert sorted(os.listdir(ipc)) == ['c.json', 'd.sock.bak', 'e.sock', 'notes.txt']
        assert outside.exists(), 'a link is removed, never followed'

    def test_the_sweep_does_not_follow_a_linked_directory(self, tmp_path, monkeypatch):
        elsewhere = tmp_path / 'elsewhere'
        elsewhere.mkdir()
        (elsewhere / 'x.sock').write_text('x')
        root = tmp_path / 'root'
        (root / 'ipc').mkdir(parents=True)
        os.symlink(elsewhere, root / 'ipc' / 'swoop')
        monkeypatch.setenv('OWLETTE_DATA_ROOT', str(root))

        swoop_spawn_posix.sweep_stale()

        assert (elsewhere / 'x.sock').exists()
