/**
 * swoop control is tied to the networks a user verified (owner, 2026-10-10).
 *
 * a step-up window says "this user passed a second factor for this machine in
 * the last 7 days", and it travels with the login cookie: a cookie stolen and
 * replayed from someone else's machine inherits it. parsec closes that by
 * blocking a token used from an address the account has not verified; this does
 * the same, coarsened to the asn (`lib/network.server.ts`) so a phone or a cgnat
 * line is not asked several times a day. control needs the request's network to
 * be one this user passed a second factor on in the last 7 days; a new network
 * asks once, and passing adds it. watching is never affected.
 *
 * `SWOOP_NETWORK_BINDING`:
 *   - `log` (the default): decide as before, but record every control check
 *     (`step_up_network_check`) and the networks ceremonies pass on, and send no
 *     notice. two weeks of it say how often enforcing would ask, before it does.
 *   - `enforce`: an unverified network reads as no window, the sign-in's own
 *     ceremony stands in only on the network it ran on, and the first ceremony
 *     ever on a network emails the user.
 *   - `off`: nothing recorded, nothing checked.
 *
 * the cost, named: an attacker on the victim's own isp gets through, and a vpn or
 * a phone hotspot asks once each. the notice email is the backstop for the first.
 */

import type { NextRequest } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import { requestNetwork, UNKNOWN_NETWORK, type RequestNetwork } from '@/lib/network.server';
import { getResend, FROM_EMAIL } from '@/lib/resendClient.server';
import { buildNewNetworkEmail } from '@/lib/emailTemplates.server';

export type NetworkBindingMode = 'off' | 'log' | 'enforce';

export function networkBindingMode(): NetworkBindingMode {
  const raw = process.env.SWOOP_NETWORK_BINDING?.trim().toLowerCase();
  return raw === 'off' || raw === 'enforce' ? raw : 'log';
}

/** how long a network stays verified with no second factor passed on it. */
export const VERIFIED_NETWORK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `users/{uid}/verified_networks/{key}`. No `firestore.rules` match, so the
 * catch-all denies every client: no browser can read or add a network.
 */
function verifiedNetworkRef(userId: string, key: string) {
  return getAdminDb().collection('users').doc(userId).collection('verified_networks').doc(key);
}

/** the request's network, or null when the binding is off. */
export function bindingNetwork(request: NextRequest): RequestNetwork | null {
  return networkBindingMode() === 'off' ? null : requestNetwork(request);
}

/** expiry is read here, so a lapsed entry needs no scheduler to stop counting. */
export async function isVerifiedNetwork(
  userId: string,
  key: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (key === UNKNOWN_NETWORK) return false;
  const snap = await verifiedNetworkRef(userId, key).get();
  const at = snap.exists ? snap.data()?.lastVerifiedAt : undefined;
  return typeof at === 'number' && nowMs - at <= VERIFIED_NETWORK_TTL_MS;
}

/** the network half of one control decision. */
export interface ControlNetwork {
  mode: NetworkBindingMode;
  /** null when the binding is off. */
  network: RequestNetwork | null;
  /** this user passed a second factor on this network in the last 7 days. never true for `unknown`. */
  verified: boolean;
}

export async function controlNetwork(request: NextRequest, userId: string): Promise<ControlNetwork> {
  const mode = networkBindingMode();
  const network = bindingNetwork(request);
  return { mode, network, verified: network ? await isVerifiedNetwork(userId, network.key) : false };
}

/** may an open step-up window be read back from this network? only `enforce` says no. */
export function networkAdmitsWindow(binding: ControlNetwork): boolean {
  return binding.mode !== 'enforce' || binding.verified;
}

/**
 * may the sign-in's own ceremony stand in for the step-up from this network? in
 * `enforce`, only on the network that ceremony ran on (`mfaNetwork` on the login
 * session): otherwise a cookie stolen minutes after a sign-in would open a window
 * from wherever it is replayed.
 */
export function networkAdmitsFreshCeremony(
  binding: ControlNetwork,
  ceremonyNetwork: string | undefined,
): boolean {
  if (binding.mode !== 'enforce') return true;
  return (
    binding.network !== null &&
    binding.network.key !== UNKNOWN_NETWORK &&
    binding.network.key === ceremonyNetwork
  );
}

function networkLabel(network: RequestNetwork): string {
  return network.asn ? `AS${network.asn}` : network.key;
}

async function sendNewNetworkNotice(args: {
  userId: string;
  network: RequestNetwork;
  machineId?: string;
  at: number;
}): Promise<void> {
  const resend = getResend();
  if (!resend) {
    logger.warn('[swoop/networks] resend not configured; new-network notice not sent', {
      context: 'swoop/networks',
    });
    return;
  }
  const user = await getAdminDb().collection('users').doc(args.userId).get();
  const email = user.data()?.email;
  if (typeof email !== 'string' || !email) return;
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: email,
    subject: 'new network verified for swoop control',
    html: buildNewNetworkEmail({
      network: networkLabel(args.network),
      at: new Date(args.at),
      ...(args.machineId ? { machineId: args.machineId } : {}),
    }),
  });
  if (error) throw error;
}

/**
 * a second factor just passed on this network: add it to the user's verified
 * networks, or refresh it. the first ceremony ever on a network emails the user,
 * in `enforce` only, and once per network, because only the transaction that
 * created the entry sends.
 *
 * best effort and never throws: the ceremony has passed and the request is
 * authorised, so a write that fails costs the user one more prompt, never the
 * ceremony.
 */
export async function recordVerifiedNetwork(args: {
  userId: string;
  network: RequestNetwork;
  machineId?: string;
  nowMs?: number;
}): Promise<void> {
  const mode = networkBindingMode();
  if (mode === 'off' || args.network.key === UNKNOWN_NETWORK) return;
  const now = args.nowMs ?? Date.now();
  let created = false;
  try {
    const ref = verifiedNetworkRef(args.userId, args.network.key);
    created = await getAdminDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      tx.set(
        ref,
        {
          ...(snap.exists ? {} : { firstSeenAt: now }),
          lastVerifiedAt: now,
          asn: args.network.asn,
          label: networkLabel(args.network),
        },
        { merge: true },
      );
      return !snap.exists;
    });
  } catch (err) {
    logger.warn('[swoop/networks] could not record a verified network', {
      context: 'swoop/networks',
      data: { key: args.network.key, err: err instanceof Error ? err.message : String(err) },
    });
    return;
  }
  if (!created || mode !== 'enforce') return;
  try {
    await sendNewNetworkNotice({ ...args, at: now });
  } catch (err) {
    logger.warn('[swoop/networks] could not send a new-network notice', {
      context: 'swoop/networks',
      data: { key: args.network.key, err: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * a sign-in's second factor just passed on this request: add the network to the
 * user's verified list, and answer the key to stamp on the login session as
 * `mfaNetwork`, which is what lets that ceremony stand in for swoop's step-up
 * only on the network it ran on. undefined when the binding is off.
 */
export async function signInCeremonyNetwork(
  request: NextRequest,
  userId: string,
): Promise<string | undefined> {
  const network = bindingNetwork(request);
  if (!network) return undefined;
  await recordVerifiedNetwork({ userId, network });
  return network.key;
}
