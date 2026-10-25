"""Tests for the wave-2A extensions on ``roost.machines``.

Covers ``dispatch_command``, ``get_command``, and ``capture_screenshot``.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from roost import Roost
from roost.client import RetryPolicy
from roost.resources import machines as machines_module


def _transport(handler: "callable[[httpx.Request], httpx.Response]") -> httpx.MockTransport:
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_dispatch_command_unwraps_envelope_and_emits_idempotency() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={"ok": True, "data": {"commandId": "cmd_1", "status": "queued"}},
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        out = await client.machines.dispatch_command(
            "s1", "m1", "reboot_machine", {"delay_seconds": 0}
        )

    assert out == {"commandId": "cmd_1", "status": "queued"}
    req = captured[0]
    assert req.method == "POST"
    assert req.url.path == "/api/sites/s1/machines/m1/commands"
    body = json.loads(req.content)
    assert body == {"type": "reboot_machine", "params": {"delay_seconds": 0}}
    assert req.headers["Idempotency-Key"].startswith("py-sdk-")


def _queued(captured: list[httpx.Request]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            202, json={"ok": True, "data": {"commandId": "cmd_1", "status": "pending"}}
        )

    return _transport(handler)


@pytest.mark.asyncio
async def test_reboot_sends_no_params_by_default() -> None:
    captured: list[httpx.Request] = []
    async with Roost(token="owk_live_x", transport=_queued(captured)) as client:
        out = await client.machines.reboot("s1", "m1")

    assert out == {"commandId": "cmd_1", "status": "pending"}
    assert captured[0].url.path == "/api/sites/s1/machines/m1/commands"
    assert json.loads(captured[0].content) == {"type": "reboot_machine", "params": {}}


@pytest.mark.asyncio
async def test_reboot_after_active_hours_sends_when() -> None:
    captured: list[httpx.Request] = []
    async with Roost(token="owk_live_x", transport=_queued(captured)) as client:
        await client.machines.reboot("s1", "m1", after_active_hours=True)

    assert json.loads(captured[0].content) == {
        "type": "reboot_machine",
        "params": {"when": "after_active_hours"},
    }


@pytest.mark.asyncio
async def test_reboot_override_sends_reason_and_idempotency_key() -> None:
    captured: list[httpx.Request] = []
    async with Roost(token="owk_live_x", transport=_queued(captured)) as client:
        await client.machines.reboot(
            "s1",
            "m1",
            active_hours_override={"reason": "hotfix for the show"},
            idempotency_key="reboot-key",
        )

    assert json.loads(captured[0].content) == {
        "type": "reboot_machine",
        "params": {"active_hours_override": {"reason": "hotfix for the show"}},
    }
    assert captured[0].headers["Idempotency-Key"] == "reboot-key"


@pytest.mark.asyncio
async def test_shutdown_override_sends_shutdown_machine() -> None:
    captured: list[httpx.Request] = []
    async with Roost(token="owk_live_x", transport=_queued(captured)) as client:
        await client.machines.shutdown(
            "s1", "m1", active_hours_override={"reason": "power work"}
        )

    assert json.loads(captured[0].content) == {
        "type": "shutdown_machine",
        "params": {"active_hours_override": {"reason": "power work"}},
    }


@pytest.mark.asyncio
async def test_get_command_unwraps_envelope() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "ok": True,
                "data": {
                    "commandId": "cmd_1",
                    "status": "completed",
                    "result": {"screenshot_url": "https://r2/x.png"},
                },
            },
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        out = await client.machines.get_command("s1", "m1", "cmd_1")

    assert out["status"] == "completed"
    assert out["result"]["screenshot_url"] == "https://r2/x.png"


@pytest.mark.asyncio
async def test_capture_screenshot_polls_then_downloads_to_disk(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Fast-forward sleeps so the test runs in ms.
    sleeps: list[float] = []

    async def fake_sleep(s: float) -> None:
        sleeps.append(s)

    monkeypatch.setattr(machines_module.asyncio, "sleep", fake_sleep)

    poll_attempts = {"n": 0}
    api_calls: list[httpx.Request] = []
    download_calls: list[httpx.Request] = []
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16

    def api_handler(request: httpx.Request) -> httpx.Response:
        api_calls.append(request)
        if request.method == "POST" and request.url.path.endswith("/commands"):
            return httpx.Response(
                200, json={"ok": True, "data": {"commandId": "cmd_1", "status": "queued"}}
            )
        # GET command status — first poll pending, second completed.
        poll_attempts["n"] += 1
        if poll_attempts["n"] == 1:
            return httpx.Response(
                200, json={"ok": True, "data": {"commandId": "cmd_1", "status": "pending"}}
            )
        return httpx.Response(
            200,
            json={
                "ok": True,
                "data": {
                    "commandId": "cmd_1",
                    "status": "completed",
                    "result": {"screenshot_url": "https://r2.example/screenshot.png"},
                },
            },
        )

    def download_handler(request: httpx.Request) -> httpx.Response:
        download_calls.append(request)
        return httpx.Response(200, content=png_bytes)

    # Patch httpx.AsyncClient construction inside machines.py to inject
    # our download MockTransport — but only for the one call sourced
    # from the screenshot path (which uses a one-shot client with no
    # transport= kwarg). Roost() itself passes transport= explicitly so
    # we leave that one alone.
    orig_async_client = machines_module.httpx.AsyncClient

    def make_client(*args: object, **kwargs: object) -> httpx.AsyncClient:
        if "transport" not in kwargs:
            kwargs["transport"] = _transport(download_handler)
        return orig_async_client(*args, **kwargs)

    monkeypatch.setattr(machines_module.httpx, "AsyncClient", make_client)

    async with Roost(token="owk_live_x", transport=_transport(api_handler)) as client:
        out_path = tmp_path / "shot.png"
        bytes_ = await client.machines.capture_screenshot(
            "s1",
            "m1",
            monitor="primary",
            timeout_seconds=10,
            download_to=out_path,
        )

    assert bytes_ == png_bytes
    assert out_path.read_bytes() == png_bytes
    # POST + at least 2 GETs.
    assert api_calls[0].method == "POST"
    assert api_calls[0].url.path == "/api/sites/s1/machines/m1/commands"
    body = json.loads(api_calls[0].content)
    assert body["type"] == "capture_screenshot"
    assert body["params"] == {"monitor": "primary"}
    # First poll did NOT sleep (attempt index 0); subsequent ones did.
    assert sleeps and all(s == 1.5 for s in sleeps)
    assert len(download_calls) == 1


@pytest.mark.asyncio
async def test_capture_screenshot_raises_runtime_error_on_failed_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_sleep(_s: float) -> None:
        return None

    monkeypatch.setattr(machines_module.asyncio, "sleep", fake_sleep)

    def api_handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(
                200, json={"ok": True, "data": {"commandId": "cmd_1", "status": "queued"}}
            )
        return httpx.Response(
            200,
            json={
                "ok": True,
                "data": {
                    "commandId": "cmd_1",
                    "status": "failed",
                    "error": "agent crashed",
                },
            },
        )

    async with Roost(
        token="owk_live_x",
        transport=_transport(api_handler),
        retry=RetryPolicy(max_attempts=1),
    ) as client:
        with pytest.raises(RuntimeError, match="agent crashed"):
            await client.machines.capture_screenshot("s1", "m1")
