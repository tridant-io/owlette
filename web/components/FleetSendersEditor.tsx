'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { MultiSelect } from '@/components/ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useFleetSettings } from '@/hooks/useFleetSettings';
import { useSiteMachines } from '@/hooks/useSiteMachines';
import { storedFleetGrant, type FleetGrant, type StoredFleetGrant } from '@/lib/fleet/grant';
import { toast } from '@/lib/toast';

// every word the admin panel's hoot page shows for the grant (ADR 0017)
export const FLEET_COPY = {
  switchLabel: 'let machines act on other machines',
  switchDescription:
    "a machine you choose can use hoot's tools on other machines in this site, through an ai agent running on it. off until you turn it on.",
  offHint: 'turn this on to choose which machines may act.',
  senderToggle: 'may act on others',
  tierLabel: 'how far',
  tiers: { 1: 'read', 2: 'bounded changes', 3: 'privileged' },
  reachLabel: 'on which machines',
  reaches: { none: 'no machines', some: 'chosen machines', whole: 'the whole site' },
  pickMachines: 'pick machines',
  pickNoun: 'machines',
  pickSearch: 'search machines…',
  tier3Warning: 'privileged runs shell commands on the machines it may act on, with nobody approving.',
  reachesNothing: 'reaches no machines yet: pick them under on which machines.',
  loading: 'loading machines…',
  noMachines: 'this site has no machines yet.',
} as const;

type Reach = keyof typeof FLEET_COPY.reaches;
type Tier = FleetGrant['maxTier'];
type Senders = Record<string, StoredFleetGrant>;

function reachOf(grant: StoredFleetGrant, picking: boolean): Reach {
  if (grant.wholeSite) return 'whole';
  return (grant.machineIds?.length ?? 0) > 0 || picking ? 'some' : 'none';
}

/**
 * the senders of a site's fleet grant (ADR 0017), one row per machine. every
 * change PATCHes the whole map at once, like the site's switches, and the rows
 * follow `useFleetSettings`. writes go out one at a time, and the rows show the
 * map being written until the snapshot catches up, so a second pick in the
 * machines list never starts from the first one's old state.
 */
