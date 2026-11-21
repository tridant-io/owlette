"""log_bundle.build_log_zip: what goes in the issue log zip and what never does."""

import os
import sys
import time
import zipfile
from types import SimpleNamespace

import pytest

import log_bundle

DAY = 24 * 3600
# the fixture stubs the runner out; a test that wants the real one takes it from here
_REAL_RUN = log_bundle._run

# (app id, folder in the zip, log file prefix) for each per-user app log
APPS = [
    ('app.owlette.desktop', 'desktop', 'owlette-desktop'),
    ('app.owlette.swoop-viewer', 'viewer', 'owlette-swoop-viewer'),
]

# the commands each OS runs, for the manifest lines a stubbed run leaves
COMMAND_ENTRIES = {
    'win32': ['system/application-crashes.txt'],
    'linux': ['system/journal-owlette-agent.txt', 'system/journal-owlette-update.txt'],
}.get(sys.platform, [])
# the macOS install root, as the runtime's paths name it
MAC_RUNTIME = '/Library/Application Support/Owlette/runtime'


def _not_run(argv, timeout, cap):
    raise log_bundle._Skip(f'{argv[0]} not run in tests')


def _as_platform(monkeypatch, name):
    """Run log_bundle's per-OS branches for `name` on whatever OS runs the test."""
    monkeypatch.setattr(log_bundle, 'sys', SimpleNamespace(platform=name))


@pytest.fixture
def tree(tmp_path, monkeypatch):
    """A data root with logs/ and tmp/, the secrets beside them, and per-user log folders."""
    data = tmp_path / 'data'
    logs = data / 'logs'
    (logs / 'swoop').mkdir(parents=True)
    (logs / 'roost_scrub_reports').mkdir()
    (logs / 'service.log').write_bytes(b'service line\n')
    (logs / 'swoop' / 'host.log').write_bytes(b'swoop line\n')
    (logs / 'roost_scrub_reports' / 'scrub.json').write_text('{}')
    (data / '.tokens.enc').write_bytes(b'TOKEN-SECRET')
    (data / 'config').mkdir()
    (data / 'config' / 'config.json').write_text('CONFIG-SECRET')
    (data / 'tmp').mkdir()
    (data / 'tmp' / 'status_writer.log').write_bytes(b'status line\n')
    (data / 'tmp' / 'status_writer.log.1').write_bytes(b'older status line\n')
    (data / 'tmp' / 'session_state.json').write_text('TMP-OTHER')

    dirs = {}
    for app_id, folder, prefix in APPS:
        directory = tmp_path / folder
        directory.mkdir()
        (directory / f'{prefix}.log').write_bytes(f'{folder} line\n'.encode())
        (directory / 'settings.json').write_text(f'{folder.upper()}-OTHER')
        dirs[app_id] = directory
    temp = tmp_path / 'temp'
    temp.mkdir()
    reports = tmp_path / 'reports'
    reports.mkdir()
    home = tmp_path / 'home'
    user_reports = home / 'Library' / 'Logs' / 'DiagnosticReports'
    user_reports.mkdir(parents=True)
    var_log = tmp_path / 'var-log'
    var_log.mkdir()

    monkeypatch.setattr(log_bundle, '_data_root', lambda: str(data))
    monkeypatch.setattr(log_bundle, '_install_root', lambda: str(data))
    monkeypatch.setattr(log_bundle, '_temp_dir', lambda: str(temp))
    monkeypatch.setattr(log_bundle, '_user_log_dir', lambda app_id: (str(dirs[app_id]), None))
    monkeypatch.setattr(log_bundle, '_console_home', lambda: (str(home), None))
    monkeypatch.setattr(log_bundle, 'CRASH_REPORT_DIR', str(reports))
    monkeypatch.setattr(log_bundle, 'INSTALL_LOG_DIR', str(var_log))
    monkeypatch.setattr(log_bundle, '_run', _not_run)
    return {'root': tmp_path, 'data': data, 'logs': logs, 'tmp': data / 'tmp',
            'temp': temp, 'dirs': dirs, 'desktop': dirs['app.owlette.desktop'],
            'reports': reports, 'user_reports': user_reports, 'var_log': var_log}


def _app_dirs(tree, owner_for):
    """A `_user_log_dir` stub giving each app the uid `owner_for(app_id)`."""
    return lambda app_id: (str(tree['dirs'][app_id]), owner_for(app_id))


def _build(tmp_path, **kwargs):
    dest = tmp_path / 'out' / 'logs.zip'
    dest.parent.mkdir(exist_ok=True)
    result = log_bundle.build_log_zip(str(dest), **kwargs)
    with zipfile.ZipFile(dest) as zf:
        names = zf.namelist()
        manifest = zf.read('manifest.txt').decode()
    return result, names, manifest, dest


def _read(dest, name):
    with zipfile.ZipFile(dest) as zf:
        return zf.read(name)


def _blob(dest):
    with zipfile.ZipFile(dest) as zf:
        return b''.join(zf.read(n) for n in zf.namelist())


def _symlink(target, link):
    try:
        os.symlink(target, link)
    except (OSError, NotImplementedError) as e:
        pytest.skip(f'symlinks unavailable here: {e}')


def _reasons(result):
    return dict(result['skipped'])


def test_normal_tree_includes_every_source(tree):
    result, names, manifest, dest = _build(tree['root'])

    assert sorted(names) == [
        'desktop/owlette-desktop.log',
        'logs/roost_scrub_reports/scrub.json',
        'logs/service.log',
        'logs/swoop/host.log',
        'manifest.txt',
        'system/data-root.txt',
        'tmp/status_writer.log',
        'tmp/status_writer.log.1',
        'viewer/owlette-swoop-viewer.log',
    ]
    assert names[-1] == 'manifest.txt'
    assert result['files'] == 8
    assert result['size'] == dest.stat().st_size
    with zipfile.ZipFile(dest) as zf:
        assert zf.read('logs/swoop/host.log') == b'swoop line\n'
        assert zf.read('viewer/owlette-swoop-viewer.log') == b'viewer line\n'
        assert zf.read('tmp/status_writer.log') == b'status line\n'
        assert all(info.compress_type == zipfile.ZIP_DEFLATED for info in zf.infolist())
    for entry in COMMAND_ENTRIES:
        assert entry in _reasons(result)


def test_nothing_outside_the_listed_sources(tree):
    _, names, _, dest = _build(tree['root'])

    assert all(n.startswith(('logs/', 'tmp/status_writer.log', 'desktop/', 'viewer/'))
               or n in ('manifest.txt', 'system/data-root.txt') for n in names)
    blob = _blob(dest)
    for secret in (b'TOKEN-SECRET', b'CONFIG-SECRET', b'TMP-OTHER', b'DESKTOP-OTHER',
                   b'VIEWER-OTHER'):
        assert secret not in blob


@pytest.mark.skipif(sys.platform == 'win32', reason='file mode is POSIX')
def test_dest_is_created_owner_only(tree):
    _, _, _, dest = _build(tree['root'])
    assert dest.stat().st_mode & 0o777 == 0o600


def test_manifest_lists_included_and_skipped(tree):
    old = tree['logs'] / 'old.log'
    old.write_bytes(b'old\n')
    stale = time.time() - 15 * DAY
    os.utime(old, (stale, stale))

    result, _, manifest, _ = _build(tree['root'])

    included, skipped = manifest.split('skipped (')
    assert 'owlette agent ' in manifest
    assert 'hostname: ' in manifest
    assert 'created: ' in manifest
    assert 'logs/swoop/host.log  11 bytes  modified ' in included
    assert 'desktop/owlette-desktop.log' in included
    assert 'viewer/owlette-swoop-viewer.log' in included
    assert 'system/data-root.txt' in included
    assert 'logs/old.log  older than 14 days' in skipped
    assert _reasons(result)['logs/old.log'] == 'older than 14 days'


def test_symlink_inside_logs_is_skipped(tree):
    _symlink(tree['root'] / 'data' / '.tokens.enc', tree['logs'] / 'tokens.log')

    result, names, _, _ = _build(tree['root'])

    assert 'logs/tokens.log' not in names
    assert _reasons(result)['logs/tokens.log'] == 'is a link'


def test_symlinked_directory_inside_logs_is_not_followed(tree):
    _symlink(tree['root'] / 'data' / 'config', tree['logs'] / 'cfg')

    result, names, _, _ = _build(tree['root'])

    assert not any(n.startswith('logs/cfg') for n in names)
    assert 'logs/cfg' in _reasons(result)


class _Listed(list):
    """A finished listing that `with os.scandir(...) as it:` still accepts."""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.mark.skipif(sys.platform == 'win32', reason='dir_fd is POSIX')
