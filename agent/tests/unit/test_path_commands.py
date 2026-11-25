"""
unit tests for path_commands — the `check_path` command behind the dashboard's
path warning.

the parsing runs against a fake disk so the windows, macos and linux readings are
all exercised on any machine; the bound and the real probe run against threads
and tmp_path. owlette_service and firebase_client are imported inside the tests,
as elsewhere in this suite, so collection order cannot double-initialise the
cryptography bindings.
"""

import inspect
import json
import os
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import pytest

import path_commands
from command_router import CommandRouter
from path_commands import (
    BROKEN_LINK,
    FILE,
    FILE_LINK,
    FOLDER,
    FOLDER_LINK,
    LINK,
    MISSING,
    NETWORK,
    NOT_ABSOLUTE,
    REFUSED,
    UNKNOWN,
    check_path,
    handle_check_path,
    register_handlers,
    run_bounded,
)


def disk(files=(), folders=(), unknown=(), file_links=(), folder_links=(), broken_links=()):
    """a probe over a fake disk. backslashes fold to slashes, like a windows path."""
    def fold(path):
        return path.replace('\\', '/').rstrip('/') or '/'

    table = {}
    for paths, status in ((files, FILE), (folders, FOLDER), (unknown, UNKNOWN), (file_links, FILE_LINK),
                          (folder_links, FOLDER_LINK), (broken_links, BROKEN_LINK)):
        table.update({fold(p): status for p in paths})
    probed = []

    def probe(path):
        probed.append(path)
        return table.get(fold(path), MISSING)

    probe.probed = probed
    return probe


def win(field, value, probe):
    return check_path(field, value, system='windows', probe=probe)


def linux(field, value, probe):
    return check_path(field, value, system='linux', probe=probe)


def mac(field, value, probe):
    return check_path(field, value, system='macos', probe=probe)


# path / args: a file only if the whole value is one, arguments otherwise

def test_a_path_with_a_lone_dash_in_it_is_one_path():
    value = 'C:/Users/me/OneDrive - Acme/show/main.toe'
    answer = win('file_path', value, disk(files=[value]))
    assert answer['status'] == FILE
    assert answer['path'] == value
    assert answer['rest'] == ''


def test_a_missing_path_with_a_lone_dash_in_it_is_still_one_path():
    value = 'C:/Users/me/OneDrive - Acme/show/main.toe'
    answer = win('file_path', value, disk(folders=['C:/Users/me', 'C:/Users', 'C:/']))
    assert answer['status'] == MISSING
    assert answer['warning'] == MISSING
    assert answer['path'] == value
    assert answer['rest'] == ''
    assert answer['nearest'] == 'C:\\Users\\me'


def test_a_file_then_arguments_is_found_at_the_cut():
    answer = win('file_path', 'C:/show/run.py 8000', disk(files=['C:/show/run.py']))
    assert answer['status'] == FILE
    assert answer['path'] == 'C:/show/run.py'
    assert answer['rest'] == '8000'
    assert answer['warning'] is None


def test_a_dotted_word_inside_a_file_name_stays_whole():
    value = 'C:/shows/Show v1.2 final.toe'
    answer = win('file_path', value, disk(folders=['C:/shows', 'C:/']))
    assert answer['status'] == MISSING
    assert answer['path'] == value
    assert answer['rest'] == ''
    assert answer['nearest'] == 'C:\\shows'


def test_a_missing_file_then_arguments_keeps_the_arguments_apart():
    answer = win('file_path', 'C:/show/gone.py 8000', disk(folders=['C:/show', 'C:/']))
    assert answer['status'] == MISSING
    assert answer['path'] == 'C:/show/gone.py'
    assert answer['rest'] == '8000'
    assert answer['nearest'] == 'C:\\show'


def test_the_path_ends_at_the_last_piece_with_an_extension():
    answer = win('file_path', 'C:/show/run.py C:/other/x.toe 8000', disk(folders=['C:/']))
    assert answer['path'] == 'C:/show/run.py C:/other/x.toe'
    assert answer['rest'] == '8000'


@pytest.mark.parametrize('argument', ['8.5', '127.0.0.1'])
def test_a_dotted_number_is_not_an_extension(argument):
    answer = win('file_path', f'C:/show/run.py {argument}', disk(folders=['C:/show', 'C:/']))
    assert answer['path'] == 'C:/show/run.py'
    assert answer['rest'] == argument


