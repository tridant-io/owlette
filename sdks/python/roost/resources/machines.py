"""``roost.machines`` — site → machine introspection + remote control (wave 2A)."""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, TypedDict

import httpx

if TYPE_CHECKING:
    from roost.client import RoostClient


CommandType = Literal["reboot_machine", "shutdown_machine", "capture_screenshot"]
CommandStatus = Literal["pending", "in_progress", "completed", "failed"]


class ActiveHoursOverride(TypedDict):
    """Act inside the machine's active hours anyway; ``reason`` goes to the site log."""

    reason: str


# Polling cadence for `capture_screenshot` — 1.5s × 40 = 60s wall-clock
# matches the cli's `machine screenshot` command.
_SCREENSHOT_POLL_INTERVAL_S = 1.5
_SCREENSHOT_POLL_MAX_ATTEMPTS = 40


@dataclass(slots=True)
class MachineSummary:
    id: str
    name: str
    online: bool
    last_heartbeat: str | None
    agent_version: str | None
    os: str | None
    current_roosts: list[dict[str, Any]] = field(default_factory=list)


@dataclass(slots=True)
class MachineDetail:
    id: str
    site_id: str
    name: str
    online: bool
    last_heartbeat: str | None
    agent_version: str | None
    os: str | None
    hostname: str | None
    metrics: Any | None
    processes: list[dict[str, Any]]


@dataclass(slots=True)
class MachineDeployment:
    roost_id: str
    name: str
    current_version_id: str | None
    previous_version_id: str | None
    extract_path: str | None
    reported_version_id: str | None
    reported_status: str | None
    reported_at: str | None


