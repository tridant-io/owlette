'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Eye, Loader2, Square, Play, Download, Maximize2, X as XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { ImageLightbox } from '@/components/ImageLightbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';

interface LiveViewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  machineId: string;
  machineName: string;
  onStartLiveView: (machineId: string, interval: number, duration: number) => Promise<void>;
  onStopLiveView: (machineId: string) => Promise<void>;
}

export function LiveViewModal({
  open,
  onOpenChange,
  siteId,
  machineId,
  machineName,
  onStartLiveView,
  onStopLiveView,
}: LiveViewModalProps) {
  const { userPreferences } = useAuth();
  const [interval, setInterval_] = useState(10);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [liveViewActive, setLiveViewActive] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<string>('');
  const [screenshot, setScreenshot] = useState<{ url: string; timestamp: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors of isStarting/isStopping so the once-per-open snapshot listener can
  // read pending state without re-subscribing.
  const isStartingRef = useRef(false);
  const isStoppingRef = useRef(false);

  const clearPendingTimeout = () => {
    if (pendingTimeoutRef.current) {
      clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current = null;
    }
  };

  // Machine doc updates (lastScreenshot + liveView), and the only correct place
  // to clear the start/stop spinners: sendMachineCommand returns in ~100ms, long
  // before the agent acts, so clearing in its finally block flickers the button
  // back to idle during the gap.
  useEffect(() => {
    if (!open || !db || !siteId || !machineId) return;

    const machineRef = doc(db, 'sites', siteId, 'machines', machineId);
    const unsubscribe = onSnapshot(machineRef, (snapshot) => {
      const data = snapshot.data();
      if (!data) return;

      if (data.lastScreenshot?.url) {
        // serverTimestamp arrives as a Timestamp — convert to ms.
        const ts = data.lastScreenshot.timestamp;
        const timestampMs =
          ts && typeof ts.toMillis === 'function'
            ? ts.toMillis()
            : typeof ts === 'number'
              ? ts
              : ts && typeof ts.seconds === 'number'
                ? ts.seconds * 1000
                : Date.now();
        setScreenshot({
          url: data.lastScreenshot.url,
          timestamp: timestampMs,
        });
      }

      const lv = data.liveView;
      const newActive = lv ? !!lv.active : false;
      setLiveViewActive(newActive);
      if (lv) {
        setExpiresAt(lv.expiresAt ? lv.expiresAt * 1000 : null); // convert seconds to ms
        if (lv.interval) setInterval_(lv.interval);
      } else {
        setExpiresAt(null);
      }

      // Spinners clear only once the agent confirms the state change.
      if (newActive && isStartingRef.current) {
        isStartingRef.current = false;
        setIsStarting(false);
        clearPendingTimeout();
      } else if (!newActive && isStoppingRef.current) {
        isStoppingRef.current = false;
        setIsStopping(false);
        clearPendingTimeout();
      }
    });

    return () => unsubscribe();
  }, [open, siteId, machineId]);

  useEffect(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }

    if (!liveViewActive || !expiresAt) {
      // Nothing to count down to.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTimeRemaining('');
      return;
    }

    const updateCountdown = () => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      if (remaining <= 0) {
        setTimeRemaining('expired');
        setLiveViewActive(false);
        if (countdownRef.current) clearInterval(countdownRef.current);
        return;
      }
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      setTimeRemaining(`${mins}:${secs.toString().padStart(2, '0')}`);
    };

    updateCountdown();
    countdownRef.current = setInterval(updateCountdown, 1000);

    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [liveViewActive, expiresAt]);

  // Reset transient UI state on close so a re-open starts fresh.
  useEffect(() => {
    if (!open) {
      isStartingRef.current = false;
      isStoppingRef.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional UI reset
      setIsStarting(false);
      setIsStopping(false);
      setFullscreen(false);
      if (pendingTimeoutRef.current) {
        clearTimeout(pendingTimeoutRef.current);
        pendingTimeoutRef.current = null;
      }
    }
  }, [open]);

  useEffect(() => {
    return () => {
      if (pendingTimeoutRef.current) clearTimeout(pendingTimeoutRef.current);
    };
  }, []);

  // If the agent never confirms, clear the spinner after 30s rather than leave
  // the user on "starting..." forever.
  const PENDING_TIMEOUT_MS = 30000;

  const handleStart = useCallback(async () => {
    isStartingRef.current = true;
    setIsStarting(true);
    clearPendingTimeout();
    pendingTimeoutRef.current = setTimeout(() => {
      isStartingRef.current = false;
      setIsStarting(false);
      pendingTimeoutRef.current = null;
    }, PENDING_TIMEOUT_MS);

    try {
      await onStartLiveView(machineId, interval, 600);
      // isStarting clears on the snapshot confirming liveView.active=true.
    } catch (err) {
      console.error('Failed to start live view:', err);
      isStartingRef.current = false;
      setIsStarting(false);
      clearPendingTimeout();
    }
  }, [machineId, interval, onStartLiveView]);

  const handleStop = useCallback(async () => {
    isStoppingRef.current = true;
    setIsStopping(true);
    clearPendingTimeout();
    pendingTimeoutRef.current = setTimeout(() => {
      isStoppingRef.current = false;
      setIsStopping(false);
      pendingTimeoutRef.current = null;
    }, PENDING_TIMEOUT_MS);

    try {
      await onStopLiveView(machineId);
      // isStopping clears on the snapshot confirming liveView.active=false.
    } catch (err) {
      console.error('Failed to stop live view:', err);
      isStoppingRef.current = false;
      setIsStopping(false);
      clearPendingTimeout();
    }
  }, [machineId, onStopLiveView]);

  const handleDownload = useCallback(async () => {
    if (!screenshot?.url) return;
    try {
      const response = await fetch(screenshot.url);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${machineName}-liveview-${new Date(screenshot.timestamp).toISOString().replace(/[:.]/g, '-')}.jpg`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      if (screenshot?.url) window.open(screenshot.url, '_blank');
    }
  }, [screenshot, machineName]);

  return (
    <>
      {screenshot && (
        <ImageLightbox
          src={fullscreen ? screenshot.url : null}
          alt={`live view of ${machineName}`}
          onClose={() => setFullscreen(false)}
        />
      )}

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent showCloseButton={false} className="bg-card border-border w-[calc(100vw-2rem)] sm:max-w-4xl max-w-none p-0 gap-0 h-[calc(100dvh-4rem)] max-h-[700px]">
          <div className="flex flex-col h-full">

            <DialogHeader className="px-4 py-2 border-b border-border flex-shrink-0">
              <DialogTitle className="flex items-center gap-2">
                <Eye className="h-5 w-5 shrink-0" />
                <span className="truncate">live view — {machineName}</span>
                {liveViewActive && timeRemaining && (
                  <span className="text-xs font-normal text-muted-foreground ml-2">
                    {timeRemaining} remaining
                  </span>
                )}
                {liveViewActive && (
                  <span className="ml-2 inline-flex items-center gap-1">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                    </span>
                    <span className="text-xs font-normal text-green-400">live</span>
                  </span>
                )}
                {/* no tooltip: as the first tabbable control it takes focus on open,
                    and an open tooltip would take the first escape press */}
                <IconButton
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

            <div className="flex-1 relative bg-black/30 flex items-center justify-center overflow-hidden min-h-0">
              {!screenshot && !liveViewActive && (
                <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground text-center px-6">
                  <Eye className="h-8 w-8" />
                  <p>press <span className="text-foreground font-medium">start</span> to begin a live preview of this machine</p>
                  <p className="text-xs text-muted-foreground/80">
                    captures a screenshot every {interval}s · auto-stops after 10 minutes
                  </p>
                </div>
              )}

              {!screenshot && liveViewActive && (
                <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                  <Loader2 className="h-8 w-8 animate-spin" />
                  <p>waiting for first screenshot...</p>
                </div>
              )}

              {screenshot && (
                // eslint-disable-next-line @next/next/no-img-element -- signed storage url, not a static asset
                <img
                  src={screenshot.url}
                  alt={`live view of ${machineName}`}
                  className="absolute inset-0 w-full h-full object-contain cursor-pointer"
                  onClick={() => setFullscreen(true)}
                />
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-t border-border flex-shrink-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">

                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">interval:</span>
                  <Select
                    value={String(interval)}
                    onValueChange={(v) => setInterval_(Number(v))}
                    disabled={liveViewActive}
                  >
                    <SelectTrigger className="h-7 w-[70px] text-xs bg-secondary border-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5">5s</SelectItem>
                      <SelectItem value="10">10s</SelectItem>
                      <SelectItem value="20">20s</SelectItem>
                      <SelectItem value="30">30s</SelectItem>
                      <SelectItem value="60">60s</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {screenshot && (
                  <span className="text-xs text-muted-foreground">
                    last update: {new Date(screenshot.timestamp).toLocaleTimeString(undefined, { hour12: (userPreferences.timeFormat || '12h') === '12h' })}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {screenshot && (
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
                      label="fullscreen"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setFullscreen(true)}
                    >
                      <Maximize2 className="h-4 w-4" />
                    </IconButton>
                  </>
                )}

                {liveViewActive ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleStop}
                    disabled={isStopping}
                    className="bg-red-900/30 border-red-800 text-red-300 hover:bg-red-900/50 hover:text-red-200"
                  >
                    {isStopping ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Square className="h-4 w-4 mr-2" />
                    )}
                    {isStopping ? 'stopping...' : 'stop'}
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleStart}
                    disabled={isStarting}
                    className="bg-secondary border border-border"
                  >
                    {isStarting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4 mr-2" />
                    )}
                    {isStarting ? 'starting...' : 'start'}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
