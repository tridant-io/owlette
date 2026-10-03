/**
 * MENU_SURFACE — app-wide treatment for floating menu panels, ported verbatim
 * from `web/components/PageHeader.tsx` so desktop popovers/dropdowns read as the
 * same object as their web counterparts. Shared here rather than retyped per
 * call site.
 *
 * the shadow and ring come from the elevation tokens, which resolve to the old
 * black/50 and white/10 in dark and to a soft navy in light.
 *
 * Usage: `<DropdownMenuContent className={`${MENU_SURFACE} w-56`}>`
 */
export const MENU_SURFACE =
  'border-border bg-secondary/85 backdrop-blur-sm shadow-2xl shadow-elevation-shadow ring-1 ring-elevation-ring'
