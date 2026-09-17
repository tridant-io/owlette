"""Uninstalling an application on macOS: quit it, then remove its bundle.

A bundle has no uninstaller, so the command's uninstall_command is the bundle's
own path (owner ruling Q-M1), which makes the payload the thing that names what
root deletes. These tests hold that boundary against the real removal: only a
path the inventory lists at that moment is removed, nothing running from inside
it outlives the removal, and a removal the system refuses is reported as one.

The handler runs on a SimpleNamespace through the descriptor protocol, as in
test_update_artifact_guard.py, and sys.platform is set to darwin the way
test_launch_failed.py sets it to linux, so the Linux leg runs the same removal.
"""

import errno
import os
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import osadapter
import shared_utils

pytestmark = pytest.mark.skipif(sys.platform == 'win32', reason='the macOS arm')


class _FakeFirebase:
    """The progress and inventory calls the handler makes, recorded."""

    def __init__(self):
        self.progress = []
        self.synced = 0

    def update_command_progress(self, cmd_id, status, deployment_id=None):
        self.progress.append((cmd_id, status, deployment_id))

    def is_connected(self):
        return True

    def sync_software_inventory(self):
        self.synced += 1


@pytest.fixture
def applications(tmp_path):
    folder = tmp_path / 'Applications'
    folder.mkdir()
    return folder


def _bundle(applications, name='Kiosk'):
    """A bundle as the inventory finds one, with a tree inside it to remove."""
    bundle = applications / f'{name}.app'
    (bundle / 'Contents' / 'MacOS').mkdir(parents=True)
    (bundle / 'Contents' / 'Info.plist').write_bytes(
        plistlib.dumps({'CFBundleName': name, 'CFBundleExecutable': name}))
    return bundle


@pytest.fixture
def inventory(monkeypatch):
    """The paths osadapter.installed_software() lists, as darwin's rows."""
    listed = []

    def installed_software():
        return [{
            'name': os.path.basename(path)[:-len('.app')],
            'version': '1.0',
            'publisher': '',
            'install_location': path,
            'uninstall_command': path,
            'installer_type': 'app',
        } for path in listed]

    monkeypatch.setattr(osadapter, 'installed_software', installed_software)
    return listed


@pytest.fixture
def service():
    """A service double running the real dispatch and the macOS arm."""
    from owlette_service import OwletteService

    svc = SimpleNamespace(
        firebase_client=_FakeFirebase(),
        _command_rate_limits={},
        COMMAND_RATE_LIMIT_SECONDS=OwletteService.COMMAND_RATE_LIMIT_SECONDS,
        _command_router=SimpleNamespace(has_handler=lambda cmd_type: False),
    )
    for name in ('handle_firebase_command', '_handle_uninstall_app_bundle'):
        setattr(svc, name, getattr(OwletteService, name).__get__(svc, OwletteService))
    return svc


@pytest.fixture
def removals(monkeypatch):
    """Every rmtree the handler attempts, none of them carried out."""
    attempted = []
    monkeypatch.setattr(
        shutil, 'rmtree', lambda path, *args, **kwargs: attempted.append(path))
    return attempted


@pytest.fixture
def quits(monkeypatch):
    """Every pid the handler asks to quit, none of them asked for real."""
    asked = []
    monkeypatch.setattr(
        shared_utils, 'graceful_terminate', lambda pid, *args, **kwargs: asked.append(pid))
    return asked


def _uninstall(service, bundle, **fields):
    """Run the command the dashboard queues off an inventory row, carrying a
    deployment_id so the deployment's progress is reported as well.

    The platform reads darwin for the handler's call alone: the fixtures that
    build a test's executable and patch the adapter ask sys.platform too, and
    on the Linux leg they must go on getting the answer for Linux.
    """
    command = {
        'type': 'uninstall_software',
        'software_name': 'Kiosk',
        'uninstall_command': str(bundle),
        'installer_type': 'app',
        'verify_paths': [str(bundle)],
        'deployment_id': 'deploy-1',
    }
    command.update(fields)
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(sys, 'platform', 'darwin')
        return service.handle_firebase_command('cmd-1', command)


def _run_from_inside(bundle, private_executable):
    """Start the bundle's own executable; the process image lies inside it."""
    executable = bundle / 'Contents' / 'MacOS' / 'Kiosk'
    os.replace(private_executable('Kiosk'), executable)
    return subprocess.Popen([str(executable), '30'])


def test_a_listed_bundle_is_removed_and_reported_as_uninstalled(
        service, inventory, applications, tmp_path):
    bundle = _bundle(applications)
    inventory.append(str(bundle))
    # A link inside the bundle to a folder outside it: removing the bundle
    # unlinks the link and leaves what it points at alone.
    shared = tmp_path / 'Shared'
    shared.mkdir()
    (shared / 'show.toe').write_text('kept')
    (bundle / 'Contents' / 'Resources').symlink_to(shared)

    result = _uninstall(service, bundle)

    assert result == f'Uninstall completed successfully (removed {bundle})'
    assert not os.path.lexists(bundle)
    assert (shared / 'show.toe').read_text() == 'kept'
    # What the dashboard's deployment tracking reads: the one intermediate
    # status it maps, then a fresh inventory so the row disappears.
    assert service.firebase_client.progress == [('cmd-1', 'uninstalling', 'deploy-1')]
    assert service.firebase_client.synced == 1


def _arbitrary_directory(applications, tmp_path):
    target = tmp_path / 'data'
    target.mkdir()
    (target / 'settings.json').write_text('{}')
    return target


def _link_to_the_listed_bundle(applications, tmp_path):
    target = applications / 'Alias.app'
    target.symlink_to(applications / 'Kiosk.app')
    return target


