'use client';

import { useState } from 'react';
import { useSystemPresets, type SystemPreset } from '@/hooks/useSystemPresets';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Plus, Loader2, Pencil, Trash2, Package } from 'lucide-react';
import { toast } from '@/lib/toast';
import SystemPresetDialog from '@/components/SystemPresetDialog';

/**
 * System Presets Admin Page
 *
 * Admin-only page for managing software deployment presets.
 * Allows admins to:
 * - View all system presets
 * - Create new presets
 * - Edit existing presets
 * - Delete presets
 */
export default function SystemPresetsPage() {
  const {
    presets,
    loading,
    error,
    deletePreset,
    categories,
  } = useSystemPresets();

  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState<SystemPreset | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [presetToDelete, setPresetToDelete] = useState<SystemPreset | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>('All');

  const handleCreateNew = () => {
    setEditingPreset(null);
    setPresetDialogOpen(true);
  };

  const handleEdit = (preset: SystemPreset) => {
    setEditingPreset(preset);
    setPresetDialogOpen(true);
  };

  const handleDelete = (preset: SystemPreset) => {
    setPresetToDelete(preset);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (!presetToDelete) return;

    setDeleting(true);

    try {
      await deletePreset(presetToDelete.id);
      toast.success('Preset Deleted', {
        description: `"${presetToDelete.name}" has been deleted.`,
      });
      setDeleteDialogOpen(false);
      setPresetToDelete(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('Delete Failed', {
        description: message || 'Failed to delete preset.',
      });
    } finally {
      setDeleting(false);
    }
  };

  // Filter presets by selected category
  const filteredPresets = selectedCategory === 'All'
    ? presets
    : presets.filter(p => p.category === selectedCategory);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex items-center gap-3 text-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span>loading presets...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <p className="text-danger font-medium mb-2">error loading presets</p>
          <p className="text-muted-foreground text-sm">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="max-w-screen-2xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold text-foreground mb-2">template library</h1>
              <p className="text-muted-foreground">
                Admin-curated software catalog for deployments (TouchDesigner, VLC, owlette Agent, etc.)
              </p>
            </div>
            <Button
              onClick={handleCreateNew}
              className="cursor-pointer"
            >
              <Plus className="h-5 w-5 mr-2" />
              add template
            </Button>
          </div>

          {/* Category Filter Tabs */}
          <div className="flex gap-2 flex-wrap">
            <Button
              variant={selectedCategory === 'All' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setSelectedCategory('All')}
              aria-pressed={selectedCategory === 'All'}
              className={
                selectedCategory === 'All'
                  ? 'cursor-pointer'
                  : 'border-border bg-card text-foreground hover:bg-accent! hover:text-foreground! cursor-pointer'
              }
            >
              all ({presets.length})
            </Button>
            {categories.map(category => {
              const count = presets.filter(p => p.category === category).length;
              return (
                <Button
                  key={category}
                  variant={selectedCategory === category ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSelectedCategory(category)}
                  aria-pressed={selectedCategory === category}
                  className={
                    selectedCategory === category
                      ? 'cursor-pointer'
                      : 'border-border bg-card text-foreground hover:bg-accent! hover:text-foreground! cursor-pointer'
                  }
                >
                  {category} ({count})
                </Button>
              );
            })}
          </div>
        </div>

        {/* Presets Table/Grid */}
        {filteredPresets.length === 0 ? (
          <div className="bg-card border border-border rounded-lg p-12 text-center">
            <Package className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
            <h2 className="text-xl font-medium text-foreground mb-2">no presets found</h2>
            <p className="text-muted-foreground mb-6">
              {selectedCategory === 'All'
                ? 'Create your first system preset to get started.'
                : `No presets found in "${selectedCategory}" category.`}
            </p>
            {selectedCategory === 'All' && (
              <Button
                onClick={handleCreateNew}
                className="cursor-pointer"
              >
                <Plus className="h-5 w-5 mr-2" />
                add first preset
              </Button>
            )}
          </div>
        ) : (
          <>
            {/* Desktop Table View (hidden on mobile) */}
            <div className="hidden lg:block bg-card border border-border rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-muted/50 border-b border-border">
                    <tr>
                      <th className="px-4 xl:px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        preset
                      </th>
                      <th className="px-4 xl:px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        category
                      </th>
                      <th className="px-4 xl:px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        installer
                      </th>
                      <th className="hidden xl:table-cell px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        flags
                      </th>
                      <th className="px-4 xl:px-6 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredPresets.map((preset) => (
                      <tr key={preset.id} className="hover:bg-muted/50 transition-colors">
                        <td className="px-4 xl:px-6 py-3">
                          <div className="flex items-center gap-3 min-w-0">
                            {preset.icon && (
                              <span className="text-2xl flex-shrink-0">{preset.icon}</span>
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline gap-2 flex-wrap">
                                <p className="text-foreground font-medium text-sm">{preset.software_name}</p>
                                <p className="text-muted-foreground text-sm">{preset.name}</p>
                              </div>
                              {preset.is_owlette_agent && (
                                <Badge variant="outline" className="mt-1 border-accent-cyan/50 text-accent-cyan text-xs">
                                  Auto-update
                                </Badge>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 xl:px-6 py-3">
                          <Badge variant="outline" className="border-border text-foreground text-xs whitespace-nowrap">
                            {preset.category}
                          </Badge>
                        </td>
                        <td className="px-4 xl:px-6 py-3">
                          <p className="text-foreground text-sm font-mono truncate max-w-[200px]">{preset.installer_name}</p>
                          {preset.installer_url && (
                            <p className="text-muted-foreground text-xs truncate max-w-[200px]">
                              {preset.installer_url.substring(0, 40)}...
                            </p>
                          )}
                        </td>
                        <td className="hidden xl:table-cell px-6 py-3">
                          <p className="text-muted-foreground text-xs font-mono truncate max-w-[150px]" title={preset.silent_flags}>
                            {preset.silent_flags}
                          </p>
                        </td>
                        <td className="px-4 xl:px-6 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleEdit(preset)}
                              aria-label={`edit ${preset.name}`}
                              className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost-destructive"
                              size="icon"
                              onClick={() => handleDelete(preset)}
                              aria-label={`delete ${preset.name}`}
                              className="h-8 w-8 cursor-pointer"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile Card View */}
            <div className="lg:hidden space-y-4">
              {filteredPresets.map((preset) => (
                <div key={preset.id} className="bg-card border border-border rounded-lg p-4 hover:border-muted-foreground transition-colors">
                  {/* Header with Icon and Name */}
                  <div className="flex items-start gap-3 mb-3">
                    {preset.icon && (
                      <span className="text-3xl flex-shrink-0">{preset.icon}</span>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <div>
                          <h2 className="text-foreground font-medium text-base">{preset.software_name}</h2>
                          <p className="text-muted-foreground text-sm">{preset.name}</p>
                        </div>
                        <Badge variant="outline" className="border-border text-foreground text-xs whitespace-nowrap">
                          {preset.category}
                        </Badge>
                      </div>
                      {preset.is_owlette_agent && (
                        <Badge variant="outline" className="border-accent-cyan/50 text-accent-cyan text-xs">
                          Auto-update
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Details */}
                  <div className="space-y-2 text-sm mb-3">
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Installer</p>
                      <p className="text-foreground font-mono text-xs break-all">{preset.installer_name}</p>
                    </div>
                    {preset.installer_url && (
                      <div>
                        <p className="text-muted-foreground text-xs mb-1">URL</p>
                        <p className="text-muted-foreground text-xs truncate">{preset.installer_url}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Flags</p>
                      <p className="text-muted-foreground text-xs font-mono break-all">{preset.silent_flags}</p>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2 pt-3 border-t border-border">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEdit(preset)}
                      aria-label={`edit ${preset.name}`}
                      className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost-destructive"
                      size="icon"
                      onClick={() => handleDelete(preset)}
                      aria-label={`delete ${preset.name}`}
                      className="h-8 w-8 cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Create/Edit Preset Dialog */}
        <SystemPresetDialog
          open={presetDialogOpen}
          onOpenChange={setPresetDialogOpen}
          preset={editingPreset}
        />

        {/* Delete Confirmation Dialog */}
        <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <DialogContent className="border-border text-foreground">
            <DialogHeader>
              <DialogTitle>delete preset</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Are you sure you want to delete &quot;{presetToDelete?.name}&quot;? This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => {
                  setDeleteDialogOpen(false);
                  setPresetToDelete(null);
                }}
                disabled={deleting}
                className="bg-secondary border border-border cursor-pointer"
              >
                cancel
              </Button>
              <Button
                variant="destructive"
                onClick={confirmDelete}
                disabled={deleting}
                className="cursor-pointer"
              >
                {deleting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  'delete preset'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
