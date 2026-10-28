"""Tests for ``roost.installer`` (wave 1B)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import httpx
import pytest

from roost import Roost, RoostApiError
from roost.client import RetryPolicy


def _transport(handler: "callable[[httpx.Request], httpx.Response]") -> httpx.MockTransport:
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_list_parses_versions() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "versions": [
                    {
                        "version": "2.10.0",
                        "download_url": "https://r2/x.exe",
                        "checksum_sha256": "a" * 64,
                        "release_notes": "fixes",
                        "file_size": 1234,
                        "uploaded_at": 1700000000,
                        "uploaded_by": "u1",
                        "release_date": "2026-04-28T00:00:00.000Z",
                        "deletedAt": None,
                        "promoted_at": 1700000100,
                        "promoted_by": "u2",
                    }
                ],
                "next_page_token": "",
            },
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        page = await client.installer.list(include_deleted=True, page_size=10)

    assert page["next_page_token"] == ""
    assert len(page["versions"]) == 1
    v = page["versions"][0]
    assert v.version == "2.10.0"
    assert v.file_size == 1234
    assert v.release_date == "2026-04-28T00:00:00.000Z"
    assert v.promoted_at == 1700000100
    assert v.promoted_by == "u2"
    # a response without files (older api) parses to an empty map
    assert v.files == {}


@pytest.mark.asyncio
async def test_latest_parses_version() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "version": "2.10.0",
                "download_url": "https://r2/x.exe",
                "checksum_sha256": "a" * 64,
                "release_notes": None,
                "file_size": 1234,
                "uploaded_at": 1700000000,
                "uploaded_by": "u1",
                "release_date": "2026-04-28T00:00:00.000Z",
                "deletedAt": None,
                "promoted_at": 1700000100,
                "promoted_by": "u2",
                "files": {
                    "windows_x64": {
                        "download_url": "https://r2/x.exe",
                        "checksum_sha256": "a" * 64,
                        "file_size": 1234,
                        "file_name": "x.exe",
                        "uploaded_at": 1700000000,
                    },
                    "macos_arm64": {
                        "download_url": "https://r2/x.pkg",
                        "checksum_sha256": "b" * 64,
                        "file_size": 5678,
                        "file_name": "x.pkg",
                        "uploaded_at": 1700000050,
                    },
                },
            },
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        latest = await client.installer.latest()

    assert captured[0].method == "GET"
    assert captured[0].url.path == "/api/installer/latest"
    assert latest.version == "2.10.0"
    assert latest.release_date == "2026-04-28T00:00:00.000Z"
    assert latest.promoted_at == 1700000100
    assert latest.promoted_by == "u2"
    assert set(latest.files) == {"windows_x64", "macos_arm64"}
    mac = latest.files["macos_arm64"]
    assert mac.download_url == "https://r2/x.pkg"
    assert mac.checksum_sha256 == "b" * 64
    assert mac.file_size == 5678
    assert mac.file_name == "x.pkg"
    assert mac.uploaded_at == 1700000050


@pytest.mark.asyncio
async def test_upload_three_step_flow_with_shared_idempotency_key(tmp_path: Path) -> None:
    # Real-ish 1KB binary so we exercise the sha256 path.
    binary = b"\x00\xff" * 512
    file_path = tmp_path / "Owlette-Installer-v9.9.9.exe"
    file_path.write_bytes(binary)
    expected_sha = hashlib.sha256(binary).hexdigest()

    api_calls: list[httpx.Request] = []
    upload_calls: list[httpx.Request] = []

    def api_handler(request: httpx.Request) -> httpx.Response:
        api_calls.append(request)
        if request.method == "POST" and request.url.path == "/api/installer/upload":
            return httpx.Response(
                200,
                json={
                    "uploadUrl": "https://r2.example/upload?sig=abc",
                    "uploadId": "up_123",
                    "storagePath": "installers/9.9.9.exe",
                    "expiresAt": "2026-04-26T00:00:00Z",
                },
            )
        if request.method == "PUT" and request.url.path == "/api/installer/upload":
            return httpx.Response(
                200,
                json={
                    "version": "9.9.9",
                    "download_url": "https://r2/x.exe",
                    "checksum_sha256": expected_sha,
                    "file_size": len(binary),
                },
            )
        return httpx.Response(404, json={"detail": "unexpected route"})

    def upload_handler(request: httpx.Request) -> httpx.Response:
        upload_calls.append(request)
        # Verify the body we PUT to the signed url is byte-identical.
        assert request.content == binary
        return httpx.Response(200)

    async with Roost(token="owk_live_x", transport=_transport(api_handler)) as client:
        client.installer._upload_transport = _transport(upload_handler)
        result = await client.installer.upload(
            file_path,
            version="9.9.9",
            release_notes="bugfix",
        )

    assert result["version"] == "9.9.9"
    assert result["checksum_sha256"] == expected_sha

    # Three api calls: POST start, PUT finalize. The signed-url PUT goes
    # through the upload_transport (separate handler).
    assert len(api_calls) == 2
    assert api_calls[0].method == "POST"
    assert api_calls[1].method == "PUT"

    # Same idempotency key on POST + finalize.
    assert (
        api_calls[0].headers["Idempotency-Key"]
        == api_calls[1].headers["Idempotency-Key"]
    )
    assert api_calls[0].headers["Idempotency-Key"].startswith("py-sdk-installer-upload-")

    # Finalize body carries the sha256 we computed locally.
    finalize_body = json.loads(api_calls[1].content)
    assert finalize_body == {"uploadId": "up_123", "checksum_sha256": expected_sha}

    # Signed-url PUT happened exactly once.
    assert len(upload_calls) == 1
    assert upload_calls[0].method == "PUT"

    # No platform given: the api derives it from the extension.
    assert "platform" not in json.loads(api_calls[0].content)


@pytest.mark.asyncio
async def test_upload_sends_platform_when_given(tmp_path: Path) -> None:
    file_path = tmp_path / "Owlette-Installer-v9.9.9.deb"
    file_path.write_bytes(b"\x00\xff" * 16)

    api_calls: list[httpx.Request] = []

    def api_handler(request: httpx.Request) -> httpx.Response:
        api_calls.append(request)
        if request.method == "POST":
            return httpx.Response(
                200,
                json={
                    "uploadUrl": "https://r2.example/upload?sig=abc",
                    "uploadId": "up_123",
                    "platform": "linux_x64",
                },
            )
        return httpx.Response(
            200,
            json={"version": "9.9.9", "platform": "linux_x64", "files": {}},
        )

    async with Roost(token="owk_live_x", transport=_transport(api_handler)) as client:
        client.installer._upload_transport = _transport(lambda _r: httpx.Response(200))
        result = await client.installer.upload(
            file_path,
            version="9.9.9",
            platform="linux_x64",
        )

    assert result["platform"] == "linux_x64"
    start_body = json.loads(api_calls[0].content)
    assert start_body["fileName"] == "Owlette-Installer-v9.9.9.deb"
    assert start_body["platform"] == "linux_x64"


@pytest.mark.asyncio
async def test_set_latest_post_with_idempotency_and_explicit_key() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"version": "9.9.9", "latest": True})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        out = await client.installer.set_latest("9.9.9", idempotency_key="my-key-1")

    assert out["version"] == "9.9.9"
    req = captured[0]
    assert req.method == "POST"
    assert req.url.path == "/api/installer/9.9.9/set-latest"
    assert req.headers["Idempotency-Key"] == "my-key-1"


@pytest.mark.asyncio
async def test_delete_emits_idempotency_header_on_delete() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"version": "9.9.9", "alreadyDeleted": False})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        await client.installer.delete("9.9.9")

    req = captured[0]
    assert req.method == "DELETE"
    assert req.url.path == "/api/installer/9.9.9"
    assert req.headers["Idempotency-Key"].startswith("py-sdk-installer-delete-")


@pytest.mark.asyncio
async def test_upload_raises_on_min_versions_violated(tmp_path: Path) -> None:
    file_path = tmp_path / "x.exe"
    file_path.write_bytes(b"x")

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409,
            json={"code": "min_versions_violated", "detail": "too few versions"},
        )

    async with Roost(
        token="owk_live_x",
        transport=_transport(handler),
        retry=RetryPolicy(max_attempts=1),
    ) as client:
        with pytest.raises(RoostApiError) as excinfo:
            await client.installer.upload(file_path, version="9.9.9")
        assert excinfo.value.status == 409
        assert excinfo.value.code == "min_versions_violated"
