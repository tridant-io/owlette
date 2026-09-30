"""gate m0 (task 3.1): does the installed app's child see the screen?

launches the installed sidecar's `selfcheck` through the product's own seam --
swoop_spawn_posix's socket and launch job, osadapter.run_job, the installed
app's job runner -- and prints the launch result beside the one line the
sidecar wrote. nothing here captures anything: `selfcheck --force` asks
ScreenCaptureKit for the display list and reports the grants.

run as root under the runtime's own interpreter, with the runtime's agent/src
on the path (the default), while the installed daemon and app are running:

    sudo "/Library/Application Support/Owlette/runtime/python/bin/python3" \
        m0_selfcheck.py [--no-force] [--label <text>]

it removes the socket and the exit file it created, each by its exact path.
"""

import json
import os
import socket
import sys
import time
import uuid

RUNTIME_SRC = '/Library/Application Support/Owlette/runtime/agent/src'
sys.path.insert(0, RUNTIME_SRC)

import osadapter  # noqa: E402
import shared_utils  # noqa: E402
import swoop_spawn_posix as sp  # noqa: E402

# selfcheck waits up to 5 s on ScreenCaptureKit; leave room around it.
READ_TIMEOUT_S = 15


def _read_line(conn):
    """One line from the sidecar, or what arrived before it closed."""
    conn.settimeout(READ_TIMEOUT_S)
    buf = b''
    try:
        while b'\n' not in buf:
            data = conn.recv(65536)
            if not data:
                break
            buf += data
    except socket.timeout:
        return buf.decode('utf-8', 'replace'), 'timeout'
    return buf.split(b'\n', 1)[0].decode('utf-8', 'replace'), None


def _read_exit_file(path):
    deadline = time.monotonic() + sp.EXIT_FILE_WAIT_S
    while time.monotonic() < deadline:
        try:
            with open(path, 'rb') as f:
                return json.loads(f.read())
        except (OSError, ValueError):
            time.sleep(0.05)
    return None


def main():
    argv = sys.argv[1:]
    args = ['selfcheck'] if '--no-force' in argv else ['selfcheck', '--force']
    label = argv[argv.index('--label') + 1] if '--label' in argv else ''

    ipc_dir = shared_utils.get_data_path(sp.IPC_SUBDIR)
    log_dir = shared_utils.get_data_path(sp.LOG_SUBDIR)
    spawn_id = uuid.uuid4().hex
    socket_path = os.path.join(ipc_dir, spawn_id + sp.SOCKET_SUFFIX)
    exit_path = os.path.join(ipc_dir, spawn_id + sp.EXIT_FILE_SUFFIX)

    report = {'label': label, 'args': args, 'agentVersion': shared_utils.APP_VERSION}
    listener = conn = None
    try:
        listener = sp._listen(ipc_dir, socket_path)
        job = sp._launch_job(socket_path, exit_path, log_dir)
        job['args'] = args
        result = osadapter.run_job(job)
        sp._discard_result(result)
        report['launch'] = {k: v for k, v in result.items() if k != 'outputDir'}
        if result.get('error'):
            return report

        listener.settimeout(sp.ACCEPT_TIMEOUT_S)
        conn, _addr = listener.accept()
        report['peerUid'] = sp._peer_uid(conn)
        report['consoleUid'] = sp._console_uid()
        line, problem = _read_line(conn)
        if problem:
            report['readProblem'] = problem
        try:
            report['selfcheck'] = json.loads(line)
        except ValueError:
            report['selfcheckRaw'] = line
        report['exitFile'] = _read_exit_file(exit_path)
        return report
    except Exception as e:  # the memo wants the failure, not a traceback
        report['error'] = f'{type(e).__name__}: {e}'
        return report
    finally:
        if conn is not None:
            conn.close()
        if listener is not None:
            listener.close()
        sp._unlink(socket_path)
        sp._unlink(exit_path)


if __name__ == '__main__':
    print(json.dumps(main(), sort_keys=True))
