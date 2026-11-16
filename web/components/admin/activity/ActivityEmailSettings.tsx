'use client';

import { useState } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import { useActivityEmailSettings } from '@/hooks/useActivityEmailSettings';
import { MAX_RECIPIENTS, normaliseRecipients } from '@/lib/activity/emailRecipients';

/**
 * the platform's activity emails on admin → alerts, superadmins only: one switch and
 * the addresses they go to. each change saves as it is made.
 */
export function ActivityEmailSettings() {
  const { settings, loading, saving, error, save } = useActivityEmailSettings();
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  if (!settings) {
    return (
      <div className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground sm:p-4">
        {loading ? 'loading...' : error}
      </div>
    );
  }

  const persist = async (next: { enabled: boolean; recipients: string[] }): Promise<boolean> => {
    const failure = await save(next);
    if (failure) toast.error('could not save activity emails', { description: failure });
    return !failure;
  };

  const add = async () => {
    const entry = draft.trim().toLowerCase();
    if (!entry) return;
    if (settings.recipients.includes(entry)) return setProblem('already on the list');
    if (!normaliseRecipients([entry]).ok) return setProblem('that is not an email address');
    setProblem(null);
    if (await persist({ enabled: settings.enabled, recipients: [...settings.recipients, entry] })) setDraft('');
  };

  const full = settings.recipients.length >= MAX_RECIPIENTS;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3 sm:p-4">
      <div className="flex items-center gap-2 sm:gap-4">
        <Switch
          id="activity-emails"
          checked={settings.enabled}
          onCheckedChange={(enabled) => void persist({ enabled, recipients: settings.recipients })}
          disabled={saving}
        />
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor="activity-emails" className="text-foreground">
            activity findings
          </Label>
          <p className="text-xs text-muted-foreground">
            emails when a detection rule flags activity: high findings at once, the rest in a daily digest
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {settings.recipients.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {settings.recipients.map((address) => (
              <li
                key={address}
                className="flex min-w-0 items-center gap-1 rounded-md border border-border bg-secondary py-0.5 pl-2 text-xs text-secondary-foreground"
              >
                <span className="min-w-0 truncate">{address}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-6"
                  aria-label={`remove ${address}`}
                  disabled={saving}
                  onClick={() =>
                    void persist({ enabled: settings.enabled, recipients: settings.recipients.filter((r) => r !== address) })
                  }
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            {settings.fallback
              ? `no addresses set: emails go to ${settings.fallback}`
              : 'no addresses set and no fallback address: nothing is sent'}
          </p>
        )}

        <form
          noValidate
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <Input
            inputMode="email"
            autoComplete="off"
            aria-label="email address"
            aria-invalid={problem !== null}
            placeholder="add an email address"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setProblem(null);
            }}
            disabled={saving || full}
            className="min-w-0 flex-1 bg-background border-border"
          />
          <Button type="submit" variant="outline" disabled={saving || full}>
            add
          </Button>
        </form>
        {(problem || full) && <p className="text-xs text-destructive">{problem ?? `up to ${MAX_RECIPIENTS} addresses`}</p>}
      </div>

      <Link
        href="/admin/activity?view=flagged"
        className="hl-link inline-block text-xs font-medium text-accent-cyan"
      >
        see what was flagged
      </Link>
    </div>
  );
}