def test_arguments_are_cut_at_the_first_flag_before_any_extension():
    answer = win('file_path', 'C:/show/gone.py --config a.json', disk(folders=['C:/show', 'C:/']))
    assert answer['path'] == 'C:/show/gone.py'
    assert answer['rest'] == '--config a.json'


def test_a_piece_with_a_slash_in_it_is_not_a_flag():
    answer = win('file_path', 'C:/show -v2/gone.toe', disk(folders=['C:/show -v2', 'C:/']))
    assert answer['path'] == 'C:/show -v2/gone.toe'
    assert answer['rest'] == ''


def test_a_slash_flag_counts_only_on_windows():
    assert win('file_path', 'C:\\show\\gone.exe /S', disk(folders=['C:\\show', 'C:\\']))['rest'] == '/S'
    assert linux('file_path', '/show/gone /S', disk(folders=['/show', '/']))['rest'] == ''


def test_no_extension_anywhere_stays_whole():
    value = 'C:/shows/Show v1.2 final'
    answer = win('file_path', value, disk(folders=['C:/shows', 'C:/']))
    assert answer['path'] == value
    assert answer['rest'] == ''


def test_a_quoted_file_then_arguments():
    answer = win('file_path', '"C:/my show/run.py" 8000', disk(files=['C:/my show/run.py']))
    assert answer['status'] == FILE
    assert answer['path'] == 'C:/my show/run.py'
    assert answer['rest'] == '8000'


def test_a_quoted_missing_file_warns_and_keeps_the_arguments():
    answer = win('file_path', '"C:/my show/run.py" 8000', disk(folders=['C:/my show', 'C:/']))
    assert answer['status'] == MISSING
    assert answer['path'] == 'C:/my show/run.py'
    assert answer['rest'] == '8000'
    assert answer['nearest'] == 'C:\\my show'


@pytest.mark.parametrize('value', ['--fullscreen', '-f C:/x.toe', '8000', 'show.toe', 'sub/show.toe'])
def test_plain_arguments_and_relative_paths_are_not_checked(value):
    probe = disk()
    answer = win('file_path', value, probe)
    assert answer['status'] == UNKNOWN
    assert answer['warning'] is None
    assert probe.probed == []


def test_a_missing_file_then_a_flag_keeps_the_flag_apart():
    answer = win('file_path', 'C:/show/main.toe --fullscreen', disk(folders=['C:/show', 'C:/']))
    assert answer['status'] == MISSING
    assert answer['path'] == 'C:/show/main.toe'
    assert answer['rest'] == '--fullscreen'


def test_a_flag_is_found_before_a_dotted_flag_value_can_look_like_a_file():
    answer = win('file_path', 'C:/show/main.toe 8000 --out=x.png', disk(folders=['C:/show', 'C:/']))
    assert answer['path'] == 'C:/show/main.toe'
    assert answer['rest'] == '8000 --out=x.png'


def test_a_dot_in_a_folder_name_does_not_split_the_path():
    value = 'C:/app.v2 beta/x.exe'
    answer = win('file_path', value, disk(folders=['C:/']))
    assert answer['path'] == value
    assert answer['rest'] == ''


@pytest.mark.parametrize('value,folder', [
    ('C:/show/sub --x', 'C:/show/sub'),
    ('"C:/my show/dir" 8000', 'C:/my show/dir'),
])
def test_an_existing_folder_with_arguments_stays_silent(value, folder):
    answer = win('file_path', value, disk(folders=[folder, 'C:/']))
    assert answer['status'] == FOLDER
    assert answer['warning'] is None


def test_an_environment_variable_in_path_args_is_not_checked():
    probe = disk()
    answer = win('file_path', 'C:/%SHOW%/main.toe', probe)
    assert answer['status'] == UNKNOWN
    assert answer['warning'] is None
    assert probe.probed == []


def test_path_args_stops_at_the_first_cut_it_cannot_read():
    answer = win('file_path', 'C:/show/a b c', disk(unknown=['C:/show/a b c']))
    assert answer['status'] == UNKNOWN
    assert answer['warning'] is None


def test_path_args_on_a_drive_owlette_cannot_see_stays_silent():
    # a drive mapped in the user's session is invisible to the agent, and the
    # launcher hands this field to the user's session as text.
    answer = win('file_path', 'Z:/show/main.toe', disk())
    assert answer['status'] == UNKNOWN
    assert answer['warning'] is None


