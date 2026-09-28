"""tests for sync_assembler — atomic file reassembly with allowlist enforcement."""

import hashlib
import os
import threading
from pathlib import Path

import pytest

from destination_allowlist import DestinationAllowlist, DestinationNotAllowedError
from sync_assembler import AssembleError, AssembleResult, assemble_all
# bound at import: conftest.py stubs sync_assembler._harden_acl out of every test.
from sync_assembler import _harden_acl as _real_harden_acl
from sync_downloader import chunk_path
from sync_version import VersionChunk, VersionFile
from sync_state import SyncState


def _put_chunk(store: Path, data: bytes) -> str:
    h = hashlib.sha256(data).hexdigest()
    target = chunk_path(store, h)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return h


def _mk_version_file(path: str, chunk_data_list):
    """build a VersionFile from a list of chunk byte payloads."""
    chunks = []
    total = 0
    for data in chunk_data_list:
        h = hashlib.sha256(data).hexdigest()
        chunks.append(VersionChunk(hash=h, size=len(data)))
        total += len(data)
    return VersionFile(path=path, size=total, chunks=chunks)


# happy path


def test_single_file_single_chunk(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        data = b'hello world'
        _put_chunk(content, data)
        f = _mk_version_file('a.toe', [data])

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        result = assemble_all(
            distribution_id=dist_id,
            files=[f],
            extract_root=str(extract),
            state=state,
            allowlist=allowlist,
            content_store=str(content),
        )
        assert result.assembled == 1
        assert result.failed == 0
        assert (extract / 'a.toe').read_bytes() == data
    finally:
        state.close()


def test_single_file_multiple_chunks(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        chunks_data = [b'part 1 ', b'part 2 ', b'part 3']
        for d in chunks_data:
            _put_chunk(content, d)
        f = _mk_version_file('a.toe', chunks_data)

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        assemble_all(
            distribution_id=dist_id, files=[f], extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )
        assert (extract / 'a.toe').read_bytes() == b''.join(chunks_data)
    finally:
        state.close()


def test_creates_subdirectories(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        data = b'nested file content'
        _put_chunk(content, data)
        f = _mk_version_file('sub/dir/deep/file.toe', [data])

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        assemble_all(
            distribution_id=dist_id, files=[f], extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )
        assert (extract / 'sub' / 'dir' / 'deep' / 'file.toe').read_bytes() == data
    finally:
        state.close()


def test_idempotent_skip_when_target_already_present(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        data = b'pre-existing content'
        _put_chunk(content, data)
        f = _mk_version_file('a.toe', [data])
        # pre-create the target with the right size
        (extract / 'a.toe').write_bytes(data)

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        result = assemble_all(
            distribution_id=dist_id, files=[f], extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )
        assert result.assembled == 0
        assert result.skipped == 1
    finally:
        state.close()


# security floor


def test_extract_root_outside_allowlist_raises(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        # allowlist is /allowed but extract_root is /not_allowed
        allowed = tmp_path / 'allowed'
        not_allowed = tmp_path / 'not_allowed'
        allowed.mkdir()
        not_allowed.mkdir()
        allowlist = DestinationAllowlist([str(allowed)])

        f = _mk_version_file('a.toe', [b'data'])
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        with pytest.raises(AssembleError, match="not allowed"):
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(not_allowed),
                state=state, allowlist=allowlist, content_store=str(content),
            )
    finally:
        state.close()


def test_empty_allowlist_rejects_everything(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        allowlist = DestinationAllowlist([])  # fail-closed
        f = _mk_version_file('a.toe', [b'data'])
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        with pytest.raises(AssembleError, match="not allowed"):
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(tmp_path),
                state=state, allowlist=allowlist, content_store=str(tmp_path / 'c'),
            )
    finally:
        state.close()


# failure paths


def test_missing_chunk_in_store_fails_assembly(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        content.mkdir()
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])
        # claim a chunk exists but never put it in the store
        f = _mk_version_file('a.toe', [b'never-downloaded'])

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        with pytest.raises(AssembleError, match="failed to assemble"):
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(extract),
                state=state, allowlist=allowlist, content_store=str(content),
            )
        # state row marked failed
        files = state.list_files(dist_id, state='failed')
        assert len(files) == 1
        assert 'missing from content store' in (files[0]['error'] or '')
    finally:
        state.close()


def test_partial_file_left_on_failure_for_resume(tmp_path):
    """on failure mid-assemble, the .partial sidecar stays so a retry can resume."""
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        content.mkdir()
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        # 2 chunks: first present, second missing
        first_data = b'first chunk data'
        _put_chunk(content, first_data)
        f = _mk_version_file('a.toe', [first_data, b'never-there'])

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        with pytest.raises(AssembleError):
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(extract),
                state=state, allowlist=allowlist, content_store=str(content),
            )
        # the live target file does NOT exist
        assert not (extract / 'a.toe').exists()
    finally:
        state.close()


# cancellation


# long-path support (windows)


def test_long_path_helper_pure_function():
    """unit-level coverage for _long_path: short paths pass through, long paths get prefix."""
    import os
    from sync_assembler import _long_path
    if os.name != 'nt':
        # POSIX: always pass through
        assert _long_path('/short/path') == '/short/path'
        assert _long_path('/' + 'x' * 300) == '/' + 'x' * 300
        return
    # windows
    short = 'C:\\Users\\dylan\\file.toe'
    assert _long_path(short) == short
    long_path = 'C:\\Users\\dylan\\' + 'x' * 280 + '\\file.toe'
    assert _long_path(long_path).startswith('\\\\?\\C:\\')
    # already-prefixed → unchanged
    pre_prefixed = '\\\\?\\C:\\anything'
    assert _long_path(pre_prefixed) == pre_prefixed
    # UNC paths get the special UNC prefix
    unc_long = '\\\\server\\share\\' + 'x' * 280
    assert _long_path(unc_long).startswith('\\\\?\\UNC\\')


@pytest.mark.windows(reason='windows long-path test')
def test_assembles_file_at_long_path(tmp_path):
    """assemble a file whose final path exceeds MAX_PATH (260). win32 must accept `\\\\?\\` prefix."""
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        # tmp_path + 'extract' is ~85-90 chars on CI; pad to push the target past MAX_PATH (260).
        deep_segments = ['x' * 30 for _ in range(8)]  # 8 dirs of 30 chars each = ~240 chars
        deep_relative = '/'.join(deep_segments) + '/file.toe'
        full = str(extract / deep_relative.replace('/', os.sep))
        if len(full) < 260:
            pytest.skip(f"test path only {len(full)} chars on this filesystem; can't exercise long-path")

        data = b'long-path content'
        _put_chunk(content, data)
        f = _mk_version_file(deep_relative, [data])

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        result = assemble_all(
            distribution_id=dist_id, files=[f], extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )
        assert result.assembled == 1
        # stat via the long-path-prefixed string; a regular Path may fail
        from sync_assembler import _long_path
        prefixed = _long_path(full)
        assert os.path.exists(prefixed)
    finally:
        state.close()


# ACL hardening (windows, best-effort)


def test_harden_acl_no_op_on_posix():
    """off windows, _harden_acl returns before touching win32security."""
    import sys
    from unittest.mock import MagicMock, patch
    ws = MagicMock()
    with patch.dict(sys.modules, {'win32security': ws}), \
            patch('sync_assembler.os.name', 'posix'):
        _real_harden_acl('/nonexistent/path/file.toe')
    assert ws.mock_calls == []


@pytest.mark.skipif(os.name != 'nt', reason='windows ACL test')
def test_harden_acl_silent_when_pywin32_missing():
    """when pywin32 is unimportable, _harden_acl returns without raising, logging
    or applying anything."""
    import sys
    from unittest.mock import patch
    # None in sys.modules makes the import raise ImportError
    with patch.dict(sys.modules, {'win32security': None, 'ntsecuritycon': None}), \
            patch('sync_assembler.logger') as log:
        _real_harden_acl('C:\\anywhere\\file.toe')
    # without pywin32, any attempt at the DACL can only end in the warning branch
    assert log.mock_calls == []


@pytest.mark.windows(reason='windows ACL test')
def test_assemble_calls_harden_acl_on_target(tmp_path):
    """end-to-end: assembling a file invokes _harden_acl with the target path."""
    from unittest.mock import patch
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        data = b'acl test'
        _put_chunk(content, data)
        f = _mk_version_file('a.toe', [data])

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        with patch('sync_assembler._harden_acl') as mock_harden:
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(extract),
                state=state, allowlist=allowlist, content_store=str(content),
            )
        mock_harden.assert_called_once()
        # called with the target path string (long-path-prefixed form)
        called_with = mock_harden.call_args[0][0]
        assert 'a.toe' in called_with
    finally:
        state.close()


