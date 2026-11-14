/**
 * `owlette listen --forward-to <url>` — holds an SSE connection to
 * `/api/events/stream` and replays each event as a POST to a local URL.
 *
 * Wire format: `event: <kind>\n data: <json>\n\n`. The server currently emits
 * only `connected` and a ~15s `keepalive`; real event fanout is a later server
 * wave, and this relays whatever arrives.
 *
 * Exit codes: 0 clean SIGINT shutdown; 1 connection/forward failure or server
 * closed the stream; 2 usage/auth problem.
 */

import { Command } from 'commander';
import { createHmac } from 'crypto';
import { loadConfig } from '../config';
import { noteBillingWarning } from '../lib/http';

const KEEPALIVE_EVENT = 'keepalive';
const CONNECTED_EVENT = 'connected';

export function registerListenCommand(program: Command): void {
  program
    .command('listen')
    .description('forward the scoped SSE liveness stream from the owlette api to a local url')
    .requiredOption('--site <siteId>', 'site id to read the event stream for')
    .requiredOption('--forward-to <url>', 'local http endpoint that receives each event')
    .option(
      '--events <names>',
      'comma-separated event kinds to forward (default: all non-keepalive)',
    )
    .option(
      '--signing-secret <secret>',
      'secret used to re-sign the forwarded payload with a Roost-Signature header (default: print-only, no re-sign)',
    )
    .option(
      '--print',
      'print events to stderr as they arrive (always on; kept for explicitness)',
    )
    .action(async (opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const { apiUrl, token } = loadConfig({ profile: globals.profile });
      if (!token) {
        process.stderr.write(
          'owlette: no token configured. run `owlette auth login` or set OWLETTE_TOKEN.\n',
        );
        process.exitCode = 2;
        return;
      }

      let forwardUrl: URL;
      try {
        forwardUrl = new URL(String(opts.forwardTo));
      } catch {
        process.stderr.write(`owlette: --forward-to '${opts.forwardTo}' is not a valid url\n`);
        process.exitCode = 2;
        return;
      }

      const allowedEvents: Set<string> | null = opts.events
        ? new Set(
            String(opts.events)
              .split(',')
              .map((s: string) => s.trim())
              .filter(Boolean),
          )
        : null;

      const streamUrl = new URL(`${apiUrl}/api/events/stream`);
      streamUrl.searchParams.set('siteId', String(opts.site));
      if (opts.events) streamUrl.searchParams.set('events', String(opts.events));

      process.stderr.write(
        `owlette: listening on ${apiUrl}/api/events/stream\n` +
          `       site: ${opts.site}\n` +
          `       forwarding to ${forwardUrl}\n` +
          (allowedEvents
            ? `       events: ${[...allowedEvents].join(', ')}\n`
            : '       events: all (except keepalive)\n') +
          (opts.signingSecret
            ? `       re-signing with supplied secret\n`
            : `       (no re-sign secret — forwarded payloads carry the server's original Roost-Signature if present)\n`),
      );

      const aborter = new AbortController();
      let stopping = false;
      process.on('SIGINT', () => {
        stopping = true;
        aborter.abort();
      });

      let res: Response;
      try {
        res = await fetch(streamUrl.toString(), {
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${token}`,
          },
          signal: aborter.signal,
        });
      } catch (err) {
        process.stderr.write(
          `owlette: failed to open stream: ${(err as Error).message}\n`,
        );
        process.exitCode = 1;
        return;
      }

      // Bare `fetch`: fetchWithTimeout's 30s signal would sever the stream, so
      // the trial advisory is surfaced by hand. Outside the try — a fault here
      // is not a connection failure and must not be reported as one.
      noteBillingWarning(res);

      if (!res.ok || !res.body) {
        process.stderr.write(
          `owlette: stream open failed (${res.status}): ${await res.text().catch(() => '')}\n`,
        );
        process.exitCode = 1;
        return;
      }

      const counts = { connected: 0, keepalive: 0, event: 0, forwarded: 0, forwardErrors: 0 };

      try {
        for await (const event of sseEvents(res.body)) {
          if (event.kind === CONNECTED_EVENT) {
            counts.connected += 1;
            process.stderr.write(`owlette: stream connected\n`);
            continue;
          }
          if (event.kind === KEEPALIVE_EVENT) {
            counts.keepalive += 1;
            continue;
          }

          counts.event += 1;
          if (allowedEvents && !allowedEvents.has(event.kind)) {
            process.stderr.write(`owlette: (filtered) ${event.kind}\n`);
            continue;
          }

          const headers = buildForwardHeaders(event, opts.signingSecret);
          process.stderr.write(
            `owlette: → forwarding ${event.kind}` +
              (headers['Roost-Signature'] ? ` [sig: ${headers['Roost-Signature']}]` : '') +
              '\n',
          );

          try {
            const forwarded = await fetch(forwardUrl.toString(), {
              method: 'POST',
              headers,
              body: event.data,
            });
            counts.forwarded += 1;
            process.stderr.write(
              `owlette: ← ${forwarded.status} from ${forwardUrl}\n`,
            );
          } catch (err) {
            counts.forwardErrors += 1;
            process.stderr.write(
              `owlette: forward failed for ${event.kind}: ${(err as Error).message}\n`,
            );
          }
        }
      } catch (err) {
        if (!stopping) {
          process.stderr.write(
            `owlette: stream error: ${(err as Error).message}\n`,
          );
          process.exitCode = 1;
        }
      }

      if (!stopping && process.exitCode !== 1) {
        process.stderr.write('owlette: stream closed by server\n');
        process.exitCode = 1;
      }

      process.stderr.write(
        `owlette: listener stopped. ` +
          `connected=${counts.connected} events=${counts.event} ` +
          `forwarded=${counts.forwarded} forwardErrors=${counts.forwardErrors} ` +
          `keepalives=${counts.keepalive}\n`,
      );
    });
}

export interface SseEvent {
  kind: string;
  id: string | null;
  data: string;
}

/**
 * Parse an SSE byte stream into events, one per `event:`/`data:` block.
 * Deliberately below spec: no retry fields (the server emits none) and no
 * multi-line `data:` concatenation (every roost event is single-line JSON).
 */
export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = parseSseBlock(rawEvent);
        if (event) yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseSseBlock(block: string): SseEvent | null {
  let kind: string | null = null;
  let id: string | null = null;
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue; // comment
    if (line.startsWith('event:')) kind = line.slice(6).trim();
    else if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!kind && dataLines.length === 0) return null;
  return {
    kind: kind ?? 'message',
    id,
    data: dataLines.join('\n'),
  };
}

/**
 * Headers sent to --forward-to. With a signing secret, re-signs the payload
 * stripe-style (`t=<unix>,v1=<hmac>`) so local suites can verify against a
 * secret they know; without one, the server's original signature passes through.
 */
export function buildForwardHeaders(
  event: SseEvent,
  signingSecret: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Roost-Event': event.kind,
  };
  if (event.id) headers['Roost-Delivery'] = event.id;

  if (typeof signingSecret === 'string' && signingSecret.length > 0) {
    const t = Math.floor(Date.now() / 1000);
    const signed = createHmac('sha256', signingSecret)
      .update(`${t}.${event.data}`)
      .digest('hex');
    headers['Roost-Signature'] = `t=${t},v1=${signed}`;
  } else {
    // Forward the server's Roost-Signature if it rode inside the data payload.
    // A no-op on the transport-only v0 stream, which embeds none.
    try {
      const parsed = JSON.parse(event.data) as { roostSignature?: string };
      if (typeof parsed?.roostSignature === 'string') {
        headers['Roost-Signature'] = parsed.roostSignature;
      }
    } catch {
      /* event.data may not be json — leave headers alone */
    }
  }

  return headers;
}

/** Export for tests. */
export const _internals = { parseSseBlock, buildForwardHeaders };
