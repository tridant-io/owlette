"""file_path on Windows: a file when the whole value is one, arguments otherwise.

The value used to go through _validate_path whatever it was, so abspath prefixed
arguments with the service's working directory and the slashes were flipped.
Arguments now reach the program unchanged, and a value naming a network path or
a symbolic link is still refused, quoted or not.

Two layers: what launch_process_as_user hands to the helper, stopped at
CreateProcessAsUser; and the argv a real program received, with the same helper
command line started as a plain child because a test has no session token.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import psutil
import pytest

# windows-only: skipped, not failed, on the macos and linux legs.
pytest.importorskip('win32security', reason='windows-only: the launch handoff is pywin32')
import win32api
import win32process
import win32security


def _service():
    import owlette_service

    return SimpleNamespace(
        console_user_token=win32security.OpenProcessToken(
            win32api.GetCurrentProcess(), win32security.TOKEN_QUERY),
        environment=None,
        firebase_client=None,
        _refresh_user_token=lambda: None,
        _find_running_process_by_exe=lambda *args, **kwargs: None,
        _validate_path=owlette_service.OwletteService._validate_path,
        _record_launch=lambda process, pid: pid)


def _launch(svc, exe, value, visibility='Normal'):
    import owlette_service

    launch = owlette_service.OwletteService.launch_process_as_user.__get__(svc)
    return launch({'id': 'p', 'name': 'target', 'exe_path': str(exe),
                   'file_path': value, 'visibility': visibility})


@pytest.fixture
def seat(tmp_path, monkeypatch):
    """A data root, a service working directory, and a target exe on disk."""
    import shared_utils

    monkeypatch.setenv('OWLETTE_DATA_ROOT', str(tmp_path / 'data'))
    (tmp_path / 'data' / 'tmp').mkdir(parents=True)
    (tmp_path / 'service-cwd').mkdir()
    monkeypatch.chdir(tmp_path / 'service-cwd')
    (tmp_path / 'my show').mkdir()
    spaced = tmp_path / 'my show' / 'x.toe'
    spaced.write_bytes(b'')
    exe = tmp_path / 'target-app.exe'
    exe.write_bytes(b'')
    assert 'programdata' not in shared_utils.get_data_path('tmp').lower()
    # base interpreter: a venv's python.exe is a redirector process.
    monkeypatch.setattr(shared_utils, 'get_python_exe_path', lambda: sys._base_executable)
    return SimpleNamespace(root=tmp_path, spaced=spaced, exe=exe)


@pytest.fixture
def handed_off(seat, monkeypatch):
    """launch_process_as_user up to the session boundary, recording the handoff."""
    seen = []

    def stop_at_the_session_boundary(token, app_name, command_line, *rest):
        args_file = command_line.rsplit('"', 2)[-2]
        with open(args_file, 'r') as f:
            seen.append(json.load(f))
        raise RuntimeError('a test has no user session')

    monkeypatch.setattr(win32process, 'CreateProcessAsUser', stop_at_the_session_boundary)
    return seen


def _symlink(target, link):
    try:
        os.symlink(target, link)
    except OSError as e:
        pytest.skip(f'cannot create a symbolic link here: {e}')
    return link


@pytest.mark.parametrize('value', [
    '--fullscreen --display 2',
    r'"C:\my show\x.toe" --fullscreen',
    '/S',
    '--config C:/shows/a.json --flag',
    r'/c "C:\ops\run me.bat"',
    'https://example.com/kiosk',
    r'not-on-disk.toe',
    'C:/x --flag',
    'shows/x.toe --flag',
    r'shows\x.toe --flag',
    '--name "a b"',
])
def test_arguments_reach_the_helper_unchanged(seat, handed_off, value):
    _launch(_service(), seat.exe, value)

    assert handed_off[0]['file_path'] == value


def test_a_file_on_disk_is_the_validated_absolute_path(seat, handed_off):
    _launch(_service(), seat.exe, str(seat.spaced))

    assert handed_off[0]['file_path'] == str(seat.spaced)


def test_a_file_with_forward_slashes_is_normalized(seat, handed_off):
    _launch(_service(), seat.exe, str(seat.spaced).replace('\\', '/'))

    assert handed_off[0]['file_path'] == str(seat.spaced)


def test_a_quoted_file_is_still_that_file(seat, handed_off):
    _launch(_service(), seat.exe, f'"{seat.spaced}"')

    assert handed_off[0]['file_path'] == str(seat.spaced)


@pytest.mark.parametrize('value', [
    r'\\server\share\x.toe',
    '//server/share/x.toe',
    r'"\\server\share\x.toe"',
    r'  "\\server\share\x.toe"  ',
    r'\\server\share\x.toe --fullscreen',
    r'"\\server\share\x.toe" --fullscreen',
    '"//server/share/x.toe"',
])
def test_a_network_path_is_refused_quoted_or_not(seat, handed_off, value, caplog):
    assert _launch(_service(), seat.exe, value) is None

    assert handed_off == []
    assert 'File path cannot be a UNC/network path' in caplog.text


def test_the_refusal_of_a_bare_network_path_says_which(seat, handed_off, caplog):
    _launch(_service(), seat.exe, r'\\server\share\x.toe')

    assert r'Error: File path cannot be a UNC/network path: \\server\share\x.toe' in caplog.text


@pytest.mark.parametrize('quoted', [False, True])
def test_a_symbolic_link_is_refused_quoted_or_not(seat, handed_off, quoted, caplog):
    link = _symlink(seat.spaced, seat.root / 'link.toe')

    value = f'"{link}"' if quoted else str(link)
    assert _launch(_service(), seat.exe, value) is None

    assert handed_off == []
    assert 'File path cannot be a symbolic link' in caplog.text


def test_a_dangling_symbolic_link_is_refused_rather_than_read_as_arguments(
        seat, handed_off, caplog):
    link = _symlink(seat.root / 'gone.toe', seat.root / 'dangling.toe')

    assert _launch(_service(), seat.exe, str(link)) is None

    assert handed_off == []
    assert 'File path cannot be a symbolic link' in caplog.text


@pytest.fixture
def real_helper(monkeypatch):
    """The helper command line started as a plain child, in place of the token."""
    import owlette_service
    import shared_utils

    def start_the_real_helper(token, app_name, command_line, *rest):
        return None, None, subprocess.Popen(command_line).pid, 0

    src = Path(owlette_service.__file__).parent
    monkeypatch.setattr(win32process, 'CreateProcessAsUser', start_the_real_helper)
    monkeypatch.setattr(shared_utils, 'get_path', lambda name: str(src / name))


# pythonw: no console window on the machine running the suite.
_PYTHONW = Path(sys.base_prefix) / 'pythonw.exe'


@pytest.mark.parametrize('visibility', ['Normal', 'Hidden'])
def test_a_real_program_receives_the_exact_argv(seat, real_helper, monkeypatch, visibility):
    """The real helper, ShellExecuteEx or Popen, and a real program's sys.argv."""
    import owlette_service

    # the target exits after recording; the pid check is not what this tests.
    monkeypatch.setattr(owlette_service, '_pid_descends_from', lambda *args: True)

    record = seat.root / 'argv.json'
    code = "import json,sys;open(sys.argv[1],'w').write(json.dumps(sys.argv[2:]))"
    value = (f'-c "{code}" "{record}" "{seat.spaced}" --fullscreen /S '
             'C:/x --flag shows/x.toe')

    _launch(_service(), _PYTHONW, value, visibility)

    deadline = time.time() + 10
    while time.time() < deadline and not (record.exists() and record.stat().st_size):
        time.sleep(0.05)
    assert json.loads(record.read_text()) == [
        str(seat.spaced), '--fullscreen', '/S', 'C:/x', '--flag', 'shows/x.toe']


