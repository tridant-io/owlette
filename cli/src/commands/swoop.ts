/**
 * `owlette swoop <machineId> --site <siteId>` — open the swoop remote-desktop
 * viewer for a machine.
 *
 * Drives one read: GET /api/sites/{siteId}/machines/{machineId}, to prove the
 * machine exists and the caller may reach it before a browser window opens on
 * a dead page.
 *
 * The cli never mints a viewer token and never touches the media path. Starting
 * a session, the second-factor step-up that control requires, and the WebRTC
 * connection all happen in the browser — an api key cannot start a swoop
 * session at all (`api_key_not_permitted`), so there is nothing here to hand it.
 */

import { Command } from 'commander';
import { loadConfig } from '../config';
import { fetchWithTimeout } from '../lib/http';
import { errLine, isJson, printJson, printLine } from '../lib/output';
import { openBrowser } from '../lib/openBrowser';

interface MachineCapabilities {
  swoop?: number;
}

interface MachineDetail {
  id?: string;
  name?: string;
  online?: boolean;
  capabilities?: MachineCapabilities;
  detail?: string;
}

export function registerSwoopCommand(program: Command): void {
  program
    .command('swoop <machineId>')
    .description('open the swoop remote-desktop viewer for a machine in your browser')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .option('--no-open', 'print the viewer url without opening a browser')
    .action(async (machineId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const siteId = String(opts.site);
      const res = await fetchWithTimeout(
        `${apiUrl}/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const machine = (await res.json().catch(() => ({}))) as MachineDetail;
      if (!res.ok) {
        return fatal(
          `GET /api/sites/${siteId}/machines/${machineId} failed (${res.status}): ${machine.detail ?? JSON.stringify(machine)}`,
        );
      }

      const swoopCapability = machine.capabilities?.swoop;
      if (swoopCapability !== undefined && swoopCapability !== 1) {
        return fatal(
          `machine ${machineId} does not report the swoop capability — upgrade its agent`,
        );
      }

      const url = `${apiUrl}/swoop/${encodeURIComponent(siteId)}/${encodeURIComponent(machineId)}`;
      const open = opts.open !== false;

      if (json) {
        printJson({ siteId, machineId, url, opened: open });
      } else {
        printLine(url);
      }

      // Only the browser can tell whether a session is admitted, so every
      // caveat below is a note rather than a refusal.
      if (!json) {
        if (swoopCapability === undefined) {
          errLine(
            'owlette: this api build does not report machine capabilities — the viewer refuses if the agent is too old to stream.',
          );
        }
        if (machine.online === false) {
          errLine(`owlette: machine ${machineId} is offline; swoop cannot reach it until it reconnects.`);
        }
        errLine('owlette: taking control asks for a second factor in the browser.');
      }

      if (open) openBrowser(url);
    });
}

function resolveAuth(cmd: Command): { apiUrl: string; token: string | null; json: boolean } {
  const { apiUrl, token } = loadConfig({ profile: cmd.optsWithGlobals().profile });
  if (!token) {
    errLine('owlette: no token configured. run `owlette auth login` or set OWLETTE_TOKEN.');
    process.exitCode = 2;
    return { apiUrl, token: null, json: isJson(cmd) };
  }
  return { apiUrl, token, json: isJson(cmd) };
}

function fatal(msg: string): void {
  errLine(`owlette: ${msg}`);
  process.exitCode = 1;
}