def test_a_directory_swapped_for_a_link_after_the_listing_is_not_followed(tree, monkeypatch):
    # logs/swoop is group-writable: swap it for a link to a folder outside
    # logs/ between the listing of logs/ and the walk into logs/swoop
    monkeypatch.setattr(log_bundle, '_generated_entries', lambda skipped: [])
    monkeypatch.setattr(log_bundle, '_small_candidates', lambda *args: [])
    outside = tree['root'] / 'outside'
    outside.mkdir()
    (outside / 'secret.log').write_bytes(b'OUTSIDE-SECRET')
    swoop = tree['logs'] / 'swoop'
    real_scandir = os.scandir
    swapped = []

    def scandir(target):
        with real_scandir(target) as it:
            entries = _Listed(it)
        if not swapped:
            swapped.append(True)
            swoop.rename(tree['root'] / 'swoop-aside')
            os.symlink(outside, swoop)
        return entries

    monkeypatch.setattr(log_bundle.os, 'scandir', scandir)

    result, names, _, dest = _build(tree['root'])

    assert swapped
    assert not any(n.startswith('logs/swoop') for n in names)
    assert b'OUTSIDE-SECRET' not in _blob(dest)
    assert 'logs/swoop' in _reasons(result)
    assert 'logs/service.log' in names


@pytest.mark.parametrize('app_id,folder,prefix', APPS)
def test_hard_link_is_refused(tree, app_id, folder, prefix):
    tokens = tree['root'] / 'data' / '.tokens.enc'
    os.link(tokens, tree['logs'] / 'linked.log')
    os.link(tokens, tree['dirs'][app_id] / f'{prefix}.1.log')
    os.link(tokens, tree['tmp'] / 'status_writer.log.2')

    result, names, _, _ = _build(tree['root'])

    reasons = _reasons(result)
    for arcname in ('logs/linked.log', f'{folder}/{prefix}.1.log', 'tmp/status_writer.log.2'):
        assert arcname not in names
        assert reasons[arcname] == 'has 4 hard links'


class _ForeignOwner:
    """A real fstat result, but owned by somebody other than the console user."""

    st_uid = 4242

    def __init__(self, info):
        self._info = info

    def __getattr__(self, name):
        return getattr(self._info, name)


@pytest.mark.parametrize('app_id,folder,prefix', APPS)
def test_app_log_owned_by_another_uid_is_refused(tree, monkeypatch, app_id, folder, prefix):
    real_fstat = os.fstat
    monkeypatch.setattr(log_bundle.os, 'fstat', lambda fd: _ForeignOwner(real_fstat(fd)))
    monkeypatch.setattr(log_bundle, '_user_log_dir',
                        _app_dirs(tree, lambda a: 1000 if a == app_id else None))

    result, names, _, _ = _build(tree['root'])

    assert f'{folder}/{prefix}.log' not in names
    assert _reasons(result)[f'{folder}/{prefix}.log'] == (
        'is owned by uid 4242, not the console user')
    # the data tree carries no owner requirement
    assert 'logs/service.log' in names
    assert 'tmp/status_writer.log' in names


@pytest.mark.parametrize('app_id,folder,prefix', APPS)
def test_app_log_owned_by_the_console_user_is_read(tree, monkeypatch, app_id, folder, prefix):
    owner = os.stat(tree['dirs'][app_id] / f'{prefix}.log').st_uid
    monkeypatch.setattr(log_bundle, '_user_log_dir', _app_dirs(tree, lambda a: owner))

    _, names, _, _ = _build(tree['root'])

    assert f'{folder}/{prefix}.log' in names


@pytest.mark.skipif(sys.platform == 'win32', reason='O_NOFOLLOW is POSIX')
@pytest.mark.parametrize('app_id,folder,prefix', APPS)
def test_app_log_symlink_is_refused(tree, app_id, folder, prefix):
    target = tree['root'] / 'data' / '.tokens.enc'
    link = tree['dirs'][app_id] / f'{prefix}.2.log'
    os.symlink(target, link)

    result, names, _, dest = _build(tree['root'])

    assert f'{folder}/{prefix}.2.log' not in names
    assert _reasons(result)[f'{folder}/{prefix}.2.log'] == 'is a link'
    assert b'TOKEN-SECRET' not in _blob(dest)
    # and a link swapped in after the listing is refused on open
    with pytest.raises(log_bundle._Skip, match='could not be opened'):
        log_bundle._open_checked(str(link), None)


def test_status_writer_symlink_is_refused(tree):
    _symlink(tree['root'] / 'data' / '.tokens.enc', tree['tmp'] / 'status_writer.log.2')

    result, names, _, dest = _build(tree['root'])

    assert 'tmp/status_writer.log.2' not in names
    assert _reasons(result)['tmp/status_writer.log.2'] == 'is a link'
    assert b'TOKEN-SECRET' not in _blob(dest)


@pytest.mark.parametrize('app_id,folder,label', [
    ('app.owlette.desktop', 'desktop', 'the desktop app'),
    ('app.owlette.swoop-viewer', 'viewer', 'owlette swoop'),
])
def test_missing_app_folder_is_listed(tree, monkeypatch, app_id, folder, label):
    nowhere = tree['root'] / 'nowhere'
    monkeypatch.setattr(log_bundle, '_user_log_dir', lambda a: (
        str(nowhere if a == app_id else tree['dirs'][a]), None))

    result, names, _, _ = _build(tree['root'])

    assert _reasons(result)[f'{folder}/'] == f'{label} has no log folder'
    assert 'logs/service.log' in names


def test_missing_tmp_folder_is_listed(tree):
    for path in tree['tmp'].iterdir():
        path.unlink()
    tree['tmp'].rmdir()

    result, names, _, _ = _build(tree['root'])

    assert _reasons(result)['tmp/'] == 'the data root has no tmp folder'
    assert 'logs/service.log' in names


def test_no_console_user_is_listed(tree, monkeypatch):
    def nobody(app_id):
        raise log_bundle._Skip('nobody is at a graphical session')

    monkeypatch.setattr(log_bundle, '_user_log_dir', nobody)

    result, _, _, _ = _build(tree['root'])

    assert _reasons(result)['desktop/'] == 'nobody is at a graphical session'
    assert _reasons(result)['viewer/'] == 'nobody is at a graphical session'


def test_uncompressed_budget_keeps_the_newest(tree, monkeypatch):
    monkeypatch.setattr(log_bundle, 'UNCOMPRESSED_BUDGET_BYTES', 2500)
    monkeypatch.setattr(log_bundle, '_generated_entries', lambda skipped: [])
    now = time.time()
    for age, name in enumerate(['a.log', 'b.log', 'c.log']):
        path = tree['logs'] / name
        path.write_bytes(b'x' * 1000)
        os.utime(path, (now - age * 60, now - age * 60))
    for path in [tree['logs'] / 'service.log', tree['logs'] / 'swoop' / 'host.log',
                 tree['logs'] / 'roost_scrub_reports' / 'scrub.json']:
        os.utime(path, (now - DAY, now - DAY))

    result, names, _, _ = _build(tree['root'])

    assert 'logs/a.log' in names and 'logs/b.log' in names
    assert 'logs/c.log' not in names
    assert _reasons(result)['logs/c.log'] == 'past the 300 MB uncompressed budget'
    with zipfile.ZipFile(tree['root'] / 'out' / 'logs.zip') as zf:
        total = sum(i.file_size for i in zf.infolist() if i.filename != 'manifest.txt')
    assert total <= 2500


def test_small_sources_survive_a_logs_tree_past_the_budget(tree, monkeypatch):
    monkeypatch.setattr(log_bundle, 'UNCOMPRESSED_BUDGET_BYTES', 20_000)
    monkeypatch.setattr(log_bundle, '_run', lambda argv, timeout, cap: (b'command output\n', False))
    now = time.time()
    small = [tree['tmp'] / 'status_writer.log', tree['desktop'] / 'owlette-desktop.log',
             tree['dirs']['app.owlette.swoop-viewer'] / 'owlette-swoop-viewer.log']
    for path in small:
        os.utime(path, (now - DAY, now - DAY))
    # logs/ alone is twice the budget, and every file in it is newer than the small sources
    for i in range(8):
        path = tree['logs'] / f'big{i}.log'
        path.write_bytes(b'x' * 5000)
        os.utime(path, (now - i, now - i))

    result, names, _, _ = _build(tree['root'])

    for name in ['tmp/status_writer.log', 'desktop/owlette-desktop.log',
                 'viewer/owlette-swoop-viewer.log', 'system/data-root.txt']:
        assert name in names
    for entry in COMMAND_ENTRIES:
        assert entry in names
    assert 'logs/big0.log' in names
    assert _reasons(result)['logs/big7.log'] == 'past the 300 MB uncompressed budget'


def test_compressed_cap_stops_adding(tree, monkeypatch):
    cap = 512 * 1024
    chunk = 64 * 1024
    monkeypatch.setattr(log_bundle, 'ARCHIVE_CAP_BYTES', cap)
    monkeypatch.setattr(log_bundle, 'CHUNK_BYTES', chunk)
    now = time.time()
    for i in range(6):
        path = tree['logs'] / f'noise{i}.log'
        path.write_bytes(os.urandom(200 * 1024))
        os.utime(path, (now - i, now - i))

    result, names, manifest, dest = _build(tree['root'])

    capped = [n for n, r in result['skipped'] if r == 'the zip reached its 150 MB cap']
    assert capped
    assert not set(capped) & set(names)
    assert 'cut short at the 150 MB zip cap' in manifest
    # the overshoot is one chunk plus what deflate holds back plus the manifest
    assert dest.stat().st_size < cap + chunk + 128 * 1024
    assert result['files'] == len(names) - 1
    # the small sources went in before logs/ filled the zip
    assert 'tmp/status_writer.log' in names and 'system/data-root.txt' in names