def test_the_number_of_cuts_tried_is_bounded():
    value = 'C:/a ' + ' '.join(f'w{i}' for i in range(200))
    probe = disk(folders=['C:/'])
    win('file_path', value, probe)
    assert len(probe.probed) < 15


# launch target and working directory

def test_a_launch_target_that_is_not_absolute_warns_without_a_probe():
    probe = disk()
    answer = win('exe_path', 'notepad.exe', probe)
    assert answer['status'] == UNKNOWN
    assert answer['warning'] == NOT_ABSOLUTE
    assert probe.probed == []


def test_a_relative_working_directory_is_not_checked():
    probe = disk()
    answer = win('cwd', 'show', probe)
    assert answer['status'] == UNKNOWN
    assert answer['warning'] is None
    assert probe.probed == []


def test_a_missing_launch_target_walks_up_to_the_nearest_folder():
    answer = win('exe_path', 'C:/a/b/c/app.exe', disk(folders=['C:/a', 'C:/']))
    assert answer['status'] == MISSING
    assert answer['warning'] == MISSING
    assert answer['path'] == 'C:/a/b/c/app.exe'
    assert answer['nearest'] == 'C:\\a'


def test_a_launch_target_on_a_missing_drive_warns_with_nothing_to_browse():
    # the agent cannot start this one, whatever the user's session can see.
    answer = win('exe_path', 'Z:/app.exe', disk())
    assert answer['status'] == MISSING
    assert answer['warning'] == MISSING
    assert answer['nearest'] is None


def test_the_walk_up_steps_over_a_file_and_stops_at_something_unreadable():
    assert win('exe_path', 'C:/a/run.py/app.exe', disk(files=['C:/a/run.py'], folders=['C:/a', 'C:/']))['nearest'] == 'C:\\a'
    assert win('exe_path', 'C:/a/b/app.exe', disk(unknown=['C:/a/b'], folders=['C:/a', 'C:/']))['nearest'] is None


def test_the_walk_up_takes_a_folder_link_for_a_folder():
    assert win('exe_path', 'C:/a/b/app.exe', disk(folder_links=['C:/a/b'], folders=['C:/a', 'C:/']))['nearest'] == 'C:\\a\\b'


def test_an_existing_launch_target_does_not_warn():
    answer = win('exe_path', 'C:/app.exe', disk(files=['C:/app.exe']))
    assert answer['status'] == FILE
    assert answer['warning'] is None


def test_an_unreadable_path_is_unknown_never_missing():
    answer = win('cwd', 'C:/locked', disk(unknown=['C:/locked']))
    assert answer['status'] == UNKNOWN
    assert answer['warning'] is None


def test_a_folder_as_launch_target_warns_and_browse_starts_inside_it():
    answer = win('exe_path', 'C:/show/app', disk(folders=['C:/show/app', 'C:/show', 'C:/']))
    assert answer['status'] == FOLDER
    assert answer['warning'] == FOLDER
    assert answer['nearest'] == 'C:\\show\\app'


def test_a_file_as_working_directory_warns_and_browse_starts_in_its_parent():
    answer = win('cwd', 'C:/show/app.exe', disk(files=['C:/show/app.exe'], folders=['C:/show', 'C:/']))
    assert answer['status'] == FILE
    assert answer['warning'] == FILE
    assert answer['nearest'] == 'C:\\show'


@pytest.mark.parametrize('value', ['/Applications/Show.app', '/Applications/Show.app/'])
def test_a_mac_app_bundle_launches_as_a_folder(value):
    answer = mac('exe_path', value, disk(folders=['/Applications/Show.app', '/Applications', '/']))
    assert answer['status'] == FOLDER
    assert answer['warning'] is None


def test_an_app_named_folder_off_a_mac_is_still_a_folder():
    assert linux('exe_path', '/opt/Show.app', disk(folders=['/opt/Show.app']))['warning'] == FOLDER


def test_a_plain_folder_as_launch_target_warns_on_a_mac():
    assert mac('exe_path', '/Applications', disk(folders=['/Applications']))['warning'] == FOLDER


def test_a_folder_in_path_args_does_not_warn():
    assert win('file_path', 'C:/show', disk(folders=['C:/show', 'C:/']))['warning'] is None


# symbolic links: refused where the launchers refuse them

