'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FolderArchive, Loader2, Pencil, Plus, Save, Trash2, TriangleAlert, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useMachines } from '@/hooks/useFirestore';
import {
  useProjectDistributionPresets,
  type ProjectDistributionPreset,
} from '@/hooks/useProjectDistributionPresets';
import { Badge } from '@/components/ui/badge';
import { sanitizeError } from '@/lib/errorHandler';
import { FolderDropzone } from '@/components/FolderDropzone';
import { PreUploadSummary } from '@/components/PreUploadSummary';
import type { NamedBlob } from '@/lib/chunking';
import { summariseVersion } from '@/lib/chunking';
import {
  resolveExtractPath,
  isLikelyAllowed,
  isPosixPathOnWindowsTargets,
} from '@/lib/extractPath';
import type { MachineOsFamily } from '@/lib/machineOs';
import {
  formatBytes,
  summariseRawFiles,
  type PreUploadTarget,
} from '@/lib/preUploadCheck';
import {
  useRoostUpload,
  type UseRoostUploadApi,
  type UploadInputs,
} from '@/hooks/useRoostUpload';

/**
 * "+ new version" pre-fill — targets an EXISTING roost: name/extractPath/
 * targets are LOCKED, only file picker + description are editable. Submit runs
 * the same `uploadFolder` pipeline but skips the create-distribution write.
 */
export interface NewVersionContext {
  roostId: string;
  name: string;
  extractPath?: string;
  targets: string[];
  /** Auto-incrementing number of the current version, for the title copy. */
  currentVersionNumber: number | null;
}

interface ProjectDistributionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  /**
   * Owned by the parent page so a multi-GB run survives dismissing the dialog.
   * Omitted = dialog-local fallback (tests).
   */
  upload?: UseRoostUploadApi;
  /** Set = "+ new version" mode; omitted = "new roost" mode. */
  newVersion?: NewVersionContext;
  /** Existing roost ids, for slug-collision detection in "new roost" mode. */
  existingRoostIds?: string[];
}

/**
 * Distribution name → firestore doc id. The server validator requires 8-64
 * chars (api/_shared.ts RESOURCE_ID_RE); short slugs are padded
 * deterministically so repeat deploys of the same name share version history.
 */
function slugify(s: string): string {
  const core = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  if (core.length >= 8) return core;
  return `${core || 'roost'}-roost-folder`.slice(0, 64);
}

