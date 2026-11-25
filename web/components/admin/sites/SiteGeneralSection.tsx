'use client';

import { useState } from 'react';
import { Panel } from '@/components/admin/Panel';
import { TimezoneSelect } from '@/components/TimezoneSelect';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/lib/toast';

/**
 * a site's name and timezone. the fields seed from props once, so mount it keyed
 * on the site's id, name and timezone: a saved or remote change then re-seeds it.
 */
export function SiteGeneralSection({
  site,
  onSave,
}: {
  site: { id: string; name: string; timezone?: string };
  onSave: (siteId: string, updates: { name?: string; timezone?: string }) => Promise<void>;
}) {
  const savedTimezone = site.timezone || 'UTC';
  const [name, setName] = useState(site.name);
  const [timezone, setTimezone] = useState(savedTimezone);
  const [saving, setSaving] = useState(false);

  const trimmedName = name.trim();
  const nameChanged = trimmedName !== site.name;
  const timezoneChanged = timezone !== savedTimezone;
  const dirty = nameChanged || timezoneChanged;

  const save = async () => {
    if (saving || !dirty) return;
    if (!trimmedName) {
      toast.error('site name cannot be empty');
      return;
    }
    setSaving(true);
    try {
      // only what changed: a rename must never store the UTC shown for a site with no timezone
      const updates: { name?: string; timezone?: string } = {};
      if (nameChanged) updates.name = trimmedName;
      if (timezoneChanged) updates.timezone = timezone;
      await onSave(site.id, updates);
      toast.success('site updated');
    } catch (error) {
      toast.error('could not update the site', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      id="site-section-general"
      title="general"
      description="the site's name, and the timezone its talons and site-time schedules run on."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="min-w-40 grow space-y-1.5">
          <Label htmlFor="site-settings-name" className="text-muted-foreground">
            site name
          </Label>
          <Input
            id="site-settings-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="border-border bg-background text-foreground"
          />
        </div>
        <div className="min-w-40 grow space-y-1.5">
          <Label htmlFor="site-settings-timezone" className="text-muted-foreground">
            timezone
          </Label>
          <TimezoneSelect
            id="site-settings-timezone"
            value={timezone}
            onValueChange={setTimezone}
            className="border-border bg-background text-foreground"
          />
        </div>
        <Button type="submit" disabled={saving || !dirty}>
          {saving ? 'saving…' : 'save'}
        </Button>
      </form>
    </Panel>
  );
}
