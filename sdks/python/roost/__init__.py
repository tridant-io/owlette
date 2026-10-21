"""``owlette-sdk`` — async Python SDK for the owlette public API.

Typical usage::

    import asyncio
    from roost import Roost, PushOptions

    async def main() -> None:
        async with Roost(token="owk_live_...") as client:
            result = await client.roosts.push(
                "./dist",
                "rst_abc",
                PushOptions(site_id="site-1", on_progress=print),
            )
            print(result.version_id, "v" + str(result.version_number))

    asyncio.run(main())
"""

from __future__ import annotations

from collections.abc import Callable
from types import TracebackType
from typing import TYPE_CHECKING

from roost._chunker import (
    CHUNK_SIZE_BYTES,
    ChunkDescriptor,
    ChunkedFileEntry,
    ChunkProgressEvent,
    DiscoverProgress,
    HashProgress,
)
from roost.client import (
    DEFAULT_API_URL,
    DEFAULT_ROOST_VERSION,
    SDK_VERSION,
    ApiResponse,
    Environment,
    RetryPolicy,
    RoostApiError,
    RoostClient,
)
from roost.resources import (
    Account,
    AccountApiKeys,
    AccountKeyContext,
    AddRole,
    ApiKeyRecord,
    ApiKeyScope,
    ApiVersionResponse,
    Chat,
    Chunks,
    CommandStatus,
    CommandType,
    ControlVerb,
    ConversationSummary,
    DeployOptions,
    DeployResult,
    Deployments,
    Installer,
    InstallerDeploymentDetail,
    InstallerDeploymentSummary,
    InstallerDeploymentTarget,
    InstallerDeployments,
    InstallerFile,
    InstallerVersion,
    Keys,
    MachineDeployment,
    MachineDetail,
    MachineSummary,
    Machines,
    Member,
    Members,
    PerSiteRole,
    PlatformUser,
    ProcessRecord,
    Processes,
    PromoteRole,
    PushOptions,
    PushResult,
    QuotaHistoryDay,
    QuotaSnapshot,
    Quotas,
    RollbackOptions,
    RollbackResult,
    RoostDetail,
    Roosts,
    RoostSummary,
    ScheduleMode,
    Site,
    Sites,
    Users,
    VersionSummary,
    Versions,
    WebhookSubscription,
    Webhooks,
    WhoamiResponse,
)
from roost.signature import (
    DEFAULT_REPLAY_TOLERANCE_SECONDS,
    VerifyReason,
    VerifySignatureResult,
    is_signature_valid,
    sign_body,
    verify_signature,
)

if TYPE_CHECKING:
    import httpx


