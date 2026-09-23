"""
sync_version — roost version fetch + cache + diff.

A version is the JSON document (docs/internal/manifest-format.md) listing every
file in a roost with its chunk hashes. Fetched from R2, cached locally, diffed
against the previous version to decide what to download.

Cache lives under <data root>/versions, deliberately NOT in the user's
Documents tree beside assembled files.

Fail-loud on `schemaVersion != 2`: forward-compat goes through mediaType, not
schema bumps.

Not here: chunk download (sync_downloader), reassembly (sync_assembler), signed
URL refresh (caller's), firestore writes (sync_commands).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, List, Optional, Set

import requests

import shared_utils

logger = logging.getLogger(__name__)

def _default_cache_dir() -> str:
    """
    default cache dir: `versions` under the agent's data root.

    See sync_state._default_state_db_path() for why `~/Documents/` is avoided
    under LocalSystem.
    """
    return shared_utils.get_data_path('versions')


VERSION_MEDIA_TYPE = 'application/vnd.owlette.version.v1+json'
VERSION_SCHEMA_VERSION = 2

# HTTP fetch tuning, mirroring installer_utils.
_FETCH_CONNECT_TIMEOUT_S = 30
_FETCH_READ_TIMEOUT_S = 120
_FETCH_RETRIES = 3
_FETCH_BACKOFF_BASE_S = 5

# Largest realistic version is ~20MB (500GB project / 4MiB chunks).
MAX_VERSION_SIZE_BYTES = 50 * 1024 * 1024


class VersionError(Exception):
    """raised when version fetch, validation, or parsing fails."""
    pass


@dataclass(frozen=True)
class VersionChunk:
    hash: str
    size: int


@dataclass(frozen=True)
class VersionFile:
    path: str
    size: int
    chunks: List[VersionChunk]


@dataclass(frozen=True)
class Version:
    """parsed, validated version. the canonical in-memory shape."""
    schema_version: int
    media_type: str
    config: dict
    files: List[VersionFile]
    raw_bytes: bytes  # original bytes (for hash + cache write)

    @property
    def total_size(self) -> int:
        return sum(f.size for f in self.files)

    @property
    def total_files(self) -> int:
        return len(self.files)

    @property
    def chunks(self) -> Set[str]:
        """set of unique chunk hashes referenced by this version."""
        return {c.hash for f in self.files for c in f.chunks}

    @property
    def chunk_size_index(self) -> dict:
        """{hash: size} for every unique chunk (dedup-aware)."""
        out: dict = {}
        for f in self.files:
            for c in f.chunks:
                out[c.hash] = c.size
        return out


@dataclass(frozen=True)
class VersionDiff:
    """delta between two versions (or new vs nothing)."""
    chunks_to_fetch: Set[str]    # in new, not in old
    chunks_unused: Set[str]       # in old, not in new (eligible for GC after assemble)
    files_added: List[VersionFile]
    files_removed: List[VersionFile]
    files_changed: List[VersionFile]
    files_unchanged: List[VersionFile]


def fetch_version(
    url: str,
    expected_version_id: Optional[str] = None,
    cache_dir: Optional[str] = None,
) -> Version:
    """
    fetch a version from an R2 signed URL, validate, cache, parse.

    expected_version_id names the cache file and lets a hit skip the HTTP
    fetch — callers SHOULD pass it. Raises VersionError on any failure.
    """
    cache_path: Optional[Path] = None
    if expected_version_id is not None:
        if cache_dir is None:
            cache_root = Path(_default_cache_dir())
        else:
            cache_root = Path(os.path.expanduser(cache_dir))
        cache_path = cache_root / f'{expected_version_id}.json'
        if cache_path.exists():
            logger.debug(f"sync_version: cache hit at {cache_path}")
            try:
                raw = cache_path.read_bytes()
                return _parse_and_validate(raw)
            except (OSError, VersionError) as e:
                # corrupt cache or schema drift — refetch.
                logger.warning(
                    f"sync_version: cache miss-validate at {cache_path}: {e}; refetching"
                )

    raw = _http_fetch(url)
    version = _parse_and_validate(raw)
    if cache_path is not None:
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_bytes(raw)
        except OSError as e:
            # best-effort cache; never fail the fetch on it.
            logger.warning(f"sync_version: failed to cache at {cache_path}: {e}")
    return version


def diff_versions(
    new: Version, old: Optional[Version]
) -> VersionDiff:
    """delta new vs previously-installed; old=None (first install) = all added."""
    new_chunks = new.chunks
    new_files_by_path = {f.path: f for f in new.files}
    if old is None:
        return VersionDiff(
            chunks_to_fetch=new_chunks,
            chunks_unused=set(),
            files_added=list(new.files),
            files_removed=[],
            files_changed=[],
            files_unchanged=[],
        )
    old_chunks = old.chunks
    old_files_by_path = {f.path: f for f in old.files}

    files_added: List[VersionFile] = []
    files_removed: List[VersionFile] = []
    files_changed: List[VersionFile] = []
    files_unchanged: List[VersionFile] = []

    for path, nf in new_files_by_path.items():
        of = old_files_by_path.get(path)
        if of is None:
            files_added.append(nf)
        elif _files_identical(nf, of):
            files_unchanged.append(nf)
        else:
            files_changed.append(nf)
    for path, of in old_files_by_path.items():
        if path not in new_files_by_path:
            files_removed.append(of)

    return VersionDiff(
        chunks_to_fetch=new_chunks - old_chunks,
        chunks_unused=old_chunks - new_chunks,
        files_added=files_added,
        files_removed=files_removed,
        files_changed=files_changed,
        files_unchanged=files_unchanged,
    )


def _http_fetch(url: str) -> bytes:
    """fetch the version body with retries + exponential backoff."""
    last_exc: Optional[Exception] = None
    for attempt in range(1, _FETCH_RETRIES + 1):
        try:
            resp = requests.get(
                url,
                timeout=(_FETCH_CONNECT_TIMEOUT_S, _FETCH_READ_TIMEOUT_S),
                allow_redirects=True,
                stream=True,
            )
            resp.raise_for_status()
            content_length = resp.headers.get('Content-Length')
            if content_length and int(content_length) > MAX_VERSION_SIZE_BYTES:
                raise VersionError(
                    f"version too large: {content_length} bytes (max {MAX_VERSION_SIZE_BYTES})"
                )
            # Size-capped read: a misconfigured server must not OOM us.
            chunks_buf = []
            received = 0
            for chunk in resp.iter_content(chunk_size=64 * 1024):
                if chunk:
                    received += len(chunk)
                    if received > MAX_VERSION_SIZE_BYTES:
                        raise VersionError(
                            f"version exceeded {MAX_VERSION_SIZE_BYTES} bytes mid-stream"
                        )
                    chunks_buf.append(chunk)
            return b''.join(chunks_buf)
        except (requests.RequestException, ValueError) as e:
            last_exc = e
            if attempt < _FETCH_RETRIES:
                wait = _FETCH_BACKOFF_BASE_S * (2 ** (attempt - 1))
                logger.warning(
                    f"sync_version: fetch attempt {attempt} failed ({e}); "
                    f"retrying in {wait}s"
                )
                time.sleep(wait)
    raise VersionError(f"version fetch failed after {_FETCH_RETRIES} attempts: {last_exc}")


def _parse_and_validate(raw: bytes) -> Version:
    """parse raw bytes as JSON version and run schema validation."""
    try:
        data = json.loads(raw.decode('utf-8'))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise VersionError(f"version is not valid utf-8 json: {e}") from e

    if not isinstance(data, dict):
        raise VersionError(f"version must be a json object, got {type(data).__name__}")

    schema_version = data.get('schemaVersion')
    if schema_version != VERSION_SCHEMA_VERSION:
        raise VersionError(
            f"unsupported version schemaVersion: {schema_version!r} "
            f"(this agent supports {VERSION_SCHEMA_VERSION})"
        )

    media_type = data.get('mediaType')
    if media_type != VERSION_MEDIA_TYPE:
        raise VersionError(
            f"unsupported version mediaType: {media_type!r} "
            f"(this agent supports {VERSION_MEDIA_TYPE})"
        )

    config = data.get('config')
    if not isinstance(config, dict):
        raise VersionError("version.config must be an object")

    raw_files = data.get('files')
    if not isinstance(raw_files, list):
        raise VersionError("version.files must be an array")

    parsed_files: List[VersionFile] = []
    seen_paths: Set[str] = set()
    for i, fdata in enumerate(raw_files):
        if not isinstance(fdata, dict):
            raise VersionError(f"version.files[{i}] must be an object")
        path = fdata.get('path')
        if not isinstance(path, str) or not path:
            raise VersionError(f"version.files[{i}].path must be a non-empty string")
        if path in seen_paths:
            raise VersionError(f"version.files[{i}].path duplicated: {path!r}")
        seen_paths.add(path)
        # Reject hostile paths BEFORE any disk work, so nothing gets cached or
        # partially applied. Write-time realpath checks are destination_allowlist's.
        if _invalid_version_path(path):
            raise VersionError(
                f"version.files[{i}].path violates path constraints: {path!r}"
            )
        size = fdata.get('size')
        if not isinstance(size, int) or size < 0:
            raise VersionError(f"version.files[{i}].size must be non-negative int")
        raw_chunks = fdata.get('chunks')
        if not isinstance(raw_chunks, list):
            raise VersionError(f"version.files[{i}].chunks must be an array")
        parsed_chunks: List[VersionChunk] = []
        chunk_total = 0
        for j, cdata in enumerate(raw_chunks):
            if not isinstance(cdata, dict):
                raise VersionError(f"version.files[{i}].chunks[{j}] must be an object")
            chash = cdata.get('hash')
            csize = cdata.get('size')
            if not isinstance(chash, str) or len(chash) != 64 or not all(
                c in '0123456789abcdef' for c in chash
            ):
                raise VersionError(
                    f"version.files[{i}].chunks[{j}].hash must be lowercase 64-char sha-256 hex"
                )
            if not isinstance(csize, int) or csize <= 0:
                raise VersionError(
                    f"version.files[{i}].chunks[{j}].size must be positive int"
                )
            parsed_chunks.append(VersionChunk(hash=chash, size=csize))
            chunk_total += csize
        # Mismatch means the version was generated against a different file.
        if chunk_total != size:
            raise VersionError(
                f"version.files[{i}] chunk sizes sum to {chunk_total} but file size is {size}"
            )
        parsed_files.append(VersionFile(path=path, size=size, chunks=parsed_chunks))

    return Version(
        schema_version=schema_version,
        media_type=media_type,
        config=config,
        files=parsed_files,
        raw_bytes=raw,
    )


def _invalid_version_path(path: str) -> bool:
    """
    true if `path` is NOT safe as a version file path. Requires a canonical
    POSIX-style relative path: rejects NUL bytes, absolute paths, windows
    drive-letter prefixes (`C:foo` included), and `..` / `.` / empty segments.

    Pre-disk filter only; realpath + reparse-point checks are
    destination_allowlist's job at write-time.
    """
    if not path:
        return True
    if '\x00' in path:
        return True
    normalized = path.replace('\\', '/')
    if normalized.startswith('/'):
        return True
    # Colon at index 1 = drive-relative/absolute (`C:foo`, `C:/foo`); also kills
    # an ADS attempt in segment 0.
    if len(normalized) >= 2 and normalized[1] == ':':
        return True
    segments = normalized.split('/')
    for seg in segments:
        if seg in ('', '.', '..'):
            return True
        # Colon in a later segment is windows ADS (`file.toe:hidden`).
        if ':' in seg:
            return True
    return False


def _files_identical(a: VersionFile, b: VersionFile) -> bool:
    """identical iff same size and same chunk-hash sequence."""
    if a.size != b.size:
        return False
    if len(a.chunks) != len(b.chunks):
        return False
    for ac, bc in zip(a.chunks, b.chunks):
        if ac.hash != bc.hash:
            return False
    return True
