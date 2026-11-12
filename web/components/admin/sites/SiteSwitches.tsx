'use client';

import { ImmediateSwitch, SettingSwitch } from '@/components/admin/SettingSwitch';
import { useSwoopSettings } from '@/hooks/useSwoopSettings';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';

const siteApi = (siteId: string) => `/api/sites/${encodeURIComponent(siteId)}`;

/** a site's swoop switch, in its row on admin panel → swoop → settings. */
export function SwoopSwitch({ siteId, siteName }: { siteId: string; siteName: string }) {
  const swoop = useSwoopSettings(siteId);

  return (
    <ImmediateSwitch
      id={`swoop-${siteId}`}
      label={`swoop on ${siteName}`}
      checked={swoop.settings.enabled}
      loading={swoop.loading}
      url={`${siteApi(siteId)}/swoop-settings`}
      field="enabled"
    />
  );
}

/** the site's keep screens awake switch, on its settings page's machines section. */
export function KeepScreensAwakeSwitch({ siteId }: { siteId: string }) {
  const display = useDisplaySettings(siteId);

  return (
    <SettingSwitch
      id={`keep-awake-${siteId}`}
      label="keep screens awake"
      description="machines on this site never sleep, blank or lock"
      checked={display.settings.keepAwake}
      loading={display.loading}
      url={`${siteApi(siteId)}/display-settings`}
      field="keepAwake"
    />
  );
}
