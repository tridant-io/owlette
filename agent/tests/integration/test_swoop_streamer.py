"""Task 8.7, host half: the real streamer, spawned with a synthetic bundle.

Nothing stands in for the streamer here: this is owlette-swoop.exe, built with
the ``testhooks`` cargo feature so the bundle's test-only ``overrides`` object
can swap the desktop for the test pattern (agent/swoop/src/capture/testpattern.rs)
and the encoder chain for the software floor. Build it once from agent/swoop:

    cargo build --features testhooks --target-dir target/testhooks

or point OWLETTE_SWOOP_EXE at one. Without it every test here skips and says so.

There is no signal relay in this test, so the session goes as far as a session
can without one: ``ready`` on stdout once the pattern is captured and the
encoder chain answered, the dial ladder against a room that is not there, then
``exiting`` with 14. A viewer, and with it ``viewer_joined`` and an encoded
frame, needs the relay; the browser half of 8.7 (web/e2e/specs/swoop) owns that.

A default build refusing ``overrides`` with 10 is asserted where a default build
is guaranteed, in the crate's own tests (bundle.rs): which features an exe on
disk was built with cannot be told from outside.
"""

import json
import os
import socket
import subprocess
import threading
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(os.name != 'nt', reason='the test pattern renders into d3d11: windows only')

SWOOP = Path(__file__).resolve().parents[2] / 'swoop'
BUILT = SWOOP / 'target' / 'testhooks' / 'debug' / 'owlette-swoop.exe'

# exit codes, PROTOCOL.md section 6
EXIT_BUNDLE_INVALID = 10
EXIT_VERSION_MISMATCH = 11
EXIT_NO_CAPTURE_SOURCE = 12
EXIT_NO_ENCODER = 13
EXIT_SIGNALING_UNREACHABLE = 14

# every value below is a sentinel no log line could carry by accident
SECRETS = {
    'hostToken': 'HOSTTOKEN-SENTINEL-8841.never.logged',
    'sessionKey': 'U0VTU0lPTktFWVNFTlRJTkVMLW5ldmVyLWxvZ2dlZDE',
    'jwtKey': 'Xn7YVoJkEjPxnCQeR6DJr15ZUjEoCk7GvHAL_mJ1kyU',
    'kid': 'kid-SENTINEL-4417',
    'turnUsername': 'TURNUSER-SENTINEL-2203',
    'turnCredential': 'TURNCRED-SENTINEL-9930',
    'sid': 'sid_SENTINEL_77120',
    'site': 'site_SENTINEL_31a',
    'machine': 'machine_SENTINEL_9f2',
}


def closed_port():
    """A loopback port nothing listens on: the room the dial cannot reach."""
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def make_bundle(version, **changes):
    site, machine = SECRETS['site'], SECRETS['machine']
    bundle = {
        'protocolVersion': 1,
        'agentVersion': version,
        'sid': SECRETS['sid'],
        'site': site,
        'machine': machine,
        'now': int(time.time()),
        'streamerEpoch': int(time.time() * 1_000_000),
        'signalUrl': f'ws://127.0.0.1:{closed_port()}/v1/room/{site}/{machine}',
        'hostToken': SECRETS['hostToken'],
        'jwtKeys': [{'kid': SECRETS['kid'], 'alg': 'EdDSA', 'key': SECRETS['jwtKey']}],
        'sessionKey': SECRETS['sessionKey'],
        'iceServers': [{
            'urls': ['turn:127.0.0.1:9?transport=udp'],
            'username': SECRETS['turnUsername'],
            'credential': SECRETS['turnCredential'],
        }],
        'enablement': {
            'membersMayWatch': True,
            'maxViewers': 4,
            'leaseSeconds': 300,
            'sessionCapSeconds': 43200,
        },
        'indicator': 'banner',
        'ctl': True,
        'overrides': {'source': 'testpattern', 'encoder': 'soft'},
    }
    bundle.update(changes)
    return bundle


class Run:
    def __init__(self, code, events, stderr, log):
        self.code = code
        self.events = events
        self.stderr = stderr
        self.log = log


