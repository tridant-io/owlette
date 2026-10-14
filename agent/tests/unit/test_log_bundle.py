"""log_bundle.build_log_zip: what goes in the issue log zip and what never does."""

import os
import sys
import time
import zipfile

import pytest

import log_bundle

DAY = 24 * 3600


@pytest.fixture
def tree(tmp_path, monkeypatch):
    """A data root with logs/, the secrets beside it, and a desktop log folder."""
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

    desktop = tmp_path / 'desktop'
    desktop.mkdir()
    (desktop / 'owlette-desktop.log').write_bytes(b'desktop line\n')
    (desktop / 'settings.json').write_text('DESKTOP-OTHER')

    monkeypatch.setattr(log_bundle, '_machine_logs_dir', lambda: str(logs))
    monkeypatch.setattr(log_bundle, '_desktop_source', lambda: (str(desktop), None))
    return {'root': tmp_path, 'logs': logs, 'desktop': desktop}


def _build(tmp_path):
    dest = tmp_path / 'out' / 'logs.zip'
    dest.parent.mkdir(exist_ok=True)
    result = log_bundle.build_log_zip(str(dest))
    with zipfile.ZipFile(dest) as zf:
        names = zf.namelist()
        manifest = zf.read('manifest.txt').decode()
    return result, names, manifest, dest


def _symlink(target, link):
    try:
        os.symlink(target, link)
    except (OSError, NotImplementedError) as e:
        pytest.skip(f'symlinks unavailable here: {e}')


def _reasons(result):
    return dict(result['skipped'])


def test_normal_tree_includes_logs_swoop_and_desktop(tree):
    result, names, manifest, dest = _build(tree['root'])

    assert sorted(names) == [
        'desktop/owlette-desktop.log',
        'logs/roost_scrub_reports/scrub.json',
        'logs/service.log',
        'logs/swoop/host.log',
        'manifest.txt',
    ]
    assert names[-1] == 'manifest.txt'
    assert result['files'] == 4
    assert result['size'] == dest.stat().st_size
    with zipfile.ZipFile(dest) as zf:
        assert zf.read('logs/swoop/host.log') == b'swoop line\n'
        assert all(info.compress_type == zipfile.ZIP_DEFLATED for info in zf.infolist())


def test_nothing_outside_logs_or_the_desktop_folder(tree):
    _, names, _, dest = _build(tree['root'])

    assert all(n.startswith(('logs/', 'desktop/')) or n == 'manifest.txt' for n in names)
    with zipfile.ZipFile(dest) as zf:
        blob = b''.join(zf.read(n) for n in names)
    for secret in (b'TOKEN-SECRET', b'CONFIG-SECRET', b'DESKTOP-OTHER'):
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
    with zipfile.ZipFile(dest) as zf:
        assert all(b'OUTSIDE-SECRET' not in zf.read(n) for n in names)
    assert 'logs/swoop' in _reasons(result)
    assert 'logs/service.log' in names


def test_hard_link_is_refused(tree):
    os.link(tree['root'] / 'data' / '.tokens.enc', tree['logs'] / 'linked.log')
    os.link(tree['root'] / 'data' / '.tokens.enc', tree['desktop'] / 'owlette-desktop.1.log')

    result, names, _, _ = _build(tree['root'])

    reasons = _reasons(result)
    assert 'logs/linked.log' not in names
    assert 'desktop/owlette-desktop.1.log' not in names
    assert reasons['logs/linked.log'] == 'has 3 hard links'
    assert reasons['desktop/owlette-desktop.1.log'] == 'has 3 hard links'


class _ForeignOwner:
    """A real fstat result, but owned by somebody other than the console user."""

    st_uid = 4242

    def __init__(self, info):
        self._info = info

    def __getattr__(self, name):
        return getattr(self._info, name)