@pytest.mark.parametrize('kind,status', [('file_links', FILE), ('folder_links', FOLDER), ('broken_links', MISSING)])
@pytest.mark.parametrize('field', ['exe_path', 'cwd'])
@pytest.mark.parametrize('check,value,parent', [(win, 'C:/show/link', 'C:\\show'), (linux, '/show/link', '/show'), (mac, '/show/link', '/show')])
def test_any_link_as_launch_target_or_working_directory_warns(field, kind, status, check, value, parent):
    answer = check(field, value, disk(**{kind: [value]}, folders=[parent]))
    assert answer['warning'] == LINK
    assert answer['status'] == status
    assert answer['path'] == value
    assert answer['nearest'] == parent


@pytest.mark.parametrize('kind', ['file_links', 'folder_links', 'broken_links'])
def test_any_link_as_the_whole_of_path_args_warns_on_windows(kind):
    answer = win('file_path', 'C:/show/link', disk(**{kind: ['C:/show/link']}, folders=['C:/show']))
    assert answer['warning'] == LINK
    assert answer['nearest'] == 'C:\\show'


@pytest.mark.parametrize('check', [linux, mac])
def test_off_windows_only_a_link_to_a_file_is_refused_in_path_args(check):
    assert check('file_path', '/show/link', disk(file_links=['/show/link'], folders=['/show']))['warning'] == LINK
    assert check('file_path', '/show/link', disk(folder_links=['/show/link'], folders=['/show']))['warning'] is None
    assert check('file_path', '/show/link', disk(broken_links=['/show/link'], folders=['/show']))['warning'] is None


def test_a_link_at_a_cut_of_path_args_is_only_arguments_to_the_launcher():
    answer = win('file_path', 'C:/show/link.toe 8000', disk(file_links=['C:/show/link.toe'], folders=['C:/show']))
    assert answer['status'] == FILE
    assert answer['warning'] is None
    assert answer['rest'] == '8000'


# values starting with two slashes

@pytest.mark.parametrize('field', ['exe_path', 'cwd', 'file_path', 'folder'])
@pytest.mark.parametrize('value', ['\\\\nas\\show\\x.exe', '//nas/show/x.exe'])
def test_a_network_path_warns_without_a_probe(field, value):
    probe = disk()
    answer = win(field, value, probe)
    assert answer['status'] == UNKNOWN
    assert answer['warning'] == NETWORK
    assert probe.probed == []


@pytest.mark.parametrize('field', ['exe_path', 'cwd', 'file_path', 'folder'])
@pytest.mark.parametrize('value', ['\\\\?\\C:\\x.exe', '\\\\.\\pipe\\show', '//flag', '\\\\server'])
def test_two_slashes_that_are_no_share_are_refused_without_a_probe(field, value):
    probe = disk()
    answer = win(field, value, probe)
    assert answer['status'] == UNKNOWN
    assert answer['warning'] == REFUSED
    assert probe.probed == []


@pytest.mark.parametrize('field,value', [('exe_path', '/\\nas\\show\\x.exe'), ('file_path', '\\/nas/show/x.toe')])
def test_mixed_slashes_are_a_share_where_the_launcher_folds_them_first(field, value):
    probe = disk()
    assert win(field, value, probe)['warning'] == NETWORK
    assert probe.probed == []


def test_mixed_slashes_as_a_working_directory_are_only_relative():
    # `_validate_path` sees this field as typed, and it starts with neither `\\` nor `//`.
    probe = disk()
    answer = win('cwd', '/\\nas\\show', probe)
    assert answer['warning'] is None
    assert probe.probed == []


def test_a_network_path_keeps_the_arguments_after_it():
    answer = win('file_path', '\\\\nas\\show\\x.toe --fullscreen', disk())
    assert answer['warning'] == NETWORK
    assert answer['path'] == '\\\\nas\\show\\x.toe'
    assert answer['rest'] == '--fullscreen'


def test_a_quoted_network_path_in_path_args_is_only_arguments_to_the_launcher():
    probe = disk()
    answer = win('file_path', '"\\\\nas\\my show\\x.toe" --x', probe)
    assert answer['warning'] is None
    assert probe.probed == []


@pytest.mark.parametrize('field', ['exe_path', 'file_path'])
def test_a_trailing_separator_on_a_file_is_dropped_as_abspath_does(field):
    answer = win(field, 'C:\\x.exe\\', disk(files=['C:\\x.exe']))
    assert answer['status'] == FILE
    assert answer['warning'] is None


