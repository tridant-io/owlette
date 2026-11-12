/**
 * SSRF-safe URL validator for user-supplied webhook endpoints. Requires
 * `https:` (only `http:` when ALLOW_INSECURE_WEBHOOK_URLS=1 for local smoke
 * tests), rejects private/loopback/link-local/reserved IP literals (v4 + v6),
 * requires DNS to resolve to public addresses only, and restricts the port to
 * unset or standard http(s).
 *
 * DNS is re-checked because a public record can point at an internal IP and
 * bypass the literal check. TOCTOU remains — THE DISPATCHER MUST RE-VALIDATE
 * AT SEND TIME, and must send with `redirect: 'manual'`: a redirect's target is
 * never validated.
 *
 * A deliberate mirror of `web/lib/webhookUrl.ts` (functions cannot import from
 * web) for the retry pump's send-time check. Change both together.
 */

import { promises as dns } from 'node:dns';
import net from 'node:net';

const ALLOWED_PORTS = new Set<string>(['', '80', '443', '8080', '8443']);
const ALLOW_INSECURE = process.env.ALLOW_INSECURE_WEBHOOK_URLS === '1';

export type WebhookUrlError =
  | 'invalid_url'
  | 'bad_scheme'
  | 'bad_port'
  | 'private_ip'
  | 'dns_resolve_failed'
  | 'url_too_long';

export interface WebhookUrlResult {
  ok: true;
  url: string;
  hostname: string;
}

export type WebhookUrlValidation = WebhookUrlResult | { ok: false; reason: WebhookUrlError; detail?: string };

const MAX_URL_LENGTH = 2048;

export async function validateWebhookUrl(raw: unknown): Promise<WebhookUrlValidation> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'invalid_url', detail: 'url must be a non-empty string' };
  }
  if (raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'url_too_long', detail: `url exceeds ${MAX_URL_LENGTH} chars` };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url', detail: 'url does not parse' };
  }

  if (parsed.protocol !== 'https:' && !(ALLOW_INSECURE && parsed.protocol === 'http:')) {
    return {
      ok: false,
      reason: 'bad_scheme',
      detail: ALLOW_INSECURE
        ? `scheme must be http: or https: (got ${parsed.protocol})`
        : `scheme must be https: (got ${parsed.protocol})`,
    };
  }

  if (!ALLOWED_PORTS.has(parsed.port)) {
    return {
      ok: false,
      reason: 'bad_port',
      detail: `port ${parsed.port} not allowed — only 80, 443, 8080, 8443`,
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    return { ok: false, reason: 'invalid_url', detail: 'hostname is empty' };
  }

  // Literal IPs first — no point paying for DNS.
  const ipFamily = net.isIP(hostname);
  if (ipFamily === 4 && isPrivateIpv4(hostname)) {
    return { ok: false, reason: 'private_ip', detail: `hostname ${hostname} is a private ipv4` };
  }
  if (ipFamily === 6 && isPrivateIpv6(hostname)) {
    return { ok: false, reason: 'private_ip', detail: `hostname ${hostname} is a private ipv6` };
  }

  if (ipFamily === 0) {
    let resolved: Array<{ address: string; family: number }>;
    try {
      resolved = await dns.lookup(hostname, { all: true });
    } catch {
      return {
        ok: false,
        reason: 'dns_resolve_failed',
        detail: `hostname ${hostname} did not resolve`,
      };
    }
    if (resolved.length === 0) {
      return { ok: false, reason: 'dns_resolve_failed', detail: 'no addresses returned' };
    }
    for (const { address, family } of resolved) {
      if (family === 4 && isPrivateIpv4(address)) {
        return {
          ok: false,
          reason: 'private_ip',
          detail: `${hostname} resolves to private ipv4 ${address}`,
        };
      }
      if (family === 6 && isPrivateIpv6(address)) {
        return {
          ok: false,
          reason: 'private_ip',
          detail: `${hostname} resolves to private ipv6 ${address}`,
        };
      }
    }
  }

  return { ok: true, url: parsed.toString(), hostname };
}

export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  // 0.0.0.0/8 — "this network"
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (includes cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 — reserved
  if (a === 192 && b === 0) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 — benchmark testing
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 — reserved
  if (a >= 240) return true;
  // 100.64.0.0/10 — carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // ::  all-zeros / :: 1 loopback
  if (lower === '::' || lower === '::1') return true;
  // fe80::/10 — link-local
  if (lower.startsWith('fe80:') || lower.startsWith('fe90:') || lower.startsWith('fea0:') || lower.startsWith('feb0:')) {
    return true;
  }
  // fc00::/7 — unique local (fc00..fdff)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // ::ffff:a.b.c.d — ipv4-mapped — inspect the embedded v4
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length);
    return isPrivateIpv4(v4);
  }
  // ff00::/8 — multicast
  if (lower.startsWith('ff')) return true;
  return false;
}