export function FleetSendersEditor({ siteId }: { siteId: string }) {
  const { settings, loading } = useFleetSettings(siteId);
  const { machines, error } = useSiteMachines(siteId);
  const [draft, setDraft] = useState<Senders | null>(null);
  // machines whose reach is "chosen machines" with none picked yet, which stores the same as none
  const [picking, setPicking] = useState<ReadonlySet<string>>(new Set());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const inflight = useRef(0);
  const sawSnapshot = useRef(false);

  // a snapshot with no write outstanding is the settled state; one that lands mid-write is noted for the write's end
  useEffect(() => {
    if (inflight.current === 0) setDraft(null);
    else sawSnapshot.current = true;
  }, [settings]);

  const stored: Senders = Object.fromEntries(
    Object.entries(settings.senders).map(([id, grant]) => [id, storedFleetGrant(grant)]),
  );
  const senders = draft ?? stored;
  const latest = useRef(senders);
  latest.current = senders;

  const write = (next: Senders) => {
    setDraft(next);
    latest.current = next;
    inflight.current += 1;
    queue.current = queue.current.then(async () => {
      let failed = false;
      try {
        const res = await fetch(`/api/sites/${encodeURIComponent(siteId)}/fleet-settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ senders: next }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.detail || body?.title || 'try again in a moment.');
        }
      } catch (err) {
        failed = true;
        console.error('Failed to update the machines that may act on others:', err);
        toast.error('could not change which machines may act on others', {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        inflight.current -= 1;
        if (inflight.current === 0 && (failed || sawSnapshot.current)) {
          sawSnapshot.current = false;
          setDraft(null);
        }
      }
    });
  };

  const change = (machineId: string, grant: StoredFleetGrant | null) => {
    const next = { ...latest.current };
    if (grant) next[machineId] = grant;
    else delete next[machineId];
    write(next);
  };

  const setPicks = (machineId: string, on: boolean) =>
    setPicking((prev) => {
      const next = new Set(prev);
      if (on) next.add(machineId);
      else next.delete(machineId);
      return next;
    });

  const options = (machines ?? []).map((m) => ({ value: m.id, label: m.name }));

  return (
    <>
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : machines === null || loading ? (
        <p className="text-xs text-muted-foreground">{FLEET_COPY.loading}</p>
      ) : machines.length === 0 ? (
        <p className="text-xs text-muted-foreground">{FLEET_COPY.noMachines}</p>
      ) : (
        <ul className="space-y-2" data-testid="fleet-senders">
          {machines.map((machine) => {
            const grant = Object.prototype.hasOwnProperty.call(senders, machine.id) ? senders[machine.id] : null;
            const toggleId = `fleet-sender-${siteId}-${machine.id}`;
            const reach = grant ? reachOf(grant, picking.has(machine.id)) : 'none';
            return (
              <li
                key={machine.id}
                data-testid={`fleet-sender-${machine.id}`}
                className="rounded-lg border border-border p-3 space-y-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Label htmlFor={toggleId} className="text-foreground wrap-anywhere">
                      {machine.name}
                    </Label>
                    <p className="text-xs text-muted-foreground">{FLEET_COPY.senderToggle}</p>
                  </div>
                  <Switch
                    id={toggleId}
                    checked={grant !== null}
                    aria-label={`${machine.name} ${FLEET_COPY.senderToggle}`}
                    onCheckedChange={(on) => {
                      // a new sender starts at the lowest tier, picking its machines: the
                      // owner turned rows on three times and never found where to pick them
                      setPicks(machine.id, on);
                      change(machine.id, on ? { maxTier: 1 } : null);
                    }}
                  />
                </div>
                {grant && (
                  <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="min-w-0 space-y-1.5">
                        <Label className="text-xs text-muted-foreground">{FLEET_COPY.tierLabel}</Label>
                        <Select
                          value={String(grant.maxTier)}
                          onValueChange={(v) => change(machine.id, { ...grant, maxTier: Number(v) as Tier })}
                        >
                          <SelectTrigger
                            aria-label={`${machine.name} ${FLEET_COPY.tierLabel}`}
                            className="w-full border-border bg-background text-foreground"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {([1, 2, 3] as const).map((tier) => (
                              <SelectItem key={tier} value={String(tier)}>
                                {FLEET_COPY.tiers[tier]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="min-w-0 space-y-1.5">
                        <Label className="text-xs text-muted-foreground">{FLEET_COPY.reachLabel}</Label>
                        <Select
                          value={reach}
                          onValueChange={(v) => {
                            const next = v as Reach;
                            setPicks(machine.id, next === 'some');
                            change(
                              machine.id,
                              next === 'whole' ? { maxTier: grant.maxTier, wholeSite: true } : { maxTier: grant.maxTier },
                            );
                          }}
                        >
                          <SelectTrigger
                            aria-label={`${machine.name} ${FLEET_COPY.reachLabel}`}
                            className="w-full border-border bg-background text-foreground"
                          >
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
                        groups={[{ group: null, options }]}
                        selected={grant.machineIds ?? []}
                        onChange={(ids) => change(machine.id, { maxTier: grant.maxTier, machineIds: ids })}
                        allLabel={FLEET_COPY.pickMachines}
                        itemNoun={FLEET_COPY.pickNoun}
                        searchPlaceholder={FLEET_COPY.pickSearch}
                        data-testid={`fleet-sender-${machine.id}-machines`}
                      />
                    )}
                    {!grant.wholeSite && !grant.machineIds?.length && (
                      <p className="flex items-start gap-2 text-xs text-warning" role="note">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                        <span>{FLEET_COPY.reachesNothing}</span>
                      </p>
                    )}
                    {grant.maxTier === 3 && (
                      <p className="flex items-start gap-2 text-xs text-danger" role="note">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                        <span>{FLEET_COPY.tier3Warning}</span>
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