def _end_tree(pid):
    """Reap a launched target and anything under it, by pid."""
    try:
        proc = psutil.Process(pid)
        for each in [*proc.children(recursive=True), proc]:
            each.kill()
    except psutil.NoSuchProcess:
        pass


def _found_after_launch(exe, value, visibility):
    """Launch for real, then look the live process up by the raw configured value."""
    import shared_utils

    pid = _launch(_service(), exe, value, visibility)
    assert pid
    try:
        found = strict = None
        deadline = time.time() + 5
        while time.time() < deadline and (found, strict) != (pid, pid):
            found = shared_utils.find_running_process_by_exe(str(exe), value)
            strict = shared_utils.find_running_process_by_exe(str(exe), value, strict=True)
            time.sleep(0.1)
        assert (found, strict) == (pid, pid)
    finally:
        _end_tree(pid)


@pytest.fixture
def sleeper(seat):
    """A long-lived target script in a folder with a space in its name."""
    script = seat.root / 'my show' / 'sleeper.py'
    script.write_text('import time\ntime.sleep(30)\n')
    return script


@pytest.mark.parametrize('visibility', ['Normal', 'Hidden'])
def test_a_running_process_is_found_by_a_quoted_value(real_helper, sleeper, visibility):
    _found_after_launch(_PYTHONW, f'"{sleeper}" --name "a b"', visibility)


@pytest.mark.parametrize('visibility', ['Normal', 'Hidden'])
def test_a_running_process_is_found_by_a_quoted_file(real_helper, sleeper, visibility):
    _found_after_launch(_PYTHONW, f'"{sleeper}"', visibility)


def test_a_hidden_batch_wrapper_is_found_by_a_quoted_value(real_helper, sleeper):
    wrapper = sleeper.parent / 'run it.cmd'
    wrapper.write_text(f'@"{_PYTHONW}" %*\n')

    _found_after_launch(wrapper, f'"{sleeper}" --name "a b"', 'Hidden')
