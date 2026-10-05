'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useMachines } from '@/hooks/useFirestore';
import { useCurrentSite } from '@/hooks/useCurrentSite';
import { PageCascade } from '@/components/PageCascade';
import { NoSitesEmptyState } from '@/components/NoSitesEmptyState';
import { useDeploymentManager, type Deployment, type DeploymentTarget } from '@/hooks/useDeployments';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Plus, CheckCircle2, XCircle, Clock, Loader2, Trash2, X, MoreVertical, RefreshCw, Package, PlayCircle, Archive, ChevronDown } from 'lucide-react';
import DeploymentDialog from '@/components/DeploymentDialog';
import UninstallDialog from '@/components/UninstallDialog';
import { ManageSitesDialog } from '@/components/ManageSitesDialog';
import { CreateSiteDialog } from '@/components/CreateSiteDialog';
import { PageHeader } from '@/components/PageHeader';
import { AccountSettingsDialog } from '@/components/AccountSettingsDialog';
import DownloadButton from '@/components/DownloadButton';
import { FallingFeather } from '@/components/FallingFeather';
import { LoadingWord } from '@/components/LoadingWord';
import ConfirmDialog from '@/components/ConfirmDialog';
import { UpdateOwletteButton } from '@/components/UpdateOwletteButton';
import { useUninstall } from '@/hooks/useUninstall';
import { formatSiteScopedTimestamp } from '@/lib/timeUtils';
import { toast } from '@/lib/toast';

function getStatusIcon(status: string) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-5 w-5 text-success" />;
    case 'uninstalled':
      return <Trash2 className="h-5 w-5 text-chart-4" />;
    case 'failed':
      return <XCircle className="h-5 w-5 text-danger" />;
    case 'cancelled':
      return <XCircle className="h-5 w-5 text-accent-coral" />;
    case 'in_progress':
      return <Loader2 className="h-5 w-5 text-accent-cyan animate-spin" />;
    case 'partial':
      return <Clock className="h-5 w-5 text-warning" />;
    default:
      return <Clock className="h-5 w-5 text-muted-foreground" />;
  }
}

// outcomes take the status families. the rest are categorical: in-flight steps
// take the signal and the warm accents, and purple has no status family, so the
// install steps borrow --chart-4. a fill with no text class keeps the badge's
// primary-foreground ink, which reads on each of them in both themes
const statusColors: Record<string, string> = {
  completed: 'bg-success-solid text-success-solid-foreground',
  uninstalled: 'bg-chart-4',
  failed: 'bg-danger-solid text-danger-solid-foreground',
  cancelled: 'bg-accent-coral',
  in_progress: 'bg-primary',
  partial: 'bg-warning-solid text-warning-solid-foreground',
  pending: 'bg-muted text-muted-foreground',
  closing_processes: 'bg-accent-warm',
  downloading: 'bg-primary',
  installing: 'bg-chart-4',
};

function getStatusBadge(status: string, error?: string) {
  const badge = (
    <Badge className={`select-none ${statusColors[status] || statusColors.pending}`}>
      {status.replace('_', ' ')}
    </Badge>
  );

  if (error && (status === 'failed' || status === 'partial')) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {badge}
        </TooltipTrigger>
        <TooltipContent className="max-w-md whitespace-pre-wrap">
          <p className="text-sm">{error}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return badge;
}

