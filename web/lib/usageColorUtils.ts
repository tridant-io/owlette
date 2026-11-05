/**
 * Usage percentage → band token. Bands are deliberately far apart in hue so
 * adjacent ones stay distinguishable: <30 calm, <50 steady, <70 working,
 * <85 strained, else critical. Each theme defines the `--band-*` values in globals.css.
 */

/** Tailwind background class for a 0-100 usage percentage. */
export function getUsageColorClass(percent: number): string {
  if (percent < 30) {
    return 'bg-band-calm';
  } else if (percent < 50) {
    return 'bg-band-steady';
  } else if (percent < 70) {
    return 'bg-band-working';
  } else if (percent < 85) {
    return 'bg-band-strained';
  } else {
    return 'bg-band-critical';
  }
}
