'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/lib/toast';
import { useAuth } from '@/contexts/AuthContext';
import { validateSiteId, generateRandomSiteId } from '@/lib/validators';
import { getBrowserTimezone } from '@/lib/timeUtils';
import { TimezoneSelect } from '@/components/TimezoneSelect';
import { CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FormError } from '@/components/ui/form-error';
import { db } from '@/lib/firebase';
import { doc, getDoc } from 'firebase/firestore';

interface CreateSiteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateSite: (
    siteId: string,
    siteName: string,
    userId: string,
    timezone?: string,
    schedulesFollowSiteTime?: boolean,
  ) => Promise<string>;
  onSiteCreated?: (siteId: string) => void;
}

type AvailabilityStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

export function CreateSiteDialog({
  open,
  onOpenChange,
  onCreateSite,
  onSiteCreated,
}: CreateSiteDialogProps) {
  const { user } = useAuth();
  const [newSiteName, setNewSiteName] = useState('');
  const [newSiteId, setNewSiteId] = useState('');
  const [customIdOpen, setCustomIdOpen] = useState(false);
  const [timezone, setTimezone] = useState('');
  const [detectedTimezone, setDetectedTimezone] = useState('');
  const [timezoneOpen, setTimezoneOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [availabilityStatus, setAvailabilityStatus] = useState<AvailabilityStatus>('idle');
  const [validationError, setValidationError] = useState<string>('');

  // Generate a random ID when the dialog opens
  useEffect(() => {
    if (open) {
      setNewSiteId(generateRandomSiteId());
      setNewSiteName('');
      setCustomIdOpen(false);
      // Detected here rather than in a useState initializer so a dialog kept
      // mounted across a timezone change (laptop moved, OS setting edited)
      // re-reads it on the next open instead of serving a stale zone. Kept
      // alongside the working value so the "from your browser" provenance stops
      // being claimed the moment the operator overrides it.
      const detected = getBrowserTimezone();
      setDetectedTimezone(detected);
      setTimezone(detected);
      setTimezoneOpen(false);
      setAvailabilityStatus('idle');
      setValidationError('');
    }
  }, [open]);

  // Check site ID availability with debouncing
  const checkAvailability = useCallback(async (siteId: string) => {
    if (!siteId || siteId.trim() === '') {
      setAvailabilityStatus('idle');
      setValidationError('');
      return;
    }

    const validation = validateSiteId(siteId);
    if (!validation.isValid) {
      setAvailabilityStatus('invalid');
      setValidationError(validation.error || 'invalid site ID');
      return;
    }

    setAvailabilityStatus('checking');
    setValidationError('');

    try {
      if (!db) {
        setAvailabilityStatus('invalid');
        setValidationError('firebase is not configured');
        return;
      }

      const siteRef = doc(db, 'sites', siteId);
      const siteSnap = await getDoc(siteRef);

      if (siteSnap.exists()) {
        setAvailabilityStatus('taken');
        setValidationError('this site ID is already taken');
      } else {
        setAvailabilityStatus('available');
        setValidationError('');
      }
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      // A client read of sites/{id} is denied BOTH when the site doesn't exist
      // (truly available) AND when it exists but is owned by another user
      // (firestore.rules hides foreign sites). The client can't distinguish the
      // two, so treat permission-denied as optimistically available and let the
      // server be authoritative: POST /api/sites returns 409 on a real collision,
      // which createSite() surfaces as "already taken". This is deliberate — we do
      // NOT expose a global existence-check endpoint that would let anyone
      // enumerate site IDs. permission-denied is therefore expected, not an error.
      if (code === 'permission-denied') {
        setAvailabilityStatus('available');
        setValidationError('');
        return;
      }
      console.error('Error checking site availability:', error);
      setAvailabilityStatus('invalid');
      setValidationError('could not check availability. edit the site ID to retry');
    }
  }, []);

  // Debounce the availability check
  useEffect(() => {
    const timer = setTimeout(() => {
      if (newSiteId) {
        checkAvailability(newSiteId);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [newSiteId, checkAvailability]);

  const handleSiteIdChange = (value: string) => {
    const normalized = value.toLowerCase().replace(/\s+/g, '-');
    setNewSiteId(normalized);
  };

  const handleRegenerate = () => {
    setNewSiteId(generateRandomSiteId());
  };

  const handleCreateSite = async () => {
    if (!newSiteName.trim()) {
      toast.error('Please enter a site name');
      return;
    }

    if (!newSiteId.trim()) {
      toast.error('Site ID is missing');
      return;
    }

    if (!user) {
      toast.error('You must be logged in to create a site');
      return;
    }

    if (availabilityStatus !== 'available') {
      toast.error('Please choose an available Site ID');
      return;
    }

    setIsCreating(true);
    try {
      // New sites start on site time (dev/completed/site-time-schedules, wave 3b):
      // the flag rides along with the timezone it depends on, in one write.
      //
      // The two ALWAYS travel together. `schedulesFollowSiteTime: true` on a site
      // with no timezone is a state the server refuses on update and that would
      // silently mean UTC on create, so a zone we could not resolve drops the
      // flag entirely rather than failing the create: the site is then simply
      // "never asked" — the legacy state — and the dashboard banner asks later.
      const resolvedTimezone = timezone.trim();
      const createdSiteId = await onCreateSite(
        newSiteId,
        newSiteName,
        user.uid,
        resolvedTimezone || undefined,
        resolvedTimezone ? true : undefined,
      );
      toast.success(`Site "${newSiteName}" created successfully!`);
      setNewSiteId('');
      setNewSiteName('');
      setAvailabilityStatus('idle');
      setValidationError('');
      onOpenChange(false);

      if (onSiteCreated) {
        onSiteCreated(createdSiteId);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message || 'Failed to create site');
    } finally {
      setIsCreating(false);
    }
  };

  // taken/invalid are announced by the error alert, so the status only speaks for the rest
  const availabilityText =
    availabilityStatus === 'checking' ? 'checking site ID availability'
      : availabilityStatus === 'available' ? 'site ID available'
        : '';
  const hasIdError = availabilityStatus === 'taken' || availabilityStatus === 'invalid';

  const getAvailabilityIcon = () => {
    switch (availabilityStatus) {
      case 'checking':
        return <Loader2 className="h-4 w-4 animate-spin text-accent-cyan" />;
      case 'available':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case 'taken':
        return <XCircle className="h-4 w-4 text-red-500" />;
      case 'invalid':
        return <XCircle className="h-4 w-4 text-orange-500" />;
      default:
        return null;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-secondary text-white">
        <DialogHeader>
          <DialogTitle className="text-white">create new site</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            sites organize your machines by location, purpose, or project. for example, create separate sites for different offices, studios, or installations.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {/* Site Name Input */}
          <div className="space-y-2">
            <Label htmlFor="site-name" className="text-white">site name</Label>
            <Input
              id="site-name"
              placeholder="e.g., NYC Office"
              value={newSiteName}
              onChange={(e) => setNewSiteName(e.target.value)}
              className="border-border bg-background text-white"
              autoFocus
            />
          </div>

          {/* Auto-generated Site ID preview */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>site ID:</span>
              <span className="font-mono text-accent-cyan">{newSiteId}</span>
              {getAvailabilityIcon()}
              <span role="status" className="sr-only">{availabilityText}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleRegenerate}
                    aria-label="generate new site ID"
                    className="text-muted-foreground hover:text-accent-cyan transition-colors cursor-pointer"
                  >
                    <RefreshCw className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>generate new ID</p>
                </TooltipContent>
              </Tooltip>
            </div>

            <FormError message={validationError} id="site-id-error" />

            {/* Expandable custom ID section */}
            <button
              type="button"
              aria-expanded={customIdOpen}
              onClick={() => setCustomIdOpen(!customIdOpen)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-accent-cyan transition-colors cursor-pointer"
            >
              {customIdOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              customize site ID
            </button>

            {customIdOpen && (
              <div className="relative">
                <Label htmlFor="site-id" className="sr-only">site ID</Label>
                <Input
                  id="site-id"
                  placeholder="e.g., nyc-office"
                  value={newSiteId}
                  onChange={(e) => handleSiteIdChange(e.target.value)}
                  aria-invalid={hasIdError || undefined}
                  aria-describedby={validationError ? 'site-id-error' : undefined}
                  className={`border-border bg-background text-white pr-10 ${
                    availabilityStatus === 'available' ? 'border-green-500/50 focus-visible:ring-green-500' : ''
                  }`}
                />
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  {getAvailabilityIcon()}
                </div>
              </div>
            )}
          </div>

          {/* Detected timezone, shown read-only behind the same disclosure
              idiom as the site ID: it is a decision the browser can make for
              the operator, not one worth a required field. Editing it here is
              the only chance to get it right before the first schedule is
              written, since the site is created opted into site time. */}
          <div className="space-y-2">
            {/* flex-wrap, unlike the site ID row above: an IANA name plus its
                provenance is long enough to overflow a 390px dialog. */}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>site timezone:</span>
              <span data-testid="create-site-timezone" className="font-mono text-accent-cyan">
                {timezone || 'not detected'}
              </span>
              {timezone && timezone === detectedTimezone && <span>(from your browser)</span>}
            </div>

            <p className="text-xs text-muted-foreground">
              {timezone
                ? 'scheduled processes at this site run on this clock, on every machine.'
                : 'we could not read a timezone from your browser — pick one below to run this site’s schedules on one clock, or leave it and each machine keeps its own.'}
            </p>

            <button
              type="button"
              aria-expanded={timezoneOpen}
              onClick={() => setTimezoneOpen(!timezoneOpen)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-accent-cyan transition-colors cursor-pointer"
            >
              {timezoneOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              change timezone
            </button>

            {timezoneOpen && (
              <>
                {/* The read-only row above is the visible label; the select
                    still needs one of its own to have an accessible name. */}
                <Label htmlFor="site-timezone" className="sr-only">site timezone</Label>
                <TimezoneSelect
                  id="site-timezone"
                  value={timezone}
                  onValueChange={setTimezone}
                  className="border-border bg-background text-white"
                />
              </>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="bg-secondary border border-border cursor-pointer"
          >
            cancel
          </Button>
          <Button
            onClick={handleCreateSite}
            disabled={isCreating || availabilityStatus !== 'available'}
            className="text-gray-900 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCreating ? 'creating...' : 'create site'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
