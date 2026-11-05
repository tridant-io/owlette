"""Runner-owned sync pipeline smoke test against the S3 stand-in.

This is intentionally outside agent/tests so production agent tests stay
focused on module behavior. The container runner supplies the stand-in's credentials
through environment variables and this test exercises the existing sync
modules without importing the Windows service host.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from pathlib import Path

import pytest

boto3 = pytest.importorskip("boto3")
Config = pytest.importorskip("botocore.config").Config

from destination_allowlist import DestinationAllowlist
from sync_assembler import assemble_all
from sync_downloader import download_all
from sync_state import SyncState
from sync_version import VERSION_MEDIA_TYPE, VERSION_SCHEMA_VERSION, fetch_version


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _s3_client():
    endpoint = os.environ.get("OWLETTE_R2_ENDPOINT")
    if not endpoint:
        pytest.skip("OWLETTE_R2_ENDPOINT is not set; S3 smoke not requested")

    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=os.environ.get("OWLETTE_R2_ACCESS_KEY_ID", "minioadmin"),
        aws_secret_access_key=os.environ.get("OWLETTE_R2_SECRET_ACCESS_KEY", "minioadmin"),
        region_name="us-east-1",
        config=Config(signature_version="s3v4"),
    )


def _wait_for_bucket(s3, bucket: str) -> None:
    deadline = time.time() + 30
    last_error = None
    while time.time() < deadline:
        try:
            s3.head_bucket(Bucket=bucket)
            return
        except Exception as exc:  # pragma: no cover - only hit while the S3 stand-in starts
            last_error = exc
            time.sleep(1)
    raise AssertionError(f"bucket {bucket!r} was not ready: {last_error}")


def test_sync_pipeline_fetches_from_minio_and_assembles_file(tmp_path: Path):
    s3 = _s3_client()
    content_bucket = os.environ.get("OWLETTE_R2_CONTENT_BUCKET", "owlette-dev-content")
    manifests_bucket = os.environ.get("OWLETTE_R2_MANIFESTS_BUCKET", "owlette-dev-manifests")
    _wait_for_bucket(s3, content_bucket)
    _wait_for_bucket(s3, manifests_bucket)

    site_id = "site_agent_runner"
    roost_id = f"roost_{uuid.uuid4().hex}"
    version_chunks = [b"alpha-", b"bravo-", b"charlie"]
    file_bytes = b"".join(version_chunks)
    chunk_entries = [{"hash": _sha256(data), "size": len(data)} for data in version_chunks]

    chunk_keys = {}
    for data, entry in zip(version_chunks, chunk_entries):
        key = f"project-content/{site_id}/{entry['hash'][:2]}/{entry['hash']}"
        s3.put_object(Bucket=content_bucket, Key=key, Body=data)
        chunk_keys[entry["hash"]] = key

    version_doc = {
        "schemaVersion": VERSION_SCHEMA_VERSION,
        "mediaType": VERSION_MEDIA_TYPE,
        "config": {
            "siteId": site_id,
            "roostId": roost_id,
            "name": "agent-runner-smoke",
        },
        "files": [
            {
                "path": "show/main.toe",
                "size": len(file_bytes),
                "chunks": chunk_entries,
            }
        ],
    }
    raw_version = json.dumps(version_doc, separators=(",", ":"), sort_keys=True).encode("utf-8")
    version_id = _sha256(raw_version)
    manifest_key = f"project-manifests/{site_id}/{roost_id}/{version_id}.json"
    s3.put_object(
        Bucket=manifests_bucket,
        Key=manifest_key,
        Body=raw_version,
        ContentType=VERSION_MEDIA_TYPE,
    )

    version_url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": manifests_bucket, "Key": manifest_key},
        ExpiresIn=300,
    )
    version = fetch_version(
        version_url,
        expected_version_id=version_id,
        cache_dir=str(tmp_path / "versions"),
    )

    state = SyncState(str(tmp_path / "sync-state.db"))
    try:
        dist_id = state.start_distribution(
            site_id=site_id,
            roost_id=roost_id,
            version_id=version_id,
            version_url=version_url,
            files=[{"path": f.path, "size": f.size} for f in version.files],
            chunks=[{"hash": c["hash"], "size": c["size"]} for c in chunk_entries],
            extract_root=str(tmp_path / "extract"),
        )

        def url_provider(hashes):
            return {
                chunk_hash: s3.generate_presigned_url(
                    "get_object",
                    Params={"Bucket": content_bucket, "Key": chunk_keys[chunk_hash]},
                    ExpiresIn=300,
                )
                for chunk_hash in hashes
            }

        download_all(
            distribution_id=dist_id,
            chunks=chunk_entries,
            url_provider=url_provider,
            state=state,
            content_store=str(tmp_path / "content"),
            concurrency=2,
        )

        extract_root = tmp_path / "extract"
        extract_root.mkdir()
        assemble_all(
            distribution_id=dist_id,
            files=version.files,
            extract_root=str(extract_root),
            state=state,
            allowlist=DestinationAllowlist([str(extract_root)]),
            content_store=str(tmp_path / "content"),
        )

        assert (extract_root / "show" / "main.toe").read_bytes() == file_bytes
        assert len(state.list_chunks(dist_id, state="verified")) == len(chunk_entries)
        assert len(state.list_files(dist_id, state="committed")) == 1
    finally:
        state.close()
