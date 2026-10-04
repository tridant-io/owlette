'use client';

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { UserAvatar } from '@/components/UserAvatar';
import { cropAndResizeSquare } from '@/lib/imageUtils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { EyeIcon, EyeOffIcon, AlertTriangle, Shield, Check, Loader2, User, Bell, BellOff, Trash2, Key, Plus, X, Code } from 'lucide-react';
import { toast } from '@/lib/toast';
import { MfaFactorsSection } from '@/components/MfaFactorsSection';
import { getBrowserTimezone } from '@/lib/timeUtils';
import { TimezoneSelect } from '@/components/TimezoneSelect';
import { AppearanceControl } from '@/components/AppearanceControl';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { IconButton } from '@/components/ui/icon-button';
import { FormError } from '@/components/ui/form-error';
import { useFieldError } from '@/hooks/useFieldError';
import { HootIcon } from '@/components/icons/HootIcon';
import { ApiKeysManager } from '@/components/ApiKeysManager';
import { useScrollFade } from '@/hooks/useScrollFade';
import { useHeightTransition } from '@/hooks/useHeightTransition';
import { AVAILABLE_MODELS, preselectedModel } from '@/lib/llmModels';

type SettingsSection = 'profile' | 'preferences' | 'alerts' | 'hoot' | 'security' | 'api' | 'danger';

const SECTIONS: { id: SettingsSection; label: string; icon: React.ElementType }[] = [
  { id: 'profile', label: 'profile', icon: User },
  { id: 'preferences', label: 'preferences', icon: Bell },
  { id: 'alerts', label: 'alerts', icon: Bell },
  { id: 'hoot', label: 'hoot', icon: HootIcon },
  { id: 'security', label: 'security', icon: Shield },
  { id: 'api', label: 'api', icon: Code },
  { id: 'danger', label: 'danger zone', icon: Trash2 },
];

interface AccountSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: SettingsSection;
}

