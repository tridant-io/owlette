/**
 * `owlette chat new | list | send | delete | rename` over the public hoot
 * conversation routes (POST/GET `/api/hoot/conversations`, POST/PATCH/DELETE
 * `/api/hoot/conversations/{conversationId}`).
 *
 * `send` consumes BOTH stream protocols the server can emit, flushing deltas as
 * they arrive:
 *   `0:"<json delta>"\n` text delta · `3:"<error>"\n` error · `d:{...}\n` end
 *   `data: {"type":"text-delta","delta":"..."}` — AI SDK 6 UI-message SSE
 *
 * Mutations carry an auto-generated `Idempotency-Key` so a retry can't
 * double-create/delete; `send` sends one only for tracing — streamed responses
 * are not replayable because the server does not cache them.
 */

import { Command } from 'commander';
import { randomUUID } from 'crypto';
import { loadConfig } from '../config';
import { fetchWithTimeout, noteBillingWarning } from '../lib/http';
import {
  isJson,
  renderTable,
  unconfirmedMutationFatal,
  usageFatal,
} from '../lib/output';

interface ConversationSummary {
  conversationId: string;
  title: string | null;
  siteId: string;
  machineId?: string;
  ownerUid: string;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt?: string | null;
  messageCount: number;
}

interface ListResponse {
  conversations?: ConversationSummary[];
  nextPageToken?: string;
}

interface NewResponse {
  conversationId: string;
  title?: string | null;
  siteId?: string;
  machineId?: string;
  messages?: Array<{ role: string; content: string; timestamp?: string }>;
}

interface MutationResponse {
  conversationId?: string;
  title?: string;
  alreadyDeleted?: boolean;
}