/** Short byte formatter for toast copy. */
function formatBytesShort(n: number): string {
  if (!isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** Compact duration formatter for ETA ("2m 14s", "42s", "1h 5m"). */
function formatDurationShort(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

/**
 * Which allowlist the extract-path warning is measured against. Machines carry
 * no `osFamily` yet, and an absent one is windows.
 */
const TARGET_OS_FAMILIES: ReadonlySet<MachineOsFamily> = new Set(['windows']);

/** Stable key for detecting whether current form matches a preset's config. */
function presetConfigKey(extractPath: string | undefined): string {
  return JSON.stringify({ extract_path: extractPath || '' });
}

export default function ProjectDistributionDialog({
  open,
  onOpenChange,
  siteId,
  upload: externalUpload,
  newVersion,
  existingRoostIds,
}: ProjectDistributionDialogProps) {
  const isNewVersion = !!newVersion;
  const { machines } = useMachines(siteId);
  const { presets, createPreset, updatePreset, deletePreset } = useProjectDistributionPresets(siteId);

  // Fallback hook for standalone renders (tests). Safe despite looking
  // conditional: the prop is fixed for a component's lifetime.
  const localUpload = useRoostUpload();
  const upload: UseRoostUploadApi = externalUpload ?? localUpload;

  const [distributionName, setDistributionName] = useState('');
  const [description, setDescription] = useState('');
  const MAX_DESCRIPTION_LENGTH = 500;
  // useState's lazy initializer, not useMemo: picking randomly is impure, and
  // the hooks purity rule (rightly) rejects impure memo bodies. State init runs
  // once per mount, which is the behavior the joke placeholder always wanted.
  const [namePlaceholder] = useState(() => {
    const examples = [
      'e.g., summer vibes (final final v3)',
      'e.g., lobby loop — do not delete',
      'e.g., the one that actually works',
      'e.g., tuesday\'s revenge',
      'e.g., definitely not last minute',
      'e.g., client approved this one',
      'e.g., conference room b (rip conference room a)',
      'e.g., untitled masterpiece',
      'e.g., please work please work',
    ];
    return examples[Math.floor(Math.random() * examples.length)];
  });
  const [extractPath, setExtractPath] = useState('');
  const [selectedMachines, setSelectedMachines] = useState<Set<string>>(new Set());

  // FolderDropzone output; execution lives on the `upload` hook, not here.
  const [droppedFiles, setDroppedFiles] = useState<NamedBlob[] | null>(null);
  const [droppedRootName, setDroppedRootName] = useState<string>('');
  // Set while the PreUploadSummary confirmation gate is showing. Holds the FULL
  // UploadInputs so later form edits can't leak into the confirmed run.
  const [pendingKickoff, setPendingKickoff] = useState<UploadInputs | null>(null);

  const uploadProgress = upload.state.progress;
  const uploading = upload.state.status === 'uploading';

  // Preset bar state (mirrors RestartScheduleDialog).
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [savingNewPreset, setSavingNewPreset] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editPresetName, setEditPresetName] = useState('');
  const [confirmDeletePresetId, setConfirmDeletePresetId] = useState<string | null>(null);
  const [pendingReplacePreset, setPendingReplacePreset] = useState<ProjectDistributionPreset | null>(null);

  // idle = nothing pending; saving = write in flight; saved = briefly, then idle.
  const [autosaveStatus, setAutosaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  // Set by applyPreset so the resulting field updates don't write straight back.
  const suppressNextAutosaveRef = useRef(false);

  const allMachinesSelected = selectedMachines.size === machines.length && machines.length > 0;
  const onlineMachines = machines.filter(m => m.online);

  // Reset form on open. Deliberately does NOT reset the upload hook — reopening
  // mid-run must resume rendering progress; the hook resets on its own start().
  useEffect(() => {
    if (!open) return;
    // Reset-on-open predates the compiler rules; the sanctioned fix is
    // remounting via a key at the call site — a caller-side refactor
    // (repo-cleanup follow-up), not a change to smuggle into this commit.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActivePresetId(null);
    setSavingNewPreset(false);
    setNewPresetName('');
    setEditingPresetId(null);
    setConfirmDeletePresetId(null);
    setPendingReplacePreset(null);
    setDescription('');
    setPendingKickoff(null);
    // "+ new version": name, extract path and targets are locked to the roost.
    if (newVersion) {
      setDistributionName(newVersion.name);
      setExtractPath(newVersion.extractPath ?? '');
      setSelectedMachines(new Set(newVersion.targets));
    }
    // Keep droppedFiles + name while live so reopening shows the same chip.
    if (upload.state.status !== 'uploading') {
      setDroppedFiles(null);
      setDroppedRootName('');
    }
  }, [open, upload.state.status, newVersion]);

  // Debounced autosave into the active non-builtin preset. Built-ins excluded so
  // editing one doesn't silently create an override; the suppress ref kills the
  // echo write right after applyPreset.
  //
  // Deliberately NO auto-detect effect flipping activePresetId from field
  // contents — deselecting on divergence would cancel in-flight autosaves.
  useEffect(() => {
    if (!open) return;
    if (suppressNextAutosaveRef.current) {
      suppressNextAutosaveRef.current = false;
      return;
    }
    if (!activePresetId) return;
    const preset = presets.find(p => p.id === activePresetId);
    if (!preset || preset.isBuiltIn) return;

    // Skip when current values already match the preset (no diff to write).
    const currentKey = presetConfigKey(extractPath || undefined);
    const presetKey = presetConfigKey(preset.extract_path);
    if (currentKey === presetKey) return;

    // Queue only; "saving" flips when the Firestore call is actually in flight,
    // so the indicator doesn't blink on every keystroke.
    const handle = setTimeout(async () => {
      setAutosaveStatus('saving');
      try {
        await updatePreset(preset.id, {
          extract_path: extractPath || undefined,
        });
        setAutosaveStatus('saved');
        // Drop "saved" so it doesn't linger and imply pending changes.
        setTimeout(() => setAutosaveStatus('idle'), 1500);
      } catch (err) {
        setAutosaveStatus('idle');
        toast.error('failed to save preset', { description: sanitizeError(err) });
      }
    }, 800);

    return () => clearTimeout(handle);
  }, [open, activePresetId, extractPath, presets, updatePreset]);

  const applyPreset = async (preset: ProjectDistributionPreset) => {
    // Re-clicking the active preset deselects it (the escape hatch, now that
    // auto-detect is gone). Fields keep their values.
    if (activePresetId === preset.id) {
      setActivePresetId(null);
      return;
    }

    // Flush the outgoing preset first: changing activePresetId runs the effect
    // cleanup, which would drop edits still inside the 800ms debounce window.
    const outgoing = activePresetId ? presets.find(p => p.id === activePresetId) : null;
    if (outgoing && !outgoing.isBuiltIn) {
      const currentKey = presetConfigKey(extractPath || undefined);
      const outgoingKey = presetConfigKey(outgoing.extract_path);
      if (currentKey !== outgoingKey) {
        setAutosaveStatus('saving');
        try {
          await updatePreset(outgoing.id, {
            extract_path: extractPath || undefined,
          });
        } catch (err) {
          // Don't block the switch on failure, but say so — values are stale.
          toast.error('failed to save preset before switching', {
            description: sanitizeError(err),
          });
        }
        setAutosaveStatus('idle');
      }
    }

    // A switch fully replaces fields, clearing ones the new preset lacks —
    // otherwise old values bleed in and look stuck. Name stays per-deployment.
    setExtractPath(preset.extract_path || '');
    setActivePresetId(preset.id);
    // These values came FROM the preset; don't write them straight back.
    suppressNextAutosaveRef.current = true;
  };

  const handleCreatePreset = async () => {
    if (!newPresetName.trim()) {
      toast.error('please enter a name for the preset');
      return;
    }

    // Name collision → replace-confirm flow.
    const trimmedName = newPresetName.trim();
    const existing = presets.find(p => p.name.toLowerCase() === trimmedName.toLowerCase());
    if (existing) {
      setPendingReplacePreset(existing);
      return;
    }

    try {
      await createPreset({
        name: trimmedName,
        extract_path: extractPath || undefined,
        isBuiltIn: false,
        order: 100,
        createdBy: '',
      });
      toast.success('preset saved');
      setNewPresetName('');
      setSavingNewPreset(false);
    } catch (err) {
      toast.error('failed to save preset', { description: sanitizeError(err) });
    }
  };

  const handleConfirmReplace = async () => {
    if (!pendingReplacePreset) return;
    try {
      await updatePreset(pendingReplacePreset.id, {
        extract_path: extractPath || undefined,
      });
      toast.success(`preset "${pendingReplacePreset.name}" replaced`);
      setPendingReplacePreset(null);
      setNewPresetName('');
      setSavingNewPreset(false);
      setActivePresetId(pendingReplacePreset.id);
    } catch (err) {
      toast.error('failed to replace preset', { description: sanitizeError(err) });
    }
  };

  const handleRenamePreset = async () => {
    if (!editingPresetId || !editPresetName.trim()) return;
    try {
      await updatePreset(editingPresetId, { name: editPresetName.trim() });
      setEditingPresetId(null);
      setEditPresetName('');
    } catch (err) {
      toast.error('failed to rename preset', { description: sanitizeError(err) });
    }
  };

  const toggleMachine = (machineId: string) => {
    const newSelected = new Set(selectedMachines);
    if (newSelected.has(machineId)) {
      newSelected.delete(machineId);
    } else {
      newSelected.add(machineId);
    }
    setSelectedMachines(newSelected);
  };

  const toggleAllMachines = () => {
    if (allMachinesSelected) {
      setSelectedMachines(new Set());
    } else {
      setSelectedMachines(new Set(machines.map(m => m.machineId)));
    }
  };

  const selectOnlyOnlineMachines = () => {
    setSelectedMachines(new Set(onlineMachines.map(m => m.machineId)));
  };

  const selectedPreset = activePresetId ? presets.find(p => p.id === activePresetId) : null;

  // Shared kickoff for "upload" and "upload + distribute", running the roost
  // orchestrator (chunk → check → upload → finalize) on `useRoostUpload`.
  // withTargets=false publishes the roost with no target_state docs, so no agent
  // picks it up until the user distributes later; otherwise the fan-out cloud
  // function dispatches sync_pull to the targets on the roost doc.
  const startUpload = (withTargets: boolean) => {
    if (!droppedFiles || droppedFiles.length === 0) {
      toast.error('drop a folder first');
      return;
    }
    if (!distributionName.trim()) {
      toast.error('please provide a roost name');
      return;
    }
    if (withTargets && selectedMachines.size === 0) {
      toast.error('select at least one target machine');
      return;
    }

    // "new roost" must mean a new doc: disambiguate a taken slug, or the upload
    // lands as a new VERSION of the existing roost (slugify is deterministic on
    // purpose, for CI/CD reuse).
    const baseRoostId = slugify(distributionName) || droppedRootName || 'roost-folder';
    const taken = new Set(existingRoostIds ?? []);
    let resolvedRoostId = baseRoostId;
    if (!isNewVersion && taken.has(baseRoostId)) {
      let n = 2;
      while (taken.has(`${baseRoostId}-${n}`)) n++;
      resolvedRoostId = `${baseRoostId}-${n}`;
      toast.info(
        `a roost named "${distributionName.trim()}" already exists — creating "${resolvedRoostId}" as a separate roost. cancel and use "+ new version" on the existing roost if you wanted to add to it.`,
        { duration: 8000 },
      );
    }

    const totalBytes = droppedFiles.reduce((n, f) => n + f.blob.size, 0);

    // Stage for the PreUploadSummary gate: without it a mistyped folder pick or
    // a full-disk target burns bandwidth and only fails mid-sync at the agent
    // (codex audit #8, security-boundary punchlist).
    setPendingKickoff({
      siteId,
      roostId: isNewVersion ? newVersion!.roostId : resolvedRoostId,
      files: droppedFiles,
      name: distributionName.trim(),
      targets: withTargets ? Array.from(selectedMachines) : [],
      extractPath: extractPath.trim() ? resolveExtractPath(extractPath) : undefined,
      description: description.trim() || undefined,
      totalBytes,
      fileCount: droppedFiles.length,
    });
  };

  const handleUploadOnly = () => startUpload(false);
  const handleUploadDistribute = async () => startUpload(true);

  // Free bytes per selected machine, SUMMED across volumes (free = totalGb -
  // usedGb; volumes missing either number are skipped, and if none have both,
  // freeDiskBytes stays undefined so the summary warns instead of showing 0).
  //
  // The sum is deliberately not the destination volume alone: extract_root
  // usually lands on C:, so a 50GB roost fitting across all drives may still not
  // fit. The agent catches the per-volume failure; this only blocks the obvious.
  const summaryTargets = React.useMemo<PreUploadTarget[]>(() => {
    if (!pendingKickoff) return [];
    return pendingKickoff.targets.map((machineId) => {
      const m = machines.find((x) => x.machineId === machineId);
      const disks = m?.devices?.disks ?? [];
      let totalFreeGb = 0;
      let anyKnown = false;
      for (const d of disks) {
        if (typeof d.totalGb === 'number' && typeof d.usedGb === 'number') {
          totalFreeGb += Math.max(0, d.totalGb - d.usedGb);
          anyKnown = true;
        }
      }
      return {
        machineId,
        name: machineId,
        freeDiskBytes: anyKnown ? Math.round(totalFreeGb * 1024 ** 3) : undefined,
      };
    });
  }, [pendingKickoff, machines]);

  const summarySize = React.useMemo(
    () => (pendingKickoff ? summariseRawFiles(pendingKickoff.files) : undefined),
    [pendingKickoff],
  );

  // Fire-and-forget: the hook tracks progress; the effect below toasts the
  // terminal state.
  const handleConfirmKickoff = () => {
    if (!pendingKickoff) return;
    const inputs = pendingKickoff;
    setPendingKickoff(null);
    upload.start(inputs);
  };

  const handleCancelKickoff = () => {
    setPendingKickoff(null);
  };

  // Toast here, not in handleUploadDistribute: the dialog may be dismissed by
  // the time the hook resolves. lastReportedStatusRef dedupes across renders.
  const lastReportedStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const status = upload.state.status;
    if (status === lastReportedStatusRef.current) return;
    lastReportedStatusRef.current = status;
    if (status === 'success' && upload.state.result) {
      const result = upload.state.result;
      const versionLabel =
        result.versionNumber > 0
          ? `v${result.versionNumber}`
          : result.versionId.slice(0, 12);
      toast.success(
        `roost published — ${versionLabel}` +
          ` (uploaded ${formatBytesShort(result.uploadedBytes)} of ${formatBytesShort(result.totalBytes)})`,
      );
      // Clear per-deploy inputs so a follow-up roost starts clean. This effect
      // IS the subscription to the upload hook's state machine (ref-deduped);
      // the sanctioned fix is an onSuccess callback on the hook's API
      // (repo-cleanup follow-up).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDistributionName('');
      setExtractPath('');
      setDroppedFiles(null);
      setDroppedRootName('');
      setSelectedMachines(new Set());
      // Close on success if still open; the minimized card flashes "synced".
      if (open) onOpenChange(false);
    } else if (status === 'error' && upload.state.error) {
      toast.error('upload failed', { description: upload.state.error });
    }
  }, [upload.state.status, upload.state.result, upload.state.error, open, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mobile: near-full-viewport with a 4px inset so edge taps land; sm+
          reverts to max-w-2xl. max-h-[90vh] + overflow-y keeps the footer
          reachable on short viewports. */}
      <DialogContent className="border-border bg-secondary text-white w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] sm:max-w-2xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle className="text-white">
            {isNewVersion
              ? `publish new version of "${newVersion!.name}"`
              : 'new roost'}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {isNewVersion ? (
              <>
                push new files to this roost. name, extract path, and target machines stay the same as the current version{newVersion!.currentVersionNumber ? ` (v${newVersion!.currentVersionNumber})` : ''}; drop your folder + add a description.
              </>
            ) : (
              <>
                a roost is a deploy target — files go to specific machines and updates ship as new versions. to add a version to one you already have, open it and click <span className="font-medium">+ new version</span>.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Preset bar. Each pill is a `relative` wrapper with its action row /
              rename form absolutely positioned under it — inline would stretch
              the pill's flex slot and blow out the row. `pb-10` reserves space
              for the attached panel. */}
          <div className="space-y-1.5">
            <Label className="text-white">presets</Label>
            <div
              className={`flex flex-wrap items-start gap-x-1.5 gap-y-2 ${
                selectedPreset && !selectedPreset.isBuiltIn && !savingNewPreset && !pendingReplacePreset ? 'pb-10' : ''
              }`}
            >
              {presets.map(preset => {
                const isActive = activePresetId === preset.id;
                const showActionRow =
                  isActive &&
                  selectedPreset &&
                  !selectedPreset.isBuiltIn &&
                  !savingNewPreset &&
                  !pendingReplacePreset;
                const showRenameForm = showActionRow && editingPresetId === preset.id;
                const showDeleteConfirm = showActionRow && confirmDeletePresetId === preset.id;
                const showActions =
                  showActionRow && !showRenameForm && !showDeleteConfirm;
                return (
                  <div key={preset.id} className="relative">
                    <button
                      type="button"
                      onClick={() => applyPreset(preset)}
                      className={`px-2.5 py-1 rounded-full text-[13px] font-medium transition-colors duration-150 cursor-pointer ${
                        isActive
                          ? 'bg-cyan-600/20 text-cyan-100 ring-1 ring-cyan-500/40'
                          : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
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
                          className="h-7 w-40 text-[11px] px-2 bg-background border-border"
                          autoFocus
                        />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button type="submit" className="p-1 text-muted-foreground hover:text-foreground cursor-pointer">
                              <Save className="h-3.5 w-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>save</p>
                          </TooltipContent>
                        </Tooltip>
                        <button
                          type="button"
                          onClick={() => setEditingPresetId(null)}
                          className="p-1 text-muted-foreground hover:text-foreground cursor-pointer"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </form>
                    )}

                    {/* Per-pill two-step delete confirmation */}
                    {showDeleteConfirm && selectedPreset && (
                      <div className="absolute left-1/2 top-full z-10 mt-1 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap text-[11px] leading-5">
                        <span className="text-muted-foreground">delete &ldquo;{selectedPreset.name}&rdquo;?</span>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await deletePreset(selectedPreset.id);
                              setConfirmDeletePresetId(null);
                              setActivePresetId(null);
                              toast.success('preset deleted');
                            } catch (err) {
                              toast.error('failed to delete preset', { description: sanitizeError(err) });
                            }
                          }}
                          className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-600/20 text-red-400 hover:bg-red-600/40 hover:text-red-300 cursor-pointer transition-colors font-medium"
                        >
                          <Trash2 className="h-3 w-3" /> yes, delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeletePresetId(null)}
                          className="px-2 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer transition-colors"
                        >
                          cancel
                        </button>
                      </div>
                    )}

                    {/* Per-pill action row. Autosave is debounced — no manual
                        save button, so the indicator carries the feedback. */}
                    {showActions && selectedPreset && (
                      <div className="absolute left-1/2 top-full z-10 mt-1 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap text-[11px] leading-5 text-muted-foreground">
                        <span
                          aria-live="polite"
                          className={`flex items-center gap-1 ${
                            autosaveStatus === 'saving'
                              ? 'text-cyan-400'
                              : autosaveStatus === 'saved'
                                ? 'text-green-400'
                                : 'text-muted-foreground/70'
                          }`}
                        >
                          <Save className="h-3 w-3" />
                          {autosaveStatus === 'saving'
                            ? 'saving…'
                            : autosaveStatus === 'saved'
                              ? 'saved'
                              : 'autosaves'}
                        </span>
                        <button
                          type="button"
                          onClick={() => { setEditingPresetId(selectedPreset.id); setEditPresetName(selectedPreset.name); }}
                          className="flex items-center gap-1 hover:text-foreground cursor-pointer transition-colors"
                        >
                          <Pencil className="h-3 w-3" /> rename
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeletePresetId(selectedPreset.id)}
                          className="flex items-center gap-1 hover:text-red-400 cursor-pointer transition-colors"
                        >
                          <Trash2 className="h-3 w-3" /> delete
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {!savingNewPreset && (
                <button
                  type="button"
                  onClick={() => setSavingNewPreset(true)}
                  className="px-2.5 py-1 rounded-full text-[13px] text-muted-foreground/80 hover:text-foreground border border-dashed border-border/70 hover:border-muted-foreground transition-colors duration-150 cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5 inline mr-1" />
                  new preset
                </button>
              )}
            </div>

            {/* Inline create form — not scoped to any one pill, sits below the row. */}
            {savingNewPreset && !pendingReplacePreset && (
              <form onSubmit={(e) => { e.preventDefault(); handleCreatePreset(); }} className="flex items-center gap-1.5">
                <Input
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  placeholder="preset name"
                  className="h-7 w-40 text-[11px] px-2 bg-background border-border"
                  autoFocus
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="submit" className="p-1 text-muted-foreground hover:text-foreground cursor-pointer">
                      <Save className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>save preset</p>
                  </TooltipContent>
                </Tooltip>
                <button
                  type="button"
                  onClick={() => { setSavingNewPreset(false); setNewPresetName(''); }}
                  className="p-1 text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </form>
            )}

            {/* Inline replace-confirm — unscoped, since the conflict is with a
                different preset of the same name. */}
            {pendingReplacePreset && (
              <div className="flex flex-wrap items-center gap-2 text-[11px] leading-5">
                <span className="text-muted-foreground">
                  preset &ldquo;{pendingReplacePreset.name}&rdquo; already exists. replace it?
                </span>
                <button
                  type="button"
                  onClick={handleConfirmReplace}
                  className="flex items-center gap-1 px-2 py-0.5 rounded bg-cyan-600/20 text-cyan-300 hover:bg-cyan-600/40 hover:text-cyan-200 cursor-pointer transition-colors font-medium"
                >
                  <Save className="h-3 w-3" /> yes, replace
                </button>
                <button
                  type="button"
                  onClick={() => setPendingReplacePreset(null)}
                  className="px-2 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer transition-colors"
                >
                  cancel
                </button>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="distribution-name" className="text-white">roost name</Label>
            <Input
              id="distribution-name"
              placeholder={namePlaceholder}
              value={distributionName}
              onChange={(e) => setDistributionName(e.target.value)}
              disabled={isNewVersion}
              aria-invalid={
                !isNewVersion &&
                distributionName.length > 0 &&
                !distributionName.trim()
              }
              aria-describedby={
                !isNewVersion &&
                distributionName.length > 0 &&
                !distributionName.trim()
                  ? 'distribution-name-error'
                  : undefined
              }
              className={`bg-muted/30 text-white ${
                !isNewVersion &&
                distributionName.length > 0 &&
                !distributionName.trim()
                  ? 'border-red-500 focus-visible:ring-red-500'
                  : 'border-border'
              } ${isNewVersion ? 'opacity-70 cursor-not-allowed' : ''}`}
            />
            {!isNewVersion &&
              distributionName.length > 0 &&
              !distributionName.trim() && (
                <p
                  id="distribution-name-error"
                  className="text-xs text-red-400"
                >
                  roost name is required
                </p>
              )}
            {!isNewVersion &&
              distributionName.trim().length > 0 &&
              (existingRoostIds ?? []).includes(slugify(distributionName)) && (
                <p className="text-xs text-amber-400">
                  a roost with this name already exists. publishing here will
                  create a new, separate roost (auto-renamed) — open the
                  existing one and click <span className="font-medium">+ new version</span> if
                  you meant to add to it.
                </p>
              )}
          </div>

          {/* Description, ≤500 chars, plaintext (no markdown). Commit-message
              style in "+ new version"; the first version's description in
              new-roost mode. */}
          <div className="space-y-2">
            <Label htmlFor="distribution-description" className="text-white">
              description <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <textarea
              id="distribution-description"
              value={description}
              onChange={(e) =>
                setDescription(e.target.value.slice(0, MAX_DESCRIPTION_LENGTH))
              }
              placeholder="what changed? (e.g. 'fixed broken video')"
              rows={2}
              className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent-cyan resize-y"
            />
            <p className="text-[11px] text-muted-foreground tabular-nums text-right">
              {description.length}/{MAX_DESCRIPTION_LENGTH}
            </p>
          </div>

          {/* Uploading a folder is the only source — the v1 by-url path was
              removed, so bytes always come from a fresh file drop. */}
          <div className="space-y-2">
            <Label className="text-white">folder to upload</Label>
            <FolderDropzone
              onFilesReady={(files, rootName) => {
                setDroppedFiles(files);
                setDroppedRootName(rootName);
                // Pre-fill distribution name from the folder if the field is empty.
                if (!distributionName) setDistributionName(rootName);
              }}
              onFilesAppend={(newFiles) => {
                // Merge by relative path, later wins, so re-picking a folder
                // refreshes it. rootName + distribution name are kept.
                setDroppedFiles((prev) => {
                  const byPath = new Map<string, NamedBlob>();
                  for (const f of prev ?? []) byPath.set(f.path, f);
                  for (const f of newFiles) byPath.set(f.path, f);
                  return Array.from(byPath.values());
                });
              }}
              onClear={() => {
                setDroppedFiles(null);
                setDroppedRootName('');
              }}
              summary={
                droppedFiles
                  ? (() => {
                      const s = summariseVersion([]);
                      // Raw-blob summary; the deduped one needs hashing first.
                      s.fileCount = droppedFiles.length;
                      s.totalBytes = droppedFiles.reduce((n, f) => n + f.blob.size, 0);
                      return { fileCount: s.fileCount, totalBytes: s.totalBytes };
                    })()
                  : undefined
              }
              files={droppedFiles ?? undefined}
              disabled={uploading}
            />
            {/* Non-blocking pre-submit warnings. >5k files = noticeable
                hashing time; >20 GB = minutes, warn about keeping the tab.
                Both can apply at once. */}
            {droppedFiles && droppedFiles.length > 0 && (() => {
              const fileCount = droppedFiles.length;
              const totalBytes = droppedFiles.reduce((n, f) => n + f.blob.size, 0);
              const LARGE_FILE_COUNT = 5_000;
              const LARGE_TOTAL_BYTES = 20 * 1024 ** 3; // 20 GiB
              const warnCount = fileCount > LARGE_FILE_COUNT;
              const warnBytes = totalBytes > LARGE_TOTAL_BYTES;
              if (!warnCount && !warnBytes) return null;
              return (
                <div
                  role="status"
                  className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-400/90 space-y-1"
                >
                  <div className="flex items-center gap-1.5 font-medium text-amber-300">
                    <TriangleAlert className="h-3.5 w-3.5" />
                    heads up
                  </div>
                  {warnCount && (
                    <p className="text-amber-400/75">
                      large file count ({fileCount.toLocaleString()}) — version will be big;
                      hashing may take several minutes. consider archiving into fewer files
                      if this is a one-off.
                    </p>
                  )}
                  {warnBytes && (
                    <p className="text-amber-400/75">
                      large upload ({formatBytes(totalBytes)}) — hashing and upload will take
                      significant time. keep this tab open; the minimize-to-corner indicator
                      handles if you click away.
                    </p>
                  )}
                </div>
              );
            })()}
            {uploadProgress && uploadProgress.phase !== 'idle' && (() => {
              // Use only the active phase's fraction — both fields can be set
              // on the transition tick, snapping the bar 0% → 100%.
              const frac =
                uploadProgress.phase === 'hashing'
                  ? uploadProgress.hashFraction
                  : uploadProgress.phase === 'uploading'
                    ? uploadProgress.uploadFraction
                    : undefined;
              const pct = frac !== undefined ? Math.round(frac * 100) : null;
              const isError = uploadProgress.phase === 'error';
              // useRoostUpload needs ~3s of samples; hide rather than flash a
              // nonsense number.
              const throughput = uploadProgress.throughputBytesPerSec;
              const eta = uploadProgress.etaSeconds;
              const showRate =
                !isError &&
                throughput !== undefined &&
                eta !== undefined &&
                (uploadProgress.phase === 'hashing' || uploadProgress.phase === 'uploading');
              // Friendlier label for the opaque "checking" phase.
              const phaseCopy =
                uploadProgress.phase === 'checking'
                  ? 'checking for duplicates'
                  : uploadProgress.phase;
              return (
                <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium text-white">{phaseCopy}</span>
                  </div>
                  {/* Darker track + border so the unfilled portion stays
                      visible on the dialog's bg-muted/20 panel. Matches
                      MinimizedUploadCard. */}
                  {frac !== undefined && !isError && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="h-[4px] flex-1 overflow-hidden rounded-full bg-background border border-border/40">
                        <div
                          className="h-full bg-accent-cyan transition-[width] duration-200 ease-out"
                          style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%` }}
                        />
                      </div>
                      {pct !== null && (
                        <span className="text-muted-foreground tabular-nums flex-shrink-0 min-w-[2.5rem] text-right">
                          {pct}%
                        </span>
                      )}
                    </div>
                  )}
                  {/* One status line: "281/1841 chunks uploaded · 1 KB/s ·
                      ~9h 30m remaining". Rate + ETA are latched across ticks
                      so a sample window with no byte progress can't flicker. */}
                  {(uploadProgress.message || (showRate && throughput !== undefined)) && (
                    <div className="mt-1 text-muted-foreground tabular-nums">
                      {uploadProgress.message}
                      {showRate && throughput !== undefined && eta !== undefined && (
                        <>
                          {uploadProgress.message ? ' · ' : ''}
                          {formatBytes(throughput)}/s
                          {' · ~'}
                          {formatDurationShort(eta)} remaining
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          <div className="space-y-2">
            <Label htmlFor="extract-path" className="text-white">extract to (optional)</Label>
            <Input
              id="extract-path"
              placeholder='Leave empty for default location'
              value={extractPath}
              onChange={(e) => setExtractPath(e.target.value)}
              disabled={isNewVersion}
              className={`border-border bg-muted/30 text-white ${
                isNewVersion ? 'opacity-70 cursor-not-allowed' : ''
              }`}
            />
            <p className="text-xs text-muted-foreground">
              {extractPath.trim() ? 'resolves to' : 'default'}:{' '}
              <span className="font-mono text-accent-cyan">{resolveExtractPath(extractPath)}</span>
            </p>
            {!isLikelyAllowed(extractPath, TARGET_OS_FAMILIES) && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-400/90 space-y-1.5">
                {isPosixPathOnWindowsTargets(extractPath, TARGET_OS_FAMILIES) ? (
                  <>
                    <p className="font-medium">
                      not a path a windows machine can use
                    </p>
                    <p className="text-amber-400/75">
                      these machines run windows, where{' '}
                      <code className="font-mono">{resolveExtractPath(extractPath)}</code>{' '}
                      isn&apos;t an absolute path at all — the agent refuses it before it
                      looks at any allowlist. start with a drive letter
                      (<code className="font-mono">C:\render</code>), or leave the field
                      empty for the default.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-medium">
                      absolute path — agent needs to be told this is OK to write to
                    </p>
                    <p className="text-amber-400/75">
                      the agent runs as SYSTEM on the target machine, so by default we
                      only allow writes under <code className="font-mono">~/Documents/</code>.
                      to write to <code className="font-mono">{resolveExtractPath(extractPath)}</code>,
                      add it to the allowlist on that machine:
                    </p>
                    <ol className="list-decimal list-inside space-y-0.5 pt-0.5 text-amber-400/75">
                      <li>open <code className="font-mono">C:\ProgramData\Owlette\config\config.json</code> as admin</li>
                      <li>
                        add (or append to) the <code className="font-mono">agent_config</code> block:
                        <pre className="mt-1 ml-4 p-2 rounded bg-background/60 text-[10px] leading-snug overflow-x-auto">
{`"agent_config": {
"allowed_extract_roots": [
"~/Documents",
"${resolveExtractPath(extractPath).replace(/\\/g, '\\\\')}"
  ]
}`}
                        </pre>
                      </li>
                      <li>right-click the owlette tray icon and pick <em>restart</em></li>
                    </ol>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            {/* Wraps at 375px: the label stacks above the action buttons. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-white">target machines ({selectedMachines.size} selected){isNewVersion && ' — locked'}</Label>
              {!isNewVersion && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={selectOnlyOnlineMachines}
                    className="border-border bg-background/50 text-white hover:bg-muted hover:text-white cursor-pointer text-xs"
                  >
                    online only ({onlineMachines.length})
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={toggleAllMachines}
                    className="border-border bg-background/50 text-white hover:bg-muted hover:text-white cursor-pointer text-xs"
                  >
                    {allMachinesSelected ? 'deselect all' : 'select all'}
                  </Button>
                </div>
              )}
            </div>

            <div
              className={`border border-border rounded-lg p-3 bg-background/50 max-h-48 overflow-y-auto space-y-2 ${
                isNewVersion ? 'opacity-70' : ''
              }`}
            >
              {machines.length === 0 ? (
                <p className="text-muted-foreground text-sm text-center py-2">no machines available</p>
              ) : (
                machines.map((machine) => (
                  <div
                    key={machine.machineId}
                    className={`flex items-center justify-between p-2 rounded ${
                      isNewVersion
                        ? 'cursor-not-allowed'
                        : 'hover:bg-secondary cursor-pointer'
                    }`}
                    onClick={
                      isNewVersion ? undefined : () => toggleMachine(machine.machineId)
                    }
                  >
                    <div className="flex items-center gap-3">
                      <Checkbox
                        aria-label={machine.machineId}
                        checked={selectedMachines.has(machine.machineId)}
                        onCheckedChange={
                          isNewVersion ? undefined : () => toggleMachine(machine.machineId)
                        }
                        // The row's own onClick also toggles; without stopping
                        // propagation a click ON the checkbox fired both and
                        // net-zeroed — the box visibly did nothing.
                        onClick={(e) => e.stopPropagation()}
                        disabled={isNewVersion}
                        className={isNewVersion ? '' : 'cursor-pointer'}
                      />
                      <span className="text-white">{machine.machineId}</span>
                    </div>
                    <Badge className={`text-xs ${machine.online ? 'bg-green-600' : 'bg-red-600'}`}>
                      {machine.online ? 'online' : 'offline'}
                    </Badge>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {pendingKickoff && summarySize && (
          <div className="border-t border-border pt-4">
            <PreUploadSummary
              sizeSummary={summarySize}
              targets={summaryTargets}
              onConfirm={handleConfirmKickoff}
              onCancel={handleCancelKickoff}
            />
          </div>
        )}

        <DialogFooter className={pendingKickoff ? 'hidden' : undefined}>
          {/* Both actions are explicit during an upload — a single
              "minimize/cancel" toggle was ambiguous about whether close =
              abort. */}
          {uploading ? (
            <>
              <Button
                variant="ghost"
                onClick={() => upload.cancel()}
                className="bg-secondary border border-border text-red-400 hover:text-red-300 cursor-pointer"
              >
                cancel upload
              </Button>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                className="bg-secondary border border-border cursor-pointer"
              >
                minimize
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
          )}
          {/* Two-button kickoff so a roost can be published without targets:
              "upload" needs name + bytes, "upload and distribute" also needs a
              target. `uploading` disables both — a second start() aborts the
              first. */}
          {(() => {
            const baseMissing: string[] = [];
            if (!distributionName.trim()) baseMissing.push('name');
            if (!droppedFiles || droppedFiles.length === 0) baseMissing.push('folder');
            const distributeMissing = [...baseMissing];
            if (selectedMachines.size === 0) distributeMissing.push('target machine');
            const distributeReason =
              distributeMissing.length === 0
                ? undefined
                : `needs: ${distributeMissing.join(', ')}`;
            const uploadOnlyReason =
              baseMissing.length === 0
                ? undefined
                : `needs: ${baseMissing.join(', ')}`;
            const distributeDisabled = uploading || distributeMissing.length > 0;
            const uploadOnlyDisabled = uploading || baseMissing.length > 0;
            return (
              <>
                <Button
                  variant="ghost"
                  onClick={handleUploadOnly}
                  className="bg-secondary border border-border cursor-pointer"
                  disabled={uploadOnlyDisabled}
                  title={uploadOnlyReason}
                >
                  {uploading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      uploading...
                    </>
                  ) : (
                    <>
                      <FolderArchive className="h-4 w-4 mr-2" />
                      upload
                    </>
                  )}
                </Button>
                <Button
                  onClick={handleUploadDistribute}
                  className="text-gray-900 cursor-pointer"
                  disabled={distributeDisabled}
                  title={distributeReason}
                >
                  {uploading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      uploading...
                    </>
                  ) : (
                    <>
                      <FolderArchive className="h-4 w-4 mr-2" />
                      upload and distribute to {selectedMachines.size} machine{selectedMachines.size !== 1 ? 's' : ''}
                    </>
                  )}
                </Button>
              </>
            );
          })()}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