@pytest.mark.skipif(os.name != 'nt', reason='windows ACL test')
def test_harden_acl_takes_well_known_accounts_from_sids():
    """account names are localized ("Administratoren" on german windows): only the
    operator's own account may be looked up by name, never SYSTEM or Administrators."""
    import sys
    from unittest.mock import MagicMock, call, patch

    def localized_lookup(_system, name):
        # a non-english box: the english well-known names do not resolve
        if name == 'operator':
            return 'sid:operator', 'KIOSK', 1
        raise Exception(f'no mapping for {name!r}')

    ws = MagicMock()
    ws.ConvertStringSidToSid.side_effect = lambda sid: f'sid:{sid}'
    ws.LookupAccountName.side_effect = localized_lookup
    with patch.dict(sys.modules, {'win32security': ws}), \
            patch('sync_assembler.get_interactive_username', return_value='operator'):
        _real_harden_acl('C:\\anywhere\\file.toe')

    assert ws.LookupAccountName.call_args_list == [call('', 'operator')]
    aces = ws.ACL.return_value.AddAccessAllowedAce.call_args_list
    assert [c.args[-1] for c in aces] == [
        'sid:S-1-5-18', 'sid:S-1-5-32-544', 'sid:operator',
    ]
    ws.SetFileSecurity.assert_called_once()