def run_streamer(exe, data_root, line, timeout=90):
    """One streamer lifetime: `line` as stdin line 1, stdin held open until it
    exits, as the service holds it. The log goes under `data_root`."""
    env = dict(os.environ, OWLETTE_DATA_ROOT=str(data_root))
    proc = subprocess.Popen(
        [str(exe), 'run'],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    # stdout is read to its end, so a streamer that never exits is killed
    # rather than left to hang the run
    watchdog = threading.Timer(timeout, proc.kill)
    watchdog.start()
    try:
        proc.stdin.write(line.encode() + b'\n')
        proc.stdin.flush()
        stdout = proc.stdout.read()
        proc.wait()
    finally:
        watchdog.cancel()
        proc.stdin.close()
    stderr = proc.stderr.read().decode('utf-8', 'replace')
    proc.stderr.close()
    proc.stdout.close()
    events = [json.loads(l) for l in stdout.decode('utf-8').splitlines() if l.strip()]
    log_dir = Path(data_root) / 'logs' / 'swoop'
    log = ''.join(
        f.read_text(encoding='utf-8', errors='replace') for f in sorted(log_dir.glob('swoop.log*'))
    ) if log_dir.is_dir() else ''
    return Run(proc.returncode, events, stderr, log)


@pytest.fixture(scope='module')
def exe():
    wanted = Path(os.environ.get('OWLETTE_SWOOP_EXE') or BUILT)
    if not wanted.is_file():
        pytest.skip(
            f'no testhooks streamer at {wanted}: build it with '
            '`cargo build --features testhooks --target-dir target/testhooks` from agent/swoop, '
            'or set OWLETTE_SWOOP_EXE'
        )
    return wanted


@pytest.fixture(scope='module')
def version(exe):
    return subprocess.run([str(exe), 'version'], capture_output=True, text=True, timeout=30).stdout.strip()


@pytest.fixture(scope='module')
def session(exe, version, tmp_path_factory):
    """The one full lifetime the rest of the module reads: pattern in, software
    floor, no room."""
    root = tmp_path_factory.mktemp('swoop-session')
    run = run_streamer(exe, root, json.dumps(make_bundle(version)))
    if run.code == EXIT_BUNDLE_INVALID and not run.events:
        pytest.skip(f'{exe} refuses `overrides`: it is a default build, not a testhooks one')
    return run


def test_the_session_reports_ready_then_exits_14_without_a_room(session):
    kinds = [event['type'] for event in session.events]
    assert kinds == ['ready', 'exiting'], session.events
    ready, exiting = session.events
    assert ready['sid'] == SECRETS['sid']
    assert ready['displays'] == 1, 'the test pattern is the only output'
    # the override narrowed the chain to the software floor, which is h.264 only
    assert ready['codecs'] == ['h264']
    assert exiting == {
        'type': 'exiting',
        'sid': SECRETS['sid'],
        'code': EXIT_SIGNALING_UNREACHABLE,
        'reason': 'error',
    }
    assert session.code == EXIT_SIGNALING_UNREACHABLE


def test_the_pattern_and_the_floor_were_what_ran(session):
    assert 'capturing the test pattern at 1280x720' in session.log
    assert 'encoding only on mf-sw (test override)' in session.log
    assert 'dial attempt' in session.log


def test_no_bundle_secret_or_identifier_reaches_the_log_or_stderr(session):
    # the ice server's host and port are logged on purpose when the session
    # resolves them (session/mod.rs resolve_server); its credentials never are
    assert session.log, 'the session wrote a log'
    for field, value in SECRETS.items():
        assert value not in session.log, f'{field} reached the log'
        assert value not in session.stderr, f'{field} reached stderr'
    assert '/v1/room/' not in session.log, 'the signal url reached the log'


@pytest.mark.parametrize(
    'line, code',
    [
        pytest.param('{', EXIT_BUNDLE_INVALID, id='not-a-bundle'),
        pytest.param('', EXIT_BUNDLE_INVALID, id='empty-line'),
    ],
)
def test_a_broken_bundle_exits_10(exe, tmp_path, line, code):
    run = run_streamer(exe, tmp_path, line)
    assert run.code == code
    assert run.events == [], 'nothing is emitted for a bundle that never parsed'


def test_a_bundle_for_another_version_exits_11(exe, tmp_path):
    run = run_streamer(exe, tmp_path, json.dumps(make_bundle('0.0.1')))
    assert run.code == EXIT_VERSION_MISMATCH
    assert SECRETS['hostToken'] not in run.log


def test_an_override_source_this_build_lacks_exits_12(exe, version, tmp_path):
    bundle = make_bundle(version, overrides={'source': 'webcam'})
    run = run_streamer(exe, tmp_path, json.dumps(bundle))
    assert run.code == EXIT_NO_CAPTURE_SOURCE
    assert [event['type'] for event in run.events] == ['exiting']
    assert 'webcam' not in run.log, 'a refused override name is a bundle field'


def test_an_override_encoder_this_build_lacks_exits_13(exe, version, tmp_path):
    bundle = make_bundle(version, overrides={'source': 'testpattern', 'encoder': 'x264'})
    run = run_streamer(exe, tmp_path, json.dumps(bundle))
    assert run.code == EXIT_NO_ENCODER
    assert [event['type'] for event in run.events] == ['exiting']