class Roost:
    """Top-level async client. Use as an async context manager to ensure ``close()``.

    Resources are lazily instantiated on first access — constructor is cheap.
    """

    def __init__(
        self,
        *,
        token: str,
        api_url: str = DEFAULT_API_URL,
        roost_version: str = DEFAULT_ROOST_VERSION,
        environment: Environment | None = None,
        retry: RetryPolicy | None = None,
        transport: "httpx.AsyncBaseTransport | None" = None,
        timeout: float = 30.0,
        on_billing_warning: Callable[[str], None] | None = None,
    ) -> None:
        client_kwargs: dict[str, object] = {
            "token": token,
            "api_url": api_url,
            "roost_version": roost_version,
            "timeout": timeout,
        }
        if environment is not None:
            client_kwargs["environment"] = environment
        if retry is not None:
            client_kwargs["retry"] = retry
        if transport is not None:
            client_kwargs["transport"] = transport
        if on_billing_warning is not None:
            client_kwargs["on_billing_warning"] = on_billing_warning
        self._client = RoostClient(**client_kwargs)  # type: ignore[arg-type]

        self._roosts: Roosts | None = None
        self._chunks: Chunks | None = None
        self._versions: Versions | None = None
        self._deployments: Deployments | None = None
        self._webhooks: Webhooks | None = None
        self._keys: Keys | None = None
        self._sites: Sites | None = None
        self._machines: Machines | None = None
        self._quotas: Quotas | None = None
        self._installer: Installer | None = None
        self._installer_deployments: InstallerDeployments | None = None
        self._chat: Chat | None = None
        self._users: Users | None = None
        self._account: Account | None = None

    # ----- async context manager --------------------------------------------

    async def __aenter__(self) -> "Roost":
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        await self.close()

    async def close(self) -> None:
        await self._client.close()

    # ----- resource accessors -----------------------------------------------

    @property
    def http(self) -> RoostClient:
        """The raw low-level client for escape-hatch calls."""
        return self._client

    @property
    def account(self) -> Account:
        if self._account is None:
            self._account = Account(self._client)
        return self._account

    @property
    def roosts(self) -> Roosts:
        if self._roosts is None:
            self._roosts = Roosts(self._client)
        return self._roosts

    @property
    def chunks(self) -> Chunks:
        if self._chunks is None:
            self._chunks = Chunks(self._client)
        return self._chunks

    @property
    def versions(self) -> Versions:
        if self._versions is None:
            self._versions = Versions(self._client)
        return self._versions

    @property
    def deployments(self) -> Deployments:
        if self._deployments is None:
            self._deployments = Deployments(self._client)
        return self._deployments

    @property
    def webhooks(self) -> Webhooks:
        if self._webhooks is None:
            self._webhooks = Webhooks(self._client)
        return self._webhooks

    @property
    def keys(self) -> Keys:
        if self._keys is None:
            self._keys = Keys(self._client)
        return self._keys

    @property
    def sites(self) -> Sites:
        if self._sites is None:
            self._sites = Sites(self._client)
        return self._sites

    @property
    def machines(self) -> Machines:
        if self._machines is None:
            self._machines = Machines(self._client)
        return self._machines

    @property
    def quotas(self) -> Quotas:
        if self._quotas is None:
            self._quotas = Quotas(self._client)
        return self._quotas

    @property
    def installer(self) -> Installer:
        if self._installer is None:
            self._installer = Installer(self._client)
        return self._installer

    @property
    def installer_deployments(self) -> InstallerDeployments:
        if self._installer_deployments is None:
            self._installer_deployments = InstallerDeployments(self._client)
        return self._installer_deployments

    @property
    def chat(self) -> Chat:
        if self._chat is None:
            self._chat = Chat(self._client)
        return self._chat

    @property
    def users(self) -> Users:
        if self._users is None:
            self._users = Users(self._client)
        return self._users

    # ----- factory accessors (require extra args, can't be properties) ------

    def processes(self, site_id: str, machine_id: str) -> Processes:
        """Return a ``Processes`` handle bound to one (site, machine) pair.

        Cheap to call repeatedly — no caching needed; the handle just
        stores a few strings.
        """
        return Processes(self._client, site_id, machine_id)

    def members(self, site_id: str) -> Members:
        """Return a ``Members`` handle bound to one site."""
        return Members(self._client, site_id)


__version__ = SDK_VERSION

__all__ = [
    "CHUNK_SIZE_BYTES",
    "DEFAULT_API_URL",
    "DEFAULT_REPLAY_TOLERANCE_SECONDS",
    "DEFAULT_ROOST_VERSION",
    "SDK_VERSION",
    "Account",
    "AccountApiKeys",
    "AccountKeyContext",
    "AddRole",
    "ApiKeyRecord",
    "ApiKeyScope",
    "ApiResponse",
    "ApiVersionResponse",
    "Chat",
    "ChunkDescriptor",
    "ChunkProgressEvent",
    "ChunkedFileEntry",
    "Chunks",
    "CommandStatus",
    "CommandType",
    "ControlVerb",
    "ConversationSummary",
    "DeployOptions",
    "DeployResult",
    "Deployments",
    "DiscoverProgress",
    "Environment",
    "HashProgress",
    "Installer",
    "InstallerDeploymentDetail",
    "InstallerDeploymentSummary",
    "InstallerDeploymentTarget",
    "InstallerDeployments",
    "InstallerFile",
    "InstallerVersion",
    "Keys",
    "MachineDeployment",
    "MachineDetail",
    "MachineSummary",
    "Machines",
    "Member",
    "Members",
    "PerSiteRole",
    "PlatformUser",
    "ProcessRecord",
    "Processes",
    "PromoteRole",
    "PushOptions",
    "PushResult",
    "QuotaHistoryDay",
    "QuotaSnapshot",
    "Quotas",
    "RetryPolicy",
    "RollbackOptions",
    "RollbackResult",
    "Roost",
    "RoostApiError",
    "RoostClient",
    "RoostDetail",
    "RoostSummary",
    "Roosts",
    "ScheduleMode",
    "Site",
    "Sites",
    "Users",
    "VerifyReason",
    "VerifySignatureResult",
    "VersionSummary",
    "Versions",
    "WebhookSubscription",
    "Webhooks",
    "WhoamiResponse",
    "__version__",
    "is_signature_valid",
    "sign_body",
    "verify_signature",
]
