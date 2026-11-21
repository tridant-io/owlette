/**
 * `owlette site list | get | members | add-member | set-role | remove-member |
 * transfer-ownership`.
 *
 * Plain-ascii table / key-value detail by default, structured JSON under the
 * program-level `--json`. The site RECORD stays read-only — create, update and
 * delete remain dashboard-only — but MEMBERSHIP is manageable here, because it
 * is the part an operator scripts.
 *
 * PER-SITE ROLES. `set-role` changes someone's role on ONE site. That is not
 * what `owlette user promote` does: promote changes a GLOBAL role, and so
 * affects every site that person belongs to. Ownership is deliberately not a
 * settable role — it moves through `transfer-ownership`, which is transactional
 * and owner-or-superadmin only.
 */

import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { loadConfig } from '../config';
import { fetchWithTimeout } from '../lib/http';
import { isJson, renderTable } from '../lib/output';

interface SiteListItem {
  id: string;
  name: string;
  plan: string | null;
  timezone: string | null;
  owner: string | null;
  createdAt: string | null;
}

interface SiteMemberRow {
  uid: string;
  email: string | null;
  /** Reported per-site standing. `owner`/`superadmin` are derived, not settable. */
  role: 'owner' | 'superadmin' | 'admin' | 'member';
  globalRole: string | null;
  displayName: string | null;
}

interface SiteDetail {
  id: string;
  name: string;
  plan: string | null;
  timezone: string | null;
  owner: string | null;
  createdAt: string | null;
}