def test_a_mac_or_linux_agent_has_no_network_paths_and_no_drive_letters():
    assert linux('exe_path', '//usr/bin/x', disk(files=['//usr/bin/x']))['status'] == FILE
    assert linux('exe_path', 'C:/app.exe', disk())['warning'] == NOT_ABSOLUTE
    answer = linux('exe_path', '/opt/show/app', disk(folders=['/opt', '/']))
    assert answer['status'] == MISSING
    assert answer['nearest'] == '/opt'


def test_a_linux_path_args_with_a_slash_word():
    answer = linux('file_path', '/show/run.py /tmp/x', disk(folders=['/show', '/']))
    assert answer['path'] == '/show/run.py'
    assert answer['rest'] == '/tmp/x'


# the folder browser

def scan(folders=(), files=(), truncated=False):
    return lambda path: {'folders': list(folders), 'files': list(files), 'truncated': truncated}


def test_a_folder_answers_its_entries_and_its_parent():
    answer = check_path('folder', 'C:/show/', system='windows', probe=disk(folders=['C:/show', 'C:/']),
                        scan=scan(folders=['a'], files=['b.toe']))
    assert answer['status'] == FOLDER
    assert answer['path'] == 'C:\\show'
    assert answer['parent'] == 'C:\\'
    assert answer['folders'] == ['a']
    assert answer['files'] == ['b.toe']


def test_a_link_to_a_folder_can_be_browsed():
    answer = check_path('folder', 'C:/link', system='windows', probe=disk(folder_links=['C:/link']), scan=scan(files=['a']))
    assert answer['status'] == FOLDER
    assert answer['files'] == ['a']


def test_a_drive_root_has_no_parent():
    answer = check_path('folder', 'C:\\', system='windows', probe=disk(folders=['C:/']), scan=scan())
    assert answer['path'] == 'C:\\'
    assert answer['parent'] is None


def test_a_folder_that_went_missing_answers_the_nearest_one():
    answer = check_path('folder', 'C:/show/gone', system='windows', probe=disk(folders=['C:/show', 'C:/']), scan=scan())
    assert answer['status'] == MISSING
    assert answer['nearest'] == 'C:\\show'
    assert 'files' not in answer


def test_a_folder_that_cannot_be_read_is_unknown():
    def refused(path):
        raise PermissionError(path)

    answer = check_path('folder', 'C:/locked', system='windows', probe=disk(folders=['C:/locked', 'C:/']), scan=refused)
    assert answer['status'] == UNKNOWN
    assert 'files' not in answer


def test_entries_are_sorted_names_and_kinds_only(tmp_path):
    (tmp_path / 'Zed').mkdir()
    (tmp_path / 'alpha').mkdir()
    (tmp_path / 'b.txt').write_text('secret contents')
    (tmp_path / 'A.txt').write_text('x')

    answer = check_path('folder', str(tmp_path))

    assert answer['status'] == FOLDER
    assert answer['folders'] == ['alpha', 'Zed']
    assert answer['files'] == ['A.txt', 'b.txt']
    assert answer['truncated'] is False
    assert 'secret contents' not in json.dumps(answer)


def test_entries_are_capped_by_count(tmp_path, monkeypatch):
    monkeypatch.setattr(path_commands, 'MAX_ENTRIES', 3)
    for i in range(5):
        (tmp_path / f'f{i}').write_text('')

    answer = check_path('folder', str(tmp_path))

    assert len(answer['files']) == 3
    assert answer['truncated'] is True


class FakeEntry:
    def __init__(self, name):
        self.name = name

    def is_dir(self):
        return False


class FakeScandir:
    def __init__(self, names):
        self.names = names

    def __enter__(self):
        return iter(FakeEntry(name) for name in self.names)

    def __exit__(self, *exc):
        return False


def test_entries_are_capped_by_utf8_bytes_as_they_sit_in_the_doc(monkeypatch):
    names = ['\u5834' * 255 + str(i) for i in range(200)]
    monkeypatch.setattr(os, 'scandir', lambda path: FakeScandir(names))

    listing = path_commands._scan('C:/show')

    encoded = len(json.dumps(listing['files'], ensure_ascii=False).encode('utf-8'))
    assert encoded <= path_commands.MAX_LISTING_BYTES + 2
    assert listing['truncated'] is True
    assert len(listing['files']) < 200


def test_a_name_that_cannot_be_stored_is_left_out_rather_than_failing_the_answer(monkeypatch):
    monkeypatch.setattr(os, 'scandir', lambda path: FakeScandir(['ok.txt', 'bad\udc80.txt']))

    assert path_commands._scan('C:/show')['files'] == ['ok.txt']


