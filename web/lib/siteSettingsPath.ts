/**
 * the one builder for every link to a site's settings: the header, the site
 * list's gear, the dashboard's "turn on swoop…", the swoop picker and the swoop
 * viewer.
 */

export const SITE_SECTIONS = ['general', 'members', 'machines', 'swoop', 'billing', 'danger'] as const;

export type SiteSection = (typeof SITE_SECTIONS)[number];

export const SITE_SECTION_LABELS: Record<SiteSection, string> = {
  general: 'general',
  members: 'members',
  machines: 'machines',
  swoop: 'swoop & screens',
  billing: 'billing',
  danger: 'danger zone',
};

export function parseSiteSection(raw: string | null): SiteSection {
  return SITE_SECTIONS.find((section) => section === raw) ?? 'general';
}

export function siteSettingsPath(siteId: string, section?: SiteSection): string {
  const path = `/admin/sites/${encodeURIComponent(siteId)}`;
  return section && section !== 'general' ? `${path}?section=${section}` : path;
}
