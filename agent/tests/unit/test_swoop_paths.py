"""
Unit tests for the swoop path surface in shared_utils.

Five names are the interface every Wave-2 swoop module imports:
SWOOP_EXE_NAME, SWOOP_LOG_DIR, SWOOP_IPC_DIR, get_swoop_dir() and
get_swoop_exe_path(). These tests pin their resolution and, more importantly,
two deliberate omissions that a later "cleanup" would otherwise undo:

  * get_swoop_dir() NEVER creates the directory, and {app}\\swoop is NOT in
    ensure_data_directories(). The installer lays that directory down as SYSTEM
    with a protected DACL, and the spawn path trusts that ownership; a
    makedirs(exist_ok=True) here would extend that trust to whatever already
    sits at the path, for a binary the service runs as SYSTEM. See spike 0.7
    finding L2 for the measurement. An absent {app}\\swoop is the correct
    "swoop is not installed" signal, and get_swoop_exe_path() -> None is how it
    surfaces.
  * cleanup_old_logs() stays non-recursive, so logs/swoop is left to the
    streamer's own rotation.

The two constants are frozen at import from %PROGRAMDATA%, so the constant
cases load an independent copy of the module with PROGRAMDATA redirected
rather than reloading the one the rest of the suite shares.
"""

import importlib.util
import os
import time

import pytest

import shared_utils


AGE_90_DAYS = 90 * 24 * 60 * 60


# Helpers / fixtures

def load_isolated_shared_utils():
    """A private copy of shared_utils, imported against the caller's env.

    Import-frozen constants cannot be re-resolved by patching the env after the
    fact, and reloading the shared module object would leak into every other
    test in the session.
    """
    spec = importlib.util.spec_from_file_location(
        'shared_utils_swoop_probe', shared_utils.__file__
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    """shared_utils imported against a throwaway %PROGRAMDATA%."""
    monkeypatch.setenv('PROGRAMDATA', str(tmp_path))
    return load_isolated_shared_utils()


@pytest.fixture
def data_root(tmp_path, monkeypatch):
    """Redirect the live module's runtime get_data_path() at a temp root."""
    monkeypatch.setenv('PROGRAMDATA', str(tmp_path))
    return tmp_path / 'Owlette'


@pytest.fixture
def install_root(tmp_path, monkeypatch):
    """Pretend the agent is installed at <tmp>/install (src two levels down)."""
    root = tmp_path / 'install'
    src = root / 'agent' / 'src'
    src.mkdir(parents=True)
    monkeypatch.setattr(shared_utils, 'get_path', lambda filename=None: str(src))
    return root


def touch_old(path, age_seconds=AGE_90_DAYS + 3600):
    """Create a file and backdate it past cleanup_old_logs()'s cutoff."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('x')
    old = time.time() - age_seconds
    os.utime(str(path), (old, old))


# Constants

class TestSwoopConstants:
    """The three module-level names, resolved under a fake %PROGRAMDATA%."""

    def test_exe_name_is_the_registered_spelling(self, isolated):
        assert isolated.SWOOP_EXE_NAME == 'owlette-swoop.exe'

    def test_log_dir_under_program_data(self, isolated, tmp_path):
        assert isolated.SWOOP_LOG_DIR == str(tmp_path / 'Owlette' / 'logs' / 'swoop')

    def test_ipc_dir_under_program_data(self, isolated, tmp_path):
        assert isolated.SWOOP_IPC_DIR == str(tmp_path / 'Owlette' / 'ipc' / 'swoop')

    def test_constants_match_get_data_path(self, isolated):
        """Same seam as every other path constant — no bespoke root."""
        assert isolated.SWOOP_LOG_DIR == isolated.get_data_path('logs/swoop')
        assert isolated.SWOOP_IPC_DIR == isolated.get_data_path('ipc/swoop')


# ensure_data_directories

class TestEnsureDataDirectories:
    """Both swoop data directories are created; {app}\\swoop is not."""

    def test_creates_both_swoop_directories(self, data_root):
        assert shared_utils.ensure_data_directories() is True

        assert (data_root / 'logs' / 'swoop').is_dir()
        assert (data_root / 'ipc' / 'swoop').is_dir()

    def test_is_idempotent(self, data_root):
        assert shared_utils.ensure_data_directories() is True
        assert shared_utils.ensure_data_directories() is True

        assert (data_root / 'logs' / 'swoop').is_dir()
        assert (data_root / 'ipc' / 'swoop').is_dir()

    def test_does_not_create_the_install_directory(self, data_root, install_root):
        """Spike 0.7 L2: only the installer may create {app}\\swoop."""
        shared_utils.ensure_data_directories()

        assert not os.path.exists(shared_utils.get_swoop_dir())
        assert not (data_root / 'swoop').exists()


# get_swoop_dir / get_swoop_exe_path

class TestSwoopInstallPaths:
    """Resolution from the install root, and the never-create rule."""

    def test_dir_resolves_beside_the_other_payload_directories(self, install_root):
        assert shared_utils.get_swoop_dir() == str(install_root / 'swoop')

    def test_dir_never_creates_anything(self, install_root):
        """Calling it repeatedly must leave the install root untouched."""
        path = shared_utils.get_swoop_dir()
        shared_utils.get_swoop_dir()

        assert not os.path.exists(path)
        assert sorted(os.listdir(str(install_root))) == ['agent']

    def test_exe_path_is_none_when_the_directory_is_absent(self, install_root):
        assert shared_utils.get_swoop_exe_path() is None

    def test_exe_path_is_none_when_the_exe_is_absent(self, install_root):
        (install_root / 'swoop').mkdir()

        assert shared_utils.get_swoop_exe_path() is None

    def test_exe_path_is_the_full_path_when_installed(self, install_root):
        exe = install_root / 'swoop' / 'owlette-swoop.exe'
        exe.parent.mkdir()
        exe.write_bytes(b'MZ')

        assert shared_utils.get_swoop_exe_path() == str(exe)


# cleanup_old_logs

class TestCleanupOldLogsStaysNonRecursive:
    """logs/swoop rotates itself — see the comment beside SWOOP_LOG_DIR."""

    def test_subdirectories_are_skipped(self, data_root):
        touch_old(data_root / 'logs' / 'owlette.log')
        touch_old(data_root / 'logs' / 'swoop' / 'streamer.log')

        deleted = shared_utils.cleanup_old_logs()

        assert deleted == 1
        assert not (data_root / 'logs' / 'owlette.log').exists()
        assert (data_root / 'logs' / 'swoop' / 'streamer.log').exists()

    def test_the_swoop_log_directory_itself_survives(self, data_root):
        (data_root / 'logs' / 'swoop').mkdir(parents=True)

        assert shared_utils.cleanup_old_logs() == 0
        assert (data_root / 'logs' / 'swoop').is_dir()