def largest_answer():
    """the largest answer a value of the route's limit can produce."""
    value = 'C:\\' + '\u5834' * 1000 + '\\' + '\u5834' * 15
    names = ['\u5834' * 255 + str(i) for i in range(200)]
    real_scandir = os.scandir
    os.scandir = lambda path: FakeScandir(names)
    try:
        answer = check_path('folder', value, system='windows', probe=disk(folders=[value, 'C:/']), scan=path_commands._scan)
    finally:
        os.scandir = real_scandir
    return json.dumps(answer, ensure_ascii=False)


def test_the_largest_answer_stays_under_its_stated_limit():
    assert len(largest_answer().encode('utf-8')) <= path_commands.MAX_ANSWER_BYTES


def test_the_answer_is_not_doubled_by_ascii_escapes(tmp_path):
    (tmp_path / '\u5834.toe').write_text('')
    result = handle_check_path({'field': 'folder', 'value': str(tmp_path)}, 'cmd-1', None)
    assert '\u5834' in result
    assert '\\u5834' not in result


# the answers can't fill the machine's completed doc

class FakeDoc:
    """the one REST document this path writes, with set(merge) and field deletes."""

    def __init__(self):
        self.fields = {}
        self.fail_updates = False

    def set(self, data, merge=False):
        self.fields.update(data)

    def update(self, data):
        from firestore_rest_client import DELETE_FIELD
        if self.fail_updates:
            raise RuntimeError('network down')
        for key, value in data.items():
            if value is DELETE_FIELD:
                self.fields.pop(key, None)
            else:
                self.fields[key] = value


class FakeDb:
    def __init__(self):
        self.completed = FakeDoc()
        self.pending = FakeDoc()

    def collection(self, name):
        return self

    def document(self, name):
        return {'completed': self.completed, 'pending': self.pending}.get(name, self)

    def get_document(self, path, **kwargs):
        return dict(self.completed.fields)


def make_client():
    from firebase_client import FirebaseClient
    client = FirebaseClient.__new__(FirebaseClient)
    client.connection_manager = SimpleNamespace(is_connected=True)
    client._removed = False
    client.db = FakeDb()
    client.site_id = 'site'
    client.machine_id = 'machine'
    client.logger = SimpleNamespace(
        info=lambda *a, **k: None, debug=lambda *a, **k: None,
        warning=lambda *a, **k: None, error=lambda *a, **k: None)
    client._cancelled_commands = set()
    client._seen_commands = set()
    client._check_path_answers = []
    client._check_path_answers_lock = threading.Lock()
    client._upload_metrics = lambda metrics: pytest.fail('a check changes nothing the dashboard shows')
    return client


CHECK = {'type': 'check_path'}


def doc_bytes(client):
    return len(json.dumps(
        {key: {k: v for k, v in row.items() if k != 'completedAt'} for key, row in client.db.completed.fields.items()},
        ensure_ascii=False).encode('utf-8'))


def test_thirty_of_the_largest_answers_a_minute_cannot_fill_the_doc():
    from firebase_client import FirebaseClient
    client = make_client()
    answer = largest_answer()

    for i in range(30):
        client.finish_command(f'cmd_{i}', dict(CHECK), answer)

    rows = client.db.completed.fields
    assert len(rows) == FirebaseClient._CHECK_PATH_ANSWERS_KEPT
    assert doc_bytes(client) < 256 * 1024
    assert 'cmd_29' in rows
    assert 'cmd_0' not in rows


def test_a_day_of_checks_stays_as_small_as_a_minute_of_them():
    from firebase_client import FirebaseClient
    client = make_client()

    for i in range(1000):
        client.finish_command(f'cmd_{i}', dict(CHECK), '{}')

    assert len(client.db.completed.fields) == FirebaseClient._CHECK_PATH_ANSWERS_KEPT
    assert len(client._check_path_answers) == FirebaseClient._CHECK_PATH_ANSWERS_KEPT


def test_the_newest_answers_survive_so_a_dashboard_listening_can_read_them():
    from firebase_client import FirebaseClient
    client = make_client()
    kept = FirebaseClient._CHECK_PATH_ANSWERS_KEPT

    for i in range(kept):
        client.finish_command(f'cmd_{i}', dict(CHECK), '{}')

    assert sorted(client.db.completed.fields) == sorted(f'cmd_{i}' for i in range(kept))


