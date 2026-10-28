'use client';

import { useRef, useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IconButton } from '@/components/ui/icon-button';
import { Plus, Minus, Trash2, ChevronUp, ChevronDown, Save, Pencil, X } from 'lucide-react';
import type { ScheduleBlock } from '@/hooks/useFirestore';
import type { SchedulePreset } from '@/hooks/useSchedulePresets';
import { BLOCK_COLORS, BUILT_IN_PRESETS, ensureBlockColors } from '@/lib/scheduleDefaults';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from '@/lib/toast';
import DayPillSelector from '@/components/DayPillSelector';
import { TimezoneChip } from '@/components/TimezoneChip';
import { compareVersions, SITE_TIME_MIN_AGENT_VERSION } from '@/lib/versionUtils';

// ─── Time Picker ─────────────────────────────────────────────────────────────

interface TimePickerProps {
  value: string; // "HH:MM" 24-hour format
  onChange: (value: string) => void;
  compact?: boolean;
  /** Accessible name of the field; the ±15 steppers are named after it. */
  label?: string;
}

function formatTimeDisplay(value: string, use24h: boolean): string {
  const [h, m] = value.split(':').map(Number);
  if (use24h) {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

/**
 * Typed time → "HH:MM" 24h, or null. In 12h mode a bare "H:MM" inherits the
 * am/pm of `currentHour24`, so editing "2:25 pm" to "3:25" stays afternoon.
 */
function parseTimeInput(input: string, use24h: boolean, currentHour24?: number): string | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ');

  // "H:MM" or "HH:MM" with optional am/pm — e.g. "9:30", "17:00", "5:00 pm"
  const colonMatch = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (colonMatch) {
    let h = parseInt(colonMatch[1]);
    const m = parseInt(colonMatch[2]);
    const ampm = colonMatch[3];
    if (m > 59) return null;
    if (ampm === 'pm' && h !== 12) h = Math.min(h + 12, 23);
    else if (ampm === 'am' && h === 12) h = 0;
    else if (!ampm && !use24h && h >= 1 && h <= 12 && typeof currentHour24 === 'number') {
      const wasPM = currentHour24 >= 12;
      if (wasPM && h !== 12) h += 12;
      else if (!wasPM && h === 12) h = 0;
    }
    if (h > 23) return null;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }

  // "Ham" / "Hpm" — e.g. "5pm", "9 am"
  const shortMatch = s.match(/^(\d{1,2})\s*(am|pm)$/);
  if (shortMatch) {
    let h = parseInt(shortMatch[1]);
    const ampm = shortMatch[2];
    if (h > 12 || h < 1) return null;
    if (ampm === 'pm' && h !== 12) h += 12;
    else if (ampm === 'am' && h === 12) h = 0;
    return `${h.toString().padStart(2, '0')}:00`;
  }

  // "HHMM" compact — e.g. "1700", "900"
  const compactMatch = s.match(/^(\d{3,4})$/);
  if (compactMatch) {
    const n = parseInt(compactMatch[1]);
    const h = Math.floor(n / 100);
    const m = n % 100;
    if (h > 23 || m > 59) return null;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }

  return null;
}

export function TimePicker({ value, onChange, compact, label = 'time' }: TimePickerProps) {
  const { userPreferences } = useAuth();
  const use24h = (userPreferences.timeFormat || '12h') === '24h';
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [h, m] = value.split(':').map(Number);

  const adjust = (deltaMinutes: number): string => {
    const total = ((h * 60 + m + deltaMinutes) % (24 * 60) + 24 * 60) % (24 * 60);
    const newH = Math.floor(total / 60);
    const newM = total % 60;
    const newValue = `${newH.toString().padStart(2, '0')}:${newM.toString().padStart(2, '0')}`;
    onChange(newValue);
    return newValue;
  };

  const commit = (text: string) => {
    const parsed = parseTimeInput(text, use24h, h);
    if (parsed) onChange(parsed);
    setDraft(null);
  };

  const step = (deltaMinutes: number) => {
    const next = adjust(deltaMinutes);
    // mid-edit the field shows its draft, so the draft follows the step
    if (document.activeElement === inputRef.current) setDraft(formatTimeDisplay(next, use24h));
  };

  const displayed = formatTimeDisplay(value, use24h);
  // 16px below md: iOS zooms the page into any focused field set smaller
  const inputWidth = use24h ? 'w-16 md:w-14' : 'w-20 md:w-[4.5rem]';
  const inputPy = compact ? 'py-0.5 text-base md:text-[11px]' : 'py-1 text-base md:text-sm';
  // pointerdown is cancelled so a mouse or touch step leaves focus, and any draft, in
  // the field; the step itself runs on click, which keyboard and assistive tech also fire
  const stepperClass = 'flex h-4 w-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground cursor-pointer pointer-coarse:h-5 pointer-coarse:w-8';

  return (
    <div className="flex items-center gap-0.5">
      <input
        ref={inputRef}
        type="text"
        aria-label={label}
        value={draft ?? displayed}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => { setDraft(displayed); requestAnimationFrame(() => e.target.select()); }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit((e.target as HTMLInputElement).value); e.currentTarget.blur(); }
          if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setDraft(formatTimeDisplay(adjust(60), use24h)); }
          if (e.key === 'ArrowDown') { e.preventDefault(); setDraft(formatTimeDisplay(adjust(-60), use24h)); }
        }}
        className={`${inputPy} ${inputWidth} rounded-md border border-border bg-background text-foreground font-medium text-center cursor-text focus:border-muted-foreground transition-colors`}
        title="Type a time (e.g. 9:00, 5pm, 17:00) or use ↑↓ arrows"
      />
      <div className="flex flex-col">
        <button
          type="button"
          aria-label={`${label}, 15 minutes later`}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => step(15)}
          className={stepperClass}
        >
          <ChevronUp className="h-3 w-3" />
        </button>
        <button
          type="button"
          aria-label={`${label}, 15 minutes earlier`}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => step(-15)}
          className={stepperClass}
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