def test_cap_leaves_room_under_the_upload_limit():
    # the upload-url route refuses anything over 150 MiB
    overshoot = log_bundle.CHUNK_BYTES + 1024 * 1024
    assert log_bundle.ARCHIVE_CAP_BYTES + overshoot <= 150 * 1024 * 1024


# the data-root listing

def test_listing_has_names_sizes_and_dates_but_no_contents(tree):
    _, _, _, dest = _build(tree['root'])

    listing = _read(dest, 'system/data-root.txt').decode()
    assert listing.startswith(f"== {tree['data']}\n")
    assert '\n.tokens.enc  12 bytes  modified ' in listing
    assert '\nconfig/\n' in listing
    assert '\nconfig/config.json  13 bytes  modified ' in listing
    assert '\nlogs/swoop/host.log  11 bytes  modified ' in listing
    blob = _blob(dest)
    assert b'TOKEN-SECRET' not in blob
    assert b'CONFIG-SECRET' not in blob


def test_listing_walks_the_runtime_trees_last_and_stops_at_its_cap(tree, monkeypatch):
    lib = tree['data'] / 'python' / 'Lib'
    lib.mkdir(parents=True)
    for i in range(200):
        (lib / f'module{i:03}.py').write_text('')
    (tree['data'] / 'zzz').mkdir()
    (tree['data'] / 'zzz' / 'late.txt').write_text('')
    monkeypatch.setattr(log_bundle, 'LISTING_CAP_BYTES', 2000)

    _, _, manifest, dest = _build(tree['root'])

    listing = _read(dest, 'system/data-root.txt').decode()
    # the tree past python/ in name order is still listed: the runtime waits its turn
    assert '\nzzz/late.txt  0 bytes' in listing
    assert '\npython/\n' in listing
    assert 'python/Lib/module199.py' not in listing
    assert listing.endswith('(cut short at the 2 MB listing cap)\n')
    assert 'system/data-root.txt' in manifest.split('skipped (')[0]
    assert len(listing.encode()) <= 2000 + 100


def test_listing_does_not_follow_a_link(tree):
    outside = tree['root'] / 'outside'
    outside.mkdir()
    (outside / 'outside-name.txt').write_text('')
    _symlink(outside, tree['data'] / 'linked')

    _, _, _, dest = _build(tree['root'])

    listing = _read(dest, 'system/data-root.txt').decode()
    assert '\nlinked  link\n' in listing
    assert 'outside-name' not in listing


@pytest.mark.skipif(sys.platform == 'win32', reason='the install root sits apart on POSIX only')
def test_listing_adds_an_install_root_outside_the_data_root(tree, monkeypatch):
    install = tree['root'] / 'opt'
    (install / 'agent').mkdir(parents=True)
    (install / 'agent' / 'VERSION').write_text('9.9.9\n')
    monkeypatch.setattr(log_bundle, '_install_root', lambda: str(install))

    _, _, _, dest = _build(tree['root'])

    listing = _read(dest, 'system/data-root.txt').decode()
    assert f'\n== {install}\n' in listing
    assert '\nagent/VERSION  6 bytes  modified ' in listing


# commands: the shared runner, the journal and the crash events

def test_run_keeps_the_tail_of_an_oversize_output():
    script = 'import sys\nfor i in range(5000): sys.stdout.buffer.write(b"line %05d\\n" % i)'
    data, dropped = log_bundle._run([sys.executable, '-c', script], 20, 1000)

    assert dropped
    assert len(data) == 1000
    assert data.endswith(b'line 04999\n')


def test_run_kills_a_command_past_its_timeout():
    started = time.monotonic()
    with pytest.raises(log_bundle._Skip, match='ran past 0.5 s'):
        log_bundle._run([sys.executable, '-c', 'import time; time.sleep(30)'], 0.5, 1000)
    assert time.monotonic() - started < 10


def test_run_reports_a_missing_binary_and_a_failure():
    with pytest.raises(log_bundle._Skip, match='is not installed'):
        log_bundle._run(['owlette-no-such-command'], 5, 1000)
    with pytest.raises(log_bundle._Skip, match='exited with code 3'):
        log_bundle._run([sys.executable, '-c', 'import sys; sys.exit(3)'], 20, 1000)


def test_run_past_its_timeout_carries_what_it_wrote():
    script = ('import sys, time\nsys.stdout.buffer.write(b"early line\\n")\n'
              'sys.stdout.flush()\ntime.sleep(30)')
    with pytest.raises(log_bundle._TimedOut) as raised:
        log_bundle._run([sys.executable, '-c', script], 2, 1000)

    assert raised.value.tail == b'early line\n'
    assert not raised.value.dropped


def test_journal_trimmed_to_the_cap_starts_at_a_whole_line(monkeypatch):
    monkeypatch.setattr(log_bundle, '_run', lambda argv, timeout, cap: (b'ial\nwhole one\n', True))

    data, note = log_bundle._journal('owlette-agent')

    assert data == b'whole one\n'
    assert note == 'oldest lines cut at the 20 MB cap'


@pytest.mark.parametrize('dropped,note', [
    (False, 'cut at the 20 s limit'),
    (True, 'oldest lines cut at the 20 MB cap; cut at the 20 s limit'),
])
def test_journal_past_its_timeout_keeps_the_whole_lines_it_has(monkeypatch, dropped, note):
    def run(argv, timeout, cap):
        raise log_bundle._TimedOut('journalctl ran past 20 s', b'ial\nwhole one\nwhole two\nhal',
                                   dropped)

    monkeypatch.setattr(log_bundle, '_run', run)

    data, got = log_bundle._journal('owlette-agent')

    assert data == (b'' if dropped else b'ial\n') + b'whole one\nwhole two\n'
    assert got == note


def test_journals_of_the_agent_and_update_units_are_included_on_linux(tree, monkeypatch):
    _as_platform(monkeypatch, 'linux')
    calls = []

    def run(argv, timeout, cap):
        calls.append(argv)
        if 'owlette-update.service' in argv:
            return b'-- No entries --\n', False
        return b'2026-10-14T01:02:03+0000 kiosk owlette[1]: started\n', False

    monkeypatch.setattr(log_bundle, '_run', run)

    _, names, manifest, dest = _build(tree['root'])

    assert calls == [['journalctl', '-u', f'{unit}.service', '--since', '14 days ago',
                      '--no-pager', '-o', 'short-iso']
                     for unit in ('owlette-agent', 'owlette-update')]
    assert _read(dest, 'system/journal-owlette-agent.txt').endswith(b'started\n')
    assert _read(dest, 'system/journal-owlette-update.txt') == b'-- No entries --\n'
    included = manifest.split('skipped (')[0]
    assert 'system/journal-owlette-agent.txt' in included
    assert 'system/journal-owlette-update.txt' in included


@pytest.mark.parametrize('fault,reason', [
    (FileNotFoundError, 'journalctl is not installed'),
    (PermissionError, 'journalctl could not be run: '),
])
def test_journal_that_cannot_run_is_a_manifest_line(tree, monkeypatch, fault, reason):
    _as_platform(monkeypatch, 'linux')
    monkeypatch.setattr(log_bundle, '_run', _REAL_RUN)

    def popen(*args, **kwargs):
        raise fault(13, 'denied')

    monkeypatch.setattr(log_bundle.subprocess, 'Popen', popen)

    result, names, _, _ = _build(tree['root'])

    for arcname in ('system/journal-owlette-agent.txt', 'system/journal-owlette-update.txt'):
        assert arcname not in names
        assert _reasons(result)[arcname].startswith(reason)
    assert 'logs/service.log' in names


def test_journal_past_its_timeout_goes_in_with_a_note(tree, monkeypatch):
    _as_platform(monkeypatch, 'linux')

    def run(argv, timeout, cap):
        raise log_bundle._TimedOut(f'{argv[0]} ran past {timeout:g} s', b'first\nsecond\nthi',
                                   False)

    monkeypatch.setattr(log_bundle, '_run', run)

    result, names, manifest, dest = _build(tree['root'])

    assert _read(dest, 'system/journal-owlette-agent.txt') == b'first\nsecond\n'
    assert 'system/journal-owlette-agent.txt' not in _reasons(result)
    assert 'system/journal-owlette-agent.txt  13 bytes' in manifest
    assert '(cut at the 20 s limit)' in manifest.split('skipped (')[0]
    assert 'logs/service.log' in names


