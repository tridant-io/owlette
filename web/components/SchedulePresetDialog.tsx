'use client';

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScheduleBlocksEditor } from '@/components/ScheduleEditor';
import WeekSummaryBar from '@/components/WeekSummaryBar';
import { DEFAULT_SCHEDULE } from '@/lib/scheduleDefaults';
import { useSchedulePresets, type SchedulePreset } from '@/hooks/useSchedulePresets';
import type { ScheduleBlock } from '@/hooks/useFirestore';
import { toast } from '@/lib/toast';
import { Loader2 } from 'lucide-react';

interface SchedulePresetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset: SchedulePreset | null; // null = create mode
  siteId: string;
  userId: string;
}

export default function SchedulePresetDialog({
  open,
  onOpenChange,
  preset,
  siteId,
  userId,
}: SchedulePresetDialogProps) {
  const { createPreset, updatePreset } = useSchedulePresets(siteId);
  const isEditing = !!preset;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [blocks, setBlocks] = useState<ScheduleBlock[]>(DEFAULT_SCHEDULE);
  const [saving, setSaving] = useState(false);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      if (preset) {
        setName(preset.name);
        setDescription(preset.description || '');
        setBlocks(preset.blocks && preset.blocks.length > 0 ? preset.blocks : DEFAULT_SCHEDULE);
      } else {
        setName('');
        setDescription('');
        setBlocks(DEFAULT_SCHEDULE);
      }
    }
  }, [open, preset]);

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error('Please enter a preset name');
      return;
    }
    const validBlocks = blocks.filter(b => b.days.length > 0 && b.ranges.length > 0);
    if (validBlocks.length === 0) {
      toast.error('Please configure at least one schedule block with days and time ranges');
      return;
    }

    setSaving(true);
    try {
      // Firestore rejects `undefined` field values — only include description
      // when the user actually entered one. Without this guard, submitting
      // with an empty description throws `setDoc() called with invalid data`.
      const trimmedDescription = description.trim();
      const descriptionPatch = trimmedDescription ? { description: trimmedDescription } : {};

      if (isEditing) {
        await updatePreset(preset!.id, {
          name: name.trim(),
          ...descriptionPatch,
          blocks: validBlocks,
        });
        toast.success(`Preset "${name.trim()}" updated`);
      } else {
        await createPreset({
          name: name.trim(),
          ...descriptionPatch,
          blocks: validBlocks,
          isBuiltIn: false,
          order: 99,
          createdBy: userId,
        });
        toast.success(`Preset "${name.trim()}" created`);
      }
      onOpenChange(false);
    } catch (error: unknown) {
      console.error('Failed to save schedule preset:', error);
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message || 'Failed to save preset');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg border-border text-foreground">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Schedule Preset' : 'Create Schedule Preset'}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {isEditing ? 'Update this schedule preset' : 'Create a reusable schedule preset for your processes'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="schedule-preset-name" className="text-foreground text-sm">Name</Label>
            <Input
              id="schedule-preset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Business Hours, Night Shift"
              className="border-border bg-background text-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="schedule-preset-description" className="text-foreground text-sm">Description</Label>
            <Input
              id="schedule-preset-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              className="border-border bg-background text-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-foreground text-sm">Schedule</Label>
            <div className="flex items-center gap-3 mb-2">
              <WeekSummaryBar schedules={blocks} />
            </div>
            <div className="max-h-[250px] overflow-y-auto pr-1">
              <ScheduleBlocksEditor blocks={blocks} onChange={setBlocks} compact />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="bg-secondary border border-border cursor-pointer">
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving}
            className="cursor-pointer"
          >
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {isEditing ? 'Save Changes' : 'Create Preset'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
