/**
 * the network a request came from, as the edge reports it.
 *
 * cloudflare adds two headers on the way in (a transform rule): `X-Owlette-Asn`,
 * the client's autonomous system number, and `X-Owlette-Edge`, a secret this
 * origin shares with the edge (`EDGE_SHARED_SECRET`). the asn counts only beside
 * the secret: a request that reached the origin around cloudflare, or set the
 * header itself, has network `unknown`, and `unknown` never matches anything.
 *
 * the asn and not the address, because carrier-grade nat, ipv6 privacy addresses
 * and v4/v6 switching move a user's address several times a day while the asn
 * (the isp or carrier) stays put. the address prefix is kept for the log only:
 * it comes from forwarding headers anyone can set.
 */

import { createHash, timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';
import { getClientIp } from '@/lib/rateLimit';

export const UNKNOWN_NETWORK = 'unknown';

export interface RequestNetwork {
  /** the asn in decimal, only when the edge vouched for the request. */
  asn: string | null;
  /** the client address's /24 (ipv4) or /64 (ipv6). forgeable; for the log only. */
  prefix: string | null;
  /** the request carried the edge's shared secret. */
  viaEdge: boolean;
  /** `asn:<n>` when the edge vouched for an asn, else `unknown`. */
  key: string;
}

const ASN_PATTERN = /^[1-9][0-9]{0,9}$/;
const ASN_MAX = 4_294_967_295;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function edgeVouches(presented: string | null): boolean {
  const secret = process.env.EDGE_SHARED_SECRET;
  if (!secret || !presented) return false;
  // hashed first, so the comparison takes the same time whatever was presented
  return timingSafeEqual(sha256(presented), sha256(secret));
}

function ipv4Prefix(ip: string): string | null {
  const octets = ip.split('.');
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return null;
  return `${octets.slice(0, 3).map(Number).join('.')}.0/24`;
}

function ipv6Prefix(ip: string): string | null {
  const halves = ip.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  // `::` stands for at least one group, and without it there must be eight
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** the /24 or /64 an address sits in; an ipv4-mapped ipv6 address counts as its ipv4. */
export function addressPrefix(ip: string): string | null {
  if (ip.includes('.')) return ipv4Prefix(ip.slice(ip.lastIndexOf(':') + 1));
  if (ip.includes(':')) return ipv6Prefix(ip);
  return null;
}

export function requestNetwork(req: NextRequest): RequestNetwork {
  const viaEdge = edgeVouches(req.headers.get('x-owlette-edge'));
  const raw = req.headers.get('x-owlette-asn')?.trim() ?? '';
  const asn = viaEdge && ASN_PATTERN.test(raw) && Number(raw) <= ASN_MAX ? raw : null;
  const ip = getClientIp(req);
  return {
    asn,
    prefix: ip === 'unknown' ? null : addressPrefix(ip),
    viaEdge,
    key: asn ? `asn:${asn}` : UNKNOWN_NETWORK,
  };
}

/** what a step-up window stores about the network it opened on. */
export function networkRecord(network: RequestNetwork): Pick<RequestNetwork, 'key' | 'prefix' | 'asn'> {
  return { key: network.key, prefix: network.prefix, asn: network.asn };
}