export function registerChatCommands(program: Command): void {
  const chat = program.command('chat').description('hoot ai chat');

  chat
    .command('new')
    .description('start a new hoot conversation')
    .requiredOption('--site <siteId>', 'site id to scope the conversation to')
    .option('--machine <machineId>', 'optional machine id (omit for site-wide)')
    .option('--title <title>', 'optional human-readable title')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const body: Record<string, unknown> = { siteId: opts.site };
      if (opts.machine) body.machineId = opts.machine;
      if (opts.title) body.title = opts.title;

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-chat-new-${randomUUID()}`;
      let res: Response;
      try {
        res = await fetchWithTimeout(`${apiUrl}/api/hoot/conversations`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        unconfirmedMutationFatal({
          operation: 'POST /api/hoot/conversations',
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const raw = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        data?: NewResponse;
        detail?: string;
        code?: string;
      };
      if (!res.ok) {
        fatal(
          `POST /api/hoot/conversations failed (${res.status}, ${raw.code ?? 'unknown'}): ${raw.detail ?? JSON.stringify(raw)}`,
        );
        return;
      }

      const data = (raw.data ?? raw) as NewResponse;

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        `owlette: conversation started\n` +
          `  conversationId  ${data.conversationId}\n` +
          `  siteId          ${data.siteId ?? opts.site}\n` +
          `  machineId       ${data.machineId ?? '(site-wide)'}\n` +
          `  title           ${data.title ?? '(none)'}\n`,
      );
    });

  chat
    .command('list')
    .description('list hoot conversations on a site')
    .requiredOption('--site <siteId>', 'site id to list conversations for')
    .option('--limit <n>', 'page size (1-100, default 20)')
    .option('--cursor <token>', 'opaque page_token from a previous response')
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const params = new URLSearchParams();
      params.set('siteId', String(opts.site));
      if (opts.limit !== undefined) {
        const n = Number(opts.limit);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 100) {
          usageFatal('--limit must be an integer between 1 and 100');
          return;
        }
        params.set('page_size', String(n));
      }
      if (opts.cursor) params.set('page_token', String(opts.cursor));

      const res = await fetchWithTimeout(`${apiUrl}/api/hoot/conversations?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const raw = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        data?: ListResponse;
        detail?: string;
        code?: string;
      };
      if (!res.ok) {
        fatal(
          `GET /api/hoot/conversations failed (${res.status}, ${raw.code ?? 'unknown'}): ${raw.detail ?? JSON.stringify(raw)}`,
        );
        return;
      }

      const payload = (raw.data ?? raw) as ListResponse;
      const conversations = payload.conversations ?? [];

      if (json) {
        process.stdout.write(
          JSON.stringify(
            { conversations, nextPageToken: payload.nextPageToken ?? '' },
            null,
            2,
          ) + '\n',
        );
        return;
      }

      if (conversations.length === 0) {
        process.stdout.write('(no conversations)\n');
        return;
      }

      const rows = conversations.map((c) => [
        c.conversationId,
        c.title ?? '',
        c.machineId ?? '(site-wide)',
        String(c.messageCount ?? 0),
        c.updatedAt ?? '',
      ]);
      process.stdout.write(
        renderTable(
          ['conversationId', 'title', 'machine', 'messages', 'updatedAt'],
          rows,
        ),
      );
      if (payload.nextPageToken) {
        process.stdout.write(`\nnext page: --cursor ${payload.nextPageToken}\n`);
      }
    });

  chat
    .command('send <conversationId> <message>')
    .description('send a message and stream the assistant reply to stdout')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (conversationId: string, message: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-chat-send-${randomUUID()}`;
      let res: Response;
      try {
        res = await fetch(
          `${apiUrl}/api/hoot/conversations/${encodeURIComponent(conversationId)}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              // Tracing only — the server skips idempotency caching on streams.
              'Idempotency-Key': idempotencyKey,
            },
            body: JSON.stringify({ role: 'user', content: message }),
          },
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `owlette: POST /api/hoot/conversations/${conversationId} did not return a confirmed response: ${detail}\n` +
            '  inspect the conversation before retrying: run `owlette chat list` and view the conversation in the UI.\n' +
            '  retrying may append the message twice.\n',
        );
        process.exitCode = 1;
        return;
      }

      // Bare `fetch`: fetchWithTimeout's 30s signal would sever the stream, so
      // the trial advisory is surfaced by hand. Outside the try — a fault here
      // is not an unconfirmed mutation.
      noteBillingWarning(res);

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          detail?: string;
          code?: string;
        };
        fatal(
          `POST /api/hoot/conversations/${conversationId} failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      const body = res.body;
      if (!body) {
        fatal(`POST /api/hoot/conversations/${conversationId} returned an empty body`);
        return;
      }

      const collected: string[] = [];
      const decoder = new TextDecoder();
      let pending = '';

      const emitDelta = (delta: string): void => {
        if (json) {
          collected.push(delta);
        } else {
          process.stdout.write(delta);
        }
      };

      const emitStreamError = (detail: string): void => {
        process.stderr.write(`\nowlette: hoot error — ${detail}\n`);
        process.exitCode = 1;
      };

      const consume = (line: string): void => {
        if (!line) return;
        if (line.startsWith('0:')) {
          try {
            const parsed = JSON.parse(line.slice(2));
            if (typeof parsed === 'string') {
              emitDelta(parsed);
            }
          } catch {
            // Drop malformed delta — never crash the stream.
          }
        } else if (line.startsWith('3:')) {
          let detail = line.slice(2);
          try {
            const parsed = JSON.parse(detail);
            if (typeof parsed === 'string') detail = parsed;
          } catch {
            /* keep raw */
          }
          emitStreamError(detail);
        } else if (line.startsWith('data:')) {
          const raw = line.slice(5).trimStart();
          if (!raw || raw === '[DONE]') return;
          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            if (parsed.type === 'text-delta' && typeof parsed.delta === 'string') {
              emitDelta(parsed.delta);
            } else if (parsed.type === 'error') {
              const detail =
                typeof parsed.errorText === 'string'
                  ? parsed.errorText
                  : typeof parsed.error === 'string'
                    ? parsed.error
                    : JSON.stringify(parsed);
              emitStreamError(detail);
            }
          } catch {
            // Drop malformed SSE data — never crash the stream.
          }
        }
        // `d:` and any other prefix → ignore (end markers / tool frames).
      };

      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        pending += decoder.decode(chunk, { stream: true });
        let nl = pending.indexOf('\n');
        while (nl >= 0) {
          consume(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
          nl = pending.indexOf('\n');
        }
      }
      pending += decoder.decode();
      if (pending.length > 0) consume(pending);

      if (json) {
        process.stdout.write(
          JSON.stringify({ conversationId, content: collected.join('') }, null, 2) + '\n',
        );
      } else {
        // So the next shell prompt isn't glued to the reply.
        process.stdout.write('\n');
      }
    });

  chat
    .command('delete <conversationId>')
    .description('soft-delete a hoot conversation')
    .option('--yes', 'skip the confirmation prompt')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (conversationId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          usageFatal(
            'stdin is not a tty and --yes was not supplied; refusing to delete silently',
          );
          return;
        }
        const ok = await promptYesNo(
          `delete conversation ${conversationId}? this is a soft delete (recoverable for 30d). [y/N] `,
        );
        if (!ok) {
          process.stdout.write('delete cancelled\n');
          return;
        }
      }

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-chat-delete-${randomUUID()}`;
      let res: Response;
      try {
        res = await fetchWithTimeout(
          `${apiUrl}/api/hoot/conversations/${encodeURIComponent(conversationId)}`,
          {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${token}`,
              'Idempotency-Key': idempotencyKey,
            },
          },
        );
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `DELETE /api/hoot/conversations/${conversationId}`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const raw = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        data?: MutationResponse;
        detail?: string;
        code?: string;
      };
      if (!res.ok) {
        fatal(
          `DELETE /api/hoot/conversations/${conversationId} failed (${res.status}, ${raw.code ?? 'unknown'}): ${raw.detail ?? JSON.stringify(raw)}`,
        );
        return;
      }

      const data = (raw.data ?? raw) as MutationResponse;

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        data.alreadyDeleted
          ? `owlette: conversation ${conversationId} was already deleted\n`
          : `owlette: conversation ${conversationId} deleted\n`,
      );
    });

  chat
    .command('rename <conversationId> <title>')
    .description('rename a hoot conversation')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (conversationId: string, title: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-chat-rename-${randomUUID()}`;
      let res: Response;
      try {
        res = await fetchWithTimeout(
          `${apiUrl}/api/hoot/conversations/${encodeURIComponent(conversationId)}`,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': idempotencyKey,
            },
            body: JSON.stringify({ title }),
          },
        );
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `PATCH /api/hoot/conversations/${conversationId}`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const raw = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        data?: MutationResponse;
        detail?: string;
        code?: string;
      };
      if (!res.ok) {
        fatal(
          `PATCH /api/hoot/conversations/${conversationId} failed (${res.status}, ${raw.code ?? 'unknown'}): ${raw.detail ?? JSON.stringify(raw)}`,
        );
        return;
      }

      const data = (raw.data ?? raw) as MutationResponse;

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        `owlette: conversation ${conversationId} renamed to "${data.title ?? title}"\n`,
      );
    });
}

function resolveAuth(cmd: Command): { apiUrl: string; token: string | null; json: boolean } {
  const { apiUrl, token } = loadConfig({ profile: cmd.optsWithGlobals().profile });
  if (!token) {
    process.stderr.write(
      'owlette: no token configured. run `owlette auth login` or set OWLETTE_TOKEN.\n',
    );
    process.exitCode = 2;
    return { apiUrl, token: null, json: isJson(cmd) };
  }
  return { apiUrl, token, json: isJson(cmd) };
}

async function promptYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import('readline');
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

function fatal(msg: string): void {
  process.stderr.write(`owlette: ${msg}\n`);
  process.exitCode = 1;
}