CRASH_EVENTS = (
    'Event[0]\n  Source: Application Error\n  Event ID: 1000\n  Description: \n'
    'Faulting application name: owlette-desktop.exe, version: 4.1.14.0\n\n'
    'Event[1]\n  Source: Application Error\n  Event ID: 1000\n  Description: \n'
    'Faulting application name: TouchPlayer.exe, version: 1.0.0.1\n\n'
    'Event[2]\n  Source: Application Error\n  Event ID: 1000\n  Description: \n'
    'Faulting application name: pythonw.exe\x00\n'
    'Faulting application path: {python}\\pythonw.exe\n\n'
    'Event[3]\n  Source: Application Error\n  Event ID: 1000\n  Description: \n'
    'Faulting application name: python.exe\n'
    'Faulting application path: C:\\Python311\\python.exe\n\n'
    'Event[4]\n  Source: Windows Error Reporting\n  Event ID: 1001\n  Description: \n'
    'P1: OWLETTE-HOST.EXE\n\n'
)


@pytest.mark.skipif(sys.platform != 'win32', reason='the event log is Windows only')
def test_crash_events_keep_only_owlettes_programs(tree, monkeypatch):
    calls = []
    python = str(tree['data'] / 'python')

    def run(argv, timeout, cap):
        calls.append(argv)
        return CRASH_EVENTS.replace('{python}', python).encode(), False

    monkeypatch.setattr(log_bundle, '_run', run)

    _, names, manifest, dest = _build(tree['root'])

    (argv,) = calls
    assert argv[:3] == ['wevtutil', 'qe', 'Application'] and '/f:text' in argv
    query = next(a for a in argv if a.startswith('/q:'))
    assert 'TimeCreated[timediff(@SystemTime) <= 1209600000]' in query
    for source in ('Application Error', 'Windows Error Reporting'):
        assert f"Provider[@Name='{source}']" in query
    # owlette ships no .NET program
    assert '.NET Runtime' not in query and '1026' not in query
    text = _read(dest, 'system/application-crashes.txt').decode()
    assert '3 of 5 read' in text
    assert 'owlette-desktop.exe' in text
    assert f'{python}\\pythonw.exe' in text
    assert 'OWLETTE-HOST.EXE' in text
    assert 'TouchPlayer.exe' not in text
    assert 'Python311' not in text
    assert '\x00' not in text
    assert 'system/application-crashes.txt' in manifest.split('skipped (')[0]


@pytest.mark.skipif(sys.platform != 'win32', reason='the event log is Windows only')
def test_crash_events_failure_is_a_manifest_line(tree, monkeypatch):
    def run(argv, timeout, cap):
        raise log_bundle._Skip('wevtutil exited with code 15007')

    monkeypatch.setattr(log_bundle, '_run', run)

    result, names, _, _ = _build(tree['root'])

    assert 'system/application-crashes.txt' not in names
    assert _reasons(result)['system/application-crashes.txt'] == 'wevtutil exited with code 15007'
    assert 'logs/service.log' in names


# the windows setup logs

OWLETTE_SETUP_HEAD = (
    '2026-10-14 08:38:00.123   Log opened. (Time zone: UTC-07:00)\n'
    '2026-10-14 08:38:00.123   Setup version: Inno Setup version 6.4.1\n'
    '2026-10-14 08:38:00.123   Original Setup EXE: C:\\Users\\kiosk\\Downloads\\'
    'Owlette-Installer-v4.1.14.exe\n'
)
FOREIGN_SETUP_HEAD = (
    '2026-10-14 07:27:12.833   Log opened. (Time zone: UTC-07:00)\n'
    '2026-10-14 07:27:12.833   Setup version: Inno Setup version 6.4.1\n'
    '2026-10-14 07:27:12.833   Original Setup EXE: C:\\Users\\kiosk\\AppData\\Local\\Temp\\'
    'CodeSetup-stable.exe\n'
)
# a deployment's third-party installer: its path and its target both say owlette
DEPLOYED_SETUP_HEAD = (
    '\ufeff2026-10-14 09:00:00.000   Log opened. (Time zone: UTC-07:00)\n'
    '2026-10-14 09:00:00.000   Setup version: Inno Setup version 6.4.1\n'
    '2026-10-14 09:00:00.000   Original Setup EXE: C:\\Users\\kiosk\\AppData\\Local\\Temp\\'
    'owlette_installers\\TouchDesigner.2023.12000.exe\n'
    '2026-10-14 09:00:00.000   Setup command line: /SL5="$1,2,3,C:\\Users\\kiosk\\AppData\\'
    'Local\\Temp\\owlette_installers\\TouchDesigner.2023.12000.exe" /LOG="C:\\ProgramData\\'
    'Owlette\\logs\\deploy.log"\n'
)


def _setup_log(temp, name, head, age):
    path = temp / name
    path.write_text(head + 'setup body\n', encoding='utf-8')
    when = time.time() - age
    os.utime(path, (when, when))
    return path


def test_owlettes_setup_log_is_included_and_another_apps_is_not(tree, monkeypatch):
    _as_platform(monkeypatch, 'win32')
    _setup_log(tree['temp'], 'Setup Log 2026-10-14 #001.txt', OWLETTE_SETUP_HEAD, 60)
    _setup_log(tree['temp'], 'Setup Log 2026-10-14 #002.txt', FOREIGN_SETUP_HEAD, 30)
    _setup_log(tree['temp'], 'Setup Log 2026-09-01 #001.txt', OWLETTE_SETUP_HEAD, 30 * DAY)

    result, names, _, dest = _build(tree['root'])

    reasons = _reasons(result)
    assert 'installer/Setup Log 2026-10-14 #001.txt' in names
    assert 'installer/Setup Log 2026-10-14 #002.txt' not in names
    assert reasons['installer/Setup Log 2026-10-14 #002.txt'] == "is another app's setup log"
    assert 'installer/Setup Log 2026-09-01 #001.txt' not in names
    assert reasons['installer/'] == '1 setup logs older than 14 days'
    assert b'CodeSetup' not in _blob(dest)


def test_a_deployed_installers_setup_log_is_refused(tree, monkeypatch):
    _as_platform(monkeypatch, 'win32')
    _setup_log(tree['temp'], 'Setup Log 2026-10-14 #003.txt', DEPLOYED_SETUP_HEAD, 30)

    result, names, _, dest = _build(tree['root'])

    assert 'installer/Setup Log 2026-10-14 #003.txt' not in names
    assert _reasons(result)['installer/Setup Log 2026-10-14 #003.txt'] == (
        "is another app's setup log")
    assert b'TouchDesigner' not in _blob(dest)


@pytest.mark.parametrize('exe,ours', [
    ('C:\\Users\\kiosk\\Downloads\\Owlette-Installer-v4.1.14.exe', True),
    ('C:\\Users\\kiosk\\Downloads\\owlette-installer-v4.1.14 (1).exe', True),
    ('"C:\\Users\\kiosk\\Downloads\\Owlette-Installer-v4.1.14.exe"', True),
    ('C:\\Users\\kiosk\\AppData\\Local\\Temp\\owlette_installers\\vlc-3.0.21-win64.exe', False),
    ('C:\\Owlette-Installer\\setup.exe', False),
])
def test_setup_log_is_owlettes_by_the_exe_it_ran(exe, ours):
    head = f'2026-10-14 08:38:00.123   Original Setup EXE: {exe}\r\n'.encode()
    assert log_bundle._is_owlette_setup_log(head) is ours
    assert not log_bundle._is_owlette_setup_log(b'Owlette-Installer-v4.1.14.exe\n')


@pytest.mark.skipif(sys.platform == 'win32', reason='O_NOFOLLOW is POSIX')
def test_a_setup_log_swapped_for_a_link_is_not_read(tree):
    path = _setup_log(tree['temp'], 'Setup Log 2026-10-14 #001.txt', OWLETTE_SETUP_HEAD, 60)
    candidate = log_bundle._Candidate(str(path), 'installer/x', 0, None)
    path.unlink()
    path.symlink_to(tree['data'] / '.tokens.enc')

    with pytest.raises(log_bundle._Skip, match='could not be opened'):
        log_bundle._read_head(candidate, 4096)


def test_only_the_newest_owlette_setup_logs_are_kept(tree, monkeypatch):
    _as_platform(monkeypatch, 'win32')
    for i in range(7):
        _setup_log(tree['temp'], f'Setup Log 2026-10-14 #{i:03}.txt', OWLETTE_SETUP_HEAD,
                   60 * (i + 1))

    result, names, _, _ = _build(tree['root'])

    kept = sorted(n for n in names if n.startswith('installer/'))
    assert kept == [f'installer/Setup Log 2026-10-14 #{i:03}.txt' for i in range(5)]
    reasons = _reasons(result)
    for i in (5, 6):
        assert reasons[f'installer/Setup Log 2026-10-14 #{i:03}.txt'] == (
            'past the 5 newest setup logs')


@pytest.mark.skipif(sys.platform == 'win32', reason='checks the POSIX build skips setup logs')
def test_setup_logs_are_not_read_off_windows(tree):
    _setup_log(tree['temp'], 'Setup Log 2026-10-14 #001.txt', OWLETTE_SETUP_HEAD, 60)

    _, names, _, _ = _build(tree['root'])

    assert not any(n.startswith('installer/') for n in names)


# the macOS crash reports and installer log

