'use client';

/**
 * Modal for editing one monitor in the admin-authored "assigned" display
 * layout. Pure controlled component: no Firestore, no hooks beyond local form
 * state — the parent owns the list and persists what `onSave` returns.
 */

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import type { MonitorInfo } from '@/hooks/useDisplayState';

interface DisplayEditorDialogProps {
  /** The monitor being edited. Null when the dialog is not tied to a row. */
  monitor: MonitorInfo | null;
  /** Controls dialog visibility. */
  open: boolean;
  /** Called when the dialog should close (cancel, escape, overlay click, save). */
  onClose: () => void;
  /** Called with a Partial<MonitorInfo> containing only the changed fields. */
  onSave: (changes: Partial<MonitorInfo>) => void;
}

const ROTATION_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '0°' },
  { value: 90, label: '90°' },
  { value: 180, label: '180°' },
  { value: 270, label: '270°' },
];

const SCALE_OPTIONS: ReadonlyArray<number> = [100, 125, 150, 175, 200];

/** Coerce an <input type="number"> value to an int; garbage → 0, never NaN. */
function toInt(raw: string): number {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Partial<MonitorInfo> of changed fields only, in form order so a logged or
 * previewed diff reads in the same sequence as the UI.
 */
function computeChanges(
  original: MonitorInfo,
  next: {
    resolution: { width: number; height: number };
    refreshHz: number;
    rotation: number;
    position: { x: number; y: number };
    primary: boolean;
    scalePct: number;
  },
): Partial<MonitorInfo> {
  const changes: Partial<MonitorInfo> = {};
  if (
    next.resolution.width !== original.resolution.width ||
    next.resolution.height !== original.resolution.height
  ) {
    changes.resolution = next.resolution;
  }
  if (next.refreshHz !== original.refreshHz) changes.refreshHz = next.refreshHz;
  if (next.rotation !== original.rotation) changes.rotation = next.rotation;
  if (
    next.position.x !== original.position.x ||
    next.position.y !== original.position.y
  ) {
    changes.position = next.position;
  }
  if (next.primary !== original.primary) changes.primary = next.primary;
  if (next.scalePct !== original.scalePct) changes.scalePct = next.scalePct;
  return changes;
}

export function DisplayEditorDialog({
  monitor,
  open,
  onClose,
  onSave,
}: DisplayEditorDialogProps) {
  // Flat local state, re-seeded when the target monitor changes. Reset during
  // render (tracking source identity) rather than in a useEffect — that avoids
  // the cascading render. https://react.dev/reference/react/useState
  const [resolution, setResolution] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const [refreshHz, setRefreshHz] = useState<number>(60);
  const [rotation, setRotation] = useState<number>(0);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [primary, setPrimary] = useState<boolean>(false);
  const [scalePct, setScalePct] = useState<number>(100);
  const [seededFor, setSeededFor] = useState<MonitorInfo | null>(null);

  if (monitor !== seededFor) {
    // Called during render: React flushes these synchronous updates before
    // commit, so the output already reflects the new monitor.
    setResolution(monitor ? monitor.resolution : { width: 0, height: 0 });
    setRefreshHz(monitor ? monitor.refreshHz : 60);
    setRotation(monitor ? monitor.rotation : 0);
    setPosition(monitor ? monitor.position : { x: 0, y: 0 });
    setPrimary(monitor ? monitor.primary : false);
    setScalePct(monitor ? monitor.scalePct : 100);
    setSeededFor(monitor);
  }

  const changes = monitor
    ? computeChanges(monitor, {
        resolution,
        refreshHz,
        rotation,
        position,
        primary,
        scalePct,
      })
    : {};
  const hasChanges = Object.keys(changes).length > 0;

  const handleSave = () => {
    if (!monitor || !hasChanges) return;
    onSave(changes);
    onClose();
  };

  // Radix reports open state through one callback; anything but "opening" is a
  // user close (escape, overlay click, X).
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border text-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-foreground">edit display</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {/* friendlyName is a vendor-supplied product name — exempt from
                the lowercase UI copy rule per CLAUDE.md. */}
            {monitor?.friendlyName || monitor?.id || 'unknown'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            {/* Resolution — width × height */}
            <div className="space-y-2">
              <Label htmlFor="display-resolution-width" className="text-foreground">
                resolution
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="display-resolution-width"
                  type="number"
                  min={0}
                  value={resolution.width}
                  onChange={(e) =>
                    setResolution((prev) => ({ ...prev, width: toInt(e.target.value) }))
                  }
                  className="border-border bg-background text-foreground"
                  aria-label="resolution width"
                />
                <span
                  aria-hidden="true"
                  className="text-muted-foreground text-sm select-none"
                >
                  x
                </span>
                <Input
                  id="display-resolution-height"
                  type="number"
                  min={0}
                  value={resolution.height}
                  onChange={(e) =>
                    setResolution((prev) => ({
                      ...prev,
                      height: toInt(e.target.value),
                    }))
                  }
                  className="border-border bg-background text-foreground"
                  aria-label="resolution height"
                />
              </div>
            </div>

            {/* Refresh rate */}
            <div className="space-y-2">
              <Label htmlFor="display-refresh-hz" className="text-foreground">
                refresh rate
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="display-refresh-hz"
                  type="number"
                  min={0}
                  value={refreshHz}
                  onChange={(e) => setRefreshHz(toInt(e.target.value))}
                  className="border-border bg-background text-foreground"
                />
                <span className="text-muted-foreground text-sm select-none">hz</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Rotation */}
            <div className="space-y-2">
              <Label htmlFor="display-rotation" className="text-foreground">
                rotation
              </Label>
              <Select
                value={String(rotation)}
                onValueChange={(value) => setRotation(toInt(value))}
              >
                <SelectTrigger
                  id="display-rotation"
                  className="border-border bg-background text-foreground"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-border bg-background text-foreground">
                  {ROTATION_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={String(opt.value)}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Scale */}
            <div className="space-y-2">
              <Label htmlFor="display-scale" className="text-foreground">
                scale
              </Label>
              <Select
                value={String(scalePct)}
                onValueChange={(value) => setScalePct(toInt(value))}
              >
                <SelectTrigger
                  id="display-scale"
                  className="border-border bg-background text-foreground"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-border bg-background text-foreground">
                  {SCALE_OPTIONS.map((pct) => (
                    <SelectItem key={pct} value={String(pct)}>
                      {pct}%
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Position x / y */}
          <div className="space-y-2">
            <Label htmlFor="display-position-x" className="text-foreground">
              position (x, y)
            </Label>
            <div className="grid grid-cols-2 gap-4">
              <Input
                id="display-position-x"
                type="number"
                value={position.x}
                onChange={(e) =>
                  setPosition((prev) => ({ ...prev, x: toInt(e.target.value) }))
                }
                className="border-border bg-background text-foreground"
                aria-label="position x"
              />
              <Input
                id="display-position-y"
                type="number"
                value={position.y}
                onChange={(e) =>
                  setPosition((prev) => ({ ...prev, y: toInt(e.target.value) }))
                }
                className="border-border bg-background text-foreground"
                aria-label="position y"
              />
            </div>
          </div>

          {/* Primary display toggle */}
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="display-primary" className="text-foreground">
              primary display
            </Label>
            <Switch
              id="display-primary"
              checked={primary}
              onCheckedChange={setPrimary}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            className="bg-secondary border border-border cursor-pointer"
          >
            cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!monitor || !hasChanges}
            className="cursor-pointer"
          >
            save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