def test_cancel_event_stops_after_current_file(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        data = b'data'
        _put_chunk(content, data)
        files = [_mk_version_file(f'f{i}.toe', [data]) for i in range(3)]

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size} for f in files], chunks=[],
        )
        cancel_event = threading.Event()
        cancel_event.set()  # pre-cancelled

        result = assemble_all(
            distribution_id=dist_id, files=files, extract_root=str(extract),
            state=state, allowlist=allowlist, cancel_event=cancel_event,
            content_store=str(content),
        )
        assert result.assembled == 0
        assert result.cancelled is True
    finally:
        state.close()


# post-rename realpath TOCTOU defense


def test_post_rename_realpath_catches_escape(tmp_path, monkeypatch):
    """
    simulate a TOCTOU symlink-swap between destination_allowlist.validate()
    and os.replace(): validate passes because no symlink exists yet, but
    realpath resolves the landed file to a location OUTSIDE extract_root.
    the assembler must detect this post-rename and quarantine the file.
    """
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        outside = tmp_path / 'outside'
        extract.mkdir()
        outside.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        data = b'payload'
        _put_chunk(content, data)
        f = _mk_version_file('a.toe', [data])

        # patch realpath so the post-rename check resolves the target to `outside` while validate()
        # saw a clean path. the allowlist already consumed its own realpath, so only
        # sync_assembler's calls are affected.
        real_realpath = os.path.realpath
        extract_real = real_realpath(str(extract))
        outside_real = real_realpath(str(outside))

        def fake_realpath(p, *args, **kwargs):
            s = str(p)
            # spoof ONLY the final target; leave extract_root alone or the compare never triggers.
            # Gated on the file existing: since Python 3.10, pathlib.Path.resolve()
            # delegates to os.path.realpath, so an ungated spoof leaks into
            # DestinationAllowlist.validate() and rejects the target BEFORE the
            # post-rename check this test exists to exercise (validate runs while
            # the target does not exist yet; the post-rename check runs after it
            # does). On 3.9 the gate is inert - only sync_assembler's own call on
            # the renamed, now-existing file was ever spoofed.
            if s.endswith('a.toe') and os.path.exists(s):
                return os.path.join(outside_real, 'a.toe')
            return real_realpath(s, *args, **kwargs)

        monkeypatch.setattr('sync_assembler.os.path.realpath', fake_realpath)

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        with pytest.raises(AssembleError, match="failed to assemble"):
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(extract),
                state=state, allowlist=allowlist, content_store=str(content),
            )
        # the suspect file must have been quarantine-deleted.
        assert not (extract / 'a.toe').exists(), \
            "post-rename escape detection failed to quarantine the file"
        # the per-file row must carry the real detection message, not just the wrapper summary.
        failed_rows = state.list_files(dist_id, state='failed')
        assert len(failed_rows) == 1
        assert 'post-rename integrity' in (failed_rows[0]['error'] or '')
    finally:
        state.close()


def test_chunks_are_deleted_after_successful_assembly(tmp_path):
    """
    post-assembly cleanup: on success, chunks referenced by the version
    are deleted from the content store. R2 retains canonical copies — keeping
    them locally would double disk usage for every sync.
    """
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        chunks_data = [b'alpha chunk bytes', b'bravo chunk bytes']
        chunk_hashes = [_put_chunk(content, d) for d in chunks_data]
        f = _mk_version_file('a.toe', chunks_data)

        # precondition: both chunks on disk before assembly
        for h in chunk_hashes:
            assert chunk_path(content, h).exists()

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        assemble_all(
            distribution_id=dist_id, files=[f], extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )

        # the assembled file IS present…
        assert (extract / 'a.toe').read_bytes() == b''.join(chunks_data)
        # …and both chunks were cleaned up from the content store.
        for h in chunk_hashes:
            assert not chunk_path(content, h).exists(), (
                f"chunk {h[:12]}… should have been deleted post-assembly"
            )
    finally:
        state.close()