def test_only_check_path_rows_are_dropped():
    client = make_client()
    client.db.completed.fields['cmd_reboot'] = {'status': 'completed', 'result': 'rebooting'}

    for i in range(30):
        client.finish_command(f'cmd_{i}', dict(CHECK), '{}')

    assert 'cmd_reboot' in client.db.completed.fields


def test_a_failed_drop_is_tried_again_on_the_next_check():
    from firebase_client import FirebaseClient
    client = make_client()
    kept = FirebaseClient._CHECK_PATH_ANSWERS_KEPT
    for i in range(kept):
        client.finish_command(f'cmd_{i}', dict(CHECK), '{}')

    client.db.completed.fail_updates = True
    client.finish_command('cmd_late_1', dict(CHECK), '{}')
    assert 'cmd_0' in client.db.completed.fields

    client.db.completed.fail_updates = False
    client.finish_command('cmd_late_2', dict(CHECK), '{}')
    assert 'cmd_0' not in client.db.completed.fields
    assert 'cmd_1' not in client.db.completed.fields


def test_answers_left_by_an_earlier_run_are_dropped_too():
    from firebase_client import FirebaseClient
    client = make_client()
    kept = FirebaseClient._CHECK_PATH_ANSWERS_KEPT
    for i in range(kept + 5):
        client.db.completed.fields[f'old_{i}'] = {'status': 'completed', 'type': 'check_path', 'result': '{}'}
    client.db.completed.fields['cmd_reboot'] = {'status': 'completed', 'type': 'reboot_machine', 'result': 'x'}

    client._seed_seen_commands()
    client.finish_command('cmd_new', dict(CHECK), '{}')

    rows = [key for key, row in client.db.completed.fields.items() if row.get('type') == 'check_path']
    assert len(rows) == kept
    assert 'cmd_new' in rows
    assert 'cmd_reboot' in client.db.completed.fields


def test_other_commands_still_push_metrics():
    client = make_client()
    pushed = []
    client._upload_metrics = pushed.append

    client.finish_command('cmd_1', {'type': 'kill_process'}, 'done')

    assert len(pushed) == 1


# the real probe

def test_the_real_probe_reads_files_folders_and_absences(tmp_path):
    (tmp_path / 'f').write_text('')
    assert path_commands._stat(str(tmp_path / 'f')) == FILE
    assert path_commands._stat(str(tmp_path)) == FOLDER
    assert path_commands._stat(str(tmp_path / 'nope')) == MISSING


def test_the_real_probe_calls_a_denied_path_unknown(monkeypatch):
    def denied(path):
        raise PermissionError(13, 'denied', path)

    monkeypatch.setattr(os, 'lstat', denied)
    assert path_commands._stat('C:/locked') == UNKNOWN


def test_the_real_probe_calls_a_dead_share_unknown_though_windows_says_not_found(monkeypatch):
    # python maps ERROR_BAD_NETPATH to FileNotFoundError; the share may just be down.
    error = FileNotFoundError(2, 'bad net path')
    error.winerror = 53

    def dead(path):
        raise error

    monkeypatch.setattr(os, 'lstat', dead)
    assert path_commands._stat('Z:/show') == UNKNOWN


def test_the_real_probe_calls_a_bad_value_unknown():
    assert path_commands._stat('C:/a\x00b') == UNKNOWN


def make_symlink(target, link, is_dir=False):
    try:
        os.symlink(target, link, target_is_directory=is_dir)
    except (OSError, NotImplementedError) as e:
        pytest.skip(f'cannot create a symbolic link here: {e}')


def test_the_real_probe_sees_links_as_links(tmp_path):
    (tmp_path / 'f').write_text('')
    (tmp_path / 'd').mkdir()
    make_symlink(tmp_path / 'f', tmp_path / 'file-link')
    make_symlink(tmp_path / 'd', tmp_path / 'folder-link', is_dir=True)
    make_symlink(tmp_path / 'nothing', tmp_path / 'broken-link')

    assert path_commands._stat(str(tmp_path / 'file-link')) == FILE_LINK
    assert path_commands._stat(str(tmp_path / 'folder-link')) == FOLDER_LINK
    assert path_commands._stat(str(tmp_path / 'broken-link')) == BROKEN_LINK