export function registerSiteCommands(program: Command): void {
  const site = program.command('site').description('list + inspect sites');

  site
    .command('list')
    .description('list sites the caller has access to')
    .action(async (_opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetchWithTimeout(`${apiUrl}/api/sites`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as {
        sites?: SiteListItem[];
        detail?: string;
      };
      if (!res.ok) {
        fatal(`GET /api/sites failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`);
        return;
      }

      const sites = data.sites ?? [];

      if (json) {
        process.stdout.write(JSON.stringify({ sites }, null, 2) + '\n');
        return;
      }

      if (sites.length === 0) {
        process.stdout.write('(no sites)\n');
        return;
      }

      const rows = sites.map((s) => [
        s.id,
        s.name,
        s.plan ?? '',
        s.timezone ?? '',
        s.createdAt ?? '',
      ]);
      process.stdout.write(renderTable(['id', 'name', 'plan', 'timezone', 'createdAt'], rows));
    });

  site
    .command('get <siteId>')
    .description('print the detail record for one site')
    .action(async (siteId: string, _opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetchWithTimeout(`${apiUrl}/api/sites/${encodeURIComponent(siteId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as SiteDetail & { detail?: string };
      if (!res.ok) {
        fatal(`GET /api/sites/${siteId} failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`);
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatSiteDetail(data));
    });

  // membership

  site
    .command('members <siteId>')
    .description('list the members of a site with their per-site roles')
    .action(async (siteId: string, _opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetchWithTimeout(
        `${apiUrl}/api/sites/${encodeURIComponent(siteId)}/members`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await res.json().catch(() => ({}))) as {
        members?: SiteMemberRow[];
        detail?: string;
      };
      if (!res.ok) {
        fatal(
          `GET /api/sites/${siteId}/members failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      const members = data.members ?? [];
      if (json) {
        process.stdout.write(JSON.stringify({ members }, null, 2) + '\n');
        return;
      }
      if (members.length === 0) {
        process.stdout.write('(no members)\n');
        return;
      }
      process.stdout.write(
        renderTable(
          ['uid', 'email', 'role', 'globalRole'],
          members.map((m) => [m.uid, m.email ?? '', m.role, m.globalRole ?? '']),
        ),
      );
    });

  site
    .command('add-member <siteId>')
    .description('add a member to a site, by uid or email')
    .option('--uid <uid>', 'target user id')
    .option('--email <email>', 'target email address (resolved to a uid server-side)')
    .option('--role <role>', "'member' (default) or 'admin'", 'member')
    .option('--idempotency-key <key>', 'optional Idempotency-Key (auto-generated if omitted)')
    .action(async (siteId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      // Exactly one identifier, mirroring the API's own 400 rather than spending
      // a round trip to be told.
      if (Boolean(opts.uid) === Boolean(opts.email)) {
        fatal('provide exactly one of --uid or --email');
        return;
      }
      if (opts.role !== 'member' && opts.role !== 'admin') {
        fatal("--role must be 'member' or 'admin'");
        return;
      }

      const body = opts.uid
        ? { uid: opts.uid, role: opts.role }
        : { email: opts.email, role: opts.role };

      const res = await fetchWithTimeout(
        `${apiUrl}/api/sites/${encodeURIComponent(siteId)}/members`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': opts.idempotencyKey ?? `cli-add-member-${randomUUID()}`,
          },
          body: JSON.stringify(body),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        uid?: string;
        roleHonored?: boolean;
        detail?: string;
      };
      if (!res.ok) {
        fatal(
          `POST /api/sites/${siteId}/members failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }
      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }
      // Said loudly on purpose: the server answers 200 but wrote nothing, because
      // the target was already a member, and silence would read as success.
      if (data.roleHonored === false) {
        process.stdout.write(
          `owlette: WARNING role '${opts.role}' was NOT honored - ${data.uid ?? 'the user'} is ` +
            `already a member of ${siteId} and keeps their role. Use "owlette site set-role" to change it.\n`,
        );
        return;
      }
      process.stdout.write(`owlette: ${data.uid ?? '?'} added to ${siteId} as ${opts.role}\n`);
    });

  site
    .command('set-role <siteId> <uid> <role>')
    .description("change a member's role on THIS site only ('admin' or 'member')")
    .option('--idempotency-key <key>', 'optional Idempotency-Key (auto-generated if omitted)')
    .action(async (siteId: string, uid: string, role: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      if (role !== 'member' && role !== 'admin') {
        // 'owner' is the interesting rejection: it is not a settable role at all.
        fatal(
          role === 'owner'
            ? 'ownership is not a settable role - use "owlette site transfer-ownership"'
            : "role must be 'member' or 'admin'",
        );
        return;
      }

      const res = await fetchWithTimeout(
        `${apiUrl}/api/sites/${encodeURIComponent(siteId)}/members/${encodeURIComponent(uid)}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': opts.idempotencyKey ?? `cli-set-role-${randomUUID()}`,
          },
          body: JSON.stringify({ role }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { detail?: string };
      if (!res.ok) {
        fatal(
          `PATCH /api/sites/${siteId}/members/${uid} failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }
      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }
      process.stdout.write(
        `owlette: ${uid} is now '${role}' on ${siteId} (global role unchanged)\n`,
      );
    });

  site
    .command('remove-member <siteId> <uid>')
    .description('remove a member from a site')
    .option('--talon-successor <uid>', 'reassign talons this member authored before removing them')
    .action(async (siteId: string, uid: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const query = opts.talonSuccessor
        ? `?talonSuccessorUid=${encodeURIComponent(opts.talonSuccessor)}`
        : '';
      const res = await fetchWithTimeout(
        `${apiUrl}/api/sites/${encodeURIComponent(siteId)}/members/${encodeURIComponent(uid)}${query}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await res.json().catch(() => ({}))) as {
        wasMember?: boolean;
        talonCount?: number;
        reassignedTalonIds?: string[];
        detail?: string;
      };
      if (!res.ok) {
        fatal(
          `DELETE /api/sites/${siteId}/members/${uid} failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }
      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }
      process.stdout.write(
        data.wasMember
          ? `owlette: ${uid} removed from ${siteId}\n`
          : `owlette: ${uid} was not a member of ${siteId} (no change)\n`,
      );
      // Orphaned automations are the surprise worth naming: the talons survive
      // the removal, but their author can no longer reach the site, so they
      // start failing silently.
      const orphaned = (data.talonCount ?? 0) - (data.reassignedTalonIds?.length ?? 0);
      if (orphaned > 0) {
        process.stdout.write(
          `owlette: WARNING ${orphaned} talon(s) authored by ${uid} were left in place. ` +
            'Re-run with --talon-successor <uid> to reassign them.\n',
        );
      }
    });

  site
    .command('transfer-ownership <siteId> <successorUid>')
    .description('hand a site to another user (owner or superadmin only)')
    .option('--idempotency-key <key>', 'optional Idempotency-Key (auto-generated if omitted)')
    .action(async (siteId: string, successorUid: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetchWithTimeout(
        `${apiUrl}/api/sites/${encodeURIComponent(siteId)}/transfer-ownership`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': opts.idempotencyKey ?? `cli-transfer-owner-${randomUUID()}`,
          },
          body: JSON.stringify({ successorUid }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        previousOwnerUid?: string;
        newOwnerUid?: string;
        detail?: string;
      };
      if (!res.ok) {
        fatal(
          `POST /api/sites/${siteId}/transfer-ownership failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }
      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }
      process.stdout.write(
        `owlette: ${siteId} owner ${data.previousOwnerUid ?? '?'} -> ${data.newOwnerUid ?? successorUid}\n` +
          'owlette: the previous owner remains a member, as site admin\n',
      );
    });
}

function formatSiteDetail(s: SiteDetail): string {
  const out: string[] = [];
  out.push(`id         ${s.id}`);
  out.push(`name       ${s.name}`);
  out.push(`plan       ${s.plan ?? '(none)'}`);
  out.push(`timezone   ${s.timezone ?? '(none)'}`);
  out.push(`owner      ${s.owner ?? '(none)'}`);
  out.push(`createdAt  ${s.createdAt ?? '(unknown)'}`);
  return out.join('\n') + '\n';
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

function fatal(msg: string): void {
  process.stderr.write(`owlette: ${msg}\n`);
  process.exitCode = 1;
}

/** Export for unit tests. */
export const _internals = {
  formatSiteDetail,
  renderTable,
};
