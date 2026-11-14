'use client';

import { HootApprovalSwitch } from '@/components/admin/HootApprovalSwitch';
import { Panel } from '@/components/admin/Panel';
import { SettingSwitch } from '@/components/admin/SettingSwitch';
import { FLEET_COPY, FleetSendersEditor } from '@/components/FleetSendersEditor';
import { useFleetSettings } from '@/hooks/useFleetSettings';

/**
 * one site's hoot settings: the approval its privileged tools wait for, and
 * whether its machines may act on each other (ADR 0017), and which. the caller
 * shows it only for a site the person administers whole, which is who holds
 * FLEET_SETTINGS_MANAGE.
 */
export function HootSiteSettings({ siteId }: { siteId: string }) {
  const fleet = useFleetSettings(siteId);

  return (
    <div className="space-y-4">
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
  );
}