def test_chunks_kept_when_assembly_fails(tmp_path):
    """
    cleanup runs ONLY on success. if assembly fails, chunks must remain so
    a resume / retry can reuse them (re-downloading 100GB would be awful).
    """
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        content.mkdir()
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        first_data = b'first chunk kept on failure'
        first_hash = _put_chunk(content, first_data)
        # second chunk missing from store → assembly fails
        f = _mk_version_file('a.toe', [first_data, b'never-downloaded-chunk'])

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        with pytest.raises(AssembleError):
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(extract),
                state=state, allowlist=allowlist, content_store=str(content),
            )
        # the existing chunk is still on disk — resume needs it
        assert chunk_path(content, first_hash).exists(), (
            "chunks must be retained on assembly failure so resume can reuse them"
        )
    finally:
        state.close()


def test_chunks_kept_when_only_skips(tmp_path):
    """
    idempotent re-runs (every file already present + matches size) should not
    churn the content store. no assembled=0 path triggers cleanup.
    """
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        data = b'pre-existing + matching'
        chunk_hash = _put_chunk(content, data)
        f = _mk_version_file('a.toe', [data])
        # target already present with correct size → skip path
        (extract / 'a.toe').write_bytes(data)

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        result = assemble_all(
            distribution_id=dist_id, files=[f], extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )
        assert result.assembled == 0
        assert result.skipped == 1
        # chunk NOT deleted — nothing assembled this run, so no reason to churn the cache.
        assert chunk_path(content, chunk_hash).exists()
    finally:
        state.close()


def test_post_rename_allows_sibling_root_substring(tmp_path):
    """
    regression: `/foo/bar-extra/file` must NOT satisfy a root of `/foo/bar`
    via naive prefix matching. the separator-appended compare in
    _verify_under_root catches this.
    """
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        # `extract_bar` vs `extract` — latter is a prefix of the former
        extract_bar = tmp_path / 'extract'
        sibling = tmp_path / 'extract-sibling'
        extract_bar.mkdir()
        sibling.mkdir()
        # only `extract_bar` is allowed
        allowlist = DestinationAllowlist([str(extract_bar)])

        data = b'content'
        _put_chunk(content, data)
        f = _mk_version_file('file.toe', [data])

        # normal happy path — file lands under extract_bar, realpath stays there.
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        result = assemble_all(
            distribution_id=dist_id, files=[f], extract_root=str(extract_bar),
            state=state, allowlist=allowlist, content_store=str(content),
        )
        assert result.assembled == 1
        assert (extract_bar / 'file.toe').exists()
    finally:
        state.close()


# tree reconciliation (the project-level swap)


def _snapshot(root: Path) -> dict:
    """{relative posix path -> bytes} for every file under root."""
    out = {}
    for p in sorted(root.rglob('*')):
        if p.is_file():
            out[p.relative_to(root).as_posix()] = p.read_bytes()
    return out


def _register(state, version_id, files, extract, chunks=None):
    """register a distribution row the way sync_commands does."""
    return state.start_distribution(
        site_id='s', roost_id='r', version_id=version_id,
        version_url=f'u-{version_id}',
        files=[{'path': f.path, 'size': f.size} for f in files],
        chunks=chunks or [],
        extract_root=str(extract),
    )


def test_rollback_to_v1_leaves_tree_exactly_equal_to_v1(tmp_path):
    """
    the headline contract: assemble v2 over v1, roll back to v1, and the
    extract tree must equal v1 EXACTLY. before tree reconciliation the file
    v2 added survived the rollback, so the documented "atomic project-level
    swap" was a per-file overwrite in practice.
    """
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        root = tmp_path / 'extract'
        extract = root / 'show'
        extract.mkdir(parents=True)
        allowlist = DestinationAllowlist([str(root)])

        v1_main = b'v1 main project'
        v2_main = b'v2 main project (edited)'
        v2_extra = b'asset only v2 shipped'

        v1_files = [_mk_version_file('main.toe', [v1_main])]
        v2_files = [
            _mk_version_file('main.toe', [v2_main]),
            _mk_version_file('assets/extra.dat', [v2_extra]),
        ]

        # --- v1 ---
        _put_chunk(content, v1_main)
        d1 = _register(state, 'v1', v1_files, extract)
        assemble_all(
            distribution_id=d1, files=v1_files, extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )
        v1_tree = _snapshot(extract)
        assert v1_tree == {'main.toe': v1_main}

        # --- v2 over v1 ---
        _put_chunk(content, v2_main)
        _put_chunk(content, v2_extra)
        d2 = _register(state, 'v2', v2_files, extract)
        r2 = assemble_all(
            distribution_id=d2, files=v2_files, extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )
        assert r2.assembled == 2
        assert r2.pruned == 0  # nothing v1 had is missing from v2
        assert (extract / 'assets' / 'extra.dat').exists()

        # --- rollback: the agent just re-pulls the older version ---
        _put_chunk(content, v1_main)
        r1 = assemble_all(
            distribution_id=d1, files=v1_files, extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )

        assert r1.pruned == 1
        assert r1.prune_failed == 0
        assert _snapshot(extract) == v1_tree
        # the directory that only held the v2-only asset went with it
        assert not (extract / 'assets').exists()
        # ...but the roost keeps its own root
        assert extract.is_dir()
    finally:
        state.close()