const DeploymentRow = React.memo(function DeploymentRow({
  deployment,
  isSelected,
  onToggle,
  onRetry,
  onRetryTarget,
  onUninstall,
  onDelete,
  onCancel,
  retrying,
  timeDisplayMode,
  userTz,
  siteTz,
  timeFormat,
}: {
  deployment: Deployment;
  isSelected: boolean;
  onToggle: (id: string) => void;
  onRetry: (deployment: Deployment) => void;
  onRetryTarget: (deployment: Deployment, machineId: string) => void;
  onUninstall: (deployment: Deployment) => void;
  onDelete: (id: string) => void;
  onCancel: (deploymentId: string, machineId: string, installerName: string) => void;
  /** in-flight retry keys: deployment id (bulk) or `${deploymentId}:${machineId}` (per-row). */
  retrying: ReadonlySet<string>;
  timeDisplayMode: 'user' | 'machine' | 'site';
  userTz: string | undefined;
  siteTz: string | undefined;
  timeFormat: '12h' | '24h';
}) {
  const failedTargets = deployment.targets.filter((t: DeploymentTarget) => t.status === 'failed' && t.error);
  const errorMessages = failedTargets.map((t: DeploymentTarget) => `${t.machineId}: ${t.error}`).join('\n');
  const bulkRetrying = retrying.has(deployment.id);

  return (
    <Collapsible
      open={isSelected}
      onOpenChange={() => onToggle(deployment.id)}
    >
      {/* the whole row toggles for pointer users; the chevron button is the
          real trigger, because a row that holds the actions menu can't itself
          be a button */}
      <div
        className="flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors cursor-pointer"
        onClick={() => {
          // Don't toggle if the user's mid-drag-selecting text in the summary
          // (names are `select-text`).
          const selection = window.getSelection();
          if (selection && selection.toString().length > 0) return;
          onToggle(deployment.id);
        }}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {getStatusIcon(deployment.status)}
          <div className="min-w-0">
            <span className="block truncate text-foreground font-medium select-text">{deployment.name}</span>
            <p className="text-xs text-muted-foreground select-text truncate">{deployment.installer_name}</p>
            {/* below `sm` the badge is hidden and the icon alone carries the status */}
            <span className="sr-only sm:hidden">{deployment.status.replace('_', ' ')}</span>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {/* Status text badge is desktop-only — below `sm` the leading status
              icon already carries the same state, so the row stays icon-only
              instead of spending 90px of a 390px viewport on a duplicate. */}
          <div className="hidden sm:flex w-[90px] shrink-0 justify-end">
            {getStatusBadge(deployment.status, errorMessages || undefined)}
          </div>
          <span className="text-xs text-muted-foreground hidden sm:block w-[150px] text-right">
            {formatSiteScopedTimestamp(deployment.createdAt, timeDisplayMode, userTz, siteTz, timeFormat)}
          </span>
          <CollapsibleTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`details for ${deployment.name}`}
              onClick={(e) => e.stopPropagation()}
              className="h-7 w-7 pointer-coarse:h-10 pointer-coarse:w-10 p-0 text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer"
            >
              <ChevronDown className={`h-4 w-4 transition-transform ${isSelected ? 'rotate-180' : ''}`} />
            </Button>
          </CollapsibleTrigger>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`deployment actions for ${deployment.name}`}
                    className="h-7 w-7 pointer-coarse:h-10 pointer-coarse:w-10 p-0 text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>
                <p>more options</p>
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="border-border bg-raised">
              {deployment.targets.some((t: DeploymentTarget) => t.status === 'failed') && (
                <DropdownMenuItem
                  disabled={bulkRetrying}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRetry(deployment);
                  }}
                  className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer"
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${bulkRetrying ? 'animate-spin' : ''}`} />
                  retry failed
                </DropdownMenuItem>
              )}
              {deployment.status !== 'uninstalled' && (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onUninstall(deployment);
                  }}
                  className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  uninstall software
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(deployment.id);
                }}
                className="text-danger focus:bg-danger-surface focus:text-danger cursor-pointer"
              >
                <X className="h-4 w-4 mr-2" />
                delete record
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
        <div className="border-t border-border">
          <div className="mx-4 my-3 rounded-lg border border-border bg-background p-4 space-y-4">
            <div className="grid gap-2 text-sm">
              <div className="flex gap-2">
                <span className="text-muted-foreground flex-shrink-0 w-24">installer url</span>
                <span className="text-foreground select-text break-all">{deployment.installer_url}</span>
              </div>
              {deployment.silent_flags && (
                <div className="flex gap-2">
                  <span className="text-muted-foreground flex-shrink-0 w-24">silent flags</span>
                  <span className="text-foreground select-text break-all font-mono text-xs leading-relaxed">{deployment.silent_flags}</span>
                </div>
              )}
              {deployment.verify_path && (
                <div className="flex gap-2">
                  <span className="text-muted-foreground flex-shrink-0 w-24">verify path</span>
                  <span className="text-foreground select-text break-all">{deployment.verify_path}</span>
                </div>
              )}
            </div>

            <div>
              <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">targets ({deployment.targets.length})</h2>
              <div className="space-y-1.5">
                {deployment.targets.map((target: DeploymentTarget) => (
                  <div key={target.machineId} className="rounded border border-border/40 bg-background/50">
                    <div className="flex items-center justify-between py-1.5 px-3">
                      <span className="text-foreground text-sm select-text">{target.machineId}</span>
                      <div className="flex items-center gap-2">
                        {target.progress !== undefined && (target.status === 'downloading' || target.status === 'installing') && (
                          <span className="text-xs text-muted-foreground">{target.progress}%</span>
                        )}
                        {getStatusBadge(target.status)}
                        {target.status === 'failed' && (() => {
                          const rowRetrying = bulkRetrying || retrying.has(`${deployment.id}:${target.machineId}`);
                          return (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={rowRetrying}
                                  onClick={() => onRetryTarget(deployment, target.machineId)}
                                  aria-label={`retry deployment to ${target.machineId}`}
                                  className="h-7 px-2 text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer"
                                >
                                  <RefreshCw className={`h-4 w-4 ${rowRetrying ? 'animate-spin' : ''}`} />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>retry this machine</p>
                              </TooltipContent>
                            </Tooltip>
                          );
                        })()}
                        {(target.status === 'pending' || target.status === 'closing_processes' || target.status === 'downloading' || target.status === 'installing') && (
                          <Button
                            size="sm"
                            variant="ghost-destructive"
                            onClick={() => onCancel(deployment.id, target.machineId, deployment.installer_name)}
                            aria-label={`cancel deployment to ${target.machineId}`}
                            className="h-7 px-2 cursor-pointer"
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                    {/* inline, not tooltip-only: the reason is what the operator needs to act on */}
                    {target.error && (
                      <p className="px-3 pb-2 text-xs text-destructive whitespace-pre-wrap break-words select-text">{target.error}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

export default function DeploymentsPage() {
  const { user, loading: authLoading, userPreferences } = useAuth();
  const {
    sites,
    sitesLoading,
    currentSiteId,
    siteTimezone,
    hasNoSites,
    selectSite,
    pickSite,
    createSite,
    updateSite,
    deleteSite,
  } = useCurrentSite();
  const [deployDialogOpen, setDeployDialogOpen] = useState(false);
  const [uninstallDialogOpen, setUninstallDialogOpen] = useState(false);
  const [initialSoftwareName, setInitialSoftwareName] = useState<string | undefined>(undefined);
  const [uninstallDeploymentId, setUninstallDeploymentId] = useState<string | undefined>(undefined);
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string | null>(null);
  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deploymentToDelete, setDeploymentToDelete] = useState<string | null>(null);
  const router = useRouter();

  const {
    deployments,
    deploymentsLoading,
    templates,
    templatesLoading,
    createDeployment,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    retryDeployment,
    cancelDeployment,
    deleteDeployment,
  } = useDeploymentManager(currentSiteId);

  const { machines } = useMachines(currentSiteId);
  const { createUninstall } = useUninstall();

  const handleCreateUninstall = async (softwareName: string, machineIds: string[], deploymentId?: string) => {
    try {
      await createUninstall(currentSiteId, softwareName, machineIds, deploymentId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message || 'failed to create uninstall task');
    }
  };

  const handleDeleteDeployment = async () => {
    if (!deploymentToDelete) return;

    try {
      await deleteDeployment(deploymentToDelete);
      toast.success('deployment record deleted successfully');
    } catch (error: unknown) {
      console.error('Failed to delete deployment:', error);
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message || 'failed to delete deployment record');
    } finally {
      setDeploymentToDelete(null);
    }
  };

  // useDeploymentManager returns non-memoized functions, so referencing them
  // directly in useCallback deps recreates handlers on every render and
  // defeats React.memo on DeploymentRow. Keep a latest-ref and depend on
  // nothing, so the handlers keep stable identity for the whole list.
  const retryDeploymentRef = useRef(retryDeployment);
  retryDeploymentRef.current = retryDeployment;

  // In-flight retry keys: deployment id (bulk) or `${deploymentId}:${machineId}`
  // (per-row). Drives disabled state + spinner — the retry endpoint may stream and hash
  // the installer to self-heal a legacy deployment's missing checksum, which is slow.
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());

  const runRetry = useCallback(async (deployment: Deployment, machineIds?: string[]) => {
    const key = machineIds?.length === 1
      ? `${deployment.id}:${machineIds[0]}`
      : deployment.id;
    setRetrying((prev) => new Set(prev).add(key));
    try {
      const retried = await retryDeploymentRef.current(deployment.id, machineIds);
      toast.success(`retrying deployment for ${retried} machine(s)`);
    } catch (error: unknown) {
      console.error('Failed to retry deployment:', error);
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message || 'failed to retry deployment');
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const handleRetryDeployment = useCallback(async (deployment: Deployment) => {
    if (!deployment.targets.some((t: DeploymentTarget) => t.status === 'failed')) {
      toast.error('no failed targets to retry');
      return;
    }
    await runRetry(deployment);
  }, [runRetry]);

  const handleRetryTarget = useCallback(async (deployment: Deployment, machineId: string) => {
    await runRetry(deployment, [machineId]);
  }, [runRetry]);

  const handleSiteChange = (siteId: string) => {
    selectSite(siteId);
  };

  const handleToggleDeployment = useCallback((id: string) => {
    setSelectedDeploymentId(prev => prev === id ? null : id);
  }, []);

  const handleUninstallFromRow = useCallback((deployment: Deployment) => {
    setInitialSoftwareName(deployment.installer_name);
    setUninstallDeploymentId(deployment.id);
    setUninstallDialogOpen(true);
  }, []);

  const handleDeleteFromRow = useCallback((id: string) => {
    setDeploymentToDelete(id);
    setDeleteDialogOpen(true);
  }, []);

  const cancelDeploymentRef = useRef(cancelDeployment);
  cancelDeploymentRef.current = cancelDeployment;

  const handleCancelTarget = useCallback(async (deploymentId: string, machineId: string, installerName: string) => {
    try {
      await cancelDeploymentRef.current(deploymentId, machineId, installerName);
    } catch (error: unknown) {
      console.error('Failed to cancel deployment:', error);
    }
  }, []);

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/');
    }
  }, [user, authLoading, router]);

  if (authLoading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center">
        <FallingFeather />
        <p className="text-muted-foreground"><LoadingWord /></p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={200}>
    <PageCascade className="relative min-h-screen pb-8">
      <PageHeader
        currentPage="deploy"
        sites={sites}
        currentSiteId={currentSiteId}
        onSiteChange={handleSiteChange}
        onManageSites={() => setManageDialogOpen(true)}
        onAccountSettings={() => setAccountSettingsOpen(true)}
        actionButton={<DownloadButton />}
      />

      <ManageSitesDialog
        open={manageDialogOpen}
        onOpenChange={setManageDialogOpen}
        sites={sites}
        currentSiteId={currentSiteId}
        onUpdateSite={updateSite}
        onDeleteSite={async (siteId) => {
          await deleteSite(siteId);
          if (siteId === currentSiteId) {
            const remainingSites = sites.filter(s => s.id !== siteId);
            if (remainingSites.length > 0) {
              handleSiteChange(remainingSites[0].id);
            }
          }
        }}
        onCreateSite={() => setCreateDialogOpen(true)}
      />

      <CreateSiteDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreateSite={createSite}
        onSiteCreated={(siteId) => pickSite(siteId)}
      />

      <main className="relative z-10 mx-auto max-w-screen-2xl p-3 md:p-4">
        <DeploymentDialog
          open={deployDialogOpen}
          onOpenChange={setDeployDialogOpen}
          siteId={currentSiteId}
          templates={templates}
          onCreateDeployment={createDeployment}
          onCreateTemplate={createTemplate}
          onUpdateTemplate={updateTemplate}
          onDeleteTemplate={deleteTemplate}
        />

        <UninstallDialog
          open={uninstallDialogOpen}
          onOpenChange={setUninstallDialogOpen}
          siteId={currentSiteId}
          onCreateUninstall={handleCreateUninstall}
          initialSoftwareName={initialSoftwareName}
          deploymentId={uninstallDeploymentId}
        />

        <ConfirmDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          title="delete deployment record"
          description={`are you sure you want to delete this deployment record?\n\nthis will permanently remove the deployment from the list. this action cannot be undone.\n\nnote: this only deletes the record - it does not uninstall software from machines.`}
          confirmText="delete"
          cancelText="cancel"
          onConfirm={handleDeleteDeployment}
          variant="destructive"
        />

        {(() => {
          // A site-less account has a settled, knowable answer — zero — so
          // show it rather than a permanent '--' placeholder.
          const statsLoading =
            !hasNoSites && (deploymentsLoading || templatesLoading || !currentSiteId);
          const inProgressCount = deployments.filter(d => d.status === 'in_progress').length;
          return (
        <div className="mt-3 md:mt-2 mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          {/* Heading + inline stats wrap at narrow widths so the cluster can
              never push the document past the viewport (same shape as the
              dashboard's quick-stats row). */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 sm:gap-x-6 md:gap-8">
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">deployments</h1>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-3 sm:gap-x-6 md:gap-8">
              <div className="flex items-center gap-2.5">
                <div className={`rounded-md p-1.5 ${!statsLoading && deployments.length > 0 ? 'bg-accent-cyan/10 text-accent-cyan' : 'bg-muted text-muted-foreground'}`}>
                  <Package className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className="text-xl font-bold text-foreground">{statsLoading ? '--' : deployments.length}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">total</p>
                </div>
              </div>

              <div className="h-8 w-px bg-border" />

              <div className="flex items-center gap-2.5">
                <div className={`rounded-md p-1.5 ${!statsLoading && inProgressCount > 0 ? 'bg-accent-cyan/10 text-accent-cyan' : 'bg-muted text-muted-foreground'}`}>
                  <PlayCircle className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className={`text-xl font-bold ${!statsLoading && inProgressCount > 0 ? 'text-accent-cyan' : 'text-foreground'}`}>{statsLoading ? '--' : inProgressCount}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">in progress</p>
                </div>
              </div>

              <div className="h-8 w-px bg-border" />

              <div className="flex items-center gap-2.5">
                <div className="rounded-md p-1.5 bg-muted text-muted-foreground">
                  <Archive className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className="text-xl font-bold text-foreground">{statsLoading ? '--' : templates.length}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">templates</p>
                </div>
              </div>
            </div>
          </div>

          {/* Wraps too: with an update pending, `update owlette to vX` sits
              beside `new deployment` and the pair is wider than a phone. */}
          <div className="flex flex-wrap items-center gap-2 flex-shrink-0">
            <UpdateOwletteButton siteId={currentSiteId} machines={machines} />
            <Button
              onClick={() => setDeployDialogOpen(true)}
              className="cursor-pointer"
            >
              <Plus className="h-4 w-4 mr-2" />
              new deployment
            </Button>
          </div>
        </div>
          );
        })()}

        <div className="rounded-lg border border-border bg-card overflow-hidden animate-in fade-in duration-300">
          {/* `hasNoSites` first: it is terminal and only true once the site
              list has settled. Folding it into the loading condition below
              (via a bare `!currentSiteId`) is what left a site-less account
              on a permanent "loading deployments..." spinner. */}
          {hasNoSites ? (
            <div className="p-8">
              <NoSitesEmptyState action="manage deployments" />
            </div>
          ) : deploymentsLoading || sitesLoading || !currentSiteId ? (
            <div className="p-8 text-center">
              <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
              <p className="mt-2 text-muted-foreground">loading deployments...</p>
            </div>
          ) : deployments.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-foreground font-medium mb-1">no deployments yet</p>
              <p className="text-sm text-muted-foreground mb-4">create your first deployment to install software across your machines</p>
              <Button
                onClick={() => setDeployDialogOpen(true)}
                className="cursor-pointer"
                size="sm"
              >
                <Plus className="h-4 w-4 mr-1" />
                new deployment
              </Button>
            </div>
          ) : (
            <div className="cascade-rows divide-y divide-border">
              {deployments.map((deployment) => (
                <DeploymentRow
                  key={deployment.id}
                  deployment={deployment}
                  isSelected={selectedDeploymentId === deployment.id}
                  onToggle={handleToggleDeployment}
                  onRetry={handleRetryDeployment}
                  onRetryTarget={handleRetryTarget}
                  retrying={retrying}
                  onUninstall={handleUninstallFromRow}
                  onDelete={handleDeleteFromRow}
                  onCancel={handleCancelTarget}
                  timeDisplayMode={userPreferences.timeDisplayMode || 'machine'}
                  userTz={userPreferences.timezone}
                  siteTz={siteTimezone}
                  timeFormat={userPreferences.timeFormat || '12h'}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      <AccountSettingsDialog
        open={accountSettingsOpen}
        onOpenChange={setAccountSettingsOpen}
      />
    </PageCascade>
    </TooltipProvider>
  );
}
