'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { MultiSelect } from '@/components/ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FLEET_COPY } from '@/components/FleetSendersEditor';
import { useFleetSettings } from '@/hooks/useFleetSettings';
import { useFleetSettingsWrite } from '@/hooks/useFleetSettingsWrite';
import type { SiteMachine } from '@/hooks/useSiteMachines';
import { storedFleetGrant, type StoredFleetGrant } from '@/lib/fleet/grant';
import { toast } from '@/lib/toast';

type Reach = keyof typeof FLEET_COPY.reaches;
type Tier = StoredFleetGrant['maxTier'];

/**
 * the admin panel's answer to a machine asking to act on others (the desktop
 * app's switch, the installer's box): one save that turns the site switch on
 * and adds the machine's row. the reach starts at chosen machines with none
 * picked, because the whole site is only ever a choice (ADR 0017).
 */
export function AllowMachineCard({
  siteId,
  siteName,
  machine,
  machines,
  onCancel,
}: {
  siteId: string;
  siteName: string;
  machine: SiteMachine;
  machines: SiteMachine[];
  onCancel: () => void;
}) {
  const { settings } = useFleetSettings(siteId);
  const write = useFleetSettingsWrite(siteId);
  // a machine with a row already (its site switch is what is off) starts from it
  const stored = Object.prototype.hasOwnProperty.call(settings.senders, machine.id)
    ? storedFleetGrant(settings.senders[machine.id])
    : undefined;
  const [tier, setTier] = useState<Tier>(stored?.maxTier ?? 1);
  const [reach, setReach] = useState<Reach>(
    !stored ? 'some' : stored.wholeSite ? 'whole' : stored.machineIds ? 'some' : 'none',
  );
  const [picked, setPicked] = useState<string[]>(stored?.machineIds ?? []);
  const [saving, setSaving] = useState(false);

  const grant: StoredFleetGrant =
    reach === 'whole'
      ? { maxTier: tier, wholeSite: true }
      : reach === 'some' && picked.length > 0
        ? { maxTier: tier, machineIds: picked }
        : { maxTier: tier };

  const allow = async () => {
    setSaving(true);
    try {
      // senders replaces the whole map, so the stored ones ride along
      const senders = Object.fromEntries(
        Object.entries(settings.senders).map(([id, stored]) => [id, storedFleetGrant(stored)]),
      );
      await write({ enabled: true, senders: { ...senders, [machine.id]: grant } });
    } catch (err) {
      console.error('Failed to allow the machine to act on others:', err);
      toast.error(FLEET_COPY.writeFailed, {
        description: err instanceof Error ? err.message : String(err),
      });
      setSaving(false);
    }
  };

  return (
    <section
      aria-labelledby="hoot-allow-machine"
      data-testid="allow-machine-card"
      className="rounded-xl border border-border bg-card p-4 sm:p-5 space-y-4"
    >
      <div>
        <h2 id="hoot-allow-machine" className="text-sm font-semibold text-foreground wrap-anywhere">
          {FLEET_COPY.allowTitle(machine.name)}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground wrap-anywhere">{FLEET_COPY.allowBody(machine.name)}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <Label className="text-xs text-muted-foreground">{FLEET_COPY.tierLabel}</Label>
          <Select value={String(tier)} onValueChange={(v) => setTier(Number(v) as Tier)}>
            <SelectTrigger aria-label={FLEET_COPY.tierLabel} className="w-full border-border bg-background text-foreground">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {([1, 2, 3] as const).map((t) => (
                <SelectItem key={t} value={String(t)}>
                  {FLEET_COPY.tiers[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-0 space-y-1.5">
          <Label className="text-xs text-muted-foreground">{FLEET_COPY.reachLabel}</Label>
          <Select value={reach} onValueChange={(v) => setReach(v as Reach)}>
            <SelectTrigger aria-label={FLEET_COPY.reachLabel} className="w-full border-border bg-background text-foreground">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(FLEET_COPY.reaches) as Reach[]).map((r) => (
                <SelectItem key={r} value={r}>
                  {FLEET_COPY.reaches[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {reach === 'some' && (
        <MultiSelect
          groups={[{ group: null, options: machines.map((m) => ({ value: m.id, label: m.name })) }]}
          selected={picked}
          onChange={setPicked}
          allLabel={FLEET_COPY.pickMachines}
          itemNoun={FLEET_COPY.pickNoun}
          searchPlaceholder={FLEET_COPY.pickSearch}
          data-testid="allow-machine-machines"
        />
      )}
      {!grant.wholeSite && !grant.machineIds && (
        <p className="flex items-start gap-2 text-xs text-warning" role="note">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{FLEET_COPY.reachesNothing}</span>
        </p>
      )}
      {tier === 3 && (
        <p className="flex items-start gap-2 text-xs text-danger" role="note">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{FLEET_COPY.tier3Warning}</span>
        </p>
      )}
      {!settings.enabled && (
        <p className="text-xs text-muted-foreground">{FLEET_COPY.allowTurnsOn(siteName)}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          {FLEET_COPY.allowCancel}
        </Button>
        <Button onClick={allow} disabled={saving}>
          {FLEET_COPY.allowConfirm}
        </Button>
      </div>
    </section>
  );
}
