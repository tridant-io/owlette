/**
 * `owlette trigger <event>` — fire a synthetic webhook for local testing.
 *
 * Direct (`--to <url>`): build the body, sign with --signing-secret
 * (stripe-style `t=<unix>,v1=<hmac>`) and POST straight to the url.
 * Server probe (`--to <url> --via-api`): POST /api/webhooks/probe, which signs
 * and sends one delivery — no subscription, nothing on /api/events/stream.
 *
 * Canned payload templates supply per-event defaults; --payload /
 * --payload-file override them.
 */

import { Command } from 'commander';
import { createHmac, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { loadConfig } from '../config';
import { fetchWithTimeout } from '../lib/http';

const CANNED_PAYLOADS: Record<string, Record<string, unknown>> = {
  'version.published': {
    roostId: 'rst_synthetic_01',
    versionId: 'vrs_synthetic_01',
    versionNumber: 1,
    siteId: null, // filled in per-run
    totalSize: 123456,
    totalFiles: 3,
    createdBy: 'owlette-trigger',
  },
  'deployment.started': {
    roostId: 'rst_synthetic_01',
    rolloutId: 'vrs_synthetic_01',
    siteId: null,
    stage: 'started',
  },
  'deployment.completed': {
    roostId: 'rst_synthetic_01',
    rolloutId: 'vrs_synthetic_01',
    siteId: null,
    stage: 'complete',
    succeeded: 10,
    failed: 0,
  },
  'deployment.failed': {
    roostId: 'rst_synthetic_01',
    rolloutId: 'vrs_synthetic_01',
    siteId: null,
    stage: 'aborted',
    abortReason: 'canary_failure_rate_exceeded',
    succeeded: 3,
    failed: 7,
  },
  'version.rolled_back': {
    roostId: 'rst_synthetic_01',
    siteId: null,
    fromVersion: 'vrs_synthetic_02',
    toVersion: 'vrs_synthetic_01',
    triggeredBy: 'owlette-trigger',
  },
  'chunk.garbage_collected': {
    hash: 'a'.repeat(64),
    sizeBytes: 4 * 1024 * 1024,
    siteId: null,
  },
  'chunk.verify_failed': {
    hash: 'a'.repeat(64),
    expectedDigest: 'a'.repeat(64),
    actualDigest: 'b'.repeat(64),
    siteId: null,
  },
  'quota.warning': {
    siteId: null,
    tier: 'pro',
    usedBytes: 80 * 1024 * 1024 * 1024,
    limitBytes: 100 * 1024 * 1024 * 1024,
    threshold: 0.8,
  },
  'quota.exceeded': {
    siteId: null,
    tier: 'pro',
    usedBytes: 100 * 1024 * 1024 * 1024,
    limitBytes: 100 * 1024 * 1024 * 1024,
    blockedAt: null,
  },
  'api_key.used': {
    siteId: null,
    keyId: 'key_synthetic_01',
    keyPrefix: 'owk_live_abc',
    ip: '203.0.113.42',
    userAgent: 'owlette-trigger',
    firstUseFromIp: true,
  },
  'api_key.expired': {
    siteId: null,
    keyId: 'key_synthetic_01',
    keyPrefix: 'owk_live_abc',
    name: 'synthetic-trigger-key',
    expiresAt: null,
  },
  'machine.online': {
    siteId: null,
    machineId: 'DESKTOP-SYNTHETIC',
    lastHeartbeat: null, // filled in at runtime
  },
  'machine.offline': {
    siteId: null,
    machineId: 'DESKTOP-SYNTHETIC',
    lastHeartbeat: null,
  },
};

const KNOWN_EVENTS = Object.keys(CANNED_PAYLOADS);

export function registerTriggerCommand(program: Command): void {
  program
    .command('trigger <event>')
    .description(
      `fire a synthetic webhook for local testing (events: ${KNOWN_EVENTS.join(', ')})`,
    )
    .option('--site <siteId>', 'site id for the probe payload / API probe')
    .option(
      '--to <url>',
      'bypass the server probe and POST directly to this url (--signing-secret pairs with it)',
    )
    .option(
      '--via-api',
      'send through /api/webhooks/probe instead of posting directly from the CLI',
    )
    .option(
      '--signing-secret <secret>',
      'hmac-sha256 secret for --to mode; unused when firing via the server probe',
    )
    .option('--payload <json>', 'inline JSON payload overriding the canned body')
    .option('--payload-file <path>', 'path to a JSON file supplying the payload')
    .option('--id <delivery-id>', 'set Roost-Delivery id (default: random uuid)')
    .action(async (event: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const { apiUrl, token } = loadConfig({ profile: globals.profile });
      const json = globals.json === true;

      if (!KNOWN_EVENTS.includes(event) && !opts.payload && !opts.payloadFile) {
        process.stderr.write(
          `owlette: event '${event}' has no canned payload; pass --payload or --payload-file\n` +
            `       known events: ${KNOWN_EVENTS.join(', ')}\n`,
        );
        process.exitCode = 2;
        return;
      }

      let payload: Record<string, unknown>;
      if (opts.payload) {
        try {
          payload = JSON.parse(String(opts.payload)) as Record<string, unknown>;
        } catch (err) {
          process.stderr.write(
            `owlette: --payload is not valid json: ${(err as Error).message}\n`,
          );
          process.exitCode = 2;
          return;
        }
      } else if (opts.payloadFile) {
        try {
          payload = JSON.parse(readFileSync(opts.payloadFile, 'utf-8')) as Record<
            string,
            unknown
          >;
        } catch (err) {
          process.stderr.write(
            `owlette: --payload-file ${opts.payloadFile} unreadable or not json: ${(err as Error).message}\n`,
          );
          process.exitCode = 2;
          return;
        }
      } else {
        payload = { ...CANNED_PAYLOADS[event] };
      }

      // Fill per-run defaults on the canned payload.
      if (opts.site && payload.siteId === null) payload.siteId = String(opts.site);
      if (event === 'machine.online' || event === 'machine.offline') {
        if (payload.lastHeartbeat === null) {
          payload.lastHeartbeat = new Date().toISOString();
        }
      }
      if (event === 'quota.exceeded' && payload.blockedAt === null) {
        payload.blockedAt = new Date().toISOString();
      }
      if (event === 'api_key.expired' && payload.expiresAt === null) {
        payload.expiresAt = new Date().toISOString();
      }

      const deliveryId = String(opts.id ?? randomUUID());

      if (opts.to && !opts.viaApi) {
        // Direct mode — bypass the server.
        await fireDirect({
          to: String(opts.to),
          event,
          deliveryId,
          payload,
          signingSecret: typeof opts.signingSecret === 'string' ? opts.signingSecret : undefined,
          json,
        });
        return;
      }

      // Server-probe mode — requires auth + siteId.
      if (!opts.to) {
        process.stderr.write('owlette: --to <url> is required\n');
        process.exitCode = 2;
        return;
      }

      if (!token) {
        process.stderr.write(
          'owlette: no token configured. run `owlette auth login` or set OWLETTE_TOKEN.\n',
        );
        process.exitCode = 2;
        return;
      }
      if (!opts.site) {
        process.stderr.write('owlette: --site <siteId> is required when firing via the server probe\n');
        process.exitCode = 2;
        return;
      }

      await fireServerProbe({
        apiUrl,
        token,
        siteId: String(opts.site),
        url: String(opts.to),
        event,
        deliveryId,
        payload,
        signingSecret: typeof opts.signingSecret === 'string' ? opts.signingSecret : undefined,
        json,
      });
    });
}

// direct mode

interface FireDirectOpts {
  to: string;
  event: string;
  deliveryId: string;
  payload: Record<string, unknown>;
  signingSecret?: string;
  json: boolean;
}

async function fireDirect(opts: FireDirectOpts): Promise<void> {
  const body = JSON.stringify(opts.payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Roost-Event': opts.event,
    'Roost-Delivery': opts.deliveryId,
  };
  if (opts.signingSecret) {
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', opts.signingSecret)
      .update(`${t}.${body}`)
      .digest('hex');
    headers['Roost-Signature'] = `t=${t},v1=${v1}`;
  }

  process.stderr.write(
    `owlette: → POST ${opts.to} ${opts.event} [delivery ${opts.deliveryId}]\n` +
      (headers['Roost-Signature']
        ? `       sig: ${headers['Roost-Signature']}\n`
        : '       (no --signing-secret; forwarded unsigned)\n'),
  );

  try {
    const res = await fetch(opts.to, { method: 'POST', headers, body });
    const text = await res.text().catch(() => '');
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { mode: 'direct', to: opts.to, status: res.status, headers, body: opts.payload, responseText: text },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stderr.write(`owlette: ← ${res.status}${text ? ` — ${truncate(text, 120)}` : ''}\n`);
    }
    if (!res.ok) process.exitCode = 1;
  } catch (err) {
    process.stderr.write(`owlette: direct post failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

// server-probe mode

interface FireProbeOpts {
  apiUrl: string;
  token: string;
  siteId: string;
  url: string;
  event: string;
  deliveryId: string;
  payload: Record<string, unknown>;
  signingSecret?: string;
  json: boolean;
}

async function fireServerProbe(opts: FireProbeOpts): Promise<void> {
  const body = {
    url: opts.url,
    event: opts.event,
    payload: opts.payload,
    signingSecret: opts.signingSecret,
  };

  process.stderr.write(
    `owlette: → POST ${opts.apiUrl}/api/webhooks/probe ${opts.event} [delivery ${opts.deliveryId}]\n`,
  );

  try {
    const probeUrl = new URL(`${opts.apiUrl}/api/webhooks/probe`);
    probeUrl.searchParams.set('siteId', opts.siteId);
    const res = await fetchWithTimeout(probeUrl.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (res.status === 404) {
      process.stderr.write(
        `owlette: /api/webhooks/probe is not available on this API host. ` +
          `omit --via-api to fire the probe directly at a local listener.\n`,
      );
      process.exitCode = 1;
      return;
    }

    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ mode: 'server-probe', status: res.status, request: body, response: data }, null, 2) + '\n',
      );
    } else {
      process.stderr.write(`owlette: ← ${res.status} ${JSON.stringify(data)}\n`);
    }
    const deliveryStatus = typeof data.status === 'number' ? data.status : null;
    const networkError = typeof data.networkError === 'string' ? data.networkError : null;
    const deliveryFailed =
      networkError !== null ||
      deliveryStatus === null ||
      deliveryStatus < 200 ||
      deliveryStatus >= 300;
    if (deliveryFailed && !opts.json) {
      process.stderr.write(
        `owlette: webhook probe delivery failed: ${
          networkError ?? `receiver returned ${deliveryStatus ?? 'no status'}`
        }\n`,
      );
    }
    if (!res.ok || deliveryFailed) process.exitCode = 1;
  } catch (err) {
    process.stderr.write(`owlette: probe post failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

// util

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

/** Export for tests. */
export const _internals = { CANNED_PAYLOADS, KNOWN_EVENTS };
