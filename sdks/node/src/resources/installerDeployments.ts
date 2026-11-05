/**
 * `owlette.installerDeployments` — classic installer deployment lifecycle over
 * `/api/sites/{siteId}/deployments[/{deploymentId}[/retry|cancel|uninstall]]`.
 *
 * Mutations auto-generate `Idempotency-Key:
 * sdk-installer-deployments-<verb>-${randomUUID()}` unless the caller passes
 * `opts.idempotencyKey`. Failures throw `OwletteApiError` from `client.request`.
 */
import { randomUUID } from 'crypto';
import type { OwletteClient } from '../lib/client';

// types

export type InstallerDeploymentTargetStatus =
  | 'pending'
  | 'closing_processes'
  | 'downloading'
  | 'installing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'uninstalled';

export type InstallerDeploymentStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'partial'
  | 'partial_failed'
  | 'cancelled'
  | 'uninstalling'
  | 'uninstalled';

export interface InstallerDeploymentTarget {
  machineId: string;
  status: InstallerDeploymentTargetStatus;
  error?: string | null;
  cancelledAt?: string | null;
  retriedAt?: string | null;
  [key: string]: unknown;
}

export interface InstallerDeploymentSummary {
  id: string;
  name: string;
  installer_name: string;
  installer_url: string;
  silent_flags: string;
  verify_path: string | null;
  sha256_checksum: string | null;
  parallel_install: boolean;
  targets: InstallerDeploymentTarget[];
  status: InstallerDeploymentStatus;
  createdAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

export interface InstallerDeploymentDetail extends InstallerDeploymentSummary {
  siteId: string;
}

export interface ListInstallerDeploymentsOptions {
  pageSize?: number;
  pageToken?: string;
}

export interface ListInstallerDeploymentsResult {
  items: InstallerDeploymentSummary[];
  nextPageToken: string;
}

export interface CreateInstallerDeploymentOptions {
  name: string;
  installer_url: string;
  installer_name: string;
  silent_flags: string;
  machines: readonly string[];
  verify_path?: string;
  sha256_checksum?: string;
  close_processes?: readonly string[];
  suppress_projects?: readonly string[];
  parallel_install?: boolean;
  /**
   * Install inside the machines' active hours anyway. The server writes it onto
   * every install with your key as the approver, and the agent logs the reason.
   * Without it, a Windows agent with `capabilities.activeHoursGuard` fails a
   * target inside active hours with an `error` starting `Error: active_hours:`.
   */
  activeHoursOverride?: { reason: string };
  idempotencyKey?: string;
}

export interface RetryInstallerDeploymentOptions {
  /** As for `create`. The deployment's own override does not carry over to a retry. */
  activeHoursOverride?: { reason: string };
  idempotencyKey?: string;
}

export interface CreateInstallerDeploymentResult {
  deploymentId: string;
  siteId: string;
  status: InstallerDeploymentStatus;
  targets: InstallerDeploymentTarget[];
}

export interface InstallerDeploymentMutationResult {
  deploymentId: string;
  siteId: string;
  status: InstallerDeploymentStatus;
  /** Number of targets affected by the mutation (retried/cancelled/queued). */
  retried?: number;
  cancelled?: number;
  queued?: number;
  machine_ids?: string[];
}

export interface InstallerDeploymentDeleteResult {
  deploymentId: string;
  siteId: string;
  deleted: boolean;
}

// resource

export class InstallerDeployments {
  constructor(private readonly client: OwletteClient) {}

  async list(
    siteId: string,
    opts: ListInstallerDeploymentsOptions = {},
  ): Promise<ListInstallerDeploymentsResult> {
    const res = await this.client.request<{
      items: InstallerDeploymentSummary[];
      next_page_token: string;
    }>(`/api/sites/${encodeURIComponent(siteId)}/deployments`, {
      query: {
        page_size: opts.pageSize,
        page_token: opts.pageToken,
      },
    });
    return {
      items: res.data.items,
      nextPageToken: res.data.next_page_token,
    };
  }