def test_the_real_probe_agrees_with_the_launchers_check(tmp_path):
    (tmp_path / 'f').write_text('')
    make_symlink(tmp_path / 'f', tmp_path / 'link')
    assert os.path.islink(tmp_path / 'link')
    assert path_commands._stat(str(tmp_path / 'link')) == FILE_LINK
    assert not os.path.islink(tmp_path / 'f')
    assert path_commands._stat(str(tmp_path / 'f')) == FILE


@pytest.mark.skipif(sys.platform != 'win32', reason='junctions are a windows thing')
def test_a_junction_is_not_a_link(tmp_path):
    (tmp_path / 'real').mkdir()
    junction = tmp_path / 'junction'
    subprocess.run(['cmd', '/c', 'mklink', '/J', str(junction), str(tmp_path / 'real')],
                   check=True, capture_output=True)

    assert not os.path.islink(junction)
    assert path_commands._stat(str(junction)) == FOLDER
    assert check_path('cwd', str(junction))['warning'] is None


# the bound

def test_a_hung_probe_answers_unknown_inside_the_bound():
    release = threading.Event()

    def hung(field, value):
        release.wait(10)
        return {'status': MISSING}

    started = time.monotonic()
    answer = run_bounded('exe_path', 'Z:/app.exe', bound=0.05, check=hung)
    elapsed = time.monotonic() - started
    release.set()

    assert answer['status'] == UNKNOWN
    assert answer['warning'] is None
    assert elapsed < 2


def test_a_check_that_raises_answers_unknown():
    def broken(field, value):
        raise RuntimeError('boom')

    assert run_bounded('exe_path', 'C:/app.exe', bound=2, check=broken)['status'] == UNKNOWN


def test_wedged_probes_cannot_pile_up_threads(monkeypatch):
    monkeypatch.setattr(path_commands, '_slots', threading.BoundedSemaphore(2))
    release = threading.Event()
    calls = []

    def hung(field, value):
        calls.append(value)
        release.wait(10)
        return {'status': MISSING}

    run_bounded('exe_path', 'a', bound=0.01, check=hung)
    run_bounded('exe_path', 'b', bound=0.01, check=hung)
    third = run_bounded('exe_path', 'c', bound=2, check=hung)

    assert third['status'] == UNKNOWN
    assert calls == ['a', 'b']
    release.set()


# the handler and its dispatch

def test_register_handlers_registers_check_path():
    router = CommandRouter()
    register_handlers(router)
    assert router.registered_types() == ['check_path']


def test_check_path_rides_the_fast_lane():
    # the slow lane is one worker: a probe would wait behind an install
    from firebase_client import FirebaseClient
    assert 'check_path' in FirebaseClient._FAST_COMMAND_TYPES


def test_init_registers_the_path_handler():
    from owlette_service import OwletteService
    source = inspect.getsource(OwletteService._init_state)
    assert 'from path_commands import register_handlers' in source
    assert '_register_path_handlers(self._command_router)' in source


def test_the_handler_answers_json(tmp_path):
    result = handle_check_path(
        {'type': 'check_path', 'field': 'cwd', 'value': str(tmp_path)}, 'cmd-1', None)
    assert json.loads(result)['status'] == FOLDER


@pytest.mark.parametrize('cmd', [
    {},
    {'field': 'nope', 'value': 'C:/x'},
    {'field': 'exe_path'},
    {'field': 'exe_path', 'value': 7},
    {'field': 'exe_path', 'value': '   '},
    {'field': 'exe_path', 'value': 'C:/' + 'x' * 2000},
])
def test_the_handler_refuses_bad_input(cmd):
    assert handle_check_path(cmd, 'cmd-1', None).startswith('Error:')


def test_two_checks_inside_five_seconds_are_both_answered(tmp_path):
    # three fields saved together, and a browser opening folders, are not a
    # burst: the per-type throttle would refuse the second inside five seconds.
    from owlette_service import OwletteService
    router = CommandRouter()
    register_handlers(router)
    svc = SimpleNamespace(
        _command_rate_limits={},
        COMMAND_RATE_LIMIT_SECONDS=5,
        _command_router=router,
    )
    svc.handle_firebase_command = OwletteService.handle_firebase_command.__get__(svc, OwletteService)
    cmd = {'type': 'check_path', 'field': 'cwd', 'value': str(tmp_path)}

    first = svc.handle_firebase_command('c1', dict(cmd))
    second = svc.handle_firebase_command('c2', dict(cmd))

    assert json.loads(first)['status'] == FOLDER
    assert json.loads(second)['status'] == FOLDER
