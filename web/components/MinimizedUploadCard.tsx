'use client';

/**
 * Floating bottom-right indicator for a roost upload running outside
 * ProjectDistributionDialog. State comes from the parent's `useRoostUpload`:
 *   uploading → progress bar + phase + throughput/ETA
 *   success   → "synced" flash, auto-hides after 2s
 *   error     → error state + dismiss button
 *   cancelled → auto-hides after 1s
 *
 * Clicking the body calls `onRestore()`; the dialog reads the same
 * `state.progress` and picks up mid-flight. The X cancels behind a two-click
 * inline confirm — losing an in-flight multi-GB upload by mis-tap is worse
 * than one extra tap.
 */

import React, { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Maximize2, OctagonAlert, X } from 'lucide-react';
import type { UseRoostUploadApi } from '@/hooks/useRoostUpload';
import { formatBytes } from '@/lib/preUploadCheck';

interface MinimizedUploadCardProps {
  upload: UseRoostUploadApi;
  onRestore: () => void;
}

/** Human-friendly `Xm Ys` / `Zs` formatter. Returns `—` on non-finite. */
function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

/** Short phase label shown in the card header. */
function phaseLabel(phase: string): string {
  switch (phase) {
    case 'hashing':
      return 'hashing';
    case 'checking':
      return 'checking for duplicates';
    case 'uploading':
      return 'uploading';
    case 'finalizing':
      return 'finalizing';
    case 'done':
      return 'synced';
    case 'error':
      return 'error';
    default:
      return 'preparing';
  }
}

/**
 * The lib can set hashFraction AND uploadFraction on the tick where it crosses
 * phases; always take the one matching the current phase so the bar stays
 * monotonic.
 */
function activeFraction(progress: {
  phase: string;
  hashFraction?: number;
  uploadFraction?: number;
}): number | undefined {
  if (progress.phase === 'hashing') return progress.hashFraction;
  if (progress.phase === 'uploading') return progress.uploadFraction;
  if (progress.phase === 'finalizing' || progress.phase === 'done') return 1;
  return undefined;
}

