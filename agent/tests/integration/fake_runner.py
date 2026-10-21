"""The desktop app's job runner, played on a thread for test_swoop_wiring_posix.

Off Windows the daemon does not start the streamer itself: it drops a
``launch`` request into ``<data_root>/ipc/jobs`` and the resident desktop app
starts its own sidecar (``desktop/src-tauri/src/jobrunner.rs``). This double
does what that runner does with the request: it polls the directory, and
answers a ``launch`` by connecting to the job's socket, starting
fake_streamer.py with its stdin and stdout on that connection and its stderr on
the job's file, writing ``result.json`` with the pid, and dropping its own copy
of the connection. A thread per child writes the exit file when the child ends,
``{"pid": n, "code": c}``, with 128 plus the signal for a child a signal ended.

It plays the transport, not the security rules. The real runner honours only a
trusted request root wrote, launches only its own sidecar, and refuses a socket
root does not own and any path outside the data root; jobrunner.rs tests those
itself. This one runs as the test's own user and trusts every request it reads.
"""

import json
import os
import socket
import subprocess
import sys
import threading
from pathlib import Path

FAKE_STREAMER = Path(__file__).resolve().parent / 'fake_streamer.py'

JOBS_DIR = os.path.join('ipc', 'jobs')
RESULTS_DIR = os.path.join('ipc', 'results')
RESULT_FILE = 'result.json'
# the real runner's modes for what it writes into the seam.
RESULT_DIR_MODE = 0o750
FILE_MODE = 0o640
# the daemon polls for a result every 100 ms; this answers inside that.
POLL_S = 0.05
SIGNAL_BASE = 128


class FakeRunner:
    """Answers the jobs under ``data_root`` from :meth:`start` until :meth:`stop`."""

    def __init__(self, data_root):
        self._jobs_dir = os.path.join(data_root, JOBS_DIR)
        self._results_dir = os.path.join(data_root, RESULTS_DIR)
        self.jobs = []
        self.children = []
        self._watchers = []
        # a request stays in the directory until the daemon has read its
        # result, and must not be run twice meanwhile.
        self._seen = set()
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        self._stop.clear()
        self._thread = threading.Thread(target=self._serve, name='fake-runner', daemon=True)
        self._thread.start()

    def stop(self):
        """Stop answering. The children already started keep running."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(10)
            self._thread = None

    def pid(self):
        """The app's pid while it serves, as its tray.pid names it; None once stopped."""
        return os.getpid() if self._thread is not None else None

    def close(self):
        """Stop, end every child still running, and wait for their exit files."""
        self.stop()
        for child in self.children:
            if child.poll() is None:
                child.kill()
        for watcher in self._watchers:
            watcher.join(10)

    def _serve(self):
        while not self._stop.wait(POLL_S):
            try:
                names = os.listdir(self._jobs_dir)
            except FileNotFoundError:
                continue
            for name in names:
                if not name.endswith('.json') or name in self._seen:
                    continue
                try:
                    with open(os.path.join(self._jobs_dir, name), 'rb') as f:
                        job = json.load(f)
                except FileNotFoundError:
                    continue  # the daemon withdrew it
                self._seen.add(name)
                self.jobs.append(job)
                if job['type'] == 'launch':
                    result = self._launch(job)
                else:
                    result = {'error': 'unsupported_job', 'message': job['type']}
                self._answer(job['id'], result)

    def _launch(self, job):
        """Start the streamer on the job's socket; its pid, or ``launch_failed``."""
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            stderr = os.open(job['stderr'], os.O_WRONLY | os.O_APPEND | os.O_CREAT, FILE_MODE)
            try:
                conn.connect(job['socket'])
                child = subprocess.Popen(
                    [sys.executable, str(FAKE_STREAMER), *job['args']],
                    stdin=conn, stdout=conn, stderr=stderr,
                )
            finally:
                os.close(stderr)
        except OSError as e:
            return {'error': 'launch_failed', 'message': str(e)}
        finally:
            # the child holds the connection now, and the daemon reads end of
            # file only once the child's copies are the last ones.
            conn.close()
        self.children.append(child)
        watcher = threading.Thread(
            target=self._record_exit, args=(child, job['exit_file']),
            name='fake-runner-exit', daemon=True,
        )
        watcher.start()
        self._watchers.append(watcher)
        return {'pid': child.pid}

    def _record_exit(self, child, exit_file):
        status = child.wait()
        # popen reports a signal as its negative; the app records 128 plus it.
        code = status if status >= 0 else SIGNAL_BASE - status
        _write_whole(exit_file, {'pid': child.pid, 'code': code})

    def _answer(self, job_id, result):
        result_dir = os.path.join(self._results_dir, job_id)
        os.makedirs(result_dir, mode=RESULT_DIR_MODE, exist_ok=True)
        _write_whole(os.path.join(result_dir, RESULT_FILE), result)


def _write_whole(path, record):
    """Write ``record`` beside ``path`` and move it into place, so a reader
    never sees half of it."""
    temp = f'{path}.{os.getpid()}.tmp'
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, FILE_MODE)
    with os.fdopen(fd, 'w') as f:
        json.dump(record, f)
    os.replace(temp, path)