def _ips(proc_path):
    """An .ips report's head as macOS writes it: json, every slash escaped."""
    escaped = proc_path.replace('/', '\\/')
    return ('{"app_name":"python3.11","bug_type":"309","name":"python3.11"}\n'
            f'{{\n  "uptime" : 1000,\n  "procPath" : "{escaped}",\n  "pid" : 1\n}}\n')


def _report(folder, name, body, age=60):
    path = folder / name
    path.write_text(body)
    when = time.time() - age
    os.utime(path, (when, when))
    return path


@pytest.fixture
def mac(tree, monkeypatch):
    _as_platform(monkeypatch, 'darwin')
    monkeypatch.setattr(log_bundle, '_install_root', lambda: MAC_RUNTIME)
    return tree


def test_owlettes_crash_reports_are_included_and_no_other(mac):
    system, user = mac['reports'], mac['user_reports']
    _report(system, 'owlette-2026-10-14-101010.ips', 'AGENT CRASH')
    _report(system, 'python3.11-2026-10-14-101011.ips',
            _ips(f'{MAC_RUNTIME}/python/bin/python3.11') + 'RUNTIME CRASH')
    _report(system, 'python3.11-2026-10-14-101012.ips',
            _ips('/opt/homebrew/bin/python3.11') + 'HOMEBREW CRASH')
    _report(system, 'Notion-2026-10-14-101013.ips', 'NOTION CRASH')
    _report(system, 'owlette-2026-09-01-101010.ips', 'OLD CRASH', age=30 * DAY)
    _report(system, 'owlette-2026-10-14-101014.diag', 'DIAG FILE')
    _report(user, 'owlette-desktop-2026-10-14-101015.ips', 'DESKTOP CRASH')
    _report(user, 'Python-2026-10-14-101016.crash',
            f'Process: Python [1]\nPath: {MAC_RUNTIME}/python/bin/python3\n' + 'LEGACY CRASH')

    result, names, manifest, dest = _build(mac['root'])

    assert sorted(n for n in names if n.startswith('crash/')) == [
        'crash/Python-2026-10-14-101016.crash',
        'crash/owlette-2026-10-14-101010.ips',
        'crash/owlette-desktop-2026-10-14-101015.ips',
        'crash/python3.11-2026-10-14-101011.ips',
    ]
    reasons = _reasons(result)
    assert reasons['crash/python3.11-2026-10-14-101012.ips'] == "is another program's python"
    assert reasons['crash/'] == '1 crash reports older than 14 days'
    blob = _blob(dest)
    for foreign in (b'HOMEBREW CRASH', b'NOTION CRASH', b'OLD CRASH', b'DIAG FILE'):
        assert foreign not in blob
    assert b'RUNTIME CRASH' in blob and b'LEGACY CRASH' in blob


def test_only_the_newest_crash_reports_are_kept(mac):
    for i in range(12):
        _report(mac['reports'], f'owlette-2026-10-14-1010{i:02}.ips', 'crash', age=60 * (i + 1))

    result, names, _, _ = _build(mac['root'])

    kept = sorted(n for n in names if n.startswith('crash/'))
    assert kept == [f'crash/owlette-2026-10-14-1010{i:02}.ips' for i in range(10)]
    for i in (10, 11):
        assert _reasons(result)[f'crash/owlette-2026-10-14-1010{i:02}.ips'] == (
            'past the 10 newest crash reports')


def test_a_user_crash_report_owned_by_another_uid_is_refused(mac, monkeypatch):
    _report(mac['reports'], 'owlette-2026-10-14-101010.ips', 'agent crash')
    _report(mac['user_reports'], 'owlette-swoop-viewer-2026-10-14-101011.ips', 'viewer crash')
    real_fstat = os.fstat
    monkeypatch.setattr(log_bundle.os, 'fstat', lambda fd: _ForeignOwner(real_fstat(fd)))
    monkeypatch.setattr(log_bundle, '_console_home', lambda: (str(mac['root'] / 'home'), 501))

    result, names, _, _ = _build(mac['root'])

    assert 'crash/owlette-swoop-viewer-2026-10-14-101011.ips' not in names
    assert _reasons(result)['crash/owlette-swoop-viewer-2026-10-14-101011.ips'] == (
        'is owned by uid 4242, not the console user')
    # the system's reports carry no owner requirement
    assert 'crash/owlette-2026-10-14-101010.ips' in names


def test_a_hard_linked_crash_report_is_refused(mac):
    os.link(mac['data'] / '.tokens.enc', mac['reports'] / 'owlette-2026-10-14-101010.ips')

    result, names, _, dest = _build(mac['root'])

    assert 'crash/owlette-2026-10-14-101010.ips' not in names
    assert _reasons(result)['crash/owlette-2026-10-14-101010.ips'] == 'has 2 hard links'
    assert b'TOKEN-SECRET' not in _blob(dest)


@pytest.mark.skipif(sys.platform == 'win32', reason='O_NOFOLLOW is POSIX')
def test_a_crash_report_link_is_refused(mac):
    os.symlink(mac['data'] / '.tokens.enc', mac['user_reports'] / 'owlette-2026-10-14-1.ips')
    os.symlink(mac['data'] / '.tokens.enc', mac['reports'] / 'python3-2026-10-14-1.ips')

    result, names, _, dest = _build(mac['root'])

    reasons = _reasons(result)
    assert reasons['crash/owlette-2026-10-14-1.ips'] == 'is a link'
    assert reasons['crash/python3-2026-10-14-1.ips'] == 'is a link'
    assert b'TOKEN-SECRET' not in _blob(dest)


def test_no_console_user_still_reads_the_systems_reports(mac, monkeypatch):
    _report(mac['reports'], 'owlette-2026-10-14-101010.ips', 'agent crash')

    def nobody():
        raise log_bundle._Skip('nobody is at a graphical session')

    monkeypatch.setattr(log_bundle, '_console_home', nobody)

    result, names, _, _ = _build(mac['root'])

    assert 'crash/owlette-2026-10-14-101010.ips' in names
    assert _reasons(result)["crash/ (the console user's reports)"] == (
        'nobody is at a graphical session')


def _install_log(var_log, name, lines, age):
    path = var_log / name
    path.write_bytes(b''.join(line + b'\n' for line in lines))
    when = time.time() - age
    os.utime(path, (when, when))
    return path


def test_install_log_keeps_only_the_lines_naming_owlette(mac):
    _install_log(mac['var_log'], 'install.log.0', [
        b'2026-10-01 installd[1]: PackageKit: Installed "Owlette" (4.1.12)',
        b'2026-10-01 installd[1]: PackageKit: Installed "Slack" (4.40)',
    ], age=5 * DAY)
    _install_log(mac['var_log'], 'install.log', [
        b'2026-10-14 installer[2]: Product archive /tmp/Zoom.pkg trustLevel=350',
        b'2026-10-14 installd[1]: PackageKit: Extracting owlette-runtime.pkg',
        b'2026-10-14 installd[1]: PackageKit: Installed "Owlette" (4.1.14)',
    ], age=60)
    _install_log(mac['var_log'], 'install.log.1.gz', [b'OWLETTE GZ'], age=6 * DAY)
    _install_log(mac['var_log'], 'system.log', [b'owlette in another log'], age=60)

    _, names, manifest, dest = _build(mac['root'])

    assert _read(mac['root'] / 'out' / 'logs.zip', 'system/install-owlette.txt') == (
        b'2026-10-01 installd[1]: PackageKit: Installed "Owlette" (4.1.12)\n'
        b'2026-10-14 installd[1]: PackageKit: Extracting owlette-runtime.pkg\n'
        b'2026-10-14 installd[1]: PackageKit: Installed "Owlette" (4.1.14)\n')
    blob = _blob(dest)
    for foreign in (b'Slack', b'Zoom', b'OWLETTE GZ', b'another log'):
        assert foreign not in blob
    assert 'system/install-owlette.txt' in manifest.split('skipped (')[0]


def test_install_log_cap_keeps_the_newest_lines(mac, monkeypatch):
    monkeypatch.setattr(log_bundle, 'INSTALL_LOG_CAP_BYTES', 100)
    _install_log(mac['var_log'], 'install.log',
                 [f'owlette line {i:03}'.encode() for i in range(50)], age=60)

    _, _, manifest, dest = _build(mac['root'])

    text = _read(dest, 'system/install-owlette.txt')
    assert text.endswith(b'owlette line 049\n')
    assert b'owlette line 000' not in text
    assert len(text) <= 100
    assert '(oldest lines cut at the 5 MB cap)' in manifest


def test_missing_install_log_is_a_manifest_line(mac):
    result, names, _, _ = _build(mac['root'])

    assert 'system/install-owlette.txt' not in names
    assert _reasons(result)['system/install-owlette.txt'] == (
        f"{mac['var_log']} has no install.log")


@pytest.mark.skipif(sys.platform == 'win32', reason='O_NOFOLLOW is POSIX')
def test_an_install_log_link_is_refused(mac):
    os.symlink(mac['data'] / '.tokens.enc', mac['var_log'] / 'install.log')

    result, names, _, dest = _build(mac['root'])

    reasons = _reasons(result)
    assert 'system/install-owlette.txt' not in names
    assert reasons['system/install-owlette.txt'] == 'no install.log could be read'
    assert reasons['system/install-owlette.txt from install.log'].startswith(
        'could not be opened')
    assert b'TOKEN-SECRET' not in _blob(dest)


