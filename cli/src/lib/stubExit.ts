/**
 * Shared exit for "stub" cli commands — documented nouns whose public api has not
 * shipped. Always exits 3, reserved for stubs (1 = error, 2 = usage).
 *
 * `--json` prints one envelope on stdout:
 * `{ ok: false, stub: true, noun, reason, dashboard_url, future_plan }` — the
 * snake_case keys are the schema in "JSON output shapes", web/content/docs/cli/overview.mdx.
 * Human mode prints a block on stderr pointing at the dashboard and plan doc.
 */

import type { Command } from 'commander';
import { errLine, isJson, printJson } from './output';

export interface StubExitArgs {
  noun: string;
  reason: string;
  dashboardUrl: string;
  futurePlan: string;
  /** optional commander instance — used to detect `--json`. */
  cmd?: Command;
  /** optional verb (e.g. `list`, `new`) — included in the stderr header. */
  verb?: string;
}

export function stubExit(args: StubExitArgs): never {
  const { noun, reason, dashboardUrl, futurePlan, cmd, verb } = args;

  if (cmd && isJson(cmd)) {
    printJson({
      ok: false,
      stub: true,
      noun,
      reason,
      dashboard_url: dashboardUrl,
      future_plan: futurePlan,
    });
    process.exit(3);
  }

  const header = verb ? `\`${noun} ${verb}\`` : `\`${noun}\``;
  errLine(`owlette: ${header} is a stub — ${reason}.`);
  errLine(`  reason       : ${reason}`);
  errLine(`  dashboard    : ${dashboardUrl}`);
  errLine(`  future plan  : ${futurePlan}`);
  process.exit(3);
}