def _system_application(applications, tmp_path):
    return Path('/System/Applications/Calculator.app')


@pytest.mark.parametrize('make_target', [
    _arbitrary_directory, _link_to_the_listed_bundle, _system_application,
], ids=['arbitrary-directory', 'symlink-to-a-listed-bundle', 'system-application'])
def test_a_path_the_inventory_does_not_list_is_refused_and_left_in_place(
        service, inventory, applications, tmp_path, removals, quits, make_target):
    """The negative controls for the boundary: each of these names a directory
    root could remove, and the payload is all that names it."""
    listed = _bundle(applications)
    inventory.append(str(listed))
    target = make_target(applications, tmp_path)
    was_there = os.path.lexists(target)
    was_link = os.path.islink(target)

    result = _uninstall(service, target)

    assert result == (f"Error: Refusing to remove {target}: it is not an "
                      f"application bundle in this machine's software inventory")
    assert removals == []
    assert quits == []
    assert service.firebase_client.progress == []
    assert os.path.lexists(target) == was_there
    assert os.path.islink(target) == was_link
    assert listed.is_dir()


def test_a_process_running_from_the_bundle_is_quit_before_the_bundle_is_removed(
        service, inventory, applications, private_executable, monkeypatch):
    bundle = _bundle(applications)
    inventory.append(str(bundle))
    child = _run_from_inside(bundle, private_executable)
    graceful_terminate = shared_utils.graceful_terminate
    asked = []

    def quit_and_record(pid, *args, **kwargs):
        asked.append((pid, bundle.is_dir()))
        return graceful_terminate(pid, *args, **kwargs)

    monkeypatch.setattr(shared_utils, 'graceful_terminate', quit_and_record)
    try:
        result = _uninstall(service, bundle)
        exited = child.poll() is not None
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(10)

    # Asked while its bundle was still there, and gone by the time the
    # handler returned.
    assert asked == [(child.pid, True)]
    assert exited
    assert result == f'Uninstall completed successfully (removed {bundle})'
    assert not os.path.lexists(bundle)


def test_a_process_that_will_not_quit_keeps_its_bundle(
        service, inventory, applications, private_executable, removals, quits):
    """The negative control for the one above: the process outlives the quit,
    and the bundle it runs from is not removed from under it."""
    bundle = _bundle(applications)
    inventory.append(str(bundle))
    child = _run_from_inside(bundle, private_executable)
    try:
        result = _uninstall(service, bundle)
        still_running = child.poll() is None
    finally:
        child.kill()
        child.wait(10)

    assert quits == [child.pid]
    assert still_running
    assert result == (f'Error: Kiosk is still running (PID {child.pid}), '
                      f'so {bundle} was not removed')
    assert removals == []
    assert (bundle / 'Contents' / 'MacOS' / 'Kiosk').is_file()
    assert service.firebase_client.synced == 0


@pytest.mark.parametrize('code, hinted', [
    (errno.EPERM, True),
    (errno.EACCES, True),
    (errno.EBUSY, False),
], ids=['EPERM', 'EACCES', 'EBUSY'])
def test_a_removal_the_system_refuses_is_a_failure(
        service, inventory, applications, monkeypatch, code, hinted):
    """A permission error - EPERM is what macOS's privacy protections refuse a
    file operation with - carries the App Management hint, and nothing else
    does: a busy volume is not a missing grant."""
    bundle = _bundle(applications)
    inventory.append(str(bundle))

    def refused(path, *args, **kwargs):
        raise OSError(code, os.strerror(code), path)

    monkeypatch.setattr(shutil, 'rmtree', refused)

    result = _uninstall(service, bundle)

    assert result.startswith(f'Error: Could not remove {bundle}: ')
    assert 'completed successfully' not in result
    assert ('App Management' in result) is hinted
    assert ('System Settings > Privacy & Security' in result) is hinted
    assert bundle.is_dir()
    assert service.firebase_client.synced == 0


@pytest.mark.parametrize('installer_type', ['custom', 'pkg'])
def test_an_installer_type_other_than_an_application_bundle_is_refused(
        service, inventory, applications, removals, quits, installer_type):
    bundle = _bundle(applications)
    inventory.append(str(bundle))

    result = _uninstall(service, bundle, installer_type=installer_type)

    assert result == (f"Error: Cannot uninstall Kiosk: only an application bundle "
                      f"can be uninstalled on macOS, and its installer type is "
                      f"'{installer_type}'")
    assert removals == []
    assert quits == []
    assert bundle.is_dir()


def test_a_folder_above_the_bundle_swapped_for_a_link_does_not_redirect_the_removal(
        service, inventory, applications, tmp_path, monkeypatch):
    """The check and the removal are two steps. Swap the Applications folder
    for a link after the inventory has listed the bundle, and a removal that
    resolved the path by name - shutil.rmtree(bundle) - deletes the Kiosk.app
    the link leads to instead."""
    bundle = _bundle(applications)
    inventory.append(str(bundle))
    elsewhere = _bundle(tmp_path / 'Elsewhere')
    listed = osadapter.installed_software

    def listed_then_swapped():
        rows = listed()
        applications.rename(tmp_path / 'Applications.moved')
        applications.symlink_to(tmp_path / 'Elsewhere')
        return rows

    monkeypatch.setattr(osadapter, 'installed_software', listed_then_swapped)

    result = _uninstall(service, bundle)

    assert result.startswith(f'Error: Could not remove {bundle}: ')
    assert (elsewhere / 'Contents' / 'Info.plist').is_file()
    assert (tmp_path / 'Applications.moved' / 'Kiosk.app' / 'Contents' / 'Info.plist').is_file()
    assert service.firebase_client.synced == 0
