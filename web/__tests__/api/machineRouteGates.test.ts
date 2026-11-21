/**
 * @jest-environment node
 *
 * machine-scope inventory: every `route.ts` under
 * `app/api/sites/[siteId]/machines/[machineId]/` must answer a scoped member
 * only on the machines in their machine scope. a static source scan (pure `fs`
 * reads, as in auditMutationCoverage.test.ts): each file names a gate that
 * checks the machine, or is a pure re-export of a route that does, and none
 * calls `requireSiteAuthAndScope(` directly, which checks the site only.
 *
 * the granularity is the file, so a second verb added on the site gate is
 * caught by the ban, not by the gate list.
 */

import fs from 'fs';
import path from 'path';

const WEB_ROOT = path.resolve(__dirname, '..', '..');
const MACHINE_ROOT = path.join(WEB_ROOT, 'app', 'api', 'sites', '[siteId]', 'machines', '[machineId]');

/** the gates that check the route's machineId against the caller's machine scope */
const MACHINE_GATES: readonly RegExp[] = [
  /\bauthorizedSiteHandler\s*(?:<[^>]*>)?\s*\(/,
  /\brequireMachineAuthAndScope\s*\(/,
  /\brequireSiteMachineAuthAndScope\s*\(/,
  /\bcreateControlHandler\s*\(/,
  // the four process verbs import it from `../_helpers`, which wraps createControlHandler
  /\bhandleControlVerb\s*\(/,
];

const SITE_GATE = /\brequireSiteAuthAndScope\s*\(/;
const PURE_REEXPORT = /^(?:\s*export\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?)+\s*$/;

function walkRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // `__`-prefixed dirs are transient fixtures other suites write mid-run
    if (entry.name.startsWith('__')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkRouteFiles(full, out);
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

/** drop comments: route headers name gates in prose */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

type GateReading =
  | { ok: true; reexports: string[] }
  | { ok: false; why: string };

/** how one route source reaches the machine check; a re-export passes only if its targets do */
function readMachineGate(source: string): GateReading {
  const code = stripComments(source);
  if (SITE_GATE.test(code)) return { ok: false, why: 'calls requireSiteAuthAndScope( directly' };
  if (PURE_REEXPORT.test(code)) {
    return { ok: true, reexports: [...code.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]) };
  }
  if (MACHINE_GATES.some((gate) => gate.test(code))) return { ok: true, reexports: [] };
  return { ok: false, why: 'names no machine-checking gate' };
}

function resolveRouteImport(fromFile: string, specifier: string): string {
  const base = specifier.startsWith('@/')
    ? path.join(WEB_ROOT, specifier.slice(2))
    : path.resolve(path.dirname(fromFile), specifier);
  return base.endsWith('.ts') ? base : `${base}.ts`;
}

const relative = (file: string) => path.relative(WEB_ROOT, file).split(path.sep).join('/');

const routeFiles = walkRouteFiles(MACHINE_ROOT).sort();

const reachesMachineRoute = (fromFile: string, specifier: string) =>
  routeFiles.includes(resolveRouteImport(fromFile, specifier));

function offenders(): string[] {
  const out: string[] = [];
  for (const file of routeFiles) {
    const reading = readMachineGate(fs.readFileSync(file, 'utf8'));
    if (!reading.ok) {
      out.push(`${relative(file)}: ${reading.why}; use a machine-checking gate`);
      continue;
    }
    for (const specifier of reading.reexports) {
      if (!reachesMachineRoute(file, specifier)) {
        out.push(`${relative(file)}: re-exports ${specifier}, not a machine route; use a machine-checking gate`);
      }
    }
  }
  return out;
}

describe('machine routes check machine scope', () => {
  it('scans the whole machine tree', () => {
    expect(routeFiles.length).toBeGreaterThan(25);
    expect(routeFiles.map(relative)).toContain(
      'app/api/sites/[siteId]/machines/[machineId]/cortex-enabled/route.ts',
    );
  });

  it('every machine route checks the machine, or re-exports one that does', () => {
    expect(offenders()).toEqual([]);
  });

  describe('the matcher', () => {
    it('refuses a route on the site gate, even beside a machine gate', () => {
      const onSiteGate = `
        export async function GET(request, { params }) {
          const { siteId } = await params;
          const auth = await requireSiteAuthAndScope(request, siteId, 'read');
        }`;
      expect(readMachineGate(onSiteGate)).toEqual({
        ok: false,
        why: 'calls requireSiteAuthAndScope( directly',
      });
      expect(readMachineGate(`${onSiteGate}\nexport const DELETE = authorizedSiteHandler({})(h);`).ok).toBe(false);
    });

    it('refuses a route with no gate, and ignores gates named only in comments', () => {
      expect(readMachineGate('export async function GET() { return null; }').ok).toBe(false);
      expect(
        readMachineGate('// takes requireMachineAuthAndScope( one day\nexport async function GET() {}').ok,
      ).toBe(false);
    });

    it('admits each machine gate and the site-machine gate', () => {
      for (const call of [
        'authorizedSiteHandler<{ siteId: string; machineId: string }>({',
        'requireMachineAuthAndScope(request, siteId, machineId, "read")',
        'requireSiteMachineAuthAndScope(request, siteId, machineId, "read")',
        'createControlHandler(verb)',
        'handleControlVerb("kill", request, context)',
      ]) {
        expect(readMachineGate(`const x = ${call};`)).toEqual({ ok: true, reexports: [] });
      }
    });

    it('reads a pure re-export as its target', () => {
      expect(readMachineGate("/** alias */\nexport { PATCH } from '@/app/api/x/route';\n")).toEqual({
        ok: true,
        reexports: ['@/app/api/x/route'],
      });
    });

    it('lets a re-export through only to a machine route', () => {
      const alias = path.join(MACHINE_ROOT, 'cortex-enabled', 'route.ts');
      expect(reachesMachineRoute(alias, '@/app/api/sites/[siteId]/machines/[machineId]/hoot-enabled/route')).toBe(true);
      expect(reachesMachineRoute(alias, '../hoot-enabled/route')).toBe(true);
      expect(reachesMachineRoute(alias, '@/app/api/sites/[siteId]/logs/route')).toBe(false);
    });
  });
});
