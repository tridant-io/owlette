import type { SwoopSession } from '@/lib/swoop/features';

/**
 * take someone out of a swoop session, by a seat they hold. one streamer serves
 * everyone, so it ends for everyone in it and the record names whom it was for.
 * the caller's own page sees the kill's bye and comes back on its own.
 */
export async function kickSwoopViewer(
  session: Pick<SwoopSession, 'siteId' | 'machineId' | 'sid'>,
  viewerId: string,
): Promise<void> {
  const res = await fetch(
    `/api/sites/${encodeURIComponent(session.siteId)}/machines/${encodeURIComponent(session.machineId)}/swoop/sessions/${encodeURIComponent(session.sid)}/kick`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerId }),
    },
  ).catch(() => null);
  if (res?.ok) return;
  // a network failure, or a refusal with no sentence of its own, says only that it could not
  const problem = ((await res?.json().catch(() => null)) ?? {}) as { detail?: unknown };
  throw new Error(typeof problem.detail === 'string' ? problem.detail : 'could not kick them');
}