// ─── Format Summary ──────────────────────────────────────────────────────────

function formatScheduleSummary(schedules: ScheduleBlock[] | null | undefined, timeFormat: '12h' | '24h' = '12h'): string {
  if (!schedules || schedules.length === 0) return 'no schedule configured';
  const use24h = timeFormat === '24h';

  const parts: string[] = [];
  for (const block of schedules) {
    const days = block.days || [];
    const ranges = block.ranges || [];

    if (block.name) {
      parts.push(block.name);
      continue;
    }

    let dayStr: string;
    const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'];
    const weekends = ['sat', 'sun'];

    if (days.length === 7 || (days.length === 0)) {
      dayStr = 'daily';
    } else if (JSON.stringify([...days].sort()) === JSON.stringify([...weekdays].sort())) {
      dayStr = 'weekdays';
    } else if (JSON.stringify([...days].sort()) === JSON.stringify([...weekends].sort())) {
      dayStr = 'weekends';
    } else {
      dayStr = days.map(d => d.slice(0, 3)).join(', ');
    }

    const rangeStr = ranges.map(r => {
      const fmt = (t: string) => {
        const [h, m] = t.split(':').map(Number);
        if (use24h) {
          return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
        }
        const ampm = h >= 12 ? 'pm' : 'am';
        const h12 = h % 12 || 12;
        return m === 0 ? `${h12} ${ampm}` : `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
      };
      return `${fmt(r.start)}\u2013${fmt(r.stop)}`;
    }).join(', ');

    parts.push(`${dayStr} ${rangeStr}`);
  }
  return parts.join(' · ');
}

export { formatScheduleSummary };

// ─── Reusable Schedule Blocks Editor ────────────────────────────────────────
// Shared by the Dialog wrapper below and SchedulePopover.

interface ScheduleBlocksEditorProps {
  blocks: ScheduleBlock[];
  onChange: (blocks: ScheduleBlock[]) => void;
  compact?: boolean;
}

/** Stable colour slot: the block's `colorIndex`, else its position. */
function getBlockColorIndex(block: ScheduleBlock, position: number): number {
  return block.colorIndex ?? position;
}

export function ScheduleBlocksEditor({ blocks, onChange, compact }: ScheduleBlocksEditorProps) {
  const updateBlock = (index: number, updated: ScheduleBlock) => {
    const next = [...blocks];
    next[index] = updated;
    onChange(next);
  };

  const addBlock = () => {
    const usedColors = new Set(blocks.map(b => b.colorIndex ?? -1));
    let nextColor = 0;
    while (usedColors.has(nextColor)) nextColor++;
    onChange([...blocks, { colorIndex: nextColor, days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] }]);
  };

  const removeBlock = (index: number) => {
    onChange(blocks.filter((_, i) => i !== index));
  };

  const updateRange = (blockIndex: number, rangeIndex: number, field: 'start' | 'stop', value: string) => {
    const block = blocks[blockIndex];
    const ranges = [...block.ranges];
    ranges[rangeIndex] = { ...ranges[rangeIndex], [field]: value };
    updateBlock(blockIndex, { ...block, ranges });
  };

  const addRange = (blockIndex: number) => {
    const block = blocks[blockIndex];
    updateBlock(blockIndex, { ...block, ranges: [...block.ranges, { start: '09:00', stop: '17:00' }] });
  };

  const removeRange = (blockIndex: number, rangeIndex: number) => {
    const block = blocks[blockIndex];
    updateBlock(blockIndex, { ...block, ranges: block.ranges.filter((_, i) => i !== rangeIndex) });
  };

  const updateBlockName = (blockIndex: number, name: string) => {
    const block = blocks[blockIndex];
    updateBlock(blockIndex, { ...block, name: name || undefined });
  };

  return (
    <div className="space-y-3">
      {blocks.map((block, blockIndex) => {
        const color = BLOCK_COLORS[getBlockColorIndex(block, blockIndex) % BLOCK_COLORS.length];
        return (
        <div key={blockIndex} className="border border-border rounded-lg p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${color.pill}`} />
              <input
                type="text"
                aria-label="block name"
                value={block.name || ''}
                onChange={(e) => updateBlockName(blockIndex, e.target.value)}
                placeholder={`block ${blockIndex + 1}`}
                className="text-base md:text-sm font-medium bg-background border border-border rounded-md px-2.5 py-1.5 text-foreground placeholder:text-muted-foreground w-full min-w-0 focus:border-muted-foreground transition-colors"
              />
            </div>
            {blocks.length > 1 && (
              <IconButton
                label="remove block"
                variant="ghost-destructive"
                onClick={() => removeBlock(blockIndex)}
                className="size-6 flex-shrink-0"
              >
                <Trash2 className="h-3 w-3" />
              </IconButton>
            )}
          </div>

          {/* Day pills */}
          <DayPillSelector
            value={block.days}
            onChange={(days) => updateBlock(blockIndex, { ...block, days })}
            variant="pill"
            compact={compact}
            activeClassName={`${color.pill} ${color.pillText}`}
          />

          {/* Time ranges */}
          <div className="space-y-2">
            {block.ranges.map((range, rangeIndex) => {
              const isOvernight = range.start > range.stop;
              return (
                <div key={rangeIndex} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <TimePicker
                      label="start time"
                      value={range.start}
                      onChange={(v) => updateRange(blockIndex, rangeIndex, 'start', v)}
                      compact={compact}
                    />
                    <span className="text-muted-foreground text-xs">to</span>
                    <TimePicker
                      label="stop time"
                      value={range.stop}
                      onChange={(v) => updateRange(blockIndex, rangeIndex, 'stop', v)}
                      compact={compact}
                    />
                    {isOvernight && (
                      <span className="text-[10px] font-medium text-warning bg-warning-surface border border-warning-border/75 rounded px-1.5 py-0.5 whitespace-nowrap">
                        +1 day
                      </span>
                    )}
                    {block.ranges.length > 1 && (
                      <IconButton
                        label="remove time range"
                        variant="ghost"
                        onClick={() => removeRange(blockIndex, rangeIndex)}
                        className="size-6 text-muted-foreground hover:text-destructive flex-shrink-0"
                      >
                        <Minus className="h-3 w-3" />
                      </IconButton>
                    )}
                    {/* Add time range button on the last row */}
                    {rangeIndex === block.ranges.length - 1 && (
                      <IconButton
                        label="add time range"
                        variant="ghost"
                        onClick={() => addRange(blockIndex)}
                        className="size-6 text-muted-foreground hover:text-foreground flex-shrink-0"
                      >
                        <Plus className="h-3 w-3" />
                      </IconButton>
                    )}
                  </div>
                  {isOvernight && (
                    <p className="text-[11px] text-warning dark:text-warning/80 pl-0.5">
                      ends the following day — schedule days control when it <em>starts</em>
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        );
      })}

      <Button
        variant="outline"
        size="sm"
        onClick={addBlock}
        className="w-full border-dashed border-border text-muted-foreground hover:text-foreground cursor-pointer"
      >
        <Plus className="h-3 w-3 mr-1" />
        add schedule block
      </Button>
    </div>
  );
}

// ─── Schedule Window Check ───────────────────────────────────────────────────

function isCurrentlyInSchedule(blocks: ScheduleBlock[], timezone?: string): boolean {
  if (!blocks || blocks.length === 0) return true;
  const now = timezone
    ? new Date(new Date().toLocaleString('en-US', { timeZone: timezone }))
    : new Date();
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const currentDay = dayNames[now.getDay()];
  const prevDay = dayNames[(now.getDay() + 6) % 7];
  const currentMins = now.getHours() * 60 + now.getMinutes();
  for (const block of blocks) {
    const days = block.days || dayNames;
    for (const range of block.ranges || []) {
      const [sh, sm] = range.start.split(':').map(Number);
      const [eh, em] = range.stop.split(':').map(Number);
      const startMins = sh * 60 + sm;
      const stopMins = eh * 60 + em;
      if (startMins <= stopMins) {
        if (days.includes(currentDay) && currentMins >= startMins && currentMins <= stopMins) return true;
      } else {
        if (days.includes(currentDay) && currentMins >= startMins) return true;
        if (days.includes(prevDay) && currentMins <= stopMins) return true;
      }
    }
  }
  return false;
}

// ─── Dialog Wrapper ─────────────────────────────────────────────────────────

interface ScheduleEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedules: ScheduleBlock[] | null;
  initialPresetId?: string | null;
  onChange: (schedules: ScheduleBlock[], presetId: string | null) => void;
  siteTimezone?: string;
  /**
   * Whether this site evaluates process windows on the site's clock. Three
   * states and `undefined` is a real one: `undefined` = the site was never
   * asked, `false` = it declined, `true` = site time. Only `true` changes the
   * copy; the other two are the legacy machine-clock wording, byte for byte.
   */
  schedulesFollowSiteTime?: boolean;
  /** `agent_version` of the machine this schedule belongs to; drives the advisory only. */
  targetMachineAgentVersion?: string;
  currentLaunchMode?: 'off' | 'always' | 'scheduled';
  presets?: SchedulePreset[];
  onCreatePreset?: (name: string, blocks: ScheduleBlock[]) => Promise<void>;
  onDeletePreset?: (id: string) => Promise<void>;
  onUpdatePreset?: (id: string, updates: { name?: string; blocks?: ScheduleBlock[] }) => Promise<void>;
}

export default function ScheduleEditor({
  open, onOpenChange, schedules, initialPresetId, onChange, siteTimezone,
  schedulesFollowSiteTime, targetMachineAgentVersion, currentLaunchMode,
  presets, onCreatePreset, onDeletePreset, onUpdatePreset,
}: ScheduleEditorProps) {
  const followsSiteTime = schedulesFollowSiteTime === true;
  // Strictly older, never "unknown": an unparseable or missing `agent_version`
  // yields null from compareVersions and stays quiet. The advisory is copy, not
  // a gate (plan decision D3) — a spurious "needs a newer agent" on a machine
  // that already supports the feature costs more than a missed one.
  const targetBelowMinAgent =
    followsSiteTime &&
    compareVersions(targetMachineAgentVersion, SITE_TIME_MIN_AGENT_VERSION) === -1;
  // Built-ins first, then Firestore customs.
  const builtInAsPresets = BUILT_IN_PRESETS.map((bp, i) => ({
    id: `builtin-${i}`, ...bp, isBuiltIn: true, order: i, createdBy: '', createdAt: null,
  }));
  const customPresets = (presets || []).filter(p => !p.isBuiltIn);
  const displayPresets = [...builtInAsPresets, ...customPresets];

  // Remounts on every open, so useState initializers run fresh.
  const defaultBlocks: ScheduleBlock[] = [{ colorIndex: 0, days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '08:00', stop: '17:00' }] }];
  const initialBlocks = ensureBlockColors(schedules && schedules.length > 0 ? schedules : defaultBlocks);

  const detectedPresetId = (() => {
    if (initialPresetId) return initialPresetId;
    const blocksKey = JSON.stringify(initialBlocks.map(b => ({ days: [...b.days].sort(), ranges: b.ranges })));
    const match = displayPresets.find(p => {
      const presetKey = JSON.stringify(p.blocks.map((b: ScheduleBlock) => ({ days: [...b.days].sort(), ranges: b.ranges })));
      return blocksKey === presetKey;
    });
    return match?.id ?? null;
  })();

  const [blocks, setBlocks] = useState<ScheduleBlock[]>(initialBlocks);
  const [activePresetId, setActivePresetId] = useState<string | null>(detectedPresetId);
  const [savingPreset, setSavingPreset] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editPresetName, setEditPresetName] = useState('');


  const handleSave = () => {
    const valid = blocks.filter(b => b.days.length > 0 && b.ranges.length > 0);
    onChange(valid, activePresetId);
    onOpenChange(false);
  };

  const applyPreset = (preset: SchedulePreset) => {
    // Switching back to the preset the dialog opened on restores the user's
    // saved blocks, not the preset template.
    if (preset.id === detectedPresetId) {
      setBlocks(initialBlocks);
    } else {
      setBlocks(ensureBlockColors(preset.blocks.map(b => ({ ...b, days: [...b.days], ranges: b.ranges.map(r => ({ ...r })) }))));
    }
    setActivePresetId(preset.id);
  };

  const handleCreatePreset = async () => {
    if (!onCreatePreset) return;
    if (!newPresetName.trim()) {
      toast.error('please enter a name for the preset');
      return;
    }
    const valid = blocks.filter(b => b.days.length > 0 && b.ranges.length > 0);
    await onCreatePreset(newPresetName.trim(), valid);
    setNewPresetName('');
    setSavingPreset(false);
  };

  const handleRenamePreset = async () => {
    if (!editingPresetId || !editPresetName.trim() || !onUpdatePreset) return;
    await onUpdatePreset(editingPresetId, { name: editPresetName.trim() });
    setEditingPresetId(null);
    setEditPresetName('');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg border-border text-foreground gap-6">
        <DialogHeader>
          <DialogTitle>configure schedule</DialogTitle>
          {/* Which clock evaluates these windows is a per-site setting
              (`sites/{siteId}.schedulesFollowSiteTime`, agent support since
              3.2.3 — see firebase_client._fetch_site_metadata_from_api). Only
              an explicit `true` earns the source="site" chip; absent and false
              both keep the machine-clock wording BYTE FOR BYTE, because that is
              the state every recorded tutorial frame was shot in.
              The outside-window banner below is independent of all this: it
              stays a *prediction* evaluated in the site tz, which is the best
              predictor either way, since machines live at the site. */}
          {followsSiteTime ? (
            <DialogDescription className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span>times run on the site&rsquo;s clock</span>
              <span data-testid="schedule-editor-site-tz-chip">
                <TimezoneChip tz={siteTimezone} source="site" prefix="" />
              </span>
            </DialogDescription>
          ) : (
            <DialogDescription>times run on each machine&rsquo;s own clock</DialogDescription>
          )}
          {targetBelowMinAgent && (
            <p
              data-testid="schedule-editor-agent-advisory"
              className="text-xs text-warning dark:text-warning/90 bg-warning-surface border border-warning-border/50 rounded-md px-3 py-2"
            >
              this machine runs agent {targetMachineAgentVersion} — site time needs{' '}
              {SITE_TIME_MIN_AGENT_VERSION} or newer. until it updates, it keeps evaluating
              these windows on its own clock.
            </p>
          )}
        </DialogHeader>

        {/* Preset bar.
            Each pill sits in a `relative` wrapper; the per-pill action row
            (update/rename/delete) or inline rename form is absolutely
            positioned under it and centered horizontally, so the actions
            read as belonging to that specific chip without stretching the
            pill's flex slot. The row reserves `pb-10` when a panel is
            attached so the next section doesn't collide with the overlay. */}
        <div className="space-y-1.5">
          {(() => {
            const selectedPreset = activePresetId ? displayPresets.find(p => p.id === activePresetId) : null;
            // Dirty = blocks differ from the selected preset's stored blocks.
            const currentKey = JSON.stringify(blocks.map(b => ({ days: [...b.days].sort(), ranges: b.ranges })));
            const presetKey = selectedPreset
              ? JSON.stringify(selectedPreset.blocks.map((b: ScheduleBlock) => ({ days: [...b.days].sort(), ranges: b.ranges })))
              : '';
            const hasChanges = !!selectedPreset && currentKey !== presetKey;
            const hasAttachedPanel =
              !!selectedPreset &&
              !selectedPreset.isBuiltIn &&
              !!onDeletePreset &&
              !!onUpdatePreset &&
              !savingPreset;

            return (
              <>
                <div
                  className={`flex flex-wrap items-start gap-x-1.5 gap-y-2 ${
                    hasAttachedPanel ? 'pb-10' : ''
                  }`}
                >
                  {displayPresets.map((preset) => {
                    const isActive = activePresetId === preset.id;
                    const isCustom =
                      isActive &&
                      selectedPreset &&
                      !selectedPreset.isBuiltIn &&
                      !!onDeletePreset &&
                      !!onUpdatePreset &&
                      !savingPreset;
                    const showRenameForm = isCustom && editingPresetId === preset.id;
                    const showActions = isCustom && !showRenameForm;
                    return (
                      <div key={preset.id} className="relative">
                        <button
                          type="button"
                          onClick={() => applyPreset(preset)}
                          className={`px-2.5 py-1 rounded-full text-[13px] font-medium transition-colors duration-150 cursor-pointer ${
                            isActive
                              ? 'bg-info-solid/20 text-foreground/90 ring-1 ring-info-solid/40'
                              : 'bg-card-sunken text-muted-foreground hover:bg-accent hover:text-foreground'
                          }`}
                        >
                          {preset.name}
                        </button>

                        {/* Per-pill inline rename form */}
                        {showRenameForm && (
                          <form
                            onSubmit={(e) => { e.preventDefault(); handleRenamePreset(); }}
                            className="absolute left-1/2 top-full z-10 mt-1 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap"
                          >
                            <Input
                              value={editPresetName}
                              onChange={(e) => setEditPresetName(e.target.value)}
                              aria-label="preset name"
                              className="h-7 w-28 text-base md:text-[11px] px-2 bg-background border-border"
                              autoFocus
                            />
                            <IconButton type="submit" label="save name" variant="ghost" className="size-7 text-muted-foreground hover:text-foreground">
                              <Save className="h-3.5 w-3.5" />
                            </IconButton>
                            <IconButton label="cancel rename" variant="ghost" onClick={() => setEditingPresetId(null)} className="size-7 text-muted-foreground hover:text-foreground">
                              <X className="h-3.5 w-3.5" />
                            </IconButton>
                          </form>
                        )}

                        {/* Per-pill action row */}
                        {showActions && selectedPreset && (
                          <div className="absolute left-1/2 top-full z-10 mt-1 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap text-[11px] leading-5 text-muted-foreground">
                            {hasChanges && onUpdatePreset && (
                              <button
                                type="button"
                                onClick={() => {
                                  const valid = blocks.filter(b => b.days.length > 0 && b.ranges.length > 0);
                                  onUpdatePreset(selectedPreset.id, { blocks: valid });
                                }}
                                className="flex items-center gap-1 text-accent-cyan hover:text-accent-cyan-hover cursor-pointer transition-colors"
                              >
                                <Save className="h-3 w-3" />
                                update preset
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => { setEditingPresetId(selectedPreset.id); setEditPresetName(selectedPreset.name); }}
                              className="flex items-center gap-1 hover:text-foreground cursor-pointer transition-colors"
                            >
                              <Pencil className="h-3 w-3" />
                              rename
                            </button>
                            {onDeletePreset && (
                              <button
                                type="button"
                                onClick={() => onDeletePreset(selectedPreset.id)}
                                className="flex items-center gap-1 hover:text-danger cursor-pointer transition-colors"
                              >
                                <Trash2 className="h-3 w-3" />
                                delete
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {/* New preset */}
                  {onCreatePreset && !savingPreset && (
                    <button
                      type="button"
                      onClick={() => setSavingPreset(true)}
                      className="px-2.5 py-1 rounded-full text-[13px] text-muted-foreground/80 hover:text-foreground border border-dashed border-border/70 hover:border-muted-foreground transition-colors duration-150 cursor-pointer"
                    >
                      <Plus className="h-3.5 w-3.5 inline mr-1" />
                      new preset
                    </button>
                  )}
                </div>

                {/* Inline create form — not scoped to any pill, sits below the row. */}
                {savingPreset && onCreatePreset && (
                  <form onSubmit={(e) => { e.preventDefault(); handleCreatePreset(); }} className="flex items-center gap-1.5">
                    <Input
                      value={newPresetName}
                      onChange={(e) => setNewPresetName(e.target.value)}
                      placeholder="preset name"
                      aria-label="preset name"
                      className="h-7 w-28 text-base md:text-[11px] px-2 bg-background border-border"
                      autoFocus
                    />
                    <IconButton type="submit" label="save preset" variant="ghost" className="size-7 text-muted-foreground hover:text-foreground">
                      <Save className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton label="cancel" variant="ghost" onClick={() => { setSavingPreset(false); setNewPresetName(''); }} className="size-7 text-muted-foreground hover:text-foreground">
                      <X className="h-3.5 w-3.5" />
                    </IconButton>
                  </form>
                )}
              </>
            );
          })()}
        </div>

        <div className="max-h-[60dvh] overflow-y-auto pr-1">
          <ScheduleBlocksEditor blocks={blocks} onChange={setBlocks} />
        </div>

        {currentLaunchMode === 'scheduled' && !isCurrentlyInSchedule(blocks, siteTimezone) && (
          <p className="text-xs text-warning dark:text-warning/90 bg-warning-surface border border-warning-border/50 rounded-md px-3 py-2">
            this looks outside the current window — a machine outside it will stop the process shortly after saving.
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="bg-secondary border border-border cursor-pointer">
            cancel
          </Button>
          <Button onClick={handleSave} className="cursor-pointer">
            save schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
