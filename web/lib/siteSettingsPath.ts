/**
 * the one builder for every link to a site's settings: the header, the site
 * list's gear, the dashboard's "turn on swoop…", the swoop picker and the swoop
 * viewer. swoop's switch has its own page in the admin panel's swoop section.
 */

export const SITE_SECTIONS = ['general', 'members', 'machines', 'danger'] as const;

export type SiteSection = (typeof SITE_SECTIONS)[number];

export const SITE_SECTION_LABELS: Record<SiteSection, string> = {
  general: 'general',
  members: 'members',
  machines: 'machines',
  danger: 'danger zone',
};

export function parseSiteSection(raw: string | null): SiteSection {
  return SITE_SECTIONS.find((section) => section === raw) ?? 'general';
}

export function siteSettingsPath(siteId: string, section?: SiteSection): string {
  const path = `/admin/sites/${encodeURIComponent(siteId)}`;
  return section && section !== 'general' ? `${path}?section=${section}` : path;
}

export const SWOOP_SETTINGS_PATH = '/admin/swoop';

/** where a section that left the site's page lives now, so its old links still land on it. */
export function movedSiteSectionPath(raw: string | null): string | null {
  return raw === 'swoop' ? SWOOP_SETTINGS_PATH : null;
}