class Machines:
    def __init__(self, client: "RoostClient") -> None:
        self._client = client

    async def list(self, site_id: str) -> list[MachineSummary]:
        resp = await self._client.request(f"/api/sites/{site_id}/machines")
        data = resp.data if isinstance(resp.data, dict) else {}
        return [
            MachineSummary(
                id=str(m.get("id", "")),
                name=str(m.get("name", "")),
                online=bool(m.get("online", False)),
                last_heartbeat=m.get("lastHeartbeat"),
                agent_version=m.get("agentVersion"),
                os=m.get("os"),
                current_roosts=list(m.get("currentRoosts") or []),
            )
            for m in data.get("machines", [])
            if isinstance(m, dict)
        ]

    async def get(self, site_id: str, machine_id: str) -> MachineDetail:
        resp = await self._client.request(
            f"/api/sites/{site_id}/machines/{machine_id}"
        )
        m = resp.data if isinstance(resp.data, dict) else {}
        return MachineDetail(
            id=str(m.get("id", "")),
            site_id=str(m.get("siteId", site_id)),
            name=str(m.get("name", "")),
            online=bool(m.get("online", False)),
            last_heartbeat=m.get("lastHeartbeat"),
            agent_version=m.get("agentVersion"),
            os=m.get("os"),
            hostname=m.get("hostname"),
            metrics=m.get("metrics"),
            processes=list(m.get("processes") or []),
        )

    async def deployments(self, site_id: str, machine_id: str) -> list[MachineDeployment]:
        resp = await self._client.request(
            f"/api/sites/{site_id}/machines/{machine_id}/deployments"
        )
        data = resp.data if isinstance(resp.data, dict) else {}
        return [
            MachineDeployment(
                roost_id=str(d.get("roostId", "")),
                name=str(d.get("name", "")),
                current_version_id=d.get("currentVersionId"),
                previous_version_id=d.get("previousVersionId"),
                extract_path=d.get("extractPath"),
                reported_version_id=d.get("reportedVersionId"),
                reported_status=d.get("reportedStatus"),
                reported_at=d.get("reportedAt"),
            )
            for d in data.get("deployments", [])
            if isinstance(d, dict)
        ]

    # ─────────────────────────────────────────────────────────────────────
    # wave-2A: remote command dispatch + status poll
    # ─────────────────────────────────────────────────────────────────────

    async def dispatch_command(
        self,
        site_id: str,
        machine_id: str,
        type: CommandType,  # noqa: A002 — matches server payload key
        params: dict[str, Any] | None = None,
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Queue a remote command on the machine.

        Returns ``{commandId, status}`` (server envelope unwrapped).
        Auto-generates ``Idempotency-Key`` if not supplied.
        """
        body: dict[str, Any] = {"type": type, "params": params or {}}
        resp = await self._client.request(
            f"/api/sites/{site_id}/machines/{machine_id}/commands",
            method="POST",
            body=body,
            idempotency_key=idempotency_key,
        )
        envelope = resp.data if isinstance(resp.data, dict) else {}
        # Server returns `{ ok: true, data: {commandId, status} }` —
        # surface the inner payload to keep the SDK shape flat.
        payload = envelope.get("data") if isinstance(envelope.get("data"), dict) else envelope
        return payload if isinstance(payload, dict) else {}

    async def reboot(
        self,
        site_id: str,
        machine_id: str,
        *,
        after_active_hours: bool = False,
        active_hours_override: ActiveHoursOverride | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Queue ``reboot_machine``; returns ``{commandId, status}``.

        A Windows agent of 4.1.21 or later (``capabilities.activeHoursGuard``)
        refuses inside the machine's active hours: ``get_command`` then
        reports ``failed`` with an ``error`` starting ``Error: active_hours:``.
        ``after_active_hours`` restarts once they end (now when outside them);
        older agents, a machine rolled back below 4.1.21 (which keeps the
        capability), macOS and Linux can't hold it, so the API refuses it with
        409 ``held_restart_unsupported``.
        ``active_hours_override`` restarts inside them anyway. Not both.
        """
        params = _active_hours_params(active_hours_override)
        if after_active_hours:
            params["when"] = "after_active_hours"
        return await self.dispatch_command(
            site_id, machine_id, "reboot_machine", params, idempotency_key=idempotency_key
        )

    async def shutdown(
        self,
        site_id: str,
        machine_id: str,
        *,
        active_hours_override: ActiveHoursOverride | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Queue ``shutdown_machine``; returns ``{commandId, status}``.

        Refused inside active hours like ``reboot``, unless
        ``active_hours_override`` carries a reason.
        """
        return await self.dispatch_command(
            site_id,
            machine_id,
            "shutdown_machine",
            _active_hours_params(active_hours_override),
            idempotency_key=idempotency_key,
        )

    async def get_command(
        self,
        site_id: str,
        machine_id: str,
        command_id: str,
    ) -> dict[str, Any]:
        """Fetch the status + result for a queued command."""
        resp = await self._client.request(
            f"/api/sites/{site_id}/machines/{machine_id}/commands/{command_id}",
        )
        envelope = resp.data if isinstance(resp.data, dict) else {}
        payload = envelope.get("data") if isinstance(envelope.get("data"), dict) else envelope
        return payload if isinstance(payload, dict) else {}

    async def capture_screenshot(
        self,
        site_id: str,
        machine_id: str,
        *,
        monitor: int | str | None = None,
        timeout_seconds: float = 60.0,
        download_to: str | os.PathLike[str] | None = None,
        idempotency_key: str | None = None,
    ) -> bytes:
        """Convenience wrapper: dispatch ``capture_screenshot`` → poll → download.

        Polls every 1.5s up to ~``timeout_seconds`` (capped at 40 attempts).
        On success, fetches the signed url returned by the agent and either
        writes the bytes to ``download_to`` or just returns them.

        Raises ``TimeoutError`` if the command stays pending past the cap,
        or ``RuntimeError`` if the agent reports a failure.
        """
        params: dict[str, Any] = {}
        if monitor is not None:
            params["monitor"] = monitor

        queued = await self.dispatch_command(
            site_id,
            machine_id,
            "capture_screenshot",
            params,
            idempotency_key=idempotency_key,
        )
        command_id = queued.get("commandId")
        if not isinstance(command_id, str):
            msg = "capture_screenshot: server did not return a commandId"
            raise RuntimeError(msg)

        max_attempts = min(
            _SCREENSHOT_POLL_MAX_ATTEMPTS,
            max(1, int(timeout_seconds // _SCREENSHOT_POLL_INTERVAL_S)),
        )
        final: dict[str, Any] | None = None
        for attempt in range(max_attempts):
            if attempt > 0:
                await asyncio.sleep(_SCREENSHOT_POLL_INTERVAL_S)
            status_payload = await self.get_command(site_id, machine_id, command_id)
            status = status_payload.get("status")
            if status in ("completed", "failed"):
                final = status_payload
                break

        if final is None:
            msg = (
                f"capture_screenshot: timed out after "
                f"{max_attempts * _SCREENSHOT_POLL_INTERVAL_S:.0f}s "
                f"(commandId={command_id}); agent did not report back"
            )
            raise TimeoutError(msg)

        if final.get("status") == "failed":
            err = final.get("error") or "(no error detail)"
            msg = f"capture_screenshot: agent reported failure — {err}"
            raise RuntimeError(msg)

        result = final.get("result")
        signed_url: str | None = None
        if isinstance(result, dict):
            url = result.get("screenshot_url")
            if isinstance(url, str):
                signed_url = url
        if not signed_url:
            msg = "capture_screenshot: command completed but no screenshot_url returned"
            raise RuntimeError(msg)

        # Use a one-shot AsyncClient — the signed url is pre-authenticated
        # and rejects extra headers, so we don't reuse the SDK's client.
        async with httpx.AsyncClient() as raw:
            dl = await raw.get(signed_url)
        if dl.status_code >= 400:
            msg = (
                f"capture_screenshot: signed-url GET failed "
                f"(status={dl.status_code}, body={dl.text[:200]!r})"
            )
            raise RuntimeError(msg)

        bytes_ = dl.content
        if download_to is not None:
            Path(download_to).write_bytes(bytes_)
        return bytes_


def _active_hours_params(override: ActiveHoursOverride | None) -> dict[str, Any]:
    if override is None:
        return {}
    return {"active_hours_override": {"reason": override["reason"]}}


__all__ = [
    "ActiveHoursOverride",
    "CommandStatus",
    "CommandType",
    "MachineDeployment",
    "MachineDetail",
    "MachineSummary",
    "Machines",
]
