'use client';

import { useState, useEffect } from 'react';
import { useSchedulePresets, type SchedulePreset } from '@/hooks/useSchedulePresets';
import { useSites } from '@/hooks/useFirestore';
import { useAuth } from '@/contexts/AuthContext';
import { formatScheduleSummary } from '@/components/ScheduleEditor';
import WeekSummaryBar from '@/components/WeekSummaryBar';
import SchedulePresetDialog from '@/components/SchedulePresetDialog';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Loader2, Pencil, Trash2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { AdminPageHeader } from '@/components/admin/AdminPageHeader';
import { CompactButton } from '@/components/admin/CompactButton';

export default function SchedulePresetsPage() {
  const { user, isSuperadmin, userSites, userPreferences } = useAuth();
  const { sites } = useSites(user?.uid, userSites, isSuperadmin);

  // Use first site by default
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);

  useEffect(() => {
    if (sites.length > 0 && !selectedSiteId) {
      setSelectedSiteId(sites[0].id);
    }
  }, [sites, selectedSiteId]);

  const {
    presets,
    loading,
    error,
    deletePreset,
  } = useSchedulePresets(selectedSiteId);

  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState<SchedulePreset | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [presetToDelete, setPresetToDelete] = useState<SchedulePreset | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleCreateNew = () => {
    setEditingPreset(null);
    setPresetDialogOpen(true);
  };

  const handleEdit = (preset: SchedulePreset) => {
    setEditingPreset(preset);
    setPresetDialogOpen(true);
  };

  const handleDelete = (preset: SchedulePreset) => {
    setPresetToDelete(preset);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (!presetToDelete) return;
    setDeleting(true);
    try {
      await deletePreset(presetToDelete.id);
      toast.success(`Preset "${presetToDelete.name}" deleted`);
      setDeleteDialogOpen(false);
      setPresetToDelete(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message || 'Failed to delete preset');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex items-center gap-3 text-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span>loading schedule presets...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <p className="text-danger font-medium mb-2">error loading schedule presets</p>
          <p className="text-muted-foreground text-sm">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 md:p-8">
      <div className="max-w-screen-2xl mx-auto">
        <AdminPageHeader
          className="mb-6 md:mb-8"
          title="schedules"
          description="manage reusable schedule presets for process scheduling across machines"
          toolbar={
            sites.length > 1 && (
              <Select value={selectedSiteId || ''} onValueChange={setSelectedSiteId}>
                <SelectTrigger aria-label="site" className="min-w-32 flex-1 sm:w-[180px] sm:flex-none border-border bg-card text-foreground">
                  <SelectValue placeholder="select site" />
                </SelectTrigger>
                <SelectContent className="border-border bg-card text-foreground">
                  {sites.map(site => (
                    <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )
          }
          actions={<CompactButton icon={Plus} label="create preset" onClick={handleCreateNew} />}
        />

        {/* Presets list */}
        {presets.length > 0 && (
          <div className="space-y-3">
            {presets.map((preset) => (
              <div
                key={preset.id}
                className="flex items-center gap-3 p-3 sm:gap-4 sm:p-4 rounded-lg border border-border bg-card"
              >
                {/* a phone gives the name and summary the width; the summary says the same */}
                <WeekSummaryBar schedules={preset.blocks} className="max-sm:hidden" />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-1 mb-1">
                    <span className="min-w-0 text-foreground font-medium">{preset.name}</span>
                    {preset.isBuiltIn && (
                      <Badge className="border-info-border bg-info-surface text-info dark:border-transparent dark:bg-info-solid/20 text-[10px]">built-in</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate max-sm:line-clamp-2 max-sm:whitespace-normal">
                    {preset.description || formatScheduleSummary(preset.blocks, userPreferences.timeFormat || '12h')}
                  </p>
                </div>
                <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
                  <IconButton
                    label={`edit ${preset.name}`}
                    variant="ghost"
                    onClick={() => handleEdit(preset)}
                    className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </IconButton>
                  {!preset.isBuiltIn && (
                    <IconButton
                      label={`delete ${preset.name}`}
                      variant="ghost-destructive"
                      onClick={() => handleDelete(preset)}
                      className="h-8 w-8 cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  )}
                </div>
              </div>
            ))}

          </div>
        )}
      </div>

      {/* Create/Edit Dialog */}
      {selectedSiteId && user?.uid && (
        <SchedulePresetDialog
          open={presetDialogOpen}
          onOpenChange={setPresetDialogOpen}
          preset={editingPreset}
          siteId={selectedSiteId}
          userId={user.uid}
        />
      )}

      {/* Delete Confirmation */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="border-border text-foreground">
          <DialogHeader>
            <DialogTitle>delete schedule preset</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              are you sure you want to delete &quot;{presetToDelete?.name}&quot;? this will not affect processes already using this schedule.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteDialogOpen(false)} className="bg-secondary border border-border cursor-pointer">
              cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
              className="cursor-pointer"
            >
              {deleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
