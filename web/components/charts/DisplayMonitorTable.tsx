'use client';

/**
 * Compact table of a machine's monitors: # | name | resolution @ refresh |
 * scale (+ rotation) | position | port. Amber cell tinting marks per-field
 * drift. In edit mode position / orientation / scale / primary become native
 * widgets; the resolution + refresh Selects bind to the per-monitor supported
 * lists from `useDisplayModes` and only render once the catalogue arrives.
 */

import { memo, useState } from 'react';
import { Star, TriangleAlert } from 'lucide-react';
import { MonitorInfo } from '@/hooks/useDisplayState';
import type { DisplayModeEntry } from '@/hooks/useDisplayModes';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type MonitorUpdate = Partial<MonitorInfo>;

/**
 * Unique `(w, h)` pairs across the monitor's supported modes, descending. The
 * catalogue arrives pre-sorted, so first-seen order is the order to emit.
 *
 * The current `{width, height}` is always appended when absent so an
 * off-catalogue value (overclock, legacy config) stays selectable — otherwise
 * the Select shows no selection on entry and looks broken.
 */
function uniqueResolutionsForMonitor(
  modes: readonly DisplayModeEntry[],
  currentW: number,
  currentH: number,
): Array<{ w: number; h: number }> {
  const seen = new Set<string>();
  const out: Array<{ w: number; h: number }> = [];
  const add = (w: number, h: number) => {
    const key = `${w}x${h}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ w, h });
  };
  for (const m of modes) add(m.w, m.h);
  add(currentW, currentH);
  // Re-sort in case the current (w, h) was appended out of order.
  out.sort((a, b) => b.w - a.w || b.h - a.h);
  return out;
}

/**
 * Refresh rates valid for a `(w, h)`, descending. Always includes the current
 * `refreshHz` even if uncatalogued, so the Select never shows blank.
 */
function refreshesForResolution(
  modes: readonly DisplayModeEntry[],
  w: number,
  h: number,
  currentHz: number,
): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const m of modes) {
    if (m.w !== w || m.h !== h) continue;
    if (seen.has(m.hz)) continue;
    seen.add(m.hz);
    out.push(m.hz);
  }
  if (!seen.has(currentHz)) {
    out.push(currentHz);
    out.sort((a, b) => b - a);
  }
  return out;
}

interface DisplayMonitorTableProps {
  monitors: MonitorInfo[];
  selectedMonitorId?: string;
  onSelect?: (id: string) => void;
  /** Double-click a row → full monitor editor. Attached only to non-editable
   * cells so double-clicks inside editable Selects are absorbed by the widget. */
  onRowDoubleClick?: (id: string) => void;
  /** Monitor hovered here or in a linked sibling view (DisplayCanvas), so
   * hovering a canvas rect lights up the matching row. */
  hoveredMonitorId?: string;
  /** Fires on mouse enter/leave of a row — id is undefined on leave. */
  onHover?: (id: string | undefined) => void;
  accentColor: string;
  driftMap?: Map<string, string[]>;
  /** When true, renders editable cells and fires onUpdateMonitor on changes. */
  editable?: boolean;
  onUpdateMonitor?: (id: string, partial: MonitorUpdate) => void;
  /** Supported modes keyed by edidHash, from
   * `useDisplayModes(...).catalogue?.byEdidHash`. Present + edit mode → bound
   * Selects; absent → read-only "WxH @Hz" text. */
  modesByEdidHash?: Record<string, { modes: DisplayModeEntry[]; dpiScales: number[] }>;
}

/** Rotation degrees → the labels Windows Settings → Display uses, lowercased. */
function orientationLabel(rotation: number): string {
  switch (rotation % 360) {
    case 90:
      return 'portrait';
    case 180:
      return 'landscape (flipped)';
    case 270:
      return 'portrait (flipped)';
    default:
      return 'landscape';
  }
}

const ROTATION_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'landscape' },
  { value: 90, label: 'portrait' },
  { value: 180, label: 'landscape (flipped)' },
  { value: 270, label: 'portrait (flipped)' },
];

// Common Windows DPI scales. Unsupported values clamp to the nearest supported,
// so an unfiltered list is safe.
const SCALE_OPTIONS = [100, 125, 150, 175, 200];

/** Panel dimensions on the virtual desktop: 90/270 swap w/h, matching Windows. */
function effectiveResolution(monitor: MonitorInfo): { w: number; h: number } {
  const rot = monitor.rotation % 360;
  if (rot === 90 || rot === 270) {
    return { w: monitor.resolution.height, h: monitor.resolution.width };
  }
  return { w: monitor.resolution.width, h: monitor.resolution.height };
}

// Native controls on purpose: keyboard + a11y for free, at a styling ceiling
// that's acceptable at this row density. 16px below md: iOS zooms the page into
// any focused field set smaller. Focus is the global outline.
const EDITABLE_CELL_BASE =
  'bg-card border border-border rounded px-1.5 py-0.5 text-base md:text-xs text-foreground ' +
  'hover:border-accent';

/**
 * Controlled numeric input surviving the two classic traps: a bare "-"
 * (Number("-") is NaN) and a cleared field (Number("") is 0, pushed back as a 0
 * the user can't backspace over → "09" / "080").
 *
 * Raw text lives in local state and only reaches the parent when it parses
 * finite; "" and "-" are held as in-flight edits. External prop changes sync
 * into `local` only while unfocused, so typing is never clobbered mid-edit.
 * Blur reverts an unparseable value to the last committed number.
 */
interface NumericPositionInputProps {
  value: number;
  onCommit: (next: number) => void;
  ariaLabel: string;
  className: string;
}

function NumericPositionInput({
  value,
  onCommit,
  ariaLabel,
  className,
}: NumericPositionInputProps) {
  const [local, setLocal] = useState<string>(() => String(value));
  const [focused, setFocused] = useState(false);
  // Last `value` prop `local` was hydrated from. Outside changes (primary-drag,
  // reset-to-assigned) resync during render — skipped while focused so
  // in-flight typing survives. setState-during-render is the canonical React
  // pattern here and avoids the repo's `react-hooks/set-state-in-effect` rule.
  const [lastSyncedValue, setLastSyncedValue] = useState<number>(value);
  if (value !== lastSyncedValue) {
    setLastSyncedValue(value);
    if (!focused) setLocal(String(value));
  }

  return (
    <input
      type="number"
      inputMode="numeric"
      step={1}
      value={local}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        setFocused(false);
        const parsed = Number(e.target.value);
        if (e.target.value.trim() === '' || !Number.isFinite(parsed)) {
          setLocal(String(value));
          return;
        }
        // Windows virtual-desktop coords are integer px — round on blur so
        // `1.5`/`1e2` land on something the agent can apply without drift.
        const rounded = Math.round(parsed);
        if (rounded !== value) onCommit(rounded);
        setLocal(String(rounded));
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setLocal(raw);
        // Commit only on a clean integer parse; "", "-", `1.5`, `1e2` are held
        // locally until onBlur rounds them.
        if (raw === '' || raw === '-') return;
        const parsed = Number(raw);
        if (
          Number.isFinite(parsed) &&
          Number.isInteger(parsed) &&
          parsed !== value
        ) {
          onCommit(parsed);
        }
      }}
      onClick={(e) => e.stopPropagation()}
      className={className}
      aria-label={ariaLabel}
    />
  );
}

function DisplayMonitorTableImpl({
  monitors,
  selectedMonitorId,
  onSelect,
  onRowDoubleClick,
  hoveredMonitorId,
  onHover,
  accentColor,
  driftMap,
  editable = false,
  onUpdateMonitor,
  modesByEdidHash,
}: DisplayMonitorTableProps) {
  const canEdit = editable && !!onUpdateMonitor;

  return (
    // overflow-auto, not overflow-hidden: at phone width the seven columns are wider
    // than the panel and scroll sideways instead of being clipped
    <div className="rounded-r-lg border border-border bg-secondary h-[280px] overflow-auto">
      <table className="w-full text-xs">
        <thead className="text-[10px] text-muted-foreground bg-card sticky top-0 z-10">
          <tr className="border-b border-border">
            <th className="text-left font-medium py-1.5 pl-2 pr-1 w-6">#</th>
            <th className="text-left font-medium py-1.5 px-1">name</th>
            <th className="text-left font-medium py-1.5 px-1">resolution</th>
            <th className="text-left font-medium py-1.5 px-1">scale</th>
            <th className="text-left font-medium py-1.5 px-1">orientation</th>
            <th className="text-left font-medium py-1.5 px-1">position</th>
            <th className="text-left font-medium py-1.5 px-1 pr-2 w-10">port</th>
          </tr>
        </thead>
        <tbody>
          {monitors.map((monitor, idx) => {
            const drift = driftMap?.get(monitor.id) ?? [];
            const resolutionDrifted =
              drift.includes('resolution.width') ||
              drift.includes('resolution.height') ||
              drift.includes('refreshHz');
            const scaleDrifted = drift.includes('scalePct');
            const orientationDrifted = drift.includes('rotation');
            const xDrifted = drift.includes('position.x');
            const yDrifted = drift.includes('position.y');

            const isSelected = selectedMonitorId === monitor.id;
            const isHovered = hoveredMonitorId === monitor.id;
            const friendlyName = monitor.friendlyName || monitor.id;
            const effRes = effectiveResolution(monitor);

            const rowClick = onSelect ? () => onSelect(monitor.id) : undefined;
            const rowDblClick = onRowDoubleClick
              ? () => onRowDoubleClick(monitor.id)
              : undefined;
            // `e.target === e.currentTarget` so Enter inside a child input
            // doesn't re-fire row selection.
            const rowKeyDown = onSelect
              ? (e: React.KeyboardEvent<HTMLTableRowElement>) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(monitor.id);
                  }
                }
              : undefined;

            return (
              <tr
                key={monitor.id}
                tabIndex={onSelect ? 0 : undefined}
                aria-selected={onSelect ? isSelected : undefined}
                aria-label={onSelect ? friendlyName : undefined}
                onKeyDown={rowKeyDown}
                onMouseEnter={onHover ? () => onHover(monitor.id) : undefined}
                onMouseLeave={onHover ? () => onHover(undefined) : undefined}
                className={cn(
                  'border-b border-border last:border-b-0 transition-colors',
                  onSelect && !canEdit && 'cursor-pointer',
                  isSelected
                    ? 'bg-accent/30'
                    : isHovered && 'bg-accent/20',
                )}
                style={
                  isSelected
                    ? { boxShadow: `inset 3px 0 0 0 ${accentColor}` }
                    : undefined
                }
              >
                <td
                  className="py-1.5 pl-2 pr-1 font-mono text-muted-foreground tabular-nums"
                  onClick={rowClick}
                  onDoubleClick={rowDblClick}
                >
                  {idx + 1}
                </td>
                <td
                  className="py-1.5 px-1"
                  onClick={rowClick}
                  onDoubleClick={rowDblClick}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="font-medium text-foreground truncate"
                      title={friendlyName}
                    >
                      {friendlyName}
                    </span>
                    {canEdit ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!monitor.primary) {
                            onUpdateMonitor?.(monitor.id, { primary: true });
                          }
                        }}
                        disabled={monitor.primary}
                        title={
                          monitor.primary
                            ? 'primary monitor'
                            : 'mark as primary'
                        }
                        aria-label={monitor.primary ? 'primary monitor' : 'mark as primary'}
                        className={cn(
                          'shrink-0 transition-colors',
                          monitor.primary
                            ? 'text-accent-warm cursor-default'
                            : 'text-muted-foreground hover:text-accent-warm',
                        )}
                      >
                        <Star
                          className={cn(
                            'h-3 w-3',
                            monitor.primary && 'fill-accent-warm',
                          )}
                          aria-hidden
                        />
                      </button>
                    ) : (
                      monitor.primary && (
                        <Star
                          className="h-2.5 w-2.5 text-accent-warm fill-accent-warm shrink-0"
                          aria-label="primary"
                        />
                      )
                    )}
                  </div>
                </td>
                <td
                  className={cn(
                    'py-1.5 px-1 tabular-nums',
                    resolutionDrifted ? 'text-warning' : 'text-foreground',
                  )}
                  onClick={canEdit ? undefined : rowClick}
                  onDoubleClick={canEdit ? undefined : rowDblClick}
                >
                  {(() => {
                    // Missing when the subscription hasn't landed, the catalogue
                    // isn't built, or this is a mirror target deduped out of
                    // `byEdidHash`.
                    const monitorModes = modesByEdidHash?.[monitor.edidHash]?.modes;
                    const haveModes = !!monitorModes && monitorModes.length > 0;
                    if (!canEdit || !haveModes) {
                      // Read-only: view mode or no catalogue. `effRes` is the
                      // rotated (desktop) size; stored resolution is native.
                      return (
                        <>
                          {effRes.w}×{effRes.h}
                          <span className="text-muted-foreground"> @{monitor.refreshHz}</span>
                        </>
                      );
                    }
                    const currentW = monitor.resolution.width;
                    const currentH = monitor.resolution.height;
                    const resolutions = uniqueResolutionsForMonitor(
                      monitorModes,
                      currentW,
                      currentH,
                    );
                    const refreshes = refreshesForResolution(
                      monitorModes,
                      currentW,
                      currentH,
                      monitor.refreshHz,
                    );
                    // Off-catalogue detection: warn before apply. Two flags so a
                    // valid resolution with an invalid rate only warns on refresh.
                    const resolutionOffList = !monitorModes.some(
                      (m) => m.w === currentW && m.h === currentH,
                    );
                    const refreshOffList = !monitorModes.some(
                      (m) =>
                        m.w === currentW &&
                        m.h === currentH &&
                        m.hz === monitor.refreshHz,
                    );
                    return (
                      <div className="flex items-center gap-1">
                        <select
                          value={`${currentW}x${currentH}`}
                          onChange={(e) => {
                            const [wRaw, hRaw] = e.target.value.split('x');
                            const w = Number(wRaw);
                            const h = Number(hRaw);
                            // Snap to the highest rate the new resolution
                            // supports rather than dropping to 60Hz.
                            const candidateRefreshes = refreshesForResolution(
                              monitorModes,
                              w,
                              h,
                              monitor.refreshHz,
                            );
                            const keepHz =
                              candidateRefreshes.includes(monitor.refreshHz)
                                ? monitor.refreshHz
                                : candidateRefreshes[0] ?? monitor.refreshHz;
                            onUpdateMonitor?.(monitor.id, {
                              resolution: { width: w, height: h },
                              refreshHz: keepHz,
                            });
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className={cn(EDITABLE_CELL_BASE, 'tabular-nums')}
                          aria-label="resolution"
                        >
                          {resolutions.map(({ w, h }) => (
                            <option key={`${w}x${h}`} value={`${w}x${h}`}>
                              {w}×{h}
                            </option>
                          ))}
                        </select>
                        {resolutionOffList && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <TriangleAlert
                                className="h-3 w-3 text-accent-warm shrink-0 cursor-help"
                                aria-label="resolution not in the supported list"
                              />
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>
                                {currentW}×{currentH} isn&apos;t in this monitor&apos;s supported list — apply at your own risk
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <span className="text-muted-foreground text-[10px] select-none">@</span>
                        <select
                          value={monitor.refreshHz}
                          onChange={(e) =>
                            onUpdateMonitor?.(monitor.id, {
                              refreshHz: Number(e.target.value),
                            })
                          }
                          onClick={(e) => e.stopPropagation()}
                          className={cn(EDITABLE_CELL_BASE, 'tabular-nums')}
                          aria-label="refresh rate"
                        >
                          {refreshes.map((hz) => (
                            <option key={hz} value={hz}>
                              {hz}
                            </option>
                          ))}
                        </select>
                        {refreshOffList && !resolutionOffList && (
                          // Suppressed when the resolution is off-list too — one
                          // warning already implicates everything downstream.
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <TriangleAlert
                                className="h-3 w-3 text-accent-warm shrink-0 cursor-help"
                                aria-label="refresh rate not in the supported list"
                              />
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>
                                {monitor.refreshHz}Hz isn&apos;t supported at {currentW}×{currentH} — apply at your own risk
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    );
                  })()}
                </td>
                <td
                  className={cn(
                    'py-1.5 px-1 tabular-nums',
                    scaleDrifted ? 'text-warning' : 'text-foreground',
                  )}
                >
                  {canEdit ? (
                    <select
                      value={monitor.scalePct}
                      onChange={(e) =>
                        onUpdateMonitor?.(monitor.id, {
                          scalePct: Number(e.target.value),
                        })
                      }
                      onClick={(e) => e.stopPropagation()}
                      className={cn(EDITABLE_CELL_BASE, 'tabular-nums')}
                      aria-label="scale"
                    >
                      {SCALE_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}%
                        </option>
                      ))}
                    </select>
                  ) : (
                    `${monitor.scalePct}%`
                  )}
                </td>
                <td
                  className={cn(
                    'py-1.5 px-1',
                    orientationDrifted ? 'text-warning' : 'text-muted-foreground',
                  )}
                >
                  {canEdit ? (
                    <select
                      value={monitor.rotation % 360}
                      onChange={(e) =>
                        onUpdateMonitor?.(monitor.id, {
                          rotation: Number(e.target.value),
                        })
                      }
                      onClick={(e) => e.stopPropagation()}
                      className={EDITABLE_CELL_BASE}
                      aria-label="orientation"
                    >
                      {ROTATION_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    orientationLabel(monitor.rotation)
                  )}
                </td>
                <td className="py-1.5 px-1 tabular-nums text-muted-foreground">
                  {canEdit && !monitor.primary ? (
                    <div className="flex items-center gap-1">
                      <NumericPositionInput
                        value={monitor.position.x}
                        onCommit={(x) =>
                          onUpdateMonitor?.(monitor.id, {
                            position: { x, y: monitor.position.y },
                          })
                        }
                        ariaLabel="x position"
                        className={cn(EDITABLE_CELL_BASE, 'w-20 tabular-nums')}
                      />
                      <NumericPositionInput
                        value={monitor.position.y}
                        onCommit={(y) =>
                          onUpdateMonitor?.(monitor.id, {
                            position: { x: monitor.position.x, y },
                          })
                        }
                        ariaLabel="y position"
                        className={cn(EDITABLE_CELL_BASE, 'w-20 tabular-nums')}
                      />
                    </div>
                  ) : (
                    <span
                      title={
                        canEdit && monitor.primary
                          ? 'primary defines the coordinate origin — drag it on the layout to reposition relative to the others'
                          : undefined
                      }
                    >
                      <span className={xDrifted ? 'text-warning' : undefined}>
                        {monitor.position.x}
                      </span>
                      ,{' '}
                      <span className={yDrifted ? 'text-warning' : undefined}>
                        {monitor.position.y}
                      </span>
                    </span>
                  )}
                </td>
                <td
                  className="py-1.5 px-1 pr-2 text-muted-foreground"
                  onClick={rowClick}
                  onDoubleClick={rowDblClick}
                >
                  {monitor.connectionType}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const DisplayMonitorTable = memo(DisplayMonitorTableImpl);
