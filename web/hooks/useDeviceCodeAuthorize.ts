'use client';

import { useCallback, useState } from 'react';
import { toast } from '@/lib/toast';

/** the machine a phrase names, for the phrase and site it was looked up with. */
interface Review {
  phrase: string;
  siteId: string;
  machineId: string | null;
  existing: boolean;
}

/**
 * Shared "enter code" device-code authorization — one implementation for /add,
 * the AddMachineButton modal and the zero-machine getting-started card, so they
 * cannot drift.
 *
 * Two steps against `POST /api/agent/auth/device-code/authorize`: `lookUp` sends
 * `preview` and puts the machine the phrase names on screen, then `authorize`
 * approves it. A machine already on the site comes back `existing`, and pairs only
 * with its name sent as `replaceMachineId`. The route needs only a session + site
 * access, not an existing machine, so it works on a brand-new empty site.
 */
export function useDeviceCodeAuthorize(siteId: string) {
  const [phrase, setPhrase] = useState('');
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [success, setSuccess] = useState(false);
  const [authorizedMachineId, setAuthorizedMachineId] = useState<string | null>(null);
  const [lookedUp, setLookedUp] = useState<Review | null>(null);
  // editing the phrase or the site makes the operator look the machine up again.
  const review = lookedUp && lookedUp.phrase === phrase && lookedUp.siteId === siteId ? lookedUp : null;

  const send = useCallback(async ({ preview, replaceMachineId }: { preview?: true; replaceMachineId?: string }) => {
    const trimmed = phrase.trim();
    if (!trimmed || !siteId) return;

    setIsAuthorizing(true);
    try {
      const response = await fetch('/api/agent/auth/device-code/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairPhrase: trimmed.toLowerCase(),
          siteId,
          preview,
          replaceMachineId,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        // joined the site since the preview: ask for the confirmation rather than fail.
        if (data.code === 'machine_exists' && typeof data.machineId === 'string') {
          setLookedUp({ phrase, siteId, machineId: data.machineId, existing: true });
          return;
        }
        // "not found" can mean the machine is pairing with a different owlette server;
        // "has expired" and the 409 already-used message reach the operator verbatim.
        if (response.status === 404 && /not found/i.test(data.error ?? '')) {
          throw new Error(
            `phrase not found on ${window.location.host} — it may have expired, or the machine may be pairing with a different owlette server.`
          );
        }
        throw new Error(data.error || 'authorization failed');
      }

      if (preview) {
        setLookedUp({
          phrase,
          siteId,
          machineId: typeof data.machineId === 'string' ? data.machineId : null,
          existing: data.existing === true,
        });
        return;
      }

      setLookedUp(null);
      setAuthorizedMachineId(typeof data.machineId === 'string' ? data.machineId : null);
      setSuccess(true);
      toast.success('machine authorized');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message || 'failed to authorize machine');
    } finally {
      setIsAuthorizing(false);
    }
  }, [phrase, siteId]);

  const lookUp = useCallback(() => send({ preview: true }), [send]);

  const authorize = useCallback(
    () => send({ replaceMachineId: (review?.existing && review.machineId) || undefined }),
    [send, review],
  );

  const cancel = useCallback(() => setLookedUp(null), []);

  const reset = useCallback(() => {
    setPhrase('');
    setIsAuthorizing(false);
    setSuccess(false);
    setAuthorizedMachineId(null);
    setLookedUp(null);
  }, []);

  return {
    phrase,
    setPhrase,
    review,
    lookUp,
    authorize,
    cancel,
    isAuthorizing,
    success,
    authorizedMachineId,
    reset,
  };
}
