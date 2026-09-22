"""The data root resolves through one seam, and one override moves all of it.

`OWLETTE_DATA_ROOT` is the only knob: set it and `get_data_path()`, the
directories `ensure_data_directories()` builds and every roost default path
land inside it. Unset, the Windows arm answers with %PROGRAMDATA%\\Owlette.
"""

import os

import pytest

import osadapter
import shared_utils
import sync_downloader
import sync_scrub
import sync_state
import sync_version


# Every roost path that used to open-code its own root, by the leaf it owns.
SYNC_DEFAULTS = {
    'content': sync_downloader._default_content_store,
    'scrub-reports': sync_scrub._default_scrub_report_dir,
    'sync-state.db': sync_state._default_state_db_path,
    'versions': sync_version._default_cache_dir,
}


@pytest.fixture
def relocated(tmp_path, monkeypatch):
    """The data root, pointed at a sandbox for the duration of one test."""
    monkeypatch.setenv(osadapter.DATA_ROOT_ENV, str(tmp_path))
    return tmp_path


def test_the_override_names_the_root(relocated):
    assert shared_utils.get_data_path() == str(relocated)


def test_the_override_carries_the_whole_tree(relocated):
    assert shared_utils.get_data_path('config/config.json') == str(
        relocated / 'config' / 'config.json'
    )


def test_ensure_data_directories_builds_under_the_override(relocated):
    assert shared_utils.ensure_data_directories() is True
    assert sorted(p.name for p in relocated.iterdir()) == [
        'cache', 'config', 'ipc', 'logs', 'tmp',
    ]
    # the cortex trio is service-owned on windows: only a SYSTEM process creates it
    assert (relocated / 'ipc' / 'cortex_commands').is_dir() is (os.name != 'nt')


@pytest.mark.parametrize('leaf, resolve', sorted(SYNC_DEFAULTS.items()))
def test_the_roost_defaults_follow_the_root(relocated, leaf, resolve):
    assert resolve() == str(relocated / leaf)


def test_a_relative_override_resolves_against_the_cwd(tmp_path, monkeypatch):
    """Returned absolute, so nothing downstream re-joins it against another base."""
    monkeypatch.setenv(osadapter.DATA_ROOT_ENV, 'sandbox')
    monkeypatch.chdir(tmp_path)

    assert shared_utils.get_data_path() == str(tmp_path / 'sandbox')
    assert os.path.isabs(shared_utils.get_data_path('config'))


@pytest.mark.windows
def test_the_adapter_arm_honours_the_same_override(relocated):
    """No divergence: the arm and the package resolve to one path."""
    from osadapter import win

    assert win.data_root('tmp') == shared_utils.get_data_path('tmp')


@pytest.mark.windows
def test_without_the_override_the_root_is_program_data(tmp_path, monkeypatch):
    monkeypatch.delenv(osadapter.DATA_ROOT_ENV, raising=False)
    monkeypatch.setenv('PROGRAMDATA', str(tmp_path))

    assert shared_utils.get_data_path() == str(tmp_path / 'Owlette')