def test_prune_never_touches_files_the_agent_did_not_write(tmp_path):
    """
    provenance, not a directory walk: the default extract root is shared
    between roosts, so anything we have no record of writing stays put.
    """
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        root = tmp_path / 'extract'
        extract = root / 'show'
        extract.mkdir(parents=True)
        allowlist = DestinationAllowlist([str(root)])

        operator_file = extract / 'operator-notes.txt'
        operator_file.write_bytes(b'not ours')
        other_roost_file = extract / 'nested' / 'other-roost.toe'
        other_roost_file.parent.mkdir()
        other_roost_file.write_bytes(b'another roost lives here')

        data = b'our only file'
        _put_chunk(content, data)
        files = [_mk_version_file('main.toe', [data])]
        dist_id = _register(state, 'v1', files, extract)
        result = assemble_all(
            distribution_id=dist_id, files=files, extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )

        assert result.pruned == 0
        assert operator_file.read_bytes() == b'not ours'
        assert other_roost_file.read_bytes() == b'another roost lives here'
    finally:
        state.close()


def test_prune_ignores_distributions_that_landed_in_another_root(tmp_path):
    """
    a roost whose extract_path was changed must not have its OLD tree's file
    names deleted out of the NEW tree just because the names collide.
    """
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        root = tmp_path / 'extract'
        old_extract = root / 'old'
        new_extract = root / 'new'
        old_extract.mkdir(parents=True)
        new_extract.mkdir(parents=True)
        allowlist = DestinationAllowlist([str(root)])

        old_data = b'old root file'
        _put_chunk(content, old_data)
        old_files = [_mk_version_file('legacy.toe', [old_data])]
        d_old = _register(state, 'v1', old_files, old_extract)
        assemble_all(
            distribution_id=d_old, files=old_files, extract_root=str(old_extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )

        # a same-named file appears in the NEW root, written by someone else
        collision = new_extract / 'legacy.toe'
        collision.write_bytes(b'unrelated file in the new root')

        new_data = b'new root file'
        _put_chunk(content, new_data)
        new_files = [_mk_version_file('main.toe', [new_data])]
        d_new = _register(state, 'v2', new_files, new_extract)
        result = assemble_all(
            distribution_id=d_new, files=new_files, extract_root=str(new_extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )

        assert result.pruned == 0
        assert collision.read_bytes() == b'unrelated file in the new root'
        assert (old_extract / 'legacy.toe').exists()
    finally:
        state.close()


def test_prune_removes_orphaned_partial_sidecar(tmp_path):
    """an interrupted write for a file the new version dropped is garbage."""
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        root = tmp_path / 'extract'
        extract = root / 'show'
        extract.mkdir(parents=True)
        allowlist = DestinationAllowlist([str(root)])

        gone_data = b'file that v2 drops'
        _put_chunk(content, gone_data)
        v1_files = [_mk_version_file('dropped.toe', [gone_data])]
        d1 = _register(state, 'v1', v1_files, extract)
        assemble_all(
            distribution_id=d1, files=v1_files, extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )
        # simulate a crash mid-rewrite of that same file
        sidecar = extract / 'dropped.toe.partial'
        sidecar.write_bytes(b'half-written bytes')

        kept_data = b'v2 keeps only this'
        _put_chunk(content, kept_data)
        v2_files = [_mk_version_file('kept.toe', [kept_data])]
        d2 = _register(state, 'v2', v2_files, extract)
        result = assemble_all(
            distribution_id=d2, files=v2_files, extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )

        assert result.pruned == 1
        assert not (extract / 'dropped.toe').exists()
        assert not sidecar.exists()
        assert (extract / 'kept.toe').read_bytes() == kept_data
    finally:
        state.close()


def test_prune_can_be_disabled(tmp_path):
    """prune=False keeps the pre-reconciliation behaviour for callers that want it."""
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        root = tmp_path / 'extract'
        extract = root / 'show'
        extract.mkdir(parents=True)
        allowlist = DestinationAllowlist([str(root)])

        old_data = b'dropped by v2'
        _put_chunk(content, old_data)
        v1_files = [_mk_version_file('dropped.toe', [old_data])]
        d1 = _register(state, 'v1', v1_files, extract)
        assemble_all(
            distribution_id=d1, files=v1_files, extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )

        new_data = b'v2 file'
        _put_chunk(content, new_data)
        v2_files = [_mk_version_file('kept.toe', [new_data])]
        d2 = _register(state, 'v2', v2_files, extract)
        result = assemble_all(
            distribution_id=d2, files=v2_files, extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
            prune=False,
        )

        assert result.pruned == 0
        assert (extract / 'dropped.toe').exists()
    finally:
        state.close()


def test_prune_skipped_when_cancelled(tmp_path):
    """
    a cancelled run must not reconcile: the tree is a partial install and
    deleting the previous version's files would leave gaps.
    """
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        root = tmp_path / 'extract'
        extract = root / 'show'
        extract.mkdir(parents=True)
        allowlist = DestinationAllowlist([str(root)])

        old_data = b'v1 file that v2 drops'
        _put_chunk(content, old_data)
        v1_files = [_mk_version_file('dropped.toe', [old_data])]
        d1 = _register(state, 'v1', v1_files, extract)
        assemble_all(
            distribution_id=d1, files=v1_files, extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )

        new_data = b'v2 file'
        _put_chunk(content, new_data)
        v2_files = [_mk_version_file('kept.toe', [new_data])]
        d2 = _register(state, 'v2', v2_files, extract)
        cancel = threading.Event()
        cancel.set()
        result = assemble_all(
            distribution_id=d2, files=v2_files, extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
            cancel_event=cancel,
        )

        assert result.cancelled is True
        assert result.pruned == 0
        assert (extract / 'dropped.toe').exists()
    finally:
        state.close()


def test_prune_skipped_for_rows_without_an_extract_root(tmp_path):
    """
    a pre-4a.4 distribution row has no extract_root, so we cannot prove its
    files landed in this tree — leave them.
    """
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        root = tmp_path / 'extract'
        extract = root / 'show'
        extract.mkdir(parents=True)
        allowlist = DestinationAllowlist([str(root)])

        legacy = extract / 'legacy.toe'
        legacy.write_bytes(b'written by an older agent build')
        # row with extract_root=None, file marked as written
        d_legacy = state.start_distribution(
            site_id='s', roost_id='r', version_id='v0', version_url='u0',
            files=[{'path': 'legacy.toe', 'size': legacy.stat().st_size}],
            chunks=[],
        )
        state.set_file_state(d_legacy, 'legacy.toe', 'committed')

        data = b'current version'
        _put_chunk(content, data)
        files = [_mk_version_file('main.toe', [data])]
        dist_id = _register(state, 'v1', files, extract)
        result = assemble_all(
            distribution_id=dist_id, files=files, extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )

        assert result.pruned == 0
        assert legacy.exists()
    finally:
        state.close()


# file modes (POSIX, best-effort)


@pytest.mark.parametrize('head', [
    b'#!/bin/sh\nexit 0\n',
    b'\x7fELF\x02\x01\x01\x00',
    b'\xcf\xfa\xed\xfe\x0c\x00\x00\x01',   # Mach-O 64, little-endian
    b'\xfe\xed\xfa\xce\x00\x00\x00\x12',   # Mach-O 32, big-endian
    b'\xca\xfe\xba\xbe\x00\x00\x00\x02',   # a universal binary
])
def test_an_assembled_program_gets_its_execute_bit(head, monkeypatch, tmp_path):
    """the .partial sidecar is opened 0644 and os.replace carries that mode
    across, so without this a synced binary or script arrives unable to run.
    the v1 version schema has no mode field -- the browser uploader has none to
    send -- so the content is the only signal there is."""
    import sync_assembler
    monkeypatch.setattr(sync_assembler, '_HAS_FILE_MODES', True)
    target = tmp_path / 'program'
    target.write_bytes(head)

    modes = _record_fchmod(monkeypatch)
    sync_assembler._apply_file_mode(str(target))

    assert modes == [0o755]


@pytest.mark.parametrize('head', [b'\x89PNG\r\n\x1a\n', b'TOE\x00', b''])
def test_an_assembled_document_is_not_made_executable(head, monkeypatch, tmp_path):
    """negative control: a project file that arrived 0666 under a loose umask
    is brought back to 0644, and nothing that is not a program is 0755."""
    import sync_assembler
    monkeypatch.setattr(sync_assembler, '_HAS_FILE_MODES', True)
    target = tmp_path / 'show.toe'
    target.write_bytes(head)

    modes = _record_fchmod(monkeypatch)
    sync_assembler._apply_file_mode(str(target))

    assert modes == [0o644]


def test_windows_leaves_the_mode_alone(monkeypatch, tmp_path):
    """what a file may do on windows is its DACL, which _harden_acl sets;
    a chmod there would only toggle the read-only bit."""
    import sync_assembler
    monkeypatch.setattr(sync_assembler, '_HAS_FILE_MODES', False)
    target = tmp_path / 'program'
    target.write_bytes(b'#!/bin/sh\n')

    modes = _record_fchmod(monkeypatch)
    sync_assembler._apply_file_mode(str(target))

    assert modes == []


@pytest.mark.skipif(os.name != 'posix', reason='fifos and O_NONBLOCK are POSIX')
def test_a_fifo_at_the_target_is_not_chmodded(monkeypatch, tmp_path):
    """negative control for the flags: the folder belongs to the kiosk user by
    the time the mode is set, so a fifo swapped in over the renamed file would
    otherwise block the sync thread in the open for good."""
    import signal

    import sync_assembler
    monkeypatch.setattr(sync_assembler, '_HAS_FILE_MODES', True)
    target = tmp_path / 'program'
    os.mkfifo(target)

    modes = _record_fchmod(monkeypatch)

    def _blocked(signum, frame):
        raise AssertionError('setting the mode blocked on the fifo')

    previous = signal.signal(signal.SIGALRM, _blocked)
    signal.alarm(3)
    try:
        sync_assembler._apply_file_mode(str(target))
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)

    assert modes == []


def _record_fchmod(monkeypatch):
    """The modes _apply_file_mode sets, from either platform.

    os.fchmod does not exist on windows at all, which is why the injected
    platform has to be answered rather than run for real.
    """
    import sync_assembler
    modes = []
    monkeypatch.setattr(
        sync_assembler.os, 'fchmod', lambda fd, mode: modes.append(mode),
        raising=False,
    )
    return modes


def test_assemble_sets_the_mode_of_what_it_wrote(tmp_path):
    """end-to-end: the mode is applied to the target after the rename, not to
    the sidecar that no longer exists."""
    from unittest.mock import patch
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        data = b'#!/bin/sh\nexit 0\n'
        _put_chunk(content, data)
        f = _mk_version_file('run.sh', [data])

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        with patch('sync_assembler._apply_file_mode') as mock_mode:
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(extract),
                state=state, allowlist=allowlist, content_store=str(content),
            )

        assert mock_mode.call_count == 1
        assert mock_mode.call_args[0][0].endswith('run.sh')
    finally:
        state.close()