# screenshots

PNG = b'\x89PNG\r\n\x1a\n' + b'png body'
JPEG = b'\xff\xd8\xff\xe0' + b'jpeg body'
WEBP = b'RIFF\x10\x00\x00\x00WEBPVP8 ' + b'webp body'
EXT = {PNG: 'png', JPEG: 'jpg', WEBP: 'webp'}


def _staging(tree):
    staging = tree['data'] / 'ipc' / 'issue-attachments'
    staging.mkdir(parents=True, exist_ok=True)
    return staging


def _stage(tree, *images):
    """Each image staged under a fresh name, as the desktop app does; the names."""
    staging = _staging(tree)
    names = []
    for image in images:
        name = f'{len(list(staging.iterdir())):032x}.{EXT.get(image, "png")}'
        (staging / name).write_bytes(image)
        names.append(name)
    return names


def test_screenshots_go_in_first_in_their_order(tree):
    names = _stage(tree, JPEG, PNG, WEBP)

    result, entries, manifest, dest = _build(tree['root'], screenshots=names)

    assert entries[:3] == ['screenshots/1.jpg', 'screenshots/2.png', 'screenshots/3.webp']
    assert [_read(dest, e) for e in entries[:3]] == [JPEG, PNG, WEBP]
    assert result['screenshots'] == 3
    # the logs follow them
    assert 'logs/service.log' in entries
    assert 'screenshots/1.jpg' in manifest
    with zipfile.ZipFile(dest) as zf:
        assert zf.getinfo('screenshots/1.jpg').compress_type == zipfile.ZIP_STORED


def test_screenshots_without_logs_are_all_the_zip_holds(tree):
    names = _stage(tree, PNG)

    result, entries, _, dest = _build(tree['root'], screenshots=names, include_logs=False)

    assert entries == ['screenshots/1.png', 'manifest.txt']
    assert result == {'files': 1, 'size': dest.stat().st_size, 'skipped': [], 'screenshots': 1,
                      'videos': 0}


def test_no_screenshots_leaves_the_log_zip_as_it_was(tree):
    result, entries, _, _ = _build(tree['root'])

    assert result['screenshots'] == 0
    assert not any(e.startswith('screenshots/') for e in entries)


def test_a_screenshot_that_is_not_an_image_is_a_manifest_line(tree):
    names = _stage(tree, b'GIF89a not allowed', PNG)

    result, entries, _, _ = _build(tree['root'], screenshots=names, include_logs=False)

    # numbered by what went in
    assert entries == ['screenshots/1.png', 'manifest.txt']
    assert _reasons(result) == {f'screenshot {names[0]}': 'is not a png, jpeg or webp image'}
    assert result['screenshots'] == 1


def test_a_screenshot_past_the_size_limit_is_a_manifest_line(tree, monkeypatch):
    monkeypatch.setattr(log_bundle, 'SCREENSHOT_MAX_BYTES', len(PNG) - 1)
    names = _stage(tree, PNG)

    result, entries, _, _ = _build(tree['root'], screenshots=names, include_logs=False)

    assert entries == ['manifest.txt']
    assert _reasons(result) == {f'screenshot {names[0]}': 'is larger than 8 MB'}


