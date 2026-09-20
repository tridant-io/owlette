"""locale / unicode / emoji / cjk / rtl filename tests for sync_assembler.

ntfs stores filenames as utf-16; python on windows uses wide-char apis. the
risk is that version paths containing accents, cjk, emoji, or rtl scripts
fail somewhere in the chunk → assembled-file pipeline (path joining, mkdir,
fsync, atomic rename, allowlist validation, sqlite state writes).

these tests exercise the full assemble_all() path with non-ascii filenames
and confirm:
  - the file is created at the expected path
  - the bytes match the source chunk
  - the SyncState row is queryable by the same path string
"""

import hashlib
import unicodedata
from pathlib import Path

import pytest

from destination_allowlist import DestinationAllowlist
from sync_assembler import assemble_all
from sync_downloader import chunk_path
from sync_version import VersionChunk, VersionFile
from sync_state import SyncState


def _put_chunk(store: Path, data: bytes) -> str:
    h = hashlib.sha256(data).hexdigest()
    target = chunk_path(store, h)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return h


def _mk_version_file(path: str, data: bytes) -> VersionFile:
    h = hashlib.sha256(data).hexdigest()
    return VersionFile(
        path=path, size=len(data), chunks=[VersionChunk(hash=h, size=len(data))]
    )


def _assemble(tmp_path: Path, rel_path: str, data: bytes = b'unicode payload'):
    """run a single-file assembly with the given path; return target Path."""
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])
        _put_chunk(content, data)
        f = _mk_version_file(rel_path, data)

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
        assert result.assembled == 1, f"failed to assemble {rel_path!r}"
        assert result.failed == 0
        target = extract / rel_path
        assert target.exists(), f"target missing for {rel_path!r}"
        assert target.read_bytes() == data
        return target
    finally:
        state.close()




def test_french_accents(tmp_path):
    _assemble(tmp_path, 'café/résumé.toe')


def test_spanish_tilde(tmp_path):
    _assemble(tmp_path, 'mañana/niño.toe')


def test_german_umlaut(tmp_path):
    _assemble(tmp_path, 'über/grüße.toe')


def test_nordic_chars(tmp_path):
    _assemble(tmp_path, 'København/Ærø.toe')




def test_chinese_simplified(tmp_path):
    _assemble(tmp_path, '中文/项目.toe')


def test_japanese_hiragana_kanji(tmp_path):
    _assemble(tmp_path, '日本語/プロジェクト.toe')


def test_korean_hangul(tmp_path):
    _assemble(tmp_path, '한국어/프로젝트.toe')




def test_arabic_filename(tmp_path):
    _assemble(tmp_path, 'مشروع/ملف.toe')


def test_hebrew_filename(tmp_path):
    _assemble(tmp_path, 'פרויקט/קובץ.toe')




def test_emoji_in_filename(tmp_path):
    _assemble(tmp_path, '🎵_audio.toe')


def test_emoji_in_directory(tmp_path):
    _assemble(tmp_path, '📁_projects/🎬_show.toe')


def test_multi_codepoint_emoji(tmp_path):
    # Surrogate-pair emoji: most likely to expose utf-16 handling bugs in
    # os.path on windows.
    _assemble(tmp_path, '👨‍👩‍👧‍👦/🇺🇸_show.toe')




def test_nfc_normalized_path(tmp_path):
    """NFC = composed form (single codepoint for é). standard for linux + windows."""
    nfc = unicodedata.normalize('NFC', 'café/résumé.toe')
    _assemble(tmp_path, nfc)


def test_nfd_normalized_path(tmp_path):
    """NFD = decomposed (e + combining acute). macOS APFS native form. windows
    accepts it but stores as the original codepoint sequence — round-trip should
    still produce a readable file even if the filesystem renormalizes."""
    nfd = unicodedata.normalize('NFD', 'café/résumé.toe')
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])
        data = b'nfd test'
        _put_chunk(content, data)
        f = _mk_version_file(nfd, data)

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
        # macOS filesystems renormalize, so accept either form.
        nfc_path = extract / unicodedata.normalize('NFC', nfd)
        nfd_path = extract / nfd
        assert nfc_path.exists() or nfd_path.exists(), (
            "neither NFC nor NFD form of NFD-input path exists on disk"
        )
    finally:
        state.close()




def test_mixed_scripts_in_one_path(tmp_path):
    """latin + cjk + emoji in a single path — confirms no script-mixing bugs."""
    _assemble(tmp_path, 'café_中文_🎵/résumé_日本語_📁.toe')


def test_long_unicode_path(tmp_path):
    """longer path with utf-8 multi-byte chars stays under windows MAX_PATH
    when measured in chars but well over when measured in bytes — exercises
    the long_path helper's char-count semantics."""
    parts = ['中文目录' * 10, 'プロジェクト' * 10, 'résumé.toe']
    _assemble(tmp_path, '/'.join(parts))


def test_state_row_queryable_by_unicode_path(tmp_path):
    """sqlite state writes use the path string as a key — confirm the same
    string round-trips through start_distribution + list_files."""
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])
        data = b'sqlite roundtrip'
        _put_chunk(content, data)
        path = '中文/résumé_🎵.toe'
        f = _mk_version_file(path, data)

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        assemble_all(
            distribution_id=dist_id,
            files=[f],
            extract_root=str(extract),
            state=state,
            allowlist=allowlist,
            content_store=str(content),
        )
        rows = state.list_files(dist_id)
        paths = [r['path'] for r in rows]
        assert path in paths, f"unicode path {path!r} not in {paths!r}"
        match = next(r for r in rows if r['path'] == path)
        assert match['state'] == 'committed'
    finally:
        state.close()




@pytest.mark.windows(reason='windows-only behavior')
def test_windows_reserved_chars_are_rejected(tmp_path):
    """windows reserves <>:"|?* in filenames. these MUST fail loud and early
    (allowlist validation rejects via path resolution); we never want a
    silent rename to the wrong location."""
    import threading

    from sync_assembler import AssembleError

    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])
        data = b'reserved char test'
        _put_chunk(content, data)
        # asterisk is reserved on windows
        f = _mk_version_file('bad*name.toe', data)

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        # default behavior raises AssembleError on first failure.
        with pytest.raises(AssembleError):
            assemble_all(
                distribution_id=dist_id,
                files=[f],
                extract_root=str(extract),
                state=state,
                allowlist=allowlist,
                content_store=str(content),
            )
        # confirm no file was created with the bad name
        assert not list(extract.glob('bad*'))
    finally:
        state.close()
