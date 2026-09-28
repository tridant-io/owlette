"""``roost.installer`` — agent installer binary management (superadmin).

Wraps ``/api/installer*``. ``upload()`` is the canonical 3-step flow: request a
signed PUT url, stream the binary to it, finalize. One ``Idempotency-Key``
spans request+finalize so retries replay while the signed url is still valid.
"""

from __future__ import annotations

import hashlib
import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx

if TYPE_CHECKING:
    from roost.client import RoostClient


@dataclass(slots=True)
class InstallerFile:
    """One platform's installer within a version."""

    download_url: str
    checksum_sha256: str | None
    file_size: int | None
    file_name: str | None
    uploaded_at: int | None


@dataclass(slots=True)
class InstallerVersion:
    version: str
    # the windows installer; an alias of files["windows_x64"].download_url
    download_url: str | None
    checksum_sha256: str | None
    release_notes: str | None
    file_size: int | None
    uploaded_at: int | None
    uploaded_by: str | None
    deleted_at: int | None
    release_date: str | None = None
    promoted_at: int | None = None
    promoted_by: str | None = None
    # keyed windows_x64 / macos_arm64 / linux_x64; a version uploaded before
    # per-platform files carries its windows installer under windows_x64
    files: dict[str, InstallerFile] = field(default_factory=dict)


def _parse_file(raw: dict[str, Any]) -> InstallerFile:
    return InstallerFile(
        download_url=str(raw.get("download_url", "")),
        checksum_sha256=raw.get("checksum_sha256"),
        file_size=raw.get("file_size"),
        file_name=raw.get("file_name"),
        uploaded_at=raw.get("uploaded_at"),
    )


def _parse_version(raw: dict[str, Any]) -> InstallerVersion:
    files = raw.get("files")
    return InstallerVersion(
        version=str(raw.get("version", "")),
        download_url=raw.get("download_url"),
        checksum_sha256=raw.get("checksum_sha256"),
        release_notes=raw.get("release_notes"),
        file_size=raw.get("file_size"),
        uploaded_at=raw.get("uploaded_at"),
        uploaded_by=raw.get("uploaded_by"),
        deleted_at=raw.get("deletedAt"),
        release_date=raw.get("release_date"),
        promoted_at=raw.get("promoted_at"),
        promoted_by=raw.get("promoted_by"),
        files={
            str(k): _parse_file(v)
            for k, v in (files.items() if isinstance(files, dict) else ())
            if isinstance(v, dict)
        },
    )


class Installer:
    """Installer binary metadata + upload flow (superadmin-only)."""

    def __init__(self, client: "RoostClient") -> None:
        self._client = client
        # Test hook: set an httpx.AsyncBaseTransport to intercept the signed-url PUT.
        self._upload_transport: httpx.AsyncBaseTransport | None = None

    async def list(
        self,
        *,
        include_deleted: bool = False,
        page_size: int | None = None,
        page_token: str | None = None,
    ) -> dict[str, Any]:
        """List uploaded installer versions, newest first."""
        query: dict[str, Any] = {}
        if include_deleted:
            query["includeDeleted"] = True
        if page_size is not None:
            query["page_size"] = page_size
        if page_token:
            query["page_token"] = page_token
        resp = await self._client.request(
            "/api/installer",
            query=query or None,
        )
        data = resp.data if isinstance(resp.data, dict) else {}
        versions = [
            _parse_version(v)
            for v in (data.get("versions") or [])
            if isinstance(v, dict)
        ]
        return {
            "versions": versions,
            "next_page_token": str(data.get("next_page_token") or data.get("nextPageToken") or ""),
        }

    async def latest(self) -> InstallerVersion:
        """Return the current latest installer version metadata."""
        resp = await self._client.request("/api/installer/latest")
        data = resp.data if isinstance(resp.data, dict) else {}
        return _parse_version(data)

    async def upload(
        self,
        file_path: str | os.PathLike[str],
        *,
        version: str,
        platform: str | None = None,
        release_notes: str | None = None,
        set_as_latest: bool = True,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Upload an installer binary: POST for a signed url → PUT bytes → PUT finalize.

        ``platform`` is ``windows_x64``, ``macos_arm64`` or ``linux_x64``; the api
        derives it from the file extension (``.exe`` / ``.pkg`` / ``.deb``) when
        omitted and rejects a mismatch. One ``Idempotency-Key`` covers the POST
        and the finalize PUT.
        """
        path = Path(file_path)
        binary = path.read_bytes()
        file_size = len(binary)
        checksum = hashlib.sha256(binary).hexdigest()
        file_name = path.name

        idem = idempotency_key or f"py-sdk-installer-upload-{uuid.uuid4()}"

        # step 1: request signed upload url
        start_body: dict[str, Any] = {
            "version": version,
            "fileName": file_name,
            "setAsLatest": set_as_latest,
        }
        if platform is not None:
            start_body["platform"] = platform
        if release_notes is not None:
            start_body["releaseNotes"] = release_notes

        start_resp = await self._client.request(
            "/api/installer/upload",
            method="POST",
            body=start_body,
            idempotency_key=idem,
        )
        start_data = start_resp.data if isinstance(start_resp.data, dict) else {}
        upload_url = start_data.get("uploadUrl")
        upload_id = start_data.get("uploadId")
        if not upload_url or not upload_id:
            msg = "installer.upload: server response missing uploadUrl or uploadId"
            raise RuntimeError(msg)

        # step 2: PUT bytes. One-shot client so the SDK's Authorization /
        # Roost-Version headers don't leak — the signed url rejects extras.
        client_kwargs: dict[str, Any] = {}
        if self._upload_transport is not None:
            client_kwargs["transport"] = self._upload_transport
        async with httpx.AsyncClient(**client_kwargs) as raw:
            put_resp = await raw.put(
                str(upload_url),
                content=binary,
                headers={
                    "Content-Type": "application/octet-stream",
                    "Content-Length": str(file_size),
                },
            )
        if put_resp.status_code >= 400:
            msg = (
                f"installer.upload: signed PUT failed "
                f"(status={put_resp.status_code}, body={put_resp.text[:200]!r})"
            )
            raise RuntimeError(msg)

        # step 3: finalize
        finalize_resp = await self._client.request(
            "/api/installer/upload",
            method="PUT",
            body={"uploadId": upload_id, "checksum_sha256": checksum},
            idempotency_key=idem,
        )
        return finalize_resp.data if isinstance(finalize_resp.data, dict) else {}

    async def set_latest(
        self,
        version: str,
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/installer/{version}/set-latest",
            method="POST",
            body={},
            idempotency_key=idempotency_key,
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def delete(
        self,
        version: str,
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        # Resource-specific prefix, not the core client's generic py-sdk key.
        idem = idempotency_key or f"py-sdk-installer-delete-{uuid.uuid4()}"
        resp = await self._client.request(
            f"/api/installer/{version}",
            method="DELETE",
            headers={"Idempotency-Key": idem},
        )
        return resp.data if isinstance(resp.data, dict) else {}


__all__ = ["Installer", "InstallerFile", "InstallerVersion"]
