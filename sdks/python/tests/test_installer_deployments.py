"""Tests for ``roost.installer_deployments`` (wave 1A)."""

from __future__ import annotations

import json

import httpx
import pytest

from roost import Roost, RoostApiError
from roost.client import RetryPolicy


def _transport(handler: "callable[[httpx.Request], httpx.Response]") -> httpx.MockTransport:
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_create_sends_body_and_idempotency_key() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={"deploymentId": "dep_1", "siteId": "s1", "status": "queued", "targets": []},
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        out = await client.installer_deployments.create(
            "s1",
            name="bulk",
            installer_name="Owlette-Installer-v2.10.0.exe",
            installer_url="https://example.com/x.exe",
            silent_flags="/S",
            machines=("m1", "m2"),
            verify_path="C:/Program Files/Owlette",
            sha256_checksum="a" * 64,
            close_processes=("TouchDesigner.exe",),
            suppress_projects=("show-a", "C:/Shows/show-b"),
            parallel_install=True,
        )

    assert out["deploymentId"] == "dep_1"
    req = captured[0]
    assert req.method == "POST"
    assert req.url.path == "/api/sites/s1/deployments"
    assert req.headers["Idempotency-Key"].startswith("py-sdk-")
    body = json.loads(req.content)
    assert body["machines"] == ["m1", "m2"]
    assert body["parallel_install"] is True
    assert body["verify_path"] == "C:/Program Files/Owlette"
    assert body["close_processes"] == ["TouchDesigner.exe"]
    assert body["suppress_projects"] == ["show-a", "C:/Shows/show-b"]


@pytest.mark.asyncio
async def test_list_parses_summary_and_pagination() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "items": [
                    {
                        "id": "dep_1",
                        "name": "bulk",
                        "installer_name": "x.exe",
                        "installer_url": "https://x",
                        "silent_flags": "/S",
                        "verify_path": None,
                        "sha256_checksum": None,
                        "parallel_install": False,
                        "targets": [{"machineId": "m1", "status": "running"}],
                        "status": "running",
                        "createdAt": "2026-04-25T00:00:00Z",
                    }
                ],
                "next_page_token": "abc",
            },
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        page = await client.installer_deployments.list("s1", page_size=20)

    assert page["next_page_token"] == "abc"
    assert len(page["items"]) == 1
    item = page["items"][0]
    assert item.id == "dep_1"
    assert item.targets[0].machine_id == "m1"


@pytest.mark.asyncio
async def test_uninstall_propagates_403_scope_insufficient() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403,
            json={"code": "scope_insufficient", "detail": "admin required"},
        )

    async with Roost(
        token="owk_live_x",
        transport=_transport(handler),
        retry=RetryPolicy(max_attempts=1),
    ) as client:
        with pytest.raises(RoostApiError) as excinfo:
            await client.installer_deployments.uninstall("s1", "dep_1")
        assert excinfo.value.status == 403
        assert excinfo.value.code == "scope_insufficient"


@pytest.mark.asyncio
async def test_retry_and_cancel_use_post_with_empty_body() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"deploymentId": "dep_1", "status": "running"})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        await client.installer_deployments.retry("s1", "dep_1")
        await client.installer_deployments.cancel("s1", "dep_1")

    assert captured[0].url.path == "/api/sites/s1/deployments/dep_1/retry"
    assert captured[1].url.path == "/api/sites/s1/deployments/dep_1/cancel"
    for req in captured:
        assert req.method == "POST"
        assert req.headers["Idempotency-Key"].startswith("py-sdk-")
        assert json.loads(req.content) == {}


@pytest.mark.asyncio
async def test_create_and_retry_send_active_hours_override() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"deploymentId": "dep_1", "status": "in_progress"})

    override = {"reason": "venue closed today"}
    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        await client.installer_deployments.create(
            "s1",
            name="bulk",
            installer_name="x.exe",
            installer_url="https://example.com/x.exe",
            silent_flags="/S",
            machines=("m1",),
            active_hours_override=override,
        )
        await client.installer_deployments.retry("s1", "dep_1", active_hours_override=override)

    assert captured[0].url.path == "/api/sites/s1/deployments"
    assert json.loads(captured[0].content)["active_hours_override"] == override
    assert captured[1].url.path == "/api/sites/s1/deployments/dep_1/retry"
    assert json.loads(captured[1].content) == {"active_hours_override": override}


@pytest.mark.asyncio
async def test_delete_uses_delete_with_empty_body_and_idempotency_key() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={"deploymentId": "dep_1", "siteId": "s1", "deleted": True},
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        out = await client.installer_deployments.delete("s1", "dep_1")

    assert out["deleted"] is True
    req = captured[0]
    assert req.method == "DELETE"
    assert req.url.path == "/api/sites/s1/deployments/dep_1"
    assert req.headers["Idempotency-Key"].startswith("py-sdk-")
    assert json.loads(req.content) == {}
