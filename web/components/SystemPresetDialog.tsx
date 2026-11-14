'use client';

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Sparkles } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useSystemPresets, type SystemPreset } from '@/hooks/useSystemPresets';
import { useAuth } from '@/contexts/AuthContext';
import { useInstallerChecksum } from '@/hooks/useInstallerChecksum';
import InstallerChecksumStatus from '@/components/InstallerChecksumStatus';

/** Create/edit dialog for global software-deployment presets. Null `preset` = create mode. */
interface SystemPresetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset: SystemPreset | null; // null for create, preset object for edit
}

export default function SystemPresetDialog({
  open,
  onOpenChange,
  preset,
}: SystemPresetDialogProps) {
  const { createPreset, updatePreset } = useSystemPresets();
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [softwareName, setSoftwareName] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [installerName, setInstallerName] = useState('');
  const [installerUrl, setInstallerUrl] = useState('');
  const [silentFlags, setSilentFlags] = useState('/VERYSILENT /NORESTART /SUPPRESSMSGBOXES');
  const [verifyPath, setVerifyPath] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState(600);
  const [order, setOrder] = useState(100);

  const [saving, setSaving] = useState(false);
  const [fetchingTd, setFetchingTd] = useState(false);

  const isEditMode = preset !== null;

  // sha256 checksum — required by agents before they run any installer.
  const checksum = useInstallerChecksum({
    endpoint: '/api/platform/installer-checksum',
    installerUrl,
    enabled: open,
  });
  const { adoptChecksum, resetChecksum } = checksum;

  useEffect(() => {
    if (preset) {
      setName(preset.name);
      setSoftwareName(preset.software_name);
      setCategory(preset.category);
      setDescription(preset.description || '');
      setIcon(preset.icon || '');
      setInstallerName(preset.installer_name);
      setInstallerUrl(preset.installer_url);
      setSilentFlags(preset.silent_flags);
      setVerifyPath(preset.verify_path || '');
      setTimeoutSeconds(preset.timeout_seconds || 600);
      setOrder(preset.order);
      adoptChecksum(preset.sha256_checksum, preset.installer_url);
    } else {
      setName('');
      setSoftwareName('');
      setCategory('');
      setDescription('');
      setIcon('');
      setInstallerName('');
      setInstallerUrl('');
      setSilentFlags('/VERYSILENT /NORESTART /SUPPRESSMSGBOXES');
      setVerifyPath('');
      setTimeoutSeconds(600);
      setOrder(100);
      resetChecksum();
    }
  }, [preset, open, adoptChecksum, resetChecksum]);

  const handleAutoFillTd = async () => {
    setFetchingTd(true);
    try {
      const res = await fetch('/api/platform/touchdesigner/builds');
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to fetch' }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const { latest } = await res.json();

      setName(`TouchDesigner ${latest.version} (Full)`);
      setSoftwareName('TouchDesigner');
      setCategory('Creative Software');
      setDescription(`TouchDesigner ${latest.version} full installer`);
      setIcon('');
      setInstallerName(`TouchDesigner.${latest.version}.exe`);
      setInstallerUrl(latest.full_installer_url);
      setSilentFlags('/VERYSILENT /SP- /NORESTART /SUPPRESSMSGBOXES');
      setVerifyPath('C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe');
      setTimeoutSeconds(1200);
      setOrder(10);

      toast.success('Auto-filled', {
        description: `TouchDesigner ${latest.version} ready to save.`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('Failed to fetch TD version', {
        description: message || 'Could not reach derivative.ca',
      });
    } finally {
      setFetchingTd(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error('Name required', { description: 'Please enter a preset name.' });
      return;
    }
    if (!softwareName.trim()) {
      toast.error('Software name required', { description: 'Please enter a software name.' });
      return;
    }
    if (!category.trim()) {
      toast.error('Category required', { description: 'Please select a category.' });
      return;
    }
    if (!installerName.trim()) {
      toast.error('Installer name required', { description: 'Please enter an installer filename.' });
      return;
    }
    if (!silentFlags.trim()) {
      toast.error('Silent flags required', { description: 'Please enter installation flags.' });
      return;
    }
    if (!installerUrl.trim()) {
      toast.error('Installer URL required', {
        description: 'Please enter a direct download URL for the installer.',
      });
      return;
    }
    if (checksum.checksumStatus === 'computing') {
      toast.error('Still computing checksum — one moment');
      return;
    }
    if (!checksum.checksumReady) {
      toast.error('Checksum required', {
        description: 'agents refuse installs without a sha256 checksum. wait for auto-compute or enter one manually.',
      });
      return;
    }

    setSaving(true);

    try {
      // Sparse: Firestore rejects undefined, so optional fields are omitted when unset.
      // `createdAt` is stamped by the hook.
      const baseData: Omit<SystemPreset, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> = {
        name,
        software_name: softwareName,
        category,
        installer_name: installerName,
        installer_url: installerUrl,
        silent_flags: silentFlags,
        sha256_checksum: checksum.sha256Checksum,
        is_owlette_agent: false,
        timeout_seconds: timeoutSeconds,
        order,
        ...(description?.trim() ? { description: description.trim() } : {}),
        ...(icon?.trim() ? { icon: icon.trim() } : {}),
        ...(verifyPath?.trim() ? { verify_path: verifyPath.trim() } : {}),
      };

      if (isEditMode && preset) {
        await updatePreset(preset.id, baseData);

        toast.success('Preset Updated', {
          description: `"${name}" has been updated successfully.`,
        });
      } else {
        await createPreset({
          ...baseData,
          createdBy: user?.uid || 'unknown',
        });

        toast.success('Preset Created', {
          description: `"${name}" has been created successfully.`,
        });
      }

      onOpenChange(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(isEditMode ? 'Update Failed' : 'Create Failed', {
        description: message || 'An error occurred while saving the preset.',
      });
    } finally {
      setSaving(false);
    }
  };

  const predefinedCategories = [
    'System',
    'Creative Software',
    'Media Server',
    'Utilities',
    'Development Tools',
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border text-foreground sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'edit template' : 'create template'}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {isEditMode
              ? 'update the template configuration.'
              : 'create a new software template for the deployment catalog.'}
          </DialogDescription>
        </DialogHeader>

        {/* Auto-fill TouchDesigner - Only show when creating new preset */}
        {!isEditMode && (
          <div className="pb-4 border-b border-border">
            {/* the deeper cyan by day: the base cyan on its own tint over --secondary misses aa */}
            <Button
              type="button"
              variant="outline"
              onClick={handleAutoFillTd}
              disabled={fetchingTd}
              className="w-full border-accent-cyan/50 bg-accent-cyan/10 text-accent-cyan-hover dark:text-accent-cyan hover:bg-accent-cyan/20 hover:text-accent-cyan-hover cursor-pointer"
            >
              {fetchingTd ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              {fetchingTd ? 'Fetching latest version...' : 'Auto-fill latest TouchDesigner'}
            </Button>
            <p className="text-xs text-muted-foreground text-center mt-2">
              fetches the latest version from derivative.ca
            </p>
          </div>
        )}

        <div className="space-y-4 py-4">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="name" className="text-foreground">
              name *
            </Label>
            <Input
              id="name"
              placeholder="e.g., TouchDesigner 2025.31550"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="border-border bg-background text-foreground"
            />
            <p className="text-xs text-muted-foreground">display name shown in UI</p>
          </div>

          {/* Software Name */}
          <div className="space-y-2">
            <Label htmlFor="softwareName" className="text-foreground">
              software name *
            </Label>
            <Input
              id="softwareName"
              placeholder="e.g., TouchDesigner"
              value={softwareName}
              onChange={(e) => setSoftwareName(e.target.value)}
              className="border-border bg-background text-foreground"
            />
            <p className="text-xs text-muted-foreground">short identifier for grouping</p>
          </div>

          {/* Category */}
          <div className="space-y-2">
            <Label htmlFor="category" className="text-foreground">
              category *
            </Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="border-border bg-background text-foreground">
                <SelectValue placeholder="select a category..." />
              </SelectTrigger>
              <SelectContent className="border-border dark:bg-secondary">
                {predefinedCategories.map((cat) => (
                  <SelectItem
                    key={cat}
                    value={cat}
                    className="text-foreground focus:bg-accent focus:text-foreground"
                  >
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">used for filtering and organization</p>
          </div>

          {/* Icon (optional) */}
          <div className="space-y-2">
            <Label htmlFor="icon" className="text-foreground">
              icon (emoji)
            </Label>
            <Input
              id="icon"
              placeholder="e.g., 🎨"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              maxLength={2}
              className="border-border bg-background text-foreground"
            />
            <p className="text-xs text-muted-foreground">optional emoji icon (one character)</p>
          </div>

          {/* Description (optional) */}
          <div className="space-y-2">
            <Label htmlFor="description" className="text-foreground">
              description
            </Label>
            <Textarea
              id="description"
              placeholder="Optional description of this preset..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="border-border bg-background text-foreground resize-none"
            />
          </div>

          {/* Installer Name */}
          <div className="space-y-2">
            <Label htmlFor="installerName" className="text-foreground">
              installer filename *
            </Label>
            <Input
              id="installerName"
              placeholder="e.g., TouchDesigner.2025.31550.exe"
              value={installerName}
              onChange={(e) => setInstallerName(e.target.value)}
              className="border-border bg-background text-foreground font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">name of the installer file</p>
          </div>

          {/* Installer URL */}
          <div className="space-y-2">
            <Label htmlFor="installerUrl" className="text-foreground">
              installer URL *
            </Label>
            <Input
              id="installerUrl"
              placeholder="https://example.com/installer.exe"
              value={installerUrl}
              onChange={(e) => setInstallerUrl(e.target.value)}
              className="border-border bg-background text-foreground font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              direct download link for the installer
            </p>
            {/* sha256 checksum — auto-computed server-side, manual fallback */}
            <InstallerChecksumStatus checksum={checksum} installerUrl={installerUrl} />
          </div>

          {/* Silent Flags */}
          <div className="space-y-2">
            <Label htmlFor="silentFlags" className="text-foreground">
              silent install flags *
            </Label>
            <Textarea
              id="silentFlags"
              placeholder="/VERYSILENT /NORESTART /SUPPRESSMSGBOXES"
              value={silentFlags}
              // Flags are one command line: wrap visually, but collapse typed/pasted newlines
              // so the agent never gets a broken multi-line invocation.
              onChange={(e) => setSilentFlags(e.target.value.replace(/\s*[\r\n]+\s*/g, ' '))}
              className="border-border bg-background text-foreground font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Command-line flags for silent installation. Include custom directory here (e.g., /DIR=&quot;C:\Custom\Path&quot;)
            </p>
          </div>

          {/* Verify Path (optional) */}
          <div className="space-y-2">
            <Label htmlFor="verifyPath" className="text-foreground">
              verification path
            </Label>
            <Input
              id="verifyPath"
              placeholder='C:\\Program Files\\Software\\app.exe'
              value={verifyPath}
              onChange={(e) => setVerifyPath(e.target.value)}
              className="border-border bg-background text-foreground font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">optional: file path to verify installation success</p>
          </div>

          {/* Advanced Options */}
          <div className="grid grid-cols-2 gap-4">
            {/* Timeout */}
            <div className="space-y-2">
              <Label htmlFor="timeout" className="text-foreground">
                timeout (seconds)
              </Label>
              <Input
                id="timeout"
                type="number"
                min="60"
                max="3600"
                value={timeoutSeconds}
                onChange={(e) => setTimeoutSeconds(parseInt(e.target.value) || 600)}
                className="border-border bg-background text-foreground"
              />
              <p className="text-xs text-muted-foreground">Max install time (default: 600)</p>
            </div>

            {/* Order */}
            <div className="space-y-2">
              <Label htmlFor="order" className="text-foreground">
                display order
              </Label>
              <Input
                id="order"
                type="number"
                min="1"
                value={order}
                onChange={(e) => setOrder(parseInt(e.target.value) || 100)}
                className="border-border bg-background text-foreground"
              />
              <p className="text-xs text-muted-foreground">sort priority (lower = first)</p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            className="bg-secondary border border-border cursor-pointer"
          >
            cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || checksum.checksumStatus === 'computing'}
            className="cursor-pointer"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {isEditMode ? 'updating...' : 'creating...'}
              </>
            ) : (
              isEditMode ? 'update template' : 'create template'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