export function MinimizedUploadCard({ upload, onRestore }: MinimizedUploadCardProps) {
  const { state, cancel, reset } = upload;
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  // Auto-dismiss on terminal states; error waits for an explicit dismiss so the
  // failure can be read. `reset()` flips the hook to `idle` and the parent stops
  // rendering this component — no local "hidden" flag, and the
  // setState-in-effect lint rule is satisfied because `reset` is stable.
  useEffect(() => {
    if (state.status === 'success') {
      const t = setTimeout(reset, 2000);
      return () => clearTimeout(t);
    }
    if (state.status === 'cancelled') {
      const t = setTimeout(reset, 1000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [state.status, reset]);

  if (state.status === 'idle') return null;

  // Gating the inline cancel-confirm on `status === 'uploading'` means a stale
  // "cancel? yes/no" can't outlive the run — no effect-driven reset needed.
  const showCancelConfirm = confirmingCancel && state.status === 'uploading';

  const progress = state.progress;
  const frac = progress ? activeFraction(progress) : undefined;
  const pct = frac !== undefined ? Math.round(Math.max(0, Math.min(1, frac)) * 100) : null;
  const isError = state.status === 'error';
  const isSuccess = state.status === 'success';
  const isCancelled = state.status === 'cancelled';

  // Only once the rate is measurable (~3s of samples); sooner is noise and
  // flashes a nonsense value on the first tick.
  const throughput = progress?.throughputBytesPerSec;
  const eta = progress?.etaSeconds;
  const showRate =
    !isError &&
    !isSuccess &&
    !isCancelled &&
    throughput !== undefined &&
    eta !== undefined &&
    (progress?.phase === 'hashing' || progress?.phase === 'uploading');

  const name = state.inputs?.name ?? 'roost';

  const handleCancelClick: React.MouseEventHandler = (e) => {
    e.stopPropagation();
    if (!confirmingCancel) {
      setConfirmingCancel(true);
      return;
    }
    cancel();
    setConfirmingCancel(false);
  };

  const handleDismissError: React.MouseEventHandler = (e) => {
    e.stopPropagation();
    reset();
  };

  const handleRestore = () => {
    if (isError) return; // clicking an errored card shouldn't reopen the dialog (nothing to resume)
    onRestore();
  };

  // z-index above sonner's 9999 to avoid toast overlap; viewport insets keep it
  // clear of the footer.
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[10000] w-[320px] rounded-lg border border-border bg-secondary shadow-lg shadow-elevation-shadow/80"
      data-testid="minimized-upload-card"
    >
      <button
        type="button"
        onClick={handleRestore}
        disabled={isError}
        aria-label={isError ? 'upload failed' : `restore upload — ${name}`}
        className={`w-full text-left p-3 rounded-lg ${
          isError ? 'cursor-default' : 'cursor-pointer hover:bg-muted/40'
        } transition-colors`}
      >
        <div className="flex items-start gap-2">
          <div className="flex-shrink-0 mt-0.5">
            {isError ? (
              <OctagonAlert className="h-4 w-4 text-danger" />
            ) : isSuccess ? (
              <CheckCircle2 className="h-4 w-4 text-success" />
            ) : (
              <Loader2 className="h-4 w-4 animate-spin text-accent-cyan" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-medium text-foreground truncate">
                {isError ? 'upload failed' : isSuccess ? 'synced' : name}
              </span>
            </div>

            {!isError && !isSuccess && !isCancelled && (
              <>
                <div className="mt-1 flex items-baseline gap-1.5 text-[11px] text-muted-foreground">
                  <span>{progress ? phaseLabel(progress.phase) : 'preparing'}</span>
                  {showRate && throughput !== undefined && eta !== undefined && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">
                        {formatBytes(throughput)}/s
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">
                        ~{formatDuration(eta)} left
                      </span>
                    </>
                  )}
                </div>
                {/* Full-width bar — the % lives under the X in the
                    absolute action area so the track has maximum room
                    for the unfilled/filled ratio to be legible. Darker
                    track (bg-background + subtle border) for contrast
                    on the card's bg-secondary panel. */}
                <div className="mt-1.5 h-[4px] w-full overflow-hidden rounded-full bg-background border border-border/40">
                  <div
                    className="h-full bg-accent-cyan transition-[width] duration-200 ease-out"
                    style={{ width: `${frac !== undefined ? Math.max(0, Math.min(1, frac)) * 100 : 0}%` }}
                  />
                </div>
              </>
            )}

            {isError && state.error && (
              <p className="mt-1 text-[11px] text-danger line-clamp-2">
                {state.error}
              </p>
            )}
          </div>
          <div className="flex-shrink-0 flex items-center gap-1">
            {!isError && !isSuccess && !isCancelled && (
              <span
                className="p-1 text-muted-foreground hover:text-foreground"
                aria-hidden="true"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </span>
            )}
          </div>
        </div>
      </button>

      {/* Percentage pinned top-right below the X — frees the full card
          width for the progress bar itself so the ratio is readable at
          a glance. Only shown during active phases (not on success /
          error / cancel where the header copy carries the signal). */}
      {pct !== null && !isError && !isSuccess && !isCancelled && (
        <span className="pointer-events-none absolute bottom-2.5 right-2.5 text-[10px] text-muted-foreground tabular-nums">
          {pct}%
        </span>
      )}

      {/* Action row — rendered outside the main restore-button so the X
          doesn't collide with the "click to restore" semantics. For errors
          this is a dismiss; for in-flight runs it's a two-click cancel. */}
      <div className="absolute top-2 right-2 flex items-center gap-1">
        {isError ? (
          <button
            type="button"
            onClick={handleDismissError}
            aria-label="dismiss"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : !isSuccess && !isCancelled ? (
          showCancelConfirm ? (
            <div
              className="flex items-center gap-1 rounded bg-muted/80 px-1.5 py-0.5 text-[10px]"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="text-muted-foreground">cancel?</span>
              <button
                type="button"
                onClick={handleCancelClick}
                className="px-1 rounded text-danger hover:text-foreground cursor-pointer font-medium"
              >
                yes
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmingCancel(false);
                }}
                className="px-1 rounded text-muted-foreground hover:text-foreground cursor-pointer"
              >
                no
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleCancelClick}
              aria-label="cancel upload"
              className="p-1 rounded text-muted-foreground hover:text-danger hover:bg-muted cursor-pointer transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}

export default MinimizedUploadCard;