  async get(siteId: string, deploymentId: string): Promise<InstallerDeploymentDetail> {
    const res = await this.client.request<InstallerDeploymentDetail>(
      `/api/sites/${encodeURIComponent(siteId)}/deployments/${encodeURIComponent(deploymentId)}`,
    );
    return res.data;
  }

  async create(
    siteId: string,
    opts: CreateInstallerDeploymentOptions,
  ): Promise<CreateInstallerDeploymentResult> {
    const body: Record<string, unknown> = {
      name: opts.name,
      installer_url: opts.installer_url,
      installer_name: opts.installer_name,
      silent_flags: opts.silent_flags,
      machines: [...opts.machines],
    };
    if (opts.verify_path !== undefined) body.verify_path = opts.verify_path;
    if (opts.sha256_checksum !== undefined) body.sha256_checksum = opts.sha256_checksum;
    if (opts.close_processes !== undefined) body.close_processes = [...opts.close_processes];
    if (opts.suppress_projects !== undefined) body.suppress_projects = [...opts.suppress_projects];
    if (opts.parallel_install) body.parallel_install = true;
    if (opts.activeHoursOverride) {
      body.active_hours_override = { reason: opts.activeHoursOverride.reason };
    }

    const res = await this.client.request<CreateInstallerDeploymentResult>(
      `/api/sites/${encodeURIComponent(siteId)}/deployments`,
      {
        method: 'POST',
        body,
        idempotencyKey:
          opts.idempotencyKey ?? `sdk-installer-deployments-create-${randomUUID()}`,
      },
    );
    return res.data;
  }

  async retry(
    siteId: string,
    deploymentId: string,
    opts: RetryInstallerDeploymentOptions = {},
  ): Promise<InstallerDeploymentMutationResult> {
    const res = await this.client.request<InstallerDeploymentMutationResult>(
      `/api/sites/${encodeURIComponent(siteId)}/deployments/${encodeURIComponent(deploymentId)}/retry`,
      {
        method: 'POST',
        body: opts.activeHoursOverride
          ? { active_hours_override: { reason: opts.activeHoursOverride.reason } }
          : {},
        idempotencyKey:
          opts.idempotencyKey ?? `sdk-installer-deployments-retry-${randomUUID()}`,
      },
    );
    return res.data;
  }

  async cancel(
    siteId: string,
    deploymentId: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<InstallerDeploymentMutationResult> {
    const res = await this.client.request<InstallerDeploymentMutationResult>(
      `/api/sites/${encodeURIComponent(siteId)}/deployments/${encodeURIComponent(deploymentId)}/cancel`,
      {
        method: 'POST',
        body: {},
        idempotencyKey:
          opts.idempotencyKey ?? `sdk-installer-deployments-cancel-${randomUUID()}`,
      },
    );
    return res.data;
  }

  async uninstall(
    siteId: string,
    deploymentId: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<InstallerDeploymentMutationResult> {
    const res = await this.client.request<InstallerDeploymentMutationResult>(
      `/api/sites/${encodeURIComponent(siteId)}/deployments/${encodeURIComponent(deploymentId)}/uninstall`,
      {
        method: 'POST',
        body: {},
        idempotencyKey:
          opts.idempotencyKey ?? `sdk-installer-deployments-uninstall-${randomUUID()}`,
      },
    );
    return res.data;
  }

  async delete(
    siteId: string,
    deploymentId: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<InstallerDeploymentDeleteResult> {
    const res = await this.client.request<InstallerDeploymentDeleteResult>(
      `/api/sites/${encodeURIComponent(siteId)}/deployments/${encodeURIComponent(deploymentId)}`,
      {
        method: 'DELETE',
        body: {},
        idempotencyKey:
          opts.idempotencyKey ?? `sdk-installer-deployments-delete-${randomUUID()}`,
      },
    );
    return res.data;
  }
}