def test_a_screenshot_that_would_pass_the_cap_is_left_out_whole(tree, monkeypatch):
    big = PNG + os.urandom(64 * 1024)
    names = _stage(tree, big, big)
    monkeypatch.setattr(log_bundle, 'ARCHIVE_CAP_BYTES', len(big) * 3 // 2)

    result, entries, _, dest = _build(tree['root'], screenshots=names, include_logs=False)

    assert entries == ['screenshots/1.png', 'manifest.txt']
    assert _read(dest, 'screenshots/1.png') == big
    assert _reasons(result) == {f'screenshot {names[1]}': 'would pass the 150 MB zip cap'}


def test_a_missing_screenshot_is_a_manifest_line(tree):
    _staging(tree)
    name = 'f' * 32 + '.png'

    result, entries, _, _ = _build(tree['root'], screenshots=[name], include_logs=False)

    assert entries == ['manifest.txt']
    assert _reasons(result)[f'screenshot {name}'].startswith('could not be opened')


def test_a_hard_linked_screenshot_is_refused(tree):
    name = 'a' * 32 + '.png'
    secret = tree['data'] / 'image-shaped-secret'
    secret.write_bytes(PNG + b'SECRET')
    os.link(secret, _staging(tree) / name)

    result, entries, _, dest = _build(tree['root'], screenshots=[name], include_logs=False)

    assert entries == ['manifest.txt']
    assert _reasons(result)[f'screenshot {name}'] == 'has 2 hard links'
    assert b'SECRET' not in _blob(dest)


@pytest.mark.skipif(sys.platform == 'win32', reason='O_NOFOLLOW is POSIX')
def test_a_screenshot_link_is_refused(tree):
    name = 'a' * 32 + '.png'
    secret = tree['data'] / 'image-shaped-secret'
    secret.write_bytes(PNG + b'SECRET')
    os.symlink(secret, _staging(tree) / name)

    result, entries, _, dest = _build(tree['root'], screenshots=[name], include_logs=False)

    assert entries == ['manifest.txt']
    assert _reasons(result)[f'screenshot {name}'].startswith('could not be opened')
    assert b'SECRET' not in _blob(dest)


@pytest.mark.skipif(sys.platform == 'win32', reason='O_NOFOLLOW is POSIX')
def test_a_staging_folder_swapped_for_a_link_is_not_followed(tree):
    elsewhere = tree['root'] / 'elsewhere'
    elsewhere.mkdir()
    name = 'a' * 32 + '.png'
    (elsewhere / name).write_bytes(PNG + b'SECRET')
    (tree['data'] / 'ipc').mkdir()
    os.symlink(elsewhere, tree['data'] / 'ipc' / 'issue-attachments')

    result, entries, _, dest = _build(tree['root'], screenshots=[name], include_logs=False)

    assert entries == ['manifest.txt']
    assert _reasons(result)[f'screenshot {name}'].startswith('could not be opened')
    assert b'SECRET' not in _blob(dest)


@pytest.mark.skipif(sys.platform == 'win32', reason='the owner check is POSIX')
def test_a_screenshot_owned_by_another_uid_is_refused(tree, monkeypatch):
    names = _stage(tree, PNG)
    real_fstat = os.fstat
    monkeypatch.setattr(log_bundle.os, 'fstat', lambda fd: _ForeignOwner(real_fstat(fd)))
    monkeypatch.setattr(log_bundle, '_console_home', lambda: (str(tree['root']), 1000))

    result, entries, _, _ = _build(tree['root'], screenshots=names, include_logs=False)

    assert entries == ['manifest.txt']
    assert _reasons(result)[f'screenshot {names[0]}'] == (
        'is owned by uid 4242, not the console user')


@pytest.mark.skipif(sys.platform == 'win32', reason='the owner check is POSIX')
def test_a_screenshot_owned_by_the_console_user_is_read(tree, monkeypatch):
    names = _stage(tree, PNG)
    owner = os.stat(_staging(tree) / names[0]).st_uid
    monkeypatch.setattr(log_bundle, '_console_home', lambda: (str(tree['root']), owner))

    result, entries, _, _ = _build(tree['root'], screenshots=names, include_logs=False)

    assert entries == ['screenshots/1.png', 'manifest.txt']


@pytest.mark.skipif(sys.platform == 'win32', reason='the owner check is POSIX')
def test_no_console_user_leaves_the_screenshots_out(tree, monkeypatch):
    names = _stage(tree, PNG)

    def nobody():
        raise log_bundle._Skip('nobody is at a graphical session')

    monkeypatch.setattr(log_bundle, '_console_home', nobody)

    result, entries, _, _ = _build(tree['root'], screenshots=names, include_logs=False)

    assert entries == ['manifest.txt']
    assert _reasons(result) == {f'screenshot {names[0]}': 'nobody is at a graphical session'}


@pytest.mark.parametrize('value,valid', [
    ([], True),
    (['a' * 32 + '.png'], True),
    ([f'{i:032x}.{ext}' for i, ext in enumerate(['png', 'jpg', 'webp'] * 3 + ['png'])], True),
    (['a' * 32 + '.png'] * 11, False),
    ('a' * 32 + '.png', False),
    (None, False),
    ([None], False),
    (['a' * 32 + '.png\n'], False),
    (['A' * 32 + '.png'], False),
    (['a' * 32 + '.jpeg'], False),
    (['a' * 32], False),
    (['../' + 'a' * 29 + '.png'], False),
])
def test_screenshot_ids_take_only_staged_names(value, valid):
    assert (log_bundle.screenshot_ids(value) == value) if valid else (
        log_bundle.screenshot_ids(value) is None)


def test_screenshot_ids_drop_repeats_and_keep_the_first_order():
    a, b, c = (f'{i:032x}.png' for i in range(3))
    assert log_bundle.screenshot_ids([b, a, b, c, a]) == [b, a, c]


def test_a_name_that_is_not_a_staged_one_is_never_opened(tree):
    _staging(tree)

    result, entries, _, dest = _build(
        tree['root'], screenshots=['../../.tokens.enc'], include_logs=False)

    assert entries == ['manifest.txt']
    assert _reasons(result) == {
        'screenshot ../../.tokens.enc': 'is not a staged screenshot name'}
    assert b'TOKEN-SECRET' not in _blob(dest)


def test_discard_deletes_exactly_the_named_screenshots_and_video(tree):
    names = _stage(tree, PNG, JPEG, WEBP)
    video = _stage_video(tree, MP4)
    (tree['data'] / 'ipc' / 'keep.png').write_bytes(PNG)

    log_bundle.discard_staged(names[:2] + [video, 'f' * 32 + '.png', '../keep.png'])

    assert sorted(p.name for p in _staging(tree).iterdir()) == [names[2]]
    assert (tree['data'] / 'ipc' / 'keep.png').exists()


def test_discard_without_a_staging_folder_is_quiet(tree):
    log_bundle.discard_staged(['a' * 32 + '.png', 'd' * 32 + '.mp4'])


# a video

MP4 = b'\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2' + b'mp4 body'
MOV = b'\x00\x00\x00\x14ftypqt  \x00\x00\x02\x00qt  ' + b'mov body'
M4V = b'\x00\x00\x00\x18ftypM4V \x00\x00\x00\x01M4V mp42' + b'm4v body'
WEBM = (b'\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\xf7\x81\x01\x42\xf2\x81\x04'
        b'\x42\xf3\x81\x08\x42\x82\x84webm' + b'webm body')


def _stage_video(tree, data, ext='mp4'):
    """`data` staged under a fresh name, as the desktop app does; the name."""
    staging = _staging(tree)
    name = f'{len(list(staging.iterdir())):032x}.{ext}'
    (staging / name).write_bytes(data)
    return name


def _video_reason(result, name):
    return _reasons(result)[f'video {name}']


def test_the_video_goes_in_after_the_screenshots_and_before_the_logs(tree):
    shots = _stage(tree, PNG, JPEG)
    video = _stage_video(tree, MP4)

    result, entries, manifest, dest = _build(tree['root'], screenshots=shots, videos=[video])

    assert entries[:3] == ['screenshots/1.png', 'screenshots/2.jpg', 'videos/1.mp4']
    assert entries[3:] and not any(e.startswith(('screenshots/', 'videos/')) for e in entries[3:])
    assert 'logs/service.log' in entries
    assert _read(dest, 'videos/1.mp4') == MP4
    assert (result['screenshots'], result['videos']) == (2, 1)
    assert f'videos/1.mp4  {len(MP4)} bytes' in manifest


def test_a_video_without_logs_is_all_the_zip_holds(tree):
    video = _stage_video(tree, WEBM, 'webm')

    result, entries, _, dest = _build(tree['root'], videos=[video], include_logs=False)

    assert entries == ['videos/1.webm', 'manifest.txt']
    assert result == {'files': 1, 'size': dest.stat().st_size, 'skipped': [], 'screenshots': 0,
                      'videos': 1}


@pytest.mark.parametrize('data,ext', [(MP4, 'mp4'), (MOV, 'mov'), (M4V, 'mp4'), (WEBM, 'webm')])
def test_the_video_is_named_by_its_magic_bytes(tree, data, ext):
    # the staged name says mp4 whatever it holds; the bytes decide
    video = _stage_video(tree, data, 'mp4')

    _, entries, _, dest = _build(tree['root'], videos=[video], include_logs=False)

    assert entries == [f'videos/1.{ext}', 'manifest.txt']
    assert _read(dest, f'videos/1.{ext}') == data


def test_the_video_is_stored_not_deflated(tree):
    data = MP4 + bytes(256 * 1024)
    video = _stage_video(tree, data)

    _, _, _, dest = _build(tree['root'], videos=[video], include_logs=False)

    with zipfile.ZipFile(dest) as zf:
        info = zf.getinfo('videos/1.mp4')
        assert info.compress_type == zipfile.ZIP_STORED
        assert info.compress_size == info.file_size == len(data)
        assert zf.testzip() is None
    # zeros would deflate to almost nothing
    assert dest.stat().st_size > len(data)


def test_the_video_is_copied_a_chunk_at_a_time(tree, monkeypatch):
    chunk = 4096
    data = MP4 + os.urandom(10 * chunk)
    video = _stage_video(tree, data)
    monkeypatch.setattr(log_bundle, 'CHUNK_BYTES', chunk)
    asked = []
    real_read = os.read

    def read(fd, n):
        asked.append(n)
        return real_read(fd, n)

    monkeypatch.setattr(log_bundle.os, 'read', read)

    _, _, _, dest = _build(tree['root'], videos=[video], include_logs=False)

    assert _read(dest, 'videos/1.mp4') == data
    # never the whole file in one read: the head, then a chunk at a time
    assert max(asked) <= chunk
    assert len(asked) > len(data) // chunk


@pytest.mark.parametrize('stop', ['shrank', 'read error'])
def test_a_video_that_changes_while_it_is_read_is_not_counted(tree, monkeypatch, stop):
    chunk = 4096
    data = MP4 + os.urandom(10 * chunk)
    video = _stage_video(tree, data)
    monkeypatch.setattr(log_bundle, 'CHUNK_BYTES', chunk)
    calls = []
    real_read = os.read

    def read(fd, n):
        calls.append(n)
        # the head, then one chunk, then the file is cut short under the copy
        if len(calls) > 2:
            if stop == 'read error':
                raise OSError(5, 'input/output error')
            return b''
        return real_read(fd, n)

    monkeypatch.setattr(log_bundle.os, 'read', read)

    result, _, manifest, _ = _build(tree['root'], videos=[video], include_logs=False)

    assert (result['files'], result['videos']) == (0, 0)
    assert _video_reason(result, video) == 'changed while it was read'
    assert f'video {video}  changed while it was read' in manifest


def test_a_video_cut_short_still_spends_the_100_mb(tree, monkeypatch):
    chunk = 4096
    data = MP4 + os.urandom(10 * chunk)
    cut = _stage_video(tree, data)
    after = _stage_video(tree, MOV, 'mov')
    monkeypatch.setattr(log_bundle, 'CHUNK_BYTES', chunk)
    # room for the next video only while the cut one's bytes in the zip go uncounted
    monkeypatch.setattr(log_bundle, 'ATTACHMENTS_MAX_BYTES', len(data) + len(MOV) - 1)
    reads = []
    real_read = os.read

    def read(fd, n):
        reads.append(n)
        # the head, then ten full chunks; the first video's last bytes never come
        if len(reads) == 12:
            return b''
        return real_read(fd, n)

    monkeypatch.setattr(log_bundle.os, 'read', read)

    result, _, _, _ = _build(tree['root'], videos=[cut, after], include_logs=False)

    assert result['videos'] == 0
    assert _video_reason(result, after) == 'would pass the 100 MB attachment limit'


@pytest.mark.parametrize('data', [
    b'GIF89a not a video at all',
    MP4[:11],
    b'\x00\x00\x00\x18ftpyisom\x00\x00\x02\x00',
    WEBM.replace(b'webm', b'matroska'),
    PNG,
])
def test_a_video_that_is_not_mp4_mov_or_webm_is_a_manifest_line(tree, data):
    video = _stage_video(tree, data)

    result, entries, _, _ = _build(tree['root'], videos=[video], include_logs=False)

    assert entries == ['manifest.txt']
    assert result['videos'] == 0
    assert _video_reason(result, video) == 'is not an mp4, mov or webm video'


@pytest.mark.parametrize('brand', [b'heic', b'heix', b'heim', b'heis', b'mif1', b'msf1',
                                   b'avif', b'avis'])
def test_a_heif_or_avif_still_is_not_a_video(tree, brand):
    video = _stage_video(tree, b'\x00\x00\x00\x18ftyp' + brand + b'\x00\x00\x00\x00mif1miaf')

    result, entries, _, _ = _build(tree['root'], videos=[video], include_logs=False)

    assert entries == ['manifest.txt']
    assert _video_reason(result, video) == 'is not an mp4, mov or webm video'


def test_hevc_is_a_video_brand(tree):
    video = _stage_video(tree, b'\x00\x00\x00\x18ftyphevc\x00\x00\x00\x00hevcmp42body')

    _, entries, _, _ = _build(tree['root'], videos=[video], include_logs=False)

    assert entries == ['videos/1.mp4', 'manifest.txt']


def test_a_video_past_100_mb_is_refused_unread(tree):
    video = _stage_video(tree, MP4)
    with open(_staging(tree) / video, 'r+b') as f:
        # sparse where the filesystem allows it; the size alone refuses it
        f.truncate(log_bundle.ATTACHMENTS_MAX_BYTES + 1)

    result, entries, _, dest = _build(tree['root'], videos=[video], include_logs=False)

    assert entries == ['manifest.txt']
    assert _video_reason(result, video) == 'would pass the 100 MB attachment limit'
    assert dest.stat().st_size < 64 * 1024


def test_a_video_at_the_limit_goes_in(tree, monkeypatch):
    monkeypatch.setattr(log_bundle, 'ATTACHMENTS_MAX_BYTES', len(MP4))
    video = _stage_video(tree, MP4)

    _, entries, _, _ = _build(tree['root'], videos=[video], include_logs=False)

    assert entries == ['videos/1.mp4', 'manifest.txt']


def test_several_videos_go_in_numbered_in_order(tree):
    videos = [_stage_video(tree, MP4), _stage_video(tree, MOV, 'mov'),
              _stage_video(tree, WEBM, 'webm')]

    result, entries, _, _ = _build(tree['root'], videos=videos, include_logs=False)

    assert entries == ['videos/1.mp4', 'videos/2.mov', 'videos/3.webm', 'manifest.txt']
    assert result['videos'] == 3


def test_screenshots_and_videos_share_the_100_mb(tree, monkeypatch):
    monkeypatch.setattr(log_bundle, 'ATTACHMENTS_MAX_BYTES', len(PNG) + len(MP4))
    shots = _stage(tree, PNG)
    first = _stage_video(tree, MP4)
    second = _stage_video(tree, MOV, 'mov')

    result, entries, _, _ = _build(tree['root'], screenshots=shots, videos=[first, second],
                                   include_logs=False)

    assert entries == ['screenshots/1.png', 'videos/1.mp4', 'manifest.txt']
    assert _video_reason(result, second) == 'would pass the 100 MB attachment limit'
    assert (result['screenshots'], result['videos']) == (1, 1)


def test_a_screenshot_past_the_100_mb_left_is_refused(tree, monkeypatch):
    monkeypatch.setattr(log_bundle, 'ATTACHMENTS_MAX_BYTES', len(PNG) + len(JPEG) - 1)
    shots = _stage(tree, PNG, JPEG)

    result, entries, _, _ = _build(tree['root'], screenshots=shots, include_logs=False)

    assert entries == ['screenshots/1.png', 'manifest.txt']
    assert _reasons(result)[f'screenshot {shots[1]}'] == 'would pass the 100 MB attachment limit'


def test_a_video_that_would_pass_the_cap_is_left_out_whole(tree, monkeypatch):
    data = MP4 + os.urandom(64 * 1024)
    video = _stage_video(tree, data)
    monkeypatch.setattr(log_bundle, 'ARCHIVE_CAP_BYTES', len(data))

    result, entries, _, _ = _build(tree['root'], videos=[video])

    assert not any(e.startswith('videos/') for e in entries)
    assert _video_reason(result, video) == 'would pass the 150 MB zip cap'
    # the logs still go in
    assert 'logs/service.log' in entries


def test_the_cap_cuts_the_logs_not_the_video(tree, monkeypatch):
    data = MP4 + os.urandom(256 * 1024)
    video = _stage_video(tree, data)
    monkeypatch.setattr(log_bundle, 'ARCHIVE_CAP_BYTES', len(data) + 128 * 1024)
    monkeypatch.setattr(log_bundle, 'CHUNK_BYTES', 64 * 1024)
    now = time.time()
    for i in range(4):
        path = tree['logs'] / f'noise{i}.log'
        path.write_bytes(os.urandom(200 * 1024))
        os.utime(path, (now - i, now - i))

    result, _, _, dest = _build(tree['root'], videos=[video])

    assert _read(dest, 'videos/1.mp4') == data
    assert result['videos'] == 1
    capped = [n for n, r in result['skipped'] if r == 'the zip reached its 150 MB cap']
    assert capped and not any(n.startswith('video') for n in capped)


def test_the_video_leaves_the_logs_uncompressed_budget_alone(tree, monkeypatch):
    video = _stage_video(tree, MP4 + bytes(256 * 1024))
    monkeypatch.setattr(log_bundle, 'UNCOMPRESSED_BUDGET_BYTES', 128 * 1024)

    result, entries, _, _ = _build(tree['root'], videos=[video])

    assert 'videos/1.mp4' in entries
    assert 'logs/service.log' in entries
    assert not [n for n, r in result['skipped'] if 'uncompressed budget' in r]


def test_a_missing_video_is_a_manifest_line(tree):
    _staging(tree)
    name = 'f' * 32 + '.mp4'

    result, entries, _, _ = _build(tree['root'], videos=[name], include_logs=False)

    assert entries == ['manifest.txt']
    assert _video_reason(result, name).startswith('could not be opened')


def test_a_hard_linked_video_is_refused(tree):
    name = 'a' * 32 + '.mp4'
    secret = tree['data'] / 'video-shaped-secret'
    secret.write_bytes(MP4 + b'SECRET')
    os.link(secret, _staging(tree) / name)

    result, entries, _, dest = _build(tree['root'], videos=[name], include_logs=False)

    assert entries == ['manifest.txt']
    assert _video_reason(result, name) == 'has 2 hard links'
    assert b'SECRET' not in _blob(dest)


@pytest.mark.skipif(sys.platform == 'win32', reason='O_NOFOLLOW is POSIX')
def test_a_video_link_is_refused(tree):
    name = 'a' * 32 + '.mp4'
    secret = tree['data'] / 'video-shaped-secret'
    secret.write_bytes(MP4 + b'SECRET')
    os.symlink(secret, _staging(tree) / name)

    result, entries, _, dest = _build(tree['root'], videos=[name], include_logs=False)

    assert entries == ['manifest.txt']
    assert _video_reason(result, name).startswith('could not be opened')
    assert b'SECRET' not in _blob(dest)


@pytest.mark.skipif(sys.platform == 'win32', reason='the owner check is POSIX')
def test_a_video_owned_by_another_uid_is_refused(tree, monkeypatch):
    video = _stage_video(tree, MP4)
    real_fstat = os.fstat
    monkeypatch.setattr(log_bundle.os, 'fstat', lambda fd: _ForeignOwner(real_fstat(fd)))
    monkeypatch.setattr(log_bundle, '_console_home', lambda: (str(tree['root']), 1000))

    result, entries, _, _ = _build(tree['root'], videos=[video], include_logs=False)

    assert entries == ['manifest.txt']
    assert _video_reason(result, video) == 'is owned by uid 4242, not the console user'


@pytest.mark.skipif(sys.platform == 'win32', reason='the owner check is POSIX')
def test_a_video_owned_by_the_console_user_is_read(tree, monkeypatch):
    video = _stage_video(tree, MP4)
    owner = os.stat(_staging(tree) / video).st_uid
    monkeypatch.setattr(log_bundle, '_console_home', lambda: (str(tree['root']), owner))

    _, entries, _, _ = _build(tree['root'], videos=[video], include_logs=False)

    assert entries == ['videos/1.mp4', 'manifest.txt']


@pytest.mark.skipif(sys.platform == 'win32', reason='the owner check is POSIX')
def test_no_console_user_leaves_the_screenshots_and_video_out(tree, monkeypatch):
    shots = _stage(tree, PNG)
    video = _stage_video(tree, MP4)

    def nobody():
        raise log_bundle._Skip('nobody is at a graphical session')

    monkeypatch.setattr(log_bundle, '_console_home', nobody)

    result, entries, _, _ = _build(tree['root'], screenshots=shots, videos=[video],
                                   include_logs=False)

    assert entries == ['manifest.txt']
    assert _reasons(result) == {f'screenshot {shots[0]}': 'nobody is at a graphical session',
                                f'video {video}': 'nobody is at a graphical session'}


def test_a_name_that_is_not_a_staged_video_is_never_opened(tree):
    _staging(tree)
    screenshot = 'a' * 32 + '.png'

    result, entries, _, dest = _build(
        tree['root'], videos=['../../.tokens.enc', screenshot], include_logs=False)

    assert entries == ['manifest.txt']
    assert _reasons(result) == {
        'video ../../.tokens.enc': 'is not a staged video name',
        f'video {screenshot}': 'is not a staged video name'}
    assert b'TOKEN-SECRET' not in _blob(dest)


@pytest.mark.parametrize('value,valid', [
    ([], True),
    (['a' * 32 + '.mp4'], True),
    (['a' * 32 + '.mov'], True),
    (['a' * 32 + '.webm'], True),
    (['a' * 32 + '.mp4', 'b' * 32 + '.mov'], True),
    ([f'{i:032x}.webm' for i in range(20)], True),
    (['a' * 32 + '.mp4'] * 21, False),
    ('a' * 32 + '.mp4', False),
    (None, False),
    ([None], False),
    (['a' * 32 + '.png'], False),
    (['a' * 32 + '.mkv'], False),
    (['A' * 32 + '.mp4'], False),
    (['a' * 32 + '.mp4\n'], False),
    (['../' + 'a' * 29 + '.mp4'], False),
])
def test_video_ids_take_only_staged_video_names(value, valid):
    assert (log_bundle.video_ids(value) == value) if valid else (
        log_bundle.video_ids(value) is None)


def test_screenshot_ids_refuse_a_video_name():
    assert log_bundle.screenshot_ids(['a' * 32 + '.mp4']) is None
