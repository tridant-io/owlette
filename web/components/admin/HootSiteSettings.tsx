'use client';

import { AllowMachineCard } from '@/components/admin/AllowMachineCard';
import { HootApprovalSwitch } from '@/components/admin/HootApprovalSwitch';
import { Panel } from '@/components/admin/Panel';
import { SettingSwitch } from '@/components/admin/SettingSwitch';
import { FLEET_COPY, FleetSendersEditor } from '@/components/FleetSendersEditor';
import { useFleetSettings } from '@/hooks/useFleetSettings';
import { useSiteMachines } from '@/hooks/useSiteMachines';
import { MemberLockSection } from '@/components/MemberLock';

/**
 * one site's hoot settings: the approval its privileged tools wait for, and
 * whether its machines may act on each other (ADR 0017), and which. the caller
 * shows it only for a site the person administers whole, which is who holds
 * FLEET_SETTINGS_MANAGE. a machine named in the link that has no sender row yet,
 * or whose site switch is off, gets the allow card above the panels.
 */
export function HootSiteSettings({
  siteId,
  siteName,
  machineId,
  onCancelAllow,
}: {
  siteId: string;
  siteName: string;
  machineId?: string;
  onCancelAllow: () => void;
}) {
  const fleet = useFleetSettings(siteId);
  const { machines } = useSiteMachines(siteId);
  const asking = machineId ? machines?.find((m) => m.id === machineId) : undefined;
  const hasRow = machineId !== undefined && Object.prototype.hasOwnProperty.call(fleet.settings.senders, machineId);

  return (
    <MemberLockSection siteId={siteId}>
    <div className="space-y-4">
      {asking && machines && !fleet.loading && (!hasRow || !fleet.settings.enabled) && (
        <AllowMachineCard
          siteId={siteId}
          siteName={siteName}
          machine={asking}
          machines={machines}
          onCancel={onCancelAllow}
        />
      )}
      <Panel id="hoot-approval" title="approval">
        <HootApprovalSwitch siteId={siteId} />
      </Panel>
      <Panel id="hoot-machines" title="machines">
        <div className="space-y-4">
          <SettingSwitch
            id={`fleet-${siteId}`}
            label={FLEET_COPY.switchLabel}
            description={FLEET_COPY.switchDescription}
            checked={fleet.settings.enabled}
            loading={fleet.loading}
            url={`/api/sites/${encodeURIComponent(siteId)}/fleet-settings`}
            field="enabled"
          />
          {/* off, the list of machines is not shown (owner, 2026-11-11): the senders are kept and come back with the switch */}
          {!fleet.loading && !fleet.settings.enabled && (
            <p className="text-xs text-muted-foreground" data-testid="fleet-senders-off">
              {FLEET_COPY.offHint}
            </p>
          )}
          {fleet.settings.enabled && <FleetSendersEditor siteId={siteId} />}
        </div>
      </Panel>
    </div>
    </MemberLockSection>
  );
}