export function AccountSettingsDialog({ open, onOpenChange, initialSection }: AccountSettingsDialogProps) {
  // The section dissolves under the dialog header rather than being cut by it.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useScrollFade<HTMLDivElement>(scrollerRef);

  const { user, userPreferences, updateUserProfile, updateUserPhoto, updatePassword, updateUserPreferences, deleteAccount } = useAuth();
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection || 'profile');
  // sections differ in length: the dialog eases to each one's height instead of cutting
  const boxRef = useHeightTransition<HTMLDivElement>(activeSection, scrollerRef);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [photoUploading, setPhotoUploading] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [temperatureUnit, setTemperatureUnit] = useState<'C' | 'F'>('C');
  const [timezone, setTimezone] = useState('UTC');
  const [timeFormat, setTimeFormat] = useState<'12h' | '24h'>('12h');
  const [timeDisplayMode, setTimeDisplayMode] = useState<'user' | 'machine' | 'site'>('machine');
  const [healthAlerts, setHealthAlerts] = useState(true);
  const [processAlerts, setProcessAlerts] = useState(true);
  const [thresholdAlerts, setThresholdAlerts] = useState(true);
  // Firestore keeps the legacy `cortexAlerts` field (web/lib/hoot/WIRE_NAMES.md);
  // local state uses the product name and maps at the wire boundary.
  const [hootAlerts, setHootAlerts] = useState(true);
  const [displayAlerts, setDisplayAlerts] = useState(true);
  const [talonAlerts, setTalonAlerts] = useState(true);
  const [apiKeyAlerts, setApiKeyAlerts] = useState(true);
  const [alertCcEmails, setAlertCcEmails] = useState<string[]>([]);
  const [newCcEmail, setNewCcEmail] = useState('');
  const { error: ccEmailError, fail: failCcEmail, clear: clearCcEmail, fieldProps: ccEmailFieldProps } = useFieldError('settings-cc-email-error');
  const [loading, setLoading] = useState(false);

  const [showPasswordSection, setShowPasswordSection] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const { error: passwordError, fail: failPassword, clear: clearPassword, fieldProps: passwordFieldProps } = useFieldError('settings-password-error');

  const [llmProvider, setLlmProvider] = useState<'anthropic' | 'openai'>('anthropic');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmModel, setLlmModel] = useState('');
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [llmSaving, setLlmSaving] = useState(false);
  const [showLlmKey, setShowLlmKey] = useState(false);
  const [llmModels, setLlmModels] = useState<{ id: string; name: string }[]>([]);
  const [llmModelsLoading, setLlmModelsLoading] = useState(false);


  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);

  const fetchLlmModels = async (provider: string) => {
    setLlmModelsLoading(true);
    try {
      const res = await fetch(`/api/settings/llm-models?provider=${provider}`);
      if (res.ok) {
        const data = await res.json();
        setLlmModels(data.models || []);
      }
    } catch {
      // Keep the hardcoded fallback list already in state.
    }
    setLlmModelsLoading(false);
  };

  useEffect(() => {
    if (open && initialSection) {
      setActiveSection(initialSection);
    }
  }, [open, initialSection]);

  useEffect(() => {
    if (open) {
      if (user?.displayName) {
        const names = user.displayName.split(' ');
        if (names.length >= 2) {
          setFirstName(names[0]);
          setLastName(names.slice(1).join(' '));
        } else {
          setFirstName(names[0]);
          setLastName('');
        }
      }

      setTemperatureUnit(userPreferences.temperatureUnit);
      setTimezone(userPreferences.timezone || getBrowserTimezone());
      setTimeFormat(userPreferences.timeFormat || '12h');
      setTimeDisplayMode(userPreferences.timeDisplayMode || 'machine');
      setHealthAlerts(userPreferences.healthAlerts);
      setProcessAlerts(userPreferences.processAlerts);
      setThresholdAlerts(userPreferences.thresholdAlerts);
      setHootAlerts(userPreferences.cortexAlerts);
      setDisplayAlerts(userPreferences.displayAlerts);
      setTalonAlerts(userPreferences.talonAlerts);
      setApiKeyAlerts(userPreferences.apiKeyAlerts);
      setAlertCcEmails(userPreferences.alertCcEmails || []);
      setNewCcEmail('');
      clearCcEmail();

      fetch('/api/settings/llm-key')
        .then((res) => res.json())
        .then((data) => {
          setLlmConfigured(data.configured || false);
          if (data.provider) setLlmProvider(data.provider);
          if (data.model) setLlmModel(data.model);
          if (data.configured) {
            fetchLlmModels(data.provider || 'anthropic');
          }
        })
        .catch(() => {});

    } else {
      setFirstName('');
      setLastName('');
      setTemperatureUnit('C');
      setTimezone(getBrowserTimezone());
      setTimeFormat('12h');
      setHealthAlerts(true);
      setProcessAlerts(true);
      setAlertCcEmails([]);
      setNewCcEmail('');
      clearCcEmail();
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      clearPassword();
      setShowPasswordSection(false);
      setShowDeleteConfirm(false);
      setDeletePassword('');
      setLlmApiKey('');
      setShowLlmKey(false);
      setActiveSection('profile');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user?.displayName, userPreferences.temperatureUnit, userPreferences.timezone, userPreferences.timeFormat, userPreferences.timeDisplayMode, userPreferences.healthAlerts, userPreferences.processAlerts, JSON.stringify(userPreferences.alertCcEmails)]);

  const handleOpenChange = (isOpen: boolean) => {
    onOpenChange(isOpen);
  };

  const handleAddCcEmail = () => {
    const email = newCcEmail.trim().toLowerCase();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return failCcEmail('settings-cc-email', 'please enter a valid email address');
    }
    if (email === user?.email?.toLowerCase()) {
      return failCcEmail('settings-cc-email', 'this is already your primary alert email');
    }
    if (alertCcEmails.includes(email)) {
      return failCcEmail('settings-cc-email', 'this email is already added');
    }
    if (alertCcEmails.length >= 5) {
      return failCcEmail('settings-cc-email', 'maximum of 5 CC addresses');
    }
    setAlertCcEmails(prev => [...prev, email]);
    setNewCcEmail('');
    clearCcEmail();
  };

  const validatePassword = (): boolean => {
    clearPassword();
    if (!currentPassword || !newPassword || !confirmPassword) {
      const empty = !currentPassword ? 'currentPassword' : !newPassword ? 'newPassword' : 'confirmPassword';
      failPassword(empty, 'fill in all three password fields');
      return false;
    }
    if (newPassword.length < 6) {
      failPassword('newPassword', 'new password must be at least 6 characters');
      return false;
    }
    if (newPassword !== confirmPassword) {
      failPassword('confirmPassword', 'new passwords do not match');
      return false;
    }
    if (newPassword === currentPassword) {
      failPassword('newPassword', 'new password must be different from your current password');
      return false;
    }
    return true;
  };

  const handlePhotoPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the same file twice still fires onChange.
    e.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Invalid File', { description: 'Please choose an image file.' });
      return;
    }

    setPhotoUploading(true);
    let blob: Blob;
    try {
      ({ blob } = await cropAndResizeSquare(file));
    } catch (err: unknown) {
      setPhotoUploading(false);
      const message = err instanceof Error ? err.message : 'Failed to prepare the selected image.';
      toast.error('Could Not Process Image', { description: message });
      return;
    }

    try {
      await updateUserPhoto(blob);
    } catch {
      // AuthContext toasts.
    } finally {
      setPhotoUploading(false);
    }
  };

  const handlePhotoRemove = async () => {
    setPhotoUploading(true);
    try {
      await updateUserPhoto(null);
    } catch {
      // AuthContext toasts.
    } finally {
      setPhotoUploading(false);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    clearPassword();
    try {
      if (firstName || lastName) {
        await updateUserProfile(firstName, lastName);
      }
      const prefsChanged = temperatureUnit !== userPreferences.temperatureUnit
        || timezone !== userPreferences.timezone
        || timeFormat !== (userPreferences.timeFormat || '12h')
        || timeDisplayMode !== (userPreferences.timeDisplayMode || 'machine')
        || healthAlerts !== userPreferences.healthAlerts
        || processAlerts !== userPreferences.processAlerts
        || thresholdAlerts !== userPreferences.thresholdAlerts
        || hootAlerts !== userPreferences.cortexAlerts
        || displayAlerts !== userPreferences.displayAlerts
        || talonAlerts !== userPreferences.talonAlerts
        || apiKeyAlerts !== userPreferences.apiKeyAlerts
        || JSON.stringify(alertCcEmails) !== JSON.stringify(userPreferences.alertCcEmails || []);
      if (prefsChanged) {
        await updateUserPreferences({ temperatureUnit, timezone, timeFormat, timeDisplayMode, healthAlerts, processAlerts, thresholdAlerts, cortexAlerts: hootAlerts, displayAlerts, talonAlerts, apiKeyAlerts, alertCcEmails });
      }
      if (showPasswordSection && (currentPassword || newPassword || confirmPassword)) {
        if (!validatePassword()) {
          setLoading(false);
          return;
        }
        await updatePassword(currentPassword, newPassword);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setShowPasswordSection(false);
      }
      onOpenChange(false);
    } catch {
      // AuthContext toasts.
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!deletePassword) return;
    setDeleting(true);
    try {
      await deleteAccount(deletePassword);
      setShowDeleteConfirm(false);
      onOpenChange(false);
    } catch {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border text-foreground sm:max-w-4xl p-0 gap-0 max-h-[90dvh]">
        <VisuallyHidden>
          <DialogTitle>account settings</DialogTitle>
        </VisuallyHidden>
        {/* min-w-0: DialogContent is a grid, and its auto column grows to the widest
            child's min-content, which on a phone is the whole tab bar */}
        <div ref={boxRef} className="flex flex-col sm:flex-row sm:min-h-[480px] min-h-0 min-w-0 max-h-[85dvh]">
          {/* Mobile: horizontal scrollable tabs */}
          {/* mr-10 leaves the dialog's close button its own slot at the end of the row */}
          <nav aria-label="settings sections" className="sm:hidden flex overflow-x-auto border-b border-border bg-card/50 p-1.5 mr-10 gap-1 flex-shrink-0">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-current={activeSection === id ? 'true' : undefined}
                onClick={() => setActiveSection(id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs whitespace-nowrap transition-colors cursor-pointer flex-shrink-0 ${
                  activeSection === id
                    ? 'bg-accent text-accent-foreground'
                    : id === 'danger'
                      ? 'text-danger hover:bg-danger-surface'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                }`}
              >
                <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                {label}
              </button>
            ))}
          </nav>

          {/* Desktop: vertical sidebar */}
          <nav aria-label="settings sections" className="hidden sm:flex w-48 border-r border-border bg-card/50 p-2 flex-col gap-0.5 flex-shrink-0">
            <div className="px-3 py-2.5 mb-1">
              <h2 className="text-sm font-semibold text-foreground">settings</h2>
            </div>
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-current={activeSection === id ? 'true' : undefined}
                onClick={() => setActiveSection(id)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${
                  activeSection === id
                    ? 'bg-accent text-accent-foreground'
                    : id === 'danger'
                      ? 'text-danger hover:bg-danger-surface'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                {label}
              </button>
            ))}
          </nav>

          {/* Content */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            {/* keyed so each section fades in and opens at its top */}
            <div key={activeSection} ref={bodyRef} className="flex-1 overflow-y-auto [[data-resizing]_&]:overflow-y-hidden p-4 sm:p-6 motion-safe:animate-in fade-in-0">
              {/* ─── Profile ─── */}
              {activeSection === 'profile' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-base font-medium text-foreground">profile</h3>
                    <p className="text-xs text-muted-foreground mt-1">your personal information</p>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="relative">
                      <UserAvatar user={user} size="lg" />
                      {photoUploading && (
                        <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50">
                          {/* eslint-disable-next-line no-restricted-syntax -- a white spinner on the black photo scrim, in either theme */}
                          <Loader2 className="h-5 w-5 text-white animate-spin" />
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      <input
                        ref={photoInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handlePhotoPick}
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => photoInputRef.current?.click()}
                          disabled={photoUploading || loading}
                        >
                          {user?.photoURL ? 'change photo' : 'upload photo'}
                        </Button>
                        {user?.photoURL && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={handlePhotoRemove}
                            disabled={photoUploading || loading}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            remove
                          </Button>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">square crop, resized to 256px</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="settings-firstName" className="text-foreground">first name</Label>
                      <Input
                        id="settings-firstName"
                        type="text"
                        placeholder="first name"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        className="border-border bg-background text-foreground"
                        disabled={loading}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="settings-lastName" className="text-foreground">last name</Label>
                      <Input
                        id="settings-lastName"
                        type="text"
                        placeholder="last name"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        className="border-border bg-background text-foreground"
                        disabled={loading}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="settings-email" className="text-foreground">email</Label>
                    <Input
                      id="settings-email"
                      type="email"
                      value={user?.email || ''}
                      className="border-border bg-background text-muted-foreground"
                      disabled
                      readOnly
                    />
                    <p className="text-xs text-muted-foreground">email cannot be changed</p>
                  </div>
                </div>
              )}

              {/* ─── Preferences ─── */}
              {activeSection === 'preferences' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-base font-medium text-foreground">preferences</h3>
                    <p className="text-xs text-muted-foreground mt-1">dashboard display settings</p>
                  </div>

                  <AppearanceControl />

                  <div className="space-y-2">
                    <p id="settings-time-display-label" className="text-sm leading-none font-medium text-foreground">display times in</p>
                    <p id="settings-time-display-help" className="text-xs text-muted-foreground">
                      controls how heartbeats, activity logs, and other absolute timestamps render across the dashboard. schedule editors are unaffected — they follow the site&apos;s schedule clock setting (each machine&apos;s own clock unless the site opted into site time), not this preference.
                    </p>
                    <div
                      role="radiogroup"
                      aria-labelledby="settings-time-display-label"
                      aria-describedby="settings-time-display-help"
                      className="space-y-2 mt-1"
                    >
                      {([
                        { value: 'machine', label: "each machine's local timezone", help: 'every machine renders its own heartbeats and timestamps in its own local clock. best when monitoring kiosks across multiple timezones.' },
                        { value: 'user', label: 'my timezone', help: 'all machines render in your selected timezone (below). best when you want a single shared reference frame.' },
                        { value: 'site', label: "site timezone", help: "all machines render in the site's configured timezone (set in manage sites). preserves the legacy behavior." },
                      ] as const).map(opt => (
                        <label
                          key={opt.value}
                          className="flex items-start gap-2.5 p-2.5 rounded-md border border-border bg-background/50 hover:bg-secondary cursor-pointer transition-colors"
                        >
                          <input
                            type="radio"
                            name="timeDisplayMode"
                            value={opt.value}
                            checked={timeDisplayMode === opt.value}
                            onChange={() => setTimeDisplayMode(opt.value)}
                            disabled={loading}
                            className="mt-0.5 cursor-pointer accent-accent-cyan"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-foreground">{opt.label}</div>
                            <div className="text-xs text-muted-foreground mt-0.5">{opt.help}</div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="timezone" className="text-foreground">
                      your timezone
                      {timeDisplayMode !== 'user' && (
                        <span className="ml-2 text-xs text-muted-foreground font-normal">(only used when display mode is &quot;my timezone&quot;)</span>
                      )}
                    </Label>
                    <TimezoneSelect
                      id="timezone"
                      value={timezone}
                      onValueChange={(value: string) => setTimezone(value)}
                      disabled={loading || timeDisplayMode !== 'user'}
                      className="border-border bg-background text-foreground hover:bg-secondary w-72 disabled:opacity-50"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="temperatureUnit" className="text-foreground">temperature unit</Label>
                    <Select
                      value={temperatureUnit}
                      onValueChange={(value: 'C' | 'F') => setTemperatureUnit(value)}
                      disabled={loading}
                    >
                      <SelectTrigger id="temperatureUnit" className="border-border bg-background text-foreground hover:bg-secondary w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-border dark:bg-secondary text-foreground">
                        <SelectItem value="C" className="cursor-pointer hover:bg-muted">Celsius (°C)</SelectItem>
                        <SelectItem value="F" className="cursor-pointer hover:bg-muted">Fahrenheit (°F)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="timeFormat" className="text-foreground">time format</Label>
                    <Select
                      value={timeFormat}
                      onValueChange={(value: '12h' | '24h') => setTimeFormat(value)}
                      disabled={loading}
                    >
                      <SelectTrigger id="timeFormat" className="border-border bg-background text-foreground hover:bg-secondary w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-border dark:bg-secondary text-foreground">
                        <SelectItem value="12h" className="cursor-pointer hover:bg-muted">12-hour (AM/PM)</SelectItem>
                        <SelectItem value="24h" className="cursor-pointer hover:bg-muted">24-hour</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {/* ─── Notifications ─── */}
              {activeSection === 'alerts' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-base font-medium text-foreground">alerts</h3>
                    <p className="text-xs text-muted-foreground mt-1">configure email alerts for machine and process events</p>
                  </div>

                  <div className="flex items-center justify-between rounded-md border border-border bg-card/50 p-4">
                    <div className="space-y-0.5">
                      <Label htmlFor="healthAlerts" className="text-foreground">machine offline alerts</Label>
                      <p className="text-xs text-muted-foreground">receive email alerts when machines go offline</p>
                    </div>
                    <Switch
                      id="healthAlerts"
                      checked={healthAlerts}
                      onCheckedChange={setHealthAlerts}
                      disabled={loading}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-md border border-border bg-card/50 p-4">
                    <div className="space-y-0.5">
                      <Label htmlFor="processAlerts" className="text-foreground">process crash alerts</Label>
                      <p className="text-xs text-muted-foreground">receive email alerts when monitored processes crash or fail to start</p>
                    </div>
                    <Switch
                      id="processAlerts"
                      checked={processAlerts}
                      onCheckedChange={setProcessAlerts}
                      disabled={loading}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-md border border-border bg-card/50 p-4">
                    <div className="space-y-0.5">
                      <Label htmlFor="thresholdAlerts" className="text-foreground">threshold alerts</Label>
                      <p className="text-xs text-muted-foreground">receive email alerts when health metrics (CPU, GPU temp, disk, etc.) exceed configured thresholds</p>
                    </div>
                    <Switch
                      id="thresholdAlerts"
                      checked={thresholdAlerts}
                      onCheckedChange={setThresholdAlerts}
                      disabled={loading}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-md border border-border bg-card/50 p-4">
                    <div className="space-y-0.5">
                      <Label htmlFor="hootAlerts" className="text-foreground">hoot escalation alerts</Label>
                      <p className="text-xs text-muted-foreground">receive email alerts when automated diagnostics can&apos;t resolve an issue</p>
                    </div>
                    <Switch
                      id="hootAlerts"
                      checked={hootAlerts}
                      onCheckedChange={setHootAlerts}
                      disabled={loading}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-md border border-border bg-card/50 p-4">
                    <div className="space-y-0.5">
                      <Label htmlFor="displayAlerts" className="text-foreground">display events</Label>
                      <p className="text-xs text-muted-foreground">receive email alerts when monitors are removed, layouts drift, or display apply fails</p>
                    </div>
                    <Switch
                      id="displayAlerts"
                      checked={displayAlerts}
                      onCheckedChange={setDisplayAlerts}
                      disabled={loading}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-md border border-border bg-card/50 p-4">
                    <div className="space-y-0.5">
                      <Label htmlFor="talonAlerts" className="text-foreground">talon alerts</Label>
                      <p className="text-xs text-muted-foreground">emails when a talon fires or fails</p>
                    </div>
                    <Switch
                      id="talonAlerts"
                      checked={talonAlerts}
                      onCheckedChange={setTalonAlerts}
                      disabled={loading}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-md border border-border bg-card/50 p-4">
                    <div className="space-y-0.5">
                      <Label htmlFor="apiKeyAlerts" className="text-foreground">api key expiry</Label>
                      <p className="text-xs text-muted-foreground">emails before an api key expires</p>
                    </div>
                    <Switch
                      id="apiKeyAlerts"
                      checked={apiKeyAlerts}
                      onCheckedChange={setApiKeyAlerts}
                      disabled={loading}
                    />
                  </div>

                  <div className="rounded-md border border-border bg-card/50 p-4 space-y-3">
                    <div className="space-y-0.5">
                      <p className="text-sm leading-none font-medium text-foreground">alert email</p>
                      <p className="text-xs text-muted-foreground">
                        alerts are sent to <span className="text-foreground font-medium">{user?.email}</span>
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="settings-cc-email" className="text-foreground text-xs">additional CC recipients</Label>
                      {alertCcEmails.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {alertCcEmails.map((email) => (
                            <span key={email} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary dark:bg-accent/30 text-xs text-foreground">
                              {email}
                              <button
                                type="button"
                                onClick={() => setAlertCcEmails(prev => prev.filter(e => e !== email))}
                                disabled={loading}
                                aria-label={`remove ${email}`}
                                className="cursor-pointer text-muted-foreground hover:text-foreground"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-2">
                        <Input
                          id="settings-cc-email"
                          type="email"
                          placeholder="colleague@example.com"
                          value={newCcEmail}
                          onChange={(e) => { setNewCcEmail(e.target.value); clearCcEmail(); }}
                          className="border-border bg-background text-foreground flex-1"
                          disabled={loading}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddCcEmail(); } }}
                          {...ccEmailFieldProps('settings-cc-email')}
                        />
                        <IconButton
                          label="add email"
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={handleAddCcEmail}
                          disabled={loading || !newCcEmail.trim()}
                          className="border-border text-foreground hover:bg-secondary"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </IconButton>
                      </div>
                      <FormError message={ccEmailError?.message} id="settings-cc-email-error" />
                      <p className="text-[11px] text-muted-foreground">these addresses will be CC&apos;d on all alert emails. max 5.</p>
                    </div>
                  </div>

                  {userPreferences.mutedMachines.length > 0 && (
                    <div className="rounded-md border border-border bg-card/50 p-4 space-y-3">
                      <div className="space-y-0.5">
                        <p className="text-sm leading-none font-medium text-foreground flex items-center gap-1.5">
                          <BellOff className="h-3.5 w-3.5" />
                          muted machines
                        </p>
                        <p className="text-xs text-muted-foreground">
                          alerts are silenced for these machines. unmute from the machine&apos;s context menu on the dashboard.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {userPreferences.mutedMachines.map((machineId) => (
                          <span key={machineId} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary dark:bg-accent/30 text-xs text-foreground">
                            {machineId}
                            <button
                              type="button"
                              onClick={() => {
                                const mutedMachines = userPreferences.mutedMachines.filter(id => id !== machineId);
                                updateUserPreferences({ mutedMachines }, { silent: true });
                              }}
                              disabled={loading}
                              aria-label={`unmute ${machineId}`}
                              className="cursor-pointer text-muted-foreground hover:text-foreground"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ─── Hoot ─── */}
              {activeSection === 'hoot' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-base font-medium text-foreground flex items-center gap-2">
                      hoot
                      {llmConfigured && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-success-surface text-success flex items-center gap-1 font-normal">
                          <Check className="h-3 w-3" /> connected
                        </span>
                      )}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1">
                      connect an LLM provider to power owlette&apos;s intelligence layer. query machines,
                      run diagnostics, and manage your fleet through natural language.
                    </p>
                  </div>

                  <div className="space-y-4 rounded-md border border-border bg-card/50 p-4">
                    <div className="space-y-2">
                      <Label htmlFor="llmProvider" className="text-foreground">provider</Label>
                      <Select
                        value={llmProvider}
                        onValueChange={(value: 'anthropic' | 'openai') => {
                          setLlmProvider(value);
                          setLlmModel('');
                          setLlmModels([]);
                          if (llmConfigured) fetchLlmModels(value);
                        }}
                        disabled={llmSaving}
                      >
                        <SelectTrigger id="llmProvider" className="border-border bg-background text-foreground hover:bg-secondary w-64">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="border-border dark:bg-secondary text-foreground">
                          <SelectItem value="anthropic" className="cursor-pointer hover:bg-muted">Anthropic (Claude)</SelectItem>
                          <SelectItem value="openai" className="cursor-pointer hover:bg-muted">OpenAI</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="llmModel" className="text-foreground">model</Label>
                      {(() => {
                        const models = llmModels.length > 0 ? llmModels : AVAILABLE_MODELS[llmProvider];
                        const defaultModel = preselectedModel(llmProvider, models);
                        return (
                          <Select
                            value={llmModel || defaultModel}
                            onValueChange={setLlmModel}
                            disabled={llmSaving || llmModelsLoading}
                          >
                            <SelectTrigger id="llmModel" className="border-border bg-background text-foreground hover:bg-secondary w-64">
                              {llmModelsLoading ? (
                                <span className="flex items-center gap-2 text-muted-foreground">
                                  <Loader2 className="h-3 w-3 animate-spin" /> loading models…
                                </span>
                              ) : (
                                <SelectValue />
                              )}
                            </SelectTrigger>
                            <SelectContent className="border-border dark:bg-secondary text-foreground max-h-64">
                              {models.map((m) => (
                                <SelectItem key={m.id} value={m.id} className="cursor-pointer hover:bg-muted">
                                  {m.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        );
                      })()}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="llmApiKey" className="text-foreground flex items-center gap-2">
                        <Key className="h-3.5 w-3.5" />
                        api key
                      </Label>
                      <div className="relative">
                        <Input
                          id="llmApiKey"
                          type={showLlmKey ? 'text' : 'password'}
                          placeholder={llmConfigured ? '••••••••••••••••••••••••' : llmProvider === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
                          value={llmApiKey}
                          onChange={(e) => setLlmApiKey(e.target.value)}
                          className="border-border bg-background pr-10 text-foreground"
                          disabled={llmSaving}
                        />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => setShowLlmKey(!showLlmKey)}
                              aria-label={showLlmKey ? 'hide key' : 'show key'}
                              className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
                            >
                              {showLlmKey ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{showLlmKey ? 'hide key' : 'show key'}</p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        your key is encrypted with AES-256 and never leaves the server.
                      </p>
                    </div>

                    <div className="flex gap-2 pt-1">
                      <Button
                        type="button"
                        size="sm"
                        onClick={async () => {
                          if (!llmApiKey) return;
                          setLlmSaving(true);
                          try {
                            const res = await fetch('/api/settings/llm-key', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                provider: llmProvider,
                                apiKey: llmApiKey,
                                model: llmModel || preselectedModel(llmProvider, llmModels.length > 0 ? llmModels : AVAILABLE_MODELS[llmProvider]),
                              }),
                            });
                            if (res.ok) {
                              setLlmConfigured(true);
                              setLlmApiKey('');
                              toast.success('API key saved');
                              fetchLlmModels(llmProvider);
                            } else {
                              const err = await res.json().catch(() => ({}));
                              toast.error(err.error || 'Failed to save API key');
                            }
                          } catch (e) {
                            toast.error(`Failed to save API key: ${e instanceof Error ? e.message : 'Unknown error'}`);
                          }
                          setLlmSaving(false);
                        }}
                        disabled={!llmApiKey || llmSaving}
                        className="cursor-pointer h-8"
                      >
                        {llmSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : 'save key'}
                      </Button>
                      {llmConfigured && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            setLlmSaving(true);
                            try {
                              await fetch('/api/settings/llm-key', { method: 'DELETE' });
                              setLlmConfigured(false);
                              setLlmApiKey('');
                              toast.success('API key removed');
                            } catch {
                              toast.error('Failed to remove API key');
                            }
                            setLlmSaving(false);
                          }}
                          disabled={llmSaving}
                          className="cursor-pointer border-border text-destructive hover:bg-muted h-8"
                        >
                          remove key
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ─── Security ─── */}
              {activeSection === 'security' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-base font-medium text-foreground">security</h3>
                    <p className="text-xs text-muted-foreground mt-1">authentication and access control</p>
                  </div>

                  {/* Every second factor — TOTP and passkeys — in one list.
                      The passkey card used to sit further down this section as
                      an unrelated sibling; it is nested inside the section now
                      because any one factor satisfies the same gate. */}
                  {user && (
                    <MfaFactorsSection
                      userId={user.uid}
                      onNavigateAway={() => onOpenChange(false)}
                    />
                  )}

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm leading-none font-medium text-foreground">change password</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setShowPasswordSection(!showPasswordSection);
                          clearPassword();
                          if (showPasswordSection) {
                            setCurrentPassword('');
                            setNewPassword('');
                            setConfirmPassword('');
                          }
                        }}
                        className="h-8 cursor-pointer border-border text-accent-cyan hover:text-accent-cyan hover:bg-muted"
                        disabled={loading}
                      >
                        {showPasswordSection ? 'cancel' : 'update password'}
                      </Button>
                    </div>

                    {showPasswordSection && (
                      <div className="space-y-3 rounded-md border border-border bg-card/50 p-4">
                        <div className="space-y-2">
                          <Label htmlFor="currentPassword" className="text-foreground">current password</Label>
                          <div className="relative">
                            <Input
                              id="currentPassword"
                              type={showCurrentPassword ? 'text' : 'password'}
                              placeholder="enter current password"
                              value={currentPassword}
                              onChange={(e) => setCurrentPassword(e.target.value)}
                              {...passwordFieldProps('currentPassword')}
                              className="border-border bg-background pr-10 text-foreground"
                              disabled={loading}
                            />
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                                  aria-label={showCurrentPassword ? 'hide password' : 'show password'}
                                  className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
                                  disabled={loading}
                                >
                                  {showCurrentPassword ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>{showCurrentPassword ? 'hide password' : 'show password'}</p>
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="newPassword" className="text-foreground">new password</Label>
                          <div className="relative">
                            <Input
                              id="newPassword"
                              type={showNewPassword ? 'text' : 'password'}
                              placeholder="enter new password"
                              value={newPassword}
                              onChange={(e) => setNewPassword(e.target.value)}
                              {...passwordFieldProps('newPassword')}
                              className="border-border bg-background pr-10 text-foreground"
                              disabled={loading}
                            />
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() => setShowNewPassword(!showNewPassword)}
                                  aria-label={showNewPassword ? 'hide password' : 'show password'}
                                  className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
                                  disabled={loading}
                                >
                                  {showNewPassword ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>{showNewPassword ? 'hide password' : 'show password'}</p>
                              </TooltipContent>
                            </Tooltip>
                          </div>
                          <p className="text-xs text-muted-foreground">must be at least 6 characters</p>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="confirmPassword" className="text-foreground">confirm new password</Label>
                          <div className="relative">
                            <Input
                              id="confirmPassword"
                              type={showConfirmPassword ? 'text' : 'password'}
                              placeholder="confirm new password"
                              value={confirmPassword}
                              onChange={(e) => setConfirmPassword(e.target.value)}
                              {...passwordFieldProps('confirmPassword')}
                              className="border-border bg-background pr-10 text-foreground"
                              disabled={loading}
                            />
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                                  aria-label={showConfirmPassword ? 'hide password' : 'show password'}
                                  className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
                                  disabled={loading}
                                >
                                  {showConfirmPassword ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>{showConfirmPassword ? 'hide password' : 'show password'}</p>
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        </div>

                        <FormError message={passwordError?.message} id="settings-password-error" />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ─── API ─── */}
              {activeSection === 'api' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-base font-medium text-foreground">api keys</h3>
                    <p className="text-xs text-muted-foreground mt-1">
                      scoped tokens for programmatic access to the owlette api
                    </p>
                  </div>

                  {/* One panel, shared with /settings/api-keys. This section
                      used to carry a reduced reimplementation that could not
                      set a ttl, build custom scopes, rotate, or show a key's
                      scopes. If key state reappears in this file, the
                      extraction has been undone. */}
                  <ApiKeysManager compact />

                  {/* Usage example */}
                  <div className="rounded-md border border-border bg-card/50 p-4 space-y-2">
                    <p className="text-xs text-muted-foreground font-medium">usage</p>
                    <code className="block text-[11px] bg-background rounded px-3 py-2 text-muted-foreground font-mono whitespace-pre-wrap">
                      {`curl "https://owlette.app/api/sites/SITE_ID/machines?api_key=owk_..."`}
                    </code>
                    <p className="text-[11px] text-muted-foreground">
                      or pass as header: <code className="font-mono">x-api-key: owk_...</code>
                    </p>
                  </div>
                </div>
              )}

              {/* ─── Danger Zone ─── */}
              {activeSection === 'danger' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-base font-medium text-danger">danger zone</h3>
                    <p className="text-xs text-muted-foreground mt-1">irreversible account actions</p>
                  </div>

                  <div className="space-y-3 rounded-md border border-danger-border bg-danger-surface p-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="h-5 w-5 text-danger mt-0.5 flex-shrink-0" />
                      <div className="flex-1 space-y-2">
                        <p className="text-sm leading-none font-semibold text-danger">delete account</p>
                        <p className="text-sm text-muted-foreground">
                          permanently delete your account and all associated data. this action cannot be undone.
                        </p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => setShowDeleteConfirm(true)}
                      className="w-full cursor-pointer"
                      disabled={loading || deleting}
                    >
                      delete account
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* Footer — only show save/cancel for sections that need it */}
            {(activeSection === 'profile' || activeSection === 'preferences' || activeSection === 'security') && (
              <div className="border-t border-border px-6 py-3 flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  className="bg-secondary border border-border cursor-pointer"
                  disabled={loading}
                >
                  cancel
                </Button>
                <Button
                  onClick={handleSave}
                  className="cursor-pointer"
                  disabled={loading}
                >
                  {loading ? 'saving...' : 'save changes'}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Delete Confirmation Dialog */}
        <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <DialogContent className="border-border text-foreground">
            <DialogHeader>
              <DialogTitle className="text-danger flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                delete account
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                this action is permanent and cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="rounded-md bg-danger-surface border border-danger-border p-4">
                <p className="text-sm text-danger font-semibold mb-2">warning:</p>
                <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
                  <li>all your sites and machines will be permanently deleted</li>
                  <li>all deployments and logs will be removed</li>
                  <li>your account data cannot be recovered</li>
                  <li>you will be immediately signed out</li>
                </ul>
              </div>
              <div className="space-y-2">
                <Label htmlFor="deletePassword" className="text-foreground">
                  enter your password to confirm
                </Label>
                <Input
                  id="deletePassword"
                  type="password"
                  placeholder="your password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  className="border-border bg-background text-foreground"
                  disabled={deleting}
                  autoFocus
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeletePassword('');
                }}
                className="bg-secondary border border-border cursor-pointer"
                disabled={deleting}
              >
                cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDeleteAccount}
                className="cursor-pointer"
                disabled={deleting || !deletePassword}
              >
                {deleting ? 'deleting...' : 'delete my account'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
