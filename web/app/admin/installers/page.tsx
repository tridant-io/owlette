'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useInstallerManagement } from '@/hooks/useInstallerManagement';
import type { FirestoreTs } from '@/hooks/useFirestore';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Package, Plus, Loader2, Download, Trash2, CheckCircle, Copy, Sparkles, Paintbrush } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import UploadInstallerDialog from '@/components/admin/UploadInstallerDialog';
import { formatFileSize } from '@/lib/storageUtils';
import { INSTALLER_PLATFORMS, PLATFORM_LABEL } from '@/lib/installerPlatform';

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
    <p ref={ref} className="text-sm text-muted-foreground line-clamp-2 cursor-default">
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

export default function InstallerVersionsPage() {
  const {
    versions,
    latestVersion,
    loading,
    error,
    uploadVersion,
    setAsLatest,
    deleteVersion,
    getCleanupCandidates,
    cleanupVersions,
  } = useInstallerManagement();
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [deletingVersion, setDeletingVersion] = useState<string | null>(null);
  const [settingLatest, setSettingLatest] = useState<string | null>(null);
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
    <div className="p-8">
      <div className="max-w-screen-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-foreground mb-2">installers</h1>
          <p className="text-muted-foreground">manage owlette Agent installer versions and downloads</p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            onClick={() => setCleanupDialogOpen(true)}
            variant="outline"
            className="border-border bg-background text-foreground hover:bg-muted! hover:text-foreground! cursor-pointer"
            disabled={versions.length < 2}
          >
            <Paintbrush className="h-4 w-4 mr-2" />
            clean up
          </Button>
          <Button
            onClick={() => setUploadDialogOpen(true)}
            className="text-gray-900 cursor-pointer"
          >
            <Plus className="h-4 w-4 mr-2" />
            upload new version
          </Button>
        </div>
      </div>

      {/* Stats Card */}
      {latestVersion && (
        <div className="bg-card border border-border rounded-lg p-6 mb-8">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-green-600 rounded-lg">
              <Package className="h-6 w-6 text-white" />
            </div>
            <div className="flex-1">
              <p className="text-sm text-muted-foreground">current latest version</p>
              <div className="flex items-center gap-2 mt-1">
                <p className="text-2xl font-bold text-foreground">{latestVersion.version}</p>
                <Badge className="bg-green-600">Latest</Badge>
              </div>
            </div>
            <div className="text-right">
              <p className="text-sm text-muted-foreground">uploaded</p>
              <p className="text-lg text-foreground font-medium">
                {formatDate(latestVersion.release_date)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm text-muted-foreground">file size</p>
              <p className="text-lg text-foreground font-medium">
                {formatFileSize(latestVersion.file_size)}
              </p>
            </div>
            <div className="flex gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={() => window.open(latestVersion.download_url, '_blank')}
                    variant="outline"
                    size="icon"
                    className="border-border bg-background text-foreground hover:bg-muted! hover:text-foreground! cursor-pointer"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>download installer</p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={() => copyDownloadLink(latestVersion.download_url, latestVersion.version)}
                    variant="outline"
                    size="icon"
                    className="border-border bg-background text-foreground hover:bg-muted! hover:text-foreground! cursor-pointer"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>copy download link</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 mb-6">
          <p className="text-red-300">{error}</p>
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
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-background/50">
                <th className="text-left p-4 text-sm font-medium text-foreground">version</th>
                <th className="text-left p-4 text-sm font-medium text-foreground">file size</th>
                <th className="text-left p-4 text-sm font-medium text-foreground">uploaded</th>
                <th className="text-left p-4 text-sm font-medium text-foreground">uploaded by</th>
                <th className="text-left p-4 text-sm font-medium text-foreground">release notes</th>
                <th className="text-right p-4 text-sm font-medium text-foreground">actions</th>
              </tr>
            </thead>
            {versions.length === 0 ? (
              <tbody>
                <tr>
                  <td colSpan={6} className="p-8 text-center text-muted-foreground">
                    No versions uploaded yet. Click &quot;upload new version&quot; to get started.
                  </td>
                </tr>
              </tbody>
            ) : (
              versions.map((version) => {
                const isLatest = latestVersion?.version === version.version;
                const isDeleting = deletingVersion === version.version;
                const isSetting = settingLatest === version.version;

                // one row group per version: the version row, then one file row per platform
                return (
                  <tbody key={version.id}>
                    <tr className="hover:bg-muted/50 transition-colors">
                      {/* Version */}
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <span className="text-foreground font-medium">{version.version}</span>
                          {isLatest && (
                            <Badge className="bg-green-600 flex items-center gap-1">
                              <CheckCircle className="h-3 w-3" />
                              Latest
                            </Badge>
                          )}
                        </div>
                      </td>

                      {/* File Size */}
                      <td className="p-4 text-muted-foreground">
                        {formatFileSize(version.file_size)}
                      </td>

                      {/* Upload Date */}
                      <td className="p-4 text-muted-foreground text-sm">
                        {formatDate(version.release_date)}
                      </td>

                      {/* Uploaded By */}
                      <td className="p-4 text-muted-foreground text-sm">
                        {version.uploaded_by}
                      </td>

                      {/* Release Notes */}
                      <td className="p-4">
                        {version.release_notes ? (
                          <TruncatedReleaseNotes text={version.release_notes} />
                        ) : (
                          <span className="text-xs text-muted-foreground/60">no notes</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="p-4">
                        <div className="flex items-center justify-between gap-2">
                          {/* Left side: Set as Latest button (or empty space) */}
                          <div className="min-w-[100px]">
                            {!isLatest && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleSetAsLatest(version.version)}
                                disabled={isSetting || isDeleting}
                                className="text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer text-sm"
                              >
                                {isSetting ? (
                                  <>
                                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                    setting...
                                  </>
                                ) : (
                                  <>
                                    <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                                    set as latest (all platforms)
                                  </>
                                )}
                              </Button>
                            )}
                          </div>

                          {/* Right side: Icon buttons (always aligned) */}
                          <div className="flex items-center gap-2">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => window.open(version.download_url, '_blank')}
                                  className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
                                >
                                  <Download className="h-3.5 w-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>download installer</p>
                              </TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => copyDownloadLink(version.download_url, version.version)}
                                  className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>copy download link</p>
                              </TooltipContent>
                            </Tooltip>
                            {!isLatest ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDelete(version.version)}
                                disabled={isDeleting || isSetting}
                                className="h-8 w-8 text-red-400 hover:text-red-300 hover:bg-red-950/30 cursor-pointer"
                              >
                                {isDeleting ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            ) : (
                              <div className="w-[36px]" />
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>

                    {INSTALLER_PLATFORMS.map((platform) => {
                      const file = version.files[platform];
                      return (
                        <tr
                          key={platform}
                          data-platform={platform}
                          className="bg-background/30 text-sm text-muted-foreground last:border-b last:border-border"
                        >
                          <td className="py-2 pl-10 pr-4">{PLATFORM_LABEL[platform]}</td>
                          <td className="py-2 px-4">
                            {file?.file_size != null ? formatFileSize(file.file_size) : '—'}
                          </td>
                          <td colSpan={3} className="py-2 px-4">
                            {file?.checksum_sha256 ? (
                              <code className="text-xs" title={file.checksum_sha256}>
                                sha256 {file.checksum_sha256.slice(0, 12)}
                              </code>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="py-2 px-4 text-right">
                            {file ? (
                              <a
                                href={file.download_url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1.5 hover:text-foreground"
                              >
                                <Download className="h-3.5 w-3.5" />
                                download
                              </a>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                );
              })
            )}
          </table>
        </div>
      )}

      {/* Info Box */}
      {!loading && !error && versions.length > 0 && (
        <div className="mt-6 bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg p-4">
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
        <DialogContent className="border-border bg-card text-foreground">
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
              className="text-gray-900 cursor-pointer"
            >
              OK
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="border-border bg-card text-foreground">
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
              onClick={confirmDelete}
              className="bg-red-600 hover:bg-red-700 text-foreground cursor-pointer"
            >
              delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cleanup Dialog */}
      <Dialog open={cleanupDialogOpen} onOpenChange={(open) => { if (!cleaningUp) setCleanupDialogOpen(open); }}>
        <DialogContent className="border-border bg-card text-foreground sm:max-w-lg">
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
              <div className="bg-green-900/20 border border-green-700/30 rounded-lg p-4">
                <p className="text-green-400 text-sm">Nothing to clean up — all versions are either the latest patch in their series or within the retention window.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="bg-red-900/20 border border-red-700/30 rounded-lg p-4">
                  <p className="text-red-400 text-sm font-medium mb-2">
                    {cleanupCandidates.length} version{cleanupCandidates.length !== 1 ? 's' : ''} will
                    be permanently deleted ({formatFileSize(totalCleanupSize)}):
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {cleanupCandidates.map((v) => (
                      <Badge
                        key={v.version}
                        variant="outline"
                        className="border-red-700/50 text-red-400 text-xs"
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
              onClick={handleCleanup}
              disabled={cleanupCandidates.length === 0 || cleaningUp}
              className="bg-red-600 hover:bg-red-700 text-foreground cursor-pointer"
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