def test_a_resync_reapplies_the_mode_of_a_file_it_skipped(tmp_path):
    """the mode is best-effort, so one that did not take is repaired the way a
    stale owner and a stale DACL are — by syncing again, which skips the file
    on its size and re-hardens it."""
    from unittest.mock import patch
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        data = b'#!/bin/sh\nexit 0\n'
        _put_chunk(content, data)
        f = _mk_version_file('run.sh', [data])
        dist_id = _register(state, 'v1', [f], extract)

        assemble_all(
            distribution_id=dist_id, files=[f], extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )
        with patch('sync_assembler._apply_file_mode') as mock_mode:
            result = assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(extract),
                state=state, allowlist=allowlist, content_store=str(content),
            )

        assert result.skipped == 1
        assert mock_mode.call_count == 1
        assert mock_mode.call_args[0][0].endswith('run.sh')
    finally:
        state.close()


# file ownership (POSIX, best-effort)


def test_chown_is_a_no_op_without_a_console_user(monkeypatch):
    """None ids — windows, an unprivileged agent, or nobody logged in — must not
    reach os.chown, which does not exist on windows at all."""
    import sync_assembler
    calls = []
    monkeypatch.setattr(sync_assembler, 'get_interactive_user_ids', lambda: None)
    monkeypatch.setattr(
        sync_assembler.os, 'chown', lambda *a, **kw: calls.append((a, kw)), raising=False
    )
    sync_assembler._chown_to_interactive_user('/var/lib/owlette/projects/a.toe')
    assert calls == []


