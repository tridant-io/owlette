'use client';

import { Panel } from '@/components/admin/Panel';
import { SettingSwitch } from '@/components/admin/SettingSwitch';
import { FLEET_COPY, FleetSendersEditor } from '@/components/FleetSendersEditor';
import { useFleetSettings } from '@/hooks/useFleetSettings';

/**
 * one site's hoot settings: whether its machines may act on each other
 * (ADR 0017), and which. the caller shows it only for a site the person
 * administers whole, which is who holds FLEET_SETTINGS_MANAGE.
 */
export function HootSiteSettings({ siteId }: { siteId: string }) {
  const fleet = useFleetSettings(siteId);

  return (
    <div className="space-y-4">
      <Panel id="hoot-machines" title="machines" description="this switch acts the moment it moves.">
        <SettingSwitch
          id={`fleet-${siteId}`}
          label={FLEET_COPY.switchLabel}
          description={FLEET_COPY.switchDescription}
          checked={fleet.settings.enabled}
          loading={fleet.loading}
          url={`/api/sites/${encodeURIComponent(siteId)}/fleet-settings`}
          field="enabled"
        />
      </Panel>
      <FleetSendersEditor siteId={siteId} />
    </div>
  );
}
