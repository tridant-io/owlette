'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useInstallerManagement } from '@/hooks/useInstallerManagement';
import type { TridantReleaseState } from '@/lib/tridantRelease.server';
import type { FirestoreTs } from '@/hooks/useFirestore';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Package, Plus, Loader2, Download, Trash2, CheckCircle, Copy, Sparkles, Paintbrush } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import UploadInstallerDialog from '@/components/admin/UploadInstallerDialog';
import { AdminPageHeader } from '@/components/admin/AdminPageHeader';
import { CompactButton } from '@/components/admin/CompactButton';
import { formatFileSize } from '@/lib/storageUtils';
import { INSTALLER_PLATFORMS, PLATFORM_LABEL, type InstallerFile, type InstallerPlatform } from '@/lib/installerPlatform';
import { cn } from '@/lib/utils';

/**
 * Installers Admin Page
 *
 * Admin-only page for managing owlette Agent installer versions.
 * Allows admins to:
 * - View all versions
 * - Upload new versions
 * - Set version as latest
 * - Delete old versions
 */
function TruncatedReleaseNotes({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  const checkTruncation = useCallback(() => {
    const el = ref.current;
    if (el) setIsTruncated(el.scrollHeight > el.clientHeight);
  }, []);

  useEffect(() => {
    checkTruncation();
    window.addEventListener('resize', checkTruncation);
    return () => window.removeEventListener('resize', checkTruncation);
  }, [checkTruncation]);

  const content = (
    // focusable once clamped, so a keyboard user can open the tooltip with the rest
    <p ref={ref} tabIndex={isTruncated ? 0 : undefined} className="text-sm text-muted-foreground line-clamp-2 cursor-default">
      {text}
    </p>
  );

  if (!isTruncated) return content;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm whitespace-pre-wrap">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** one platform's installer in a release: size and checksum, with download and copy-link */
function PlatformFile({
  platform,
  file,
  version,
  onCopyLink,
}: {
  platform: InstallerPlatform;
  file: InstallerFile | undefined;
  version: string;
  onCopyLink: (url: string, what: string) => void;
}) {
  const label = PLATFORM_LABEL[platform];
  return (
    <div
      data-platform={platform}
      className={cn(
        'flex items-center justify-between gap-3 min-w-0 rounded-md border px-3 py-2',
        file ? 'border-border bg-card-sunken' : 'border-dashed border-border',
      )}
    >
      <div className="min-w-0">
        <p className="text-sm text-foreground truncate">{label}</p>
        {file ? (
          <p className="text-xs text-muted-foreground tabular-nums truncate">
            {file.file_size != null ? formatFileSize(file.file_size) : 'size unknown'}
            {file.checksum_sha256 && (
              <code className="ml-2" title={file.checksum_sha256}>
                sha256 {file.checksum_sha256.slice(0, 12)}
              </code>
            )}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">not uploaded</p>
        )}
      </div>
      {file && (
        <div className="flex items-center gap-1 shrink-0">
          <IconButton asChild label={`download ${label}`} variant="ghost" size="icon-sm" className="text-muted-foreground">
            <a href={file.download_url} target="_blank" rel="noreferrer">
              <Download className="h-3.5 w-3.5" />
            </a>
          </IconButton>
          <IconButton
            label={`copy ${label} download link`}
            variant="ghost"
            size="icon-sm"
            onClick={() => onCopyLink(file.download_url, `${label} ${version}`)}
            className="text-muted-foreground"
          >
            <Copy className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      )}
    </div>
  );
}

/** where the version stands on tridant id; a failure offers the retry */
function TridantStatus({
  state,
  busy,
  onRegister,
}: {
  state: TridantReleaseState | null;
  busy: boolean;
  onRegister: () => void;
}) {
  if (!state) return null;
  if (state.status !== 'failed') {
    return <p className="text-xs text-muted-foreground">tridant id: {state.status}</p>;
  }
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-danger max-w-[16rem] truncate" title={state.error ?? undefined}>
        tridant id: failed{state.error ? ` (${state.error})` : ''}
      </span>
      <Button variant="link" size="sm" onClick={onRegister} disabled={busy} className="h-auto p-0 text-xs">
        {busy ? 'registering...' : 'register again'}
      </Button>
    </div>
  );
}

export default function InstallerVersionsPage() {
  const {
    versions,
    latestVersion,
    loading,
    error,
    uploadVersion,
    setAsLatest,
    deleteVersion,
    registerVersion,
    getCleanupCandidates,
    cleanupVersions,
  } = useInstallerManagement();
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [deletingVersion, setDeletingVersion] = useState<string | null>(null);
  const [settingLatest, setSettingLatest] = useState<string | null>(null);
  const [registering, setRegistering] = useState<string | null>(null);
  const [setLatestDialogOpen, setSetLatestDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [versionToSetLatest, setVersionToSetLatest] = useState<string>('');
  const [versionToDelete, setVersionToDelete] = useState<string>('');
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [cleanupRetentionDays, setCleanupRetentionDays] = useState(30);

  const handleSetAsLatest = (version: string) => {
    if (latestVersion?.version === version) {
      toast.info('Already Latest', {
        description: 'This version is already set as latest.',
      });
      return;
    }

    setVersionToSetLatest(version);
    setSetLatestDialogOpen(true);
  };

  const confirmSetAsLatest = async () => {
    setSettingLatest(versionToSetLatest);
    setSetLatestDialogOpen(false);

    try {
      await setAsLatest(versionToSetLatest);
      toast.success('Latest Version Updated', {
        description: `Version ${versionToSetLatest} is now the latest.`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('Update Failed', {
        description: message || 'Failed to update latest version.',
      });
    } finally {
      setSettingLatest(null);
      setVersionToSetLatest('');
    }
  };

  const handleRegister = async (version: string) => {
    setRegistering(version);
    try {
      const result = await registerVersion(version);
      if (result.status === 'registered' || result.status === 'yanked') {
        toast.success(`${version} is ${result.status} on tridant id`);
      } else if (result.status === 'not_configured') {
        toast.info('tridant id is not configured on this server');
      } else if (result.status === 'skipped') {
        toast.info(`nothing to register: ${version} has no file on the download host`);
      } else {
        toast.error('registration failed', { description: result.error ?? undefined });
      }
    } catch (err: unknown) {
      toast.error('registration failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRegistering(null);
    }
  };

  const handleDelete = (version: string) => {
    if (latestVersion?.version === version) {
      toast.error('Cannot Delete', {
        description: 'Cannot delete the current latest version. Set a different version as latest first.',
      });
      return;
    }

    setVersionToDelete(version);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    setDeletingVersion(versionToDelete);
    setDeleteDialogOpen(false);

    try {
      await deleteVersion(versionToDelete);
      toast.success('Version Deleted', {
        description: `Version ${versionToDelete} has been deleted.`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('Delete Failed', {
        description: message || 'Failed to delete version.',
      });
    } finally {
      setDeletingVersion(null);
      setVersionToDelete('');
    }
  };

  const formatDate = (timestamp: FirestoreTs) => {
    if (!timestamp) return 'N/A';
    const t = timestamp as { toDate?: () => Date } | null | undefined;
    const date = t && typeof t.toDate === 'function'
      ? t.toDate()
      : new Date(timestamp as number | string | Date);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const cleanupCandidates = cleanupDialogOpen ? getCleanupCandidates(cleanupRetentionDays) : [];

  const handleCleanup = async () => {
    setCleaningUp(true);
    try {
      const count = await cleanupVersions(cleanupCandidates);
      toast.success('Cleanup Complete', {
        description: `Deleted ${count} old installer${count !== 1 ? 's' : ''}.`,
      });
      setCleanupDialogOpen(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('Cleanup Failed', {
        description: message || 'Failed to clean up versions.',
      });
    } finally {
      setCleaningUp(false);
    }
  };

  const totalCleanupSize = cleanupCandidates.reduce((sum, v) => sum + (v.file_size || 0), 0);

  const copyDownloadLink = async (downloadUrl: string, version: string) => {
    try {
      await navigator.clipboard.writeText(downloadUrl);
      toast.success('Link Copied', {
        description: `Download link for version ${version} copied to clipboard.`,
      });
    } catch {
      toast.error('Copy Failed', {
        description: 'Failed to copy link to clipboard.',
      });
    }
  };

  return (
    <div className="p-4 sm:p-6 md:p-8">
      <div className="max-w-screen-2xl mx-auto">
        <AdminPageHeader
          className="mb-6 md:mb-8"
          title="installers"
          description="manage owlette Agent installer versions and downloads"
          actions={
            <>
              <CompactButton
                icon={Paintbrush}
                label="clean up"
                onClick={() => setCleanupDialogOpen(true)}
                variant="outline"
                className="border-border bg-background text-foreground hover:bg-muted! hover:text-foreground!"
                disabled={versions.length < 2}
              />
              <CompactButton icon={Plus} label="upload new version" onClick={() => setUploadDialogOpen(true)} />
            </>
          }
        />

      {/* Stats Card */}
      {latestVersion && (
        <div className="bg-card border border-border rounded-lg p-4 sm:p-6 mb-6 md:mb-8">
          {/* on a phone the upload date wraps under the version, in line with its text */}
          <div className="flex flex-wrap sm:flex-nowrap items-center gap-3">
            <div className="p-2 sm:p-3 bg-success-solid rounded-lg">
              <Package className="h-5 w-5 sm:h-6 sm:w-6 text-success-solid-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-muted-foreground">current latest version</p>
              <div className="flex items-center gap-2 mt-1">
                <p className="text-xl sm:text-2xl font-bold text-foreground">{latestVersion.version}</p>
                <Badge className="bg-success-solid text-success-solid-foreground">Latest</Badge>
              </div>
            </div>
            <div className="flex basis-full items-baseline gap-1.5 pl-12 sm:block sm:basis-auto sm:pl-0 sm:text-right">
              <p className="text-sm text-muted-foreground">uploaded</p>
              <p className="text-sm sm:text-lg text-foreground font-medium whitespace-nowrap">
                {formatDate(latestVersion.release_date)}
              </p>
            </div>
          </div>
          {/* the public link serves each visitor their own platform; these are every file */}
          <div className="mt-4 sm:mt-5 grid gap-2 sm:gap-3 md:grid-cols-3">
            {INSTALLER_PLATFORMS.map((platform) => (
              <PlatformFile
                key={platform}
                platform={platform}
                file={latestVersion.files[platform]}
                version={latestVersion.version}
                onCopyLink={copyDownloadLink}
              />
            ))}
          </div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="bg-danger-surface border border-danger-border rounded-lg p-4 mb-6">
          <p className="text-danger">{error}</p>
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="flex justify-center items-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-accent-cyan" />
          <span className="ml-3 text-muted-foreground">loading versions...</span>
        </div>
      )}

      {/* Versions Table */}
      {!loading && !error && (
        <div className="bg-card border border-border rounded-lg overflow-x-auto">
          {/* below md each version stacks into a block: version and actions, then the
              date, then the notes. from md the floor width keeps dates on one line; it
              fits the admin layout from a 1280 window up */}
          <table className="block w-full md:table md:min-w-[48rem]">
            <thead className="hidden md:table-header-group">
              <tr className="border-b border-border bg-background/50">
                <th className="text-left p-4 text-sm font-medium text-foreground">version</th>
                <th className="text-left p-4 text-sm font-medium text-foreground">uploaded</th>
                <th className="text-left p-4 text-sm font-medium text-foreground w-full">release notes</th>
                <th className="text-right p-4 text-sm font-medium text-foreground">actions</th>
              </tr>
            </thead>
            {versions.length === 0 ? (
              <tbody className="block md:table-row-group">
                <tr className="block md:table-row">
                  <td colSpan={4} className="block md:table-cell p-6 md:p-8 text-center text-muted-foreground">
                    No versions uploaded yet. Click &quot;upload new version&quot; to get started.
                  </td>
                </tr>
              </tbody>
            ) : (
              versions.map((version) => {
                const isLatest = latestVersion?.version === version.version;
                const isDeleting = deletingVersion === version.version;
                const isSetting = settingLatest === version.version;

                // one row group per version: the version row, then its platforms side by
                // side. a phone gets the version row alone: the latest card above carries
                // the platform files, and older builds are a desktop errand
                return (
                  <tbody key={version.id} className="block md:table-row-group border-b border-border last:border-b-0">
                    <tr className="flex flex-wrap items-center md:table-row">
                      <td className="order-1 flex-1 min-w-0 px-3 pt-3 pb-1 md:px-4 md:pt-4 md:pb-3 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <span className="text-foreground font-medium">{version.version}</span>
                          {isLatest && (
                            <Badge className="bg-success-solid text-success-solid-foreground flex items-center gap-1">
                              <CheckCircle className="h-3 w-3" />
                              Latest
                            </Badge>
                          )}
                        </div>
                        <TridantStatus
                          state={version.tridant}
                          busy={registering === version.version}
                          onRegister={() => void handleRegister(version.version)}
                        />
                      </td>

                      <td className="order-3 flex basis-full min-w-0 items-baseline gap-2 px-3 pb-1 md:table-cell md:px-4 md:pt-4 md:pb-3 whitespace-nowrap">
                        <p className="text-sm text-muted-foreground">{formatDate(version.release_date)}</p>
                        <p className="min-w-0 text-xs text-muted-foreground/80 max-w-[12rem] truncate" title={version.uploaded_by}>
                          by {version.uploaded_by}
                        </p>
                      </td>

                      <td className="order-4 basis-full px-3 pb-3 md:px-4 md:pt-4 md:min-w-[14rem]">
                        {version.release_notes ? (
                          <TruncatedReleaseNotes text={version.release_notes} />
                        ) : (
                          <span className="hidden md:inline text-xs text-muted-foreground/80">no notes</span>
                        )}
                      </td>

                      <td className="order-2 px-3 pt-3 pb-1 md:px-4 md:pt-4 md:pb-3">
                        {!isLatest && (
                          <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleSetAsLatest(version.version)}
                              disabled={isSetting || isDeleting}
                              className="text-muted-foreground hover:text-foreground cursor-pointer text-sm"
                            >
                              {isSetting ? (
                                <>
                                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                  setting...
                                </>
                              ) : (
                                <>
                                  <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                                  set as latest
                                </>
                              )}
                            </Button>
                            <IconButton
                              label={`delete ${version.version}`}
                              variant="ghost-destructive"
                              onClick={() => handleDelete(version.version)}
                              disabled={isDeleting || isSetting}
                              className="h-8 w-8 cursor-pointer"
                            >
                              {isDeleting ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                            </IconButton>
                          </div>
                        )}
                      </td>
                    </tr>
                    <tr className="hidden md:table-row">
                      <td colSpan={4} className="px-4 pb-4">
                        <div className="grid gap-2 md:grid-cols-3">
                          {INSTALLER_PLATFORMS.map((platform) => (
                            <PlatformFile
                              key={platform}
                              platform={platform}
                              file={version.files[platform]}
                              version={version.version}
                              onCopyLink={copyDownloadLink}
                            />
                          ))}
                        </div>
                      </td>
                    </tr>
                  </tbody>
                );
              })
            )}
          </table>
        </div>
      )}

      {/* Info Box */}
      {!loading && !error && versions.length > 0 && (
        <div className="mt-4 sm:mt-6 bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg p-3 sm:p-4">
          <p className="text-accent-cyan text-sm">
            <strong>Note:</strong> The &quot;Latest&quot; version is what users will download from the public
            download link. You can upload multiple versions and switch between them at any time.
            Old versions cannot be deleted if they are currently set as latest.
          </p>
        </div>
      )}

      {/* Upload Dialog */}
      <UploadInstallerDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        onUpload={uploadVersion}
      />

      {/* Set as Latest Confirmation Dialog */}
      <Dialog open={setLatestDialogOpen} onOpenChange={setSetLatestDialogOpen}>
        <DialogContent className="border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">set as latest version</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Set version {versionToSetLatest} as the latest version for all platforms?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setSetLatestDialogOpen(false)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={confirmSetAsLatest}
              className="cursor-pointer"
            >
              OK
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">delete version</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Are you sure you want to delete version {versionToDelete}? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteDialogOpen(false)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              className="cursor-pointer"
            >
              delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cleanup Dialog */}
      <Dialog open={cleanupDialogOpen} onOpenChange={(open) => { if (!cleaningUp) setCleanupDialogOpen(open); }}>
        <DialogContent className="border-border text-foreground sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-foreground">clean up old installers</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Remove superseded patch versions while keeping the latest patch per minor release,
              the current latest version, and anything uploaded within the retention window.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3">
              <Label htmlFor="retention-days" className="text-foreground whitespace-nowrap">
                Keep uploads from last
              </Label>
              <Input
                id="retention-days"
                type="number"
                min={0}
                max={365}
                value={cleanupRetentionDays}
                onChange={(e) => setCleanupRetentionDays(Math.max(0, parseInt(e.target.value) || 0))}
                className="w-20 border-border bg-background text-foreground"
              />
              <span className="text-muted-foreground text-sm">days</span>
            </div>

            {cleanupCandidates.length === 0 ? (
              <div className="bg-success-surface border border-success-border rounded-lg p-4">
                <p className="text-success text-sm">Nothing to clean up — all versions are either the latest patch in their series or within the retention window.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="bg-danger-surface border border-danger-border rounded-lg p-4">
                  <p className="text-danger text-sm font-medium mb-2">
                    {cleanupCandidates.length} version{cleanupCandidates.length !== 1 ? 's' : ''} will
                    be permanently deleted ({formatFileSize(totalCleanupSize)}):
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {cleanupCandidates.map((v) => (
                      <Badge
                        key={v.version}
                        variant="outline"
                        className="border-danger-border text-danger text-xs"
                      >
                        v{v.version}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCleanupDialogOpen(false)}
              disabled={cleaningUp}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleCleanup}
              disabled={cleanupCandidates.length === 0 || cleaningUp}
              className="cursor-pointer"
            >
              {cleaningUp ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                `delete ${cleanupCandidates.length} version${cleanupCandidates.length !== 1 ? 's' : ''}`
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