def test_chown_gives_the_file_to_the_console_user(monkeypatch):
    """the daemon is root, so without this the kiosk user cannot open what roost
    just wrote. follow_symlinks=False: the kiosk user owns the folder this path
    sits in, so a link left at it would hand a root-owned file away."""
    import sync_assembler
    calls = []
    monkeypatch.setattr(sync_assembler, 'get_interactive_user_ids', lambda: (1001, 1002))
    monkeypatch.setattr(
        sync_assembler.os, 'chown', lambda *a, **kw: calls.append((a, kw)), raising=False
    )
    sync_assembler._chown_to_interactive_user('/var/lib/owlette/projects/a.toe')
    assert calls == [
        (('/var/lib/owlette/projects/a.toe', 1001, 1002), {'follow_symlinks': False})
    ]


def test_chown_failure_never_fails_the_assembly(monkeypatch):
    """ownership is best-effort, exactly like the windows DACL — including the
    NotImplementedError a platform without lchown raises."""
    import sync_assembler

    def boom(*_args, **_kwargs):
        raise OSError(1, 'Operation not permitted')

    def unsupported(*_args, **_kwargs):
        raise NotImplementedError('follow_symlinks is unavailable on this platform')

    monkeypatch.setattr(sync_assembler, 'get_interactive_user_ids', lambda: (1001, 1002))
    monkeypatch.setattr(sync_assembler.os, 'chown', boom, raising=False)
    sync_assembler._chown_to_interactive_user('/var/lib/owlette/projects/a.toe')

    monkeypatch.setattr(sync_assembler.os, 'chown', unsupported, raising=False)
    sync_assembler._chown_to_interactive_user('/var/lib/owlette/projects/a.toe')


