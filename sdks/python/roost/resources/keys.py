"""``roost.keys`` — scoped API key management."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, cast

if TYPE_CHECKING:
    from roost.client import RoostClient


Permission = Literal["read", "write", "deploy", "rollback", "admin"]
Resource = Literal[
    "roost",
    "site",
    "machine",
    "chat",
    "deploy",
    "process",
    "user",
    "installer",
    "issue",
]
Environment = Literal["live", "test"]
VALID_RESOURCES: tuple[str, ...] = (
    "roost",
    "site",
    "machine",
    "chat",
    "deploy",
    "process",
    "user",
    "installer",
    "issue",
)
VALID_PERMISSIONS: tuple[str, ...] = ("read", "write", "deploy", "rollback", "admin")


@dataclass(slots=True)
class ApiKeyScope:
    resource: Resource
    id: str
    permissions: list[Permission]

    def to_payload(self) -> dict[str, Any]:
        return {
            "resource": self.resource,
            "id": self.id,
            "permissions": list(self.permissions),
        }

    @classmethod
    def from_payload(cls, raw: dict[str, Any]) -> "ApiKeyScope":
        raw_resource = raw.get("resource")
        resource: Resource = (
            cast(Resource, raw_resource) if raw_resource in VALID_RESOURCES else "site"
        )
        raw_permissions = raw.get("permissions")
        permissions: list[Permission] = []
        if isinstance(raw_permissions, list):
            permissions = [
                cast(Permission, p)
                for p in raw_permissions
                if p in VALID_PERMISSIONS
            ]
        return cls(
            resource=resource,
            id=str(raw.get("id", "")),
            permissions=permissions,
        )


@dataclass(slots=True)
class ApiKeyRecord:
    id: str
    name: str | None
    key_prefix: str | None
    environment: Environment | None
    scopes: list[ApiKeyScope] | None
    expires_at: int | str | None
    created_at: int | str | dict[str, Any] | None
    last_used_at: int | str | dict[str, Any] | None
    last_used_ip: str | None
    rotated_at: int | str | None
    rotated_from_key_id: str | None
    retires_at: int | str | None
    revoked_at: int | str | None
    expired: bool
    retired: bool

    @classmethod
    def from_payload(cls, raw: dict[str, Any]) -> "ApiKeyRecord":
        scopes_raw = raw.get("scopes")
        scopes: list[ApiKeyScope] | None = None
        if isinstance(scopes_raw, list):
            scopes = [ApiKeyScope.from_payload(s) for s in scopes_raw if isinstance(s, dict)]
        env_raw = raw.get("environment")
        env: Environment | None = (
            cast(Environment, env_raw) if env_raw in ("live", "test") else None
        )
        return cls(
            id=str(raw.get("id", "")),
            name=raw.get("name") if isinstance(raw.get("name"), str) else None,
            key_prefix=raw.get("keyPrefix") if isinstance(raw.get("keyPrefix"), str) else None,
            environment=env,
            scopes=scopes,
            expires_at=raw.get("expiresAt"),
            created_at=raw.get("createdAt"),
            last_used_at=raw.get("lastUsedAt"),
            last_used_ip=raw.get("lastUsedIp") if isinstance(raw.get("lastUsedIp"), str) else None,
            rotated_at=raw.get("rotatedAt"),
            rotated_from_key_id=raw.get("rotatedFromKeyId")
            if isinstance(raw.get("rotatedFromKeyId"), str)
            else None,
            retires_at=raw.get("retiresAt"),
            revoked_at=raw.get("revokedAt"),
            expired=bool(raw.get("expired", False)),
            retired=bool(raw.get("retired", False)),
        )


def _parse_scope(raw: dict[str, Any]) -> ApiKeyScope:
    return ApiKeyScope.from_payload(raw)


def _parse_record(raw: dict[str, Any]) -> ApiKeyRecord:
    return ApiKeyRecord.from_payload(raw)


class Keys:
    def __init__(self, client: "RoostClient") -> None:
        self._client = client

    async def create(
        self,
        *,
        name: str,
        scopes: Sequence[ApiKeyScope],
        ttl_days: int = 90,
        environment: Environment = "live",
    ) -> dict[str, Any]:
        resp = await self._client.request(
            "/api/keys",
            method="POST",
            body={
                "name": name,
                "scopes": [s.to_payload() for s in scopes],
                "ttlDays": ttl_days,
                "environment": environment,
            },
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def list(self) -> list[ApiKeyRecord]:
        resp = await self._client.request("/api/keys")
        data = resp.data if isinstance(resp.data, dict) else {}
        return [_parse_record(k) for k in data.get("keys", []) if isinstance(k, dict)]

    async def update(
        self,
        key_id: str,
        *,
        name: str | None = None,
        scopes: Sequence[ApiKeyScope] | None = None,
    ) -> ApiKeyRecord | None:
        """Edit a key's scopes and/or name without reissuing the secret.

        ``scopes`` replaces the key's scope list outright — it is not merged
        with what is already there. Like :meth:`rotate` and :meth:`revoke`,
        this route takes a session or Firebase ID token; an api key cannot
        edit itself.
        """
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if scopes is not None:
            body["scopes"] = [s.to_payload() for s in scopes]
        if not body:
            raise ValueError("update requires name and/or scopes")
        resp = await self._client.request(
            f"/api/keys/{key_id}",
            method="PATCH",
            body=body,
        )
        data = resp.data if isinstance(resp.data, dict) else {}
        key = data.get("key")
        return _parse_record(key) if isinstance(key, dict) else None

    async def rotate(self, key_id: str, *, ttl_days: int = 90) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/keys/{key_id}/rotate",
            method="POST",
            body={"ttlDays": ttl_days},
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def revoke(self, key_id: str) -> None:
        await self._client.request(
            f"/api/keys/{key_id}",
            method="DELETE",
        )


__all__ = ["ApiKeyRecord", "ApiKeyScope", "Environment", "Keys", "Permission", "Resource"]
