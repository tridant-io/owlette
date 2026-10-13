"""the tray's "kill all swoop sessions on this machine" (`tmp/swoop_kill.flag`).

the desktop app touches the flag; the service's local config watcher ends every
session through the manager kill a dashboard `swoop_kill` without a sid makes,
under the audit reason `local_tray`. no elevation, and windows only: off it
`tmp/` is group-writable and the tray does not offer the item.
"""

import sys

import pytest

import owlette_service


class FakeManager:
    def __init__(self):
        self.kills = []

    def kill(self, reason='kill', sid=None):
        self.kills.append((reason, sid))


@pytest.fixture
def service(tmp_path, monkeypatch):
    (tmp_path / 'tmp').mkdir()
    monkeypatch.setattr(
        owlette_service.shared_utils, 'get_data_path',
        lambda rel: str(tmp_path / rel),
    )
    svc = object.__new__(owlette_service.OwletteService)
    svc.swoop_manager = FakeManager()
    return svc


def flag(tmp_path):
    return tmp_path / owlette_service.SWOOP_KILL_FLAG


windows_only = pytest.mark.skipif(sys.platform != 'win32', reason='the windows flag seam')


@windows_only
def test_the_flag_ends_every_session_as_local_tray_and_is_consumed(service, tmp_path):
    flag(tmp_path).write_text('local_tray')

    service._check_tray_swoop_kill()

    assert service.swoop_manager.kills == [('local_tray', None)]
    assert not flag(tmp_path).exists()

    # once: the next tick finds nothing and kills nothing
    service._check_tray_swoop_kill()
    assert service.swoop_manager.kills == [('local_tray', None)]


@windows_only
def test_no_flag_kills_nothing(service):
    service._check_tray_swoop_kill()
    assert service.swoop_manager.kills == []


@windows_only
def test_a_flag_with_swoop_not_running_is_consumed_without_raising(service, tmp_path):
    service.swoop_manager = None
    flag(tmp_path).write_text('local_tray')

    service._check_tray_swoop_kill()

    assert not flag(tmp_path).exists()


@windows_only
def test_a_directory_under_the_flag_name_is_not_a_kill(service, tmp_path):
    flag(tmp_path).mkdir()

    service._check_tray_swoop_kill()

    assert service.swoop_manager.kills == []


@windows_only
def test_a_flag_that_cannot_be_removed_is_not_obeyed(service, tmp_path, monkeypatch):
    flag(tmp_path).write_text('local_tray')

    def refuse(path):
        raise PermissionError('in use')

    monkeypatch.setattr(owlette_service.os, 'remove', refuse)
    service._check_tray_swoop_kill()

    assert service.swoop_manager.kills == []


@pytest.mark.skipif(sys.platform == 'win32', reason='the posix arms')
def test_off_windows_a_flag_in_tmp_is_nobodys_word(service, tmp_path):
    flag(tmp_path).write_text('local_tray')

    service._check_tray_swoop_kill()

    assert service.swoop_manager.kills == []
    assert flag(tmp_path).exists()