def test_desktop_log_owned_by_another_uid_is_refused(tree, monkeypatch):
    real_fstat = os.fstat
    monkeypatch.setattr(log_bundle.os, 'fstat', lambda fd: _ForeignOwner(real_fstat(fd)))
    monkeypatch.setattr(log_bundle, '_desktop_source', lambda: (str(tree['desktop']), 1000))

    result, names, _, _ = _build(tree['root'])

    assert 'desktop/owlette-desktop.log' not in names
    assert _reasons(result)['desktop/owlette-desktop.log'] == (
        'is owned by uid 4242, not the console user')
    # the data tree carries no owner requirement
    assert 'logs/service.log' in names


def test_desktop_log_owned_by_the_console_user_is_read(tree, monkeypatch):
    owner = os.stat(tree['desktop'] / 'owlette-desktop.log').st_uid
    monkeypatch.setattr(log_bundle, '_desktop_source',
                        lambda: (str(tree['desktop']), owner))

    _, names, _, _ = _build(tree['root'])

    assert 'desktop/owlette-desktop.log' in names


@pytest.mark.skipif(sys.platform == 'win32', reason='O_NOFOLLOW is POSIX')
def test_desktop_log_symlink_is_refused(tree):
    target = tree['root'] / 'data' / '.tokens.enc'
    link = tree['desktop'] / 'owlette-desktop.2.log'
    os.symlink(target, link)

    result, names, _, _ = _build(tree['root'])

    assert 'desktop/owlette-desktop.2.log' not in names
    assert _reasons(result)['desktop/owlette-desktop.2.log'] == 'is a link'
    # and a link swapped in after the listing is refused on open
    with pytest.raises(log_bundle._Skip, match='could not be opened'):
        log_bundle._open_checked(str(link), None)


def test_missing_desktop_folder_is_listed(tree, monkeypatch):
    monkeypatch.setattr(log_bundle, '_desktop_source',
                        lambda: (str(tree['root'] / 'nowhere'), None))

    result, names, _, _ = _build(tree['root'])

    assert _reasons(result)['desktop/'] == 'the desktop app has no log folder'
    assert 'logs/service.log' in names


def test_no_console_user_is_listed(tree, monkeypatch):
    def nobody():
        raise log_bundle._Skip('nobody is at a graphical session')

    monkeypatch.setattr(log_bundle, '_desktop_source', nobody)

    result, _, _, _ = _build(tree['root'])

    assert _reasons(result)['desktop/'] == 'nobody is at a graphical session'


def test_uncompressed_budget_keeps_the_newest(tree, monkeypatch):
    monkeypatch.setattr(log_bundle, 'UNCOMPRESSED_BUDGET_BYTES', 2500)
    now = time.time()
    for age, name in enumerate(['a.log', 'b.log', 'c.log']):
        path = tree['logs'] / name
        path.write_bytes(b'x' * 1000)
        os.utime(path, (now - age * 60, now - age * 60))
    for path in [tree['logs'] / 'service.log', tree['logs'] / 'swoop' / 'host.log',
                 tree['logs'] / 'roost_scrub_reports' / 'scrub.json',
                 tree['desktop'] / 'owlette-desktop.log']:
        os.utime(path, (now - DAY, now - DAY))

    result, names, _, _ = _build(tree['root'])

    assert 'logs/a.log' in names and 'logs/b.log' in names
    assert 'logs/c.log' not in names
    assert _reasons(result)['logs/c.log'] == 'past the 300 MB uncompressed budget'
    with zipfile.ZipFile(tree['root'] / 'out' / 'logs.zip') as zf:
        total = sum(i.file_size for i in zf.infolist() if i.filename != 'manifest.txt')
    assert total <= 2500


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

    capped = [n for n, r in result['skipped'] if r == 'the zip reached its 50 MB cap']
    assert capped
    assert not set(capped) & set(names)
    assert 'cut short at the 50 MB zip cap' in manifest
    # the overshoot is one chunk plus what deflate holds back plus the manifest
    assert dest.stat().st_size < cap + chunk + 128 * 1024
    assert result['files'] == len(names) - 1


def test_cap_leaves_room_under_the_upload_limit():
    # the upload-url route refuses anything over 50 MiB
    overshoot = log_bundle.CHUNK_BYTES + 1024 * 1024
    assert log_bundle.ARCHIVE_CAP_BYTES + overshoot <= 50 * 1024 * 1024
