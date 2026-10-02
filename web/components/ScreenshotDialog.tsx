'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Camera, Loader2, AlertTriangle, Download, ClipboardCopy, Check, Maximize2, X as XIcon, PanelLeftClose, PanelLeftOpen, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { ImageLightbox } from '@/components/ImageLightbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { formatRelativeTime } from '@/lib/timeUtils';
import { useAuth } from '@/contexts/AuthContext';
import { useScreenshotHistory, ScreenshotRecord } from '@/hooks/useScreenshotHistory';
import type { FirestoreTs } from '@/hooks/useFirestore';
import { TimezoneChip } from '@/components/TimezoneChip';
import { toast } from '@/lib/toast';

interface ScreenshotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machineId: string;
  machineName: string;
  /** IANA timezone for this machine — used by the history sidebar chip to
   * tell the user which timezone the captured screenshots' timestamps refer to. */
  machineTimezone?: string;
  siteId: string;
  isOnline: boolean;
  onCaptureScreenshot: () => Promise<void>;
  lastScreenshot?: {
    url: string;
    timestamp: FirestoreTs;
    sizeKB: number;
  };
  hasActiveDeployment?: boolean;
}

export function ScreenshotDialog({
  open,
  onOpenChange,
  machineId,
  machineName,
  machineTimezone,
  siteId,
  isOnline,
  onCaptureScreenshot,
  lastScreenshot: initialScreenshot,
  hasActiveDeployment,
}: ScreenshotDialogProps) {
  const { userPreferences } = useAuth();
  const [isCapturing, setIsCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState(initialScreenshot);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showHistory, setShowHistory] = useState(true);
  const [selectedHistorical, setSelectedHistorical] = useState<ScreenshotRecord | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const captureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const { screenshots: historyScreenshots, loading: historyLoading } = useScreenshotHistory(
    siteId, machineId, open
  );

  const displayedScreenshot = selectedHistorical || screenshot;

  // Listen for screenshot updates in real-time
  useEffect(() => {
    if (!open || !db || !siteId || !machineId) return;

    const machineRef = doc(db, 'sites', siteId, 'machines', machineId);
    const unsubscribe = onSnapshot(machineRef, (snapshot) => {
      const data = snapshot.data();
      if (data?.lastScreenshot?.url) {
        setScreenshot((prev) => {
          if (!prev || data.lastScreenshot.timestamp !== prev.timestamp) {
            if (captureTimeoutRef.current) {
              clearTimeout(captureTimeoutRef.current);
              captureTimeoutRef.current = null;
            }
            setIsCapturing(false);
            setError(null);
            // New capture arrived — deselect historical so latest is shown + highlighted
            setSelectedHistorical(null);
          }
          return data.lastScreenshot;
        });
      }
    });

    return () => {
      unsubscribe();
      if (captureTimeoutRef.current) {
        clearTimeout(captureTimeoutRef.current);
        captureTimeoutRef.current = null;
      }
    };
  }, [open, siteId, machineId]);

  useEffect(() => {
    if (open && initialScreenshot) {
      setScreenshot(initialScreenshot);
    }
    if (open) {
      setSelectedHistorical(null);
    }
  }, [open, initialScreenshot]);

  const handleCapture = useCallback(async () => {
    setIsCapturing(true);
    setError(null);
    setSelectedHistorical(null);

    try {
      await onCaptureScreenshot();

      if (captureTimeoutRef.current) clearTimeout(captureTimeoutRef.current);
      captureTimeoutRef.current = setTimeout(() => {
        captureTimeoutRef.current = null;
        setIsCapturing(false);
        setError(
          hasActiveDeployment
            ? 'Screenshot timed out — a software deployment is in progress on this machine. The agent cannot process other commands until the installation completes.'
            : 'Screenshot timed out — the machine may be offline or running headless with no active user session.'
        );
      }, 20000);
    } catch (err: unknown) {
      setIsCapturing(false);
      const message = err instanceof Error ? err.message : String(err);
      setError(message || 'Failed to send screenshot command');
    }
  }, [onCaptureScreenshot, hasActiveDeployment]);

  const handleDownload = useCallback(async () => {
    if (!displayedScreenshot?.url) return;
    try {
      const response = await fetch(displayedScreenshot.url);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const ts = displayedScreenshot.timestamp as { toDate?: () => Date } | number | string | Date | null | undefined;
      const tsDate = ts && typeof (ts as { toDate?: () => Date }).toDate === 'function'
        ? (ts as { toDate: () => Date }).toDate()
        : new Date(ts as number | string | Date);
      a.download = `${machineName}-screenshot-${tsDate.toISOString().replace(/[:.]/g, '-')}.jpg`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      window.open(displayedScreenshot.url, '_blank');
    }
  }, [displayedScreenshot, machineName]);

  const handleCopy = useCallback(async () => {
    if (!displayedScreenshot?.url) return;
    try {
      const response = await fetch(displayedScreenshot.url);
      const blob = await response.blob();
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const loaded = new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to load image'));
      });
      img.src = URL.createObjectURL(blob);
      await loaded;
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      URL.revokeObjectURL(img.src);
      const pngBlob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Canvas export failed'))), 'image/png')
      );
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not supported or failed
    }
  }, [displayedScreenshot]);

  const handleDeleteScreenshot = useCallback(async (screenshotId: string) => {
    setDeletingId(screenshotId);
    try {
      const res = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/screenshots?screenshotId=${encodeURIComponent(screenshotId)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete');
      }
      // If we were viewing the deleted screenshot, go back to latest
      if (selectedHistorical?.id === screenshotId) {
        setSelectedHistorical(null);
      }
      toast.success('Screenshot deleted');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('Failed to delete screenshot', { description: message });
    } finally {
      setDeletingId(null);
    }
  }, [siteId, machineId, selectedHistorical]);

  const handleClearAll = useCallback(async () => {
    setClearingAll(true);
    try {
      const res = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/screenshots`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to clear');
      }
      const data = await res.json();
      setSelectedHistorical(null);
      setScreenshot(undefined);
      toast.success(`Cleared ${data.deleted} screenshot${data.deleted === 1 ? '' : 's'}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('Failed to clear history', { description: message });
    } finally {
      setClearingAll(false);
    }
  }, [siteId, machineId]);

  // Auto-capture on first open if no existing screenshot
  useEffect(() => {
    if (open && !screenshot && isOnline && !isCapturing) {
      handleCapture();
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const formatTimestamp = (ts: FirestoreTs) => {
    const t = ts as { toDate?: () => Date } | null | undefined;
    const d = t && typeof t.toDate === 'function'
      ? t.toDate()
      : new Date(ts as string | number | Date);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: (userPreferences.timeFormat || '12h') === '12h',
    });
  };

  return (
    <>
    {displayedScreenshot && (
      <ImageLightbox
        src={fullscreen ? displayedScreenshot.url : null}
        alt={`screenshot of ${machineName}`}
        onClose={() => setFullscreen(false)}
      />
    )}
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        // the first tabbable control carries a tooltip, and radix's default focus would
        // open it: that tooltip then takes the first escape press instead of the dialog
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          closeButtonRef.current?.focus();
        }}
        className="bg-card border-border w-[calc(100vw-2rem)] sm:max-w-none max-w-none p-0 gap-0 h-[calc(100dvh-4rem)]"
      >
        {/* below md the history stacks under the screenshot, so the image keeps the
            dialog's full width; from md it is a sidebar on the left */}
        <div className="flex h-full flex-col overflow-hidden md:flex-row">

          {/* Main content — screenshot display */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            {/* Header */}
            <DialogHeader className="px-4 py-2 border-b border-border flex-shrink-0">
              <DialogTitle className="flex items-center gap-2">
                {!showHistory && (
                  <IconButton
                    label="show history"
                    variant="ghost"
                    className="size-7 text-muted-foreground"
                    onClick={() => setShowHistory(true)}
                  >
                    <PanelLeftOpen className="h-4 w-4" />
                  </IconButton>
                )}
                <Camera className="h-5 w-5 shrink-0" />
                <span className="truncate">screenshot — {machineName}</span>
                {selectedHistorical && (
                  <span className="hidden text-xs font-normal text-muted-foreground ml-2 sm:inline">
                    (viewing {formatTimestamp(selectedHistorical.timestamp)})
                  </span>
                )}
                {/* no tooltip: this takes focus on open (see onOpenAutoFocus) */}
                <IconButton
                  ref={closeButtonRef}
                  label="close"
                  tooltip={false}
                  variant="ghost"
                  className="size-7 text-muted-foreground ml-auto"
                  onClick={() => onOpenChange(false)}
                >
                  <XIcon className="h-4 w-4" />
                </IconButton>
              </DialogTitle>
            </DialogHeader>

            {/* Screenshot display */}
            <div className="flex-1 relative bg-black/30 flex items-center justify-center overflow-hidden min-h-0">
              {isCapturing && (
                <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                  <Loader2 className="h-8 w-8 animate-spin" />
                  <p>capturing screenshot...</p>
                </div>
              )}

              {!isCapturing && error && (
                <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                  <AlertTriangle className="h-8 w-8 text-amber-400" />
                  <p className="text-sm text-center max-w-md">{error}</p>
                </div>
              )}

              {!isCapturing && !error && !displayedScreenshot && (
                <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                  <Camera className="h-8 w-8" />
                  <p>no screenshot available</p>
                </div>
              )}

              {displayedScreenshot && !isCapturing && (
                // eslint-disable-next-line @next/next/no-img-element -- signed storage url, not a static asset
                <img
                  src={displayedScreenshot.url}
                  alt={`screenshot of ${machineName}`}
                  className="absolute inset-0 w-full h-full object-contain cursor-pointer"
                  onClick={() => setFullscreen(true)}
                />
              )}
            </div>

            {/* Footer — info + action buttons */}
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-t border-border flex-shrink-0">
              <div className="min-w-0 text-xs text-muted-foreground">
                {displayedScreenshot && (
                  <>
                    captured {formatTimestamp(displayedScreenshot.timestamp)} ({displayedScreenshot.sizeKB}KB)
                  </>
                )}
                <span className="ml-2 text-muted-foreground/80">
                  screenshots may contain sensitive content
                </span>
              </div>
              <div className="flex items-center gap-1">
                {displayedScreenshot && (
                  <>
                    <IconButton
                      label="download screenshot"
                      variant="ghost"
                      size="icon-sm"
                      onClick={handleDownload}
                    >
                      <Download className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      label={copied ? 'copied' : 'copy to clipboard'}
                      variant="ghost"
                      size="icon-sm"
                      onClick={handleCopy}
                    >
                      {copied ? <Check className="h-4 w-4 text-green-500" /> : <ClipboardCopy className="h-4 w-4" />}
                    </IconButton>
                    <IconButton
                      label="fullscreen"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setFullscreen(true)}
                    >
                      <Maximize2 className="h-4 w-4" />
                    </IconButton>
                  </>
                )}
                {!showHistory && !isCapturing && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCapture}
                    disabled={isCapturing || !isOnline}
                    className="bg-secondary border-border hover:bg-accent ml-1"
                  >
                    <Camera className="h-4 w-4 mr-2" />
                    capture
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Collapsible history — after the screenshot in the DOM, so focus order
              matches the phone layout; md:order-first puts it on the left from md */}
          {showHistory && (
            <div className="max-h-[40%] flex flex-col border-t border-border md:order-first md:max-h-none md:w-52 md:flex-shrink-0 md:border-t-0 md:border-r">
              <div className="px-3 py-2 border-b border-border flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">history</span>
                  <div className="flex items-center gap-1">
                    {historyScreenshots.length > 0 && (
                      <IconButton
                        label="clear history"
                        variant="ghost-destructive"
                        className="size-6"
                        onClick={() => setConfirmClearAll(true)}
                        disabled={clearingAll}
                      >
                        {clearingAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                      </IconButton>
                    )}
                    <IconButton
                      label="hide history"
                      variant="ghost"
                      className="size-6 text-muted-foreground"
                      onClick={() => setShowHistory(false)}
                    >
                      <PanelLeftClose className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                </div>
                <TimezoneChip tz={machineTimezone} source="machine" prefix="captured in" />
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                {historyLoading ? (
                  <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    loading...
                  </div>
                ) : historyScreenshots.length === 0 ? (
                  <p className="text-xs text-muted-foreground p-3">no history yet</p>
                ) : (
                  <div className="py-1">
                    {historyScreenshots.map((hs, index) => {
                      const isSelected = selectedHistorical?.id === hs.id;
                      const isLatest = !selectedHistorical && index === 0;
                      const isDeleting = deletingId === hs.id;
                      return (
                        <div
                          key={hs.id}
                          className={`group flex items-center transition-colors ${
                            isSelected || isLatest
                              ? 'bg-primary/10 border-l-2 border-primary'
                              : 'border-l-2 border-transparent hover:bg-muted/50'
                          }`}
                        >
                          <button
                            className={`flex-1 text-left px-3 py-2 text-xs min-w-0 ${
                              isSelected || isLatest ? 'text-primary' : 'text-muted-foreground'
                            }`}
                            aria-current={isSelected || isLatest || undefined}
                            onClick={() => setSelectedHistorical(isLatest ? null : hs)}
                          >
                            <div className="font-medium truncate">{formatTimestamp(hs.timestamp)}</div>
                            <div className="text-[10px] mt-0.5">
                              {formatRelativeTime((hs.timestamp as { seconds?: number } | null | undefined)?.seconds ?? Math.floor((typeof hs.timestamp === 'number' ? hs.timestamp : 0) / 1000))} · {hs.sizeKB}KB
                            </div>
                          </button>
                          {/* hover-revealed for a mouse; always shown to touch, which has
                              no hover, and to keyboard focus */}
                          <IconButton
                            label="delete screenshot"
                            variant="ghost-destructive"
                            className="size-7 mr-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                            onClick={(e) => { e.stopPropagation(); handleDeleteScreenshot(hs.id); }}
                            disabled={isDeleting}
                          >
                            {isDeleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          </IconButton>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              {/* Capture button at bottom of sidebar */}
              <div className="p-2 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCapture}
                  disabled={isCapturing || !isOnline}
                  className="w-full bg-secondary border-border hover:bg-accent"
                >
                  {isCapturing ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Camera className="h-4 w-4 mr-2" />
                  )}
                  {isCapturing ? 'capturing...' : 'capture'}
                </Button>
              </div>
            </div>
          )}

        </div>
      </DialogContent>
    </Dialog>

    {/* Clear all confirmation dialog */}
    <Dialog open={confirmClearAll} onOpenChange={setConfirmClearAll}>
      <DialogContent className="bg-card border-border sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>clear screenshot history?</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            this will permanently delete {historyScreenshots.length} screenshot{historyScreenshots.length === 1 ? '' : 's'} from storage.
            this action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setConfirmClearAll(false)}
            className="bg-secondary border border-border cursor-pointer"
          >
            cancel
          </Button>
          <Button
            onClick={async () => {
              setConfirmClearAll(false);
              await handleClearAll();
            }}
            disabled={clearingAll}
            variant="destructive"
          >
            {clearingAll ? 'clearing...' : 'clear all'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