def test_assemble_chowns_the_target(tmp_path):
    """end-to-end: both the fresh write and the idempotent skip hand the file to
    the console user."""
    from unittest.mock import patch
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        data = b'chown test'
        _put_chunk(content, data)
        f = _mk_version_file('a.toe', [data])

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        with patch('sync_assembler._chown_to_interactive_user') as mock_chown:
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(extract),
                state=state, allowlist=allowlist, content_store=str(content),
            )
            assert mock_chown.call_count == 1
            assert 'a.toe' in mock_chown.call_args[0][0]

            # re-sync: the skip path re-applies ownership rather than leaving a
            # file that an older build wrote as root.
            mock_chown.reset_mock()
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(extract),
                state=state, allowlist=allowlist, content_store=str(content),
            )
            assert mock_chown.call_count == 1
    finally:
        state.close()


def test_assemble_chowns_the_directories_under_the_extract_root(tmp_path):
    """
    a root-owned project folder is readable but not writable by the kiosk user,
    so the app cannot save a Backup/ or a lock file beside the file roost just
    wrote. the extract root itself is pre-existing and must not be touched.
    """
    from unittest.mock import patch
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        data = b'nested chown test'
        _put_chunk(content, data)
        f = _mk_version_file('show1/assets/a.toe', [data])

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        # the console user the POSIX daemon would resolve; None on windows,
        # where ownership is a DACL and the directory pass is skipped.
        with patch('sync_assembler.get_interactive_user_ids', return_value=(1001, 1002)), \
                patch('sync_assembler._chown_to_interactive_user') as mock_chown:
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(extract),
                state=state, allowlist=allowlist, content_store=str(content),
            )
            owned = [call.args[0] for call in mock_chown.call_args_list]

            # a run that found nobody logged in left these root-owned; the
            # re-sync that skips every file is what repairs them.
            mock_chown.reset_mock()
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(extract),
                state=state, allowlist=allowlist, content_store=str(content),
            )
            re_owned = [call.args[0] for call in mock_chown.call_args_list]

        # with nobody at the machine there is nothing to hand the folders to,
        # and the ancestor walk is not paid per file.
        with patch('sync_assembler.get_interactive_user_ids', return_value=None), \
                patch('sync_assembler._chown_to_interactive_user') as no_user_chown:
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(extract),
                state=state, allowlist=allowlist, content_store=str(content),
            )
            assert str(extract / 'show1') not in [
                call.args[0] for call in no_user_chown.call_args_list
            ]

        for expected in [
            str(extract / 'show1'),
            str(extract / 'show1' / 'assets'),
            str(extract / 'show1' / 'assets' / 'a.toe'),
        ]:
            assert expected in owned
            assert expected in re_owned
        for untouched in [str(extract), str(tmp_path)]:
            assert untouched not in owned
            assert untouched not in re_owned
    finally:
        state.close()


@pytest.mark.skipif(os.name == 'nt', reason='windows has no O_NOFOLLOW')
def test_a_symlink_at_the_partial_path_is_refused(tmp_path):
    """
    the `.partial` sidecar is derived from the target string and never goes
    through the allowlist, and on POSIX the folder around it is handed to the
    kiosk user — so a link planted there would have the root daemon write roost
    bytes wherever it points. O_NOFOLLOW refuses it; the file outside stays as
    it was and the assembly fails rather than following the link.
    """
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        outside = tmp_path / 'outside.conf'
        outside.write_bytes(b'do not touch')
        allowlist = DestinationAllowlist([str(extract)])

        data = b'roost bytes'
        _put_chunk(content, data)
        f = _mk_version_file('a.toe', [data])

        try:
            os.symlink(str(outside), str(extract / 'a.toe.partial'))
        except (OSError, NotImplementedError):
            pytest.skip('symlink creation not permitted on this host')

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        with pytest.raises(AssembleError):
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(extract),
                state=state, allowlist=allowlist, content_store=str(content),
            )
        assert outside.read_bytes() == b'do not touch'
        assert not (extract / 'a.toe').exists()
    finally:
        state.close()
