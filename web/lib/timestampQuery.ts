import { NextResponse } from 'next/server';
import { problemValidation } from '@/lib/apiErrors';

/** Parse a `since`/`until` query param — unix-ms or ISO 8601; absent or blank is undefined. */
export function parseTimestampQuery(
  searchParams: URLSearchParams,
  field: 'since' | 'until',
): number | undefined | NextResponse {
  const raw = searchParams.get(field);
  if (raw === null || raw.trim() === '') return undefined;

  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber;

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return problemValidation(`${field} must be unix-ms or iso8601`, {
      [`query.${field}`]: ['invalid date'],
    });
  }
  return parsed;
}
