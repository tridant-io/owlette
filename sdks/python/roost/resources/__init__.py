"""Resource classes exposed as attributes on the top-level ``Roost`` client."""

from roost.resources.account import (
    Account,
    AccountApiKeys,
    AccountKeyContext,
    ApiVersionResponse,
    WhoamiResponse,
)
from roost.resources.chat import Chat, ConversationSummary
from roost.resources.chunks import Chunks
from roost.resources.deployments import Deployments
from roost.resources.installer import Installer, InstallerFile, InstallerVersion
from roost.resources.installer_deployments import (
    InstallerDeploymentDetail,
    InstallerDeploymentSummary,
    InstallerDeploymentTarget,
    InstallerDeployments,
)
from roost.resources.keys import ApiKeyRecord, ApiKeyScope, Keys
from roost.resources.machines import (
    CommandStatus,
    CommandType,
    MachineDeployment,
    MachineDetail,
    MachineSummary,
    Machines,
)
from roost.resources.members import AddRole, Member, Members, PerSiteRole
from roost.resources.processes import ControlVerb, ProcessRecord, Processes, ScheduleMode
from roost.resources.quotas import QuotaHistoryDay, QuotaSnapshot, Quotas
from roost.resources.roosts import (
    DeployOptions,
    DeployResult,
    PushOptions,
    PushResult,
    RollbackOptions,
    RollbackResult,
    RoostDetail,
    Roosts,
    RoostSummary,
    VersionSummary,
)
from roost.resources.sites import Site, Sites
from roost.resources.users import PlatformUser, PromoteRole, Users
from roost.resources.versions import Versions
from roost.resources.webhooks import WebhookSubscription, Webhooks

__all__ = [
    "Account",
    "AccountApiKeys",
    "AccountKeyContext",
    "AddRole",
    "ApiKeyRecord",
    "ApiKeyScope",
    "ApiVersionResponse",
    "Chat",
    "Chunks",
    "CommandStatus",
    "CommandType",
    "ControlVerb",
    "ConversationSummary",
    "DeployOptions",
    "DeployResult",
    "Deployments",
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
    "RollbackOptions",
    "RollbackResult",
    "RoostDetail",
    "RoostSummary",
    "Roosts",
    "ScheduleMode",
    "Site",
    "Sites",
    "Users",
    "VersionSummary",
    "Versions",
    "WebhookSubscription",
    "Webhooks",
    "WhoamiResponse",
]
