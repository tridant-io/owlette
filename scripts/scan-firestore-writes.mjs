#!/usr/bin/env node
/**
 * scan-firestore-writes — ast scanner for security-boundary-migration.
 *
 * Walks `web/**\/*.{ts,tsx}` for direct firestore *client* writes
 * (`firebase/firestore`, not `firebase-admin/firestore`): named calls
 * (setDoc/updateDoc/deleteDoc/addDoc/writeBatch/runTransaction/arrayUnion/
 * arrayRemove) and method-style refs (.set/.update/.delete/.add, incl.
 * transaction.update and batch.delete).
 *
 * Emits `{ file, line, firestorePath, callType, surroundingFunction,
 * classification, capability?, route? }[]` as JSON on stdout (or --json=path)
 * plus markdown to dev/active/security-boundary-migration/reference/.
 *
 * Usage: `npm run scan:firestore-writes`, or
 * `node scripts/scan-firestore-writes.mjs --json=hits.json --no-md`.
 *
 * Uses the typescript programmatic api (already a web dev dep) rather than
 * ts-morph, to avoid a new dep for a one-shot tool.
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WEB_DIR = join(ROOT, 'web');
const REPORT_DIR = join(ROOT, 'dev', 'active', 'security-boundary-migration', 'reference');
const REPORT_PATH = join(REPORT_DIR, 'write-inventory.md');

// typescript lives in web/node_modules — root has no package.json.
const requireFromWeb = createRequire(pathToFileURL(join(WEB_DIR, 'package.json')).href);
let ts;
try {
  ts = requireFromWeb('typescript');
} catch (err) {
  console.error('[scan-firestore-writes] failed to load typescript from web/node_modules.');
  console.error('  run `cd web && npm install` first.');
  console.error('  underlying error:', err.message);
  process.exit(2);
}

const argv = process.argv.slice(2);
let writeMd = true;
let jsonOutPath = null;
for (const a of argv) {
  if (a === '--no-md') writeMd = false;
  else if (a.startsWith('--json=')) jsonOutPath = a.slice('--json='.length);
}

const WRITE_FN_NAMES = new Set([
  'setDoc',
  'updateDoc',
  'deleteDoc',
  'addDoc',
  'writeBatch',
  'runTransaction',
  'arrayUnion',
  'arrayRemove',
]);

// methods called on doc/collection/transaction/batch refs
const WRITE_METHOD_NAMES = new Set(['set', 'update', 'delete', 'add']);

// directories under web/ to skip
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'out',
  'build',
  'dist',
  '.turbo',
  '.cache',
  'coverage',
]);

const INCLUDE_EXT = new Set(['.ts', '.tsx']);

// Writes that may stay client-side after lockdown. Deliberately limited to
// user-self preference paths; matched against the firestorePath inferred from
// the enclosing doc(...) call.
const PREFERENCE_ALLOWLIST = [
  {
    // useDevicePrefs.ts
    firestorePathPattern: /^users\/[^/]+\/devicePrefs\/global$/,
    rationale: 'per-user device preferences (theme, timezone, alert mute) — user-self only',
  },
  {
    // AuthContext.tsx writes users/{uid} for BOTH creation (control-plane)
    // and prefs; the surrounding-function pattern is what disambiguates.
    firestorePathPattern: /^users\/[^/]+$/,
    surroundingFunctionPattern: /^(updateUserPreferences|updateLastSite|updateLastMachine)$/,
    rationale: 'user-self preferences merge (preferences, lastSiteId, lastMachineIds)',
  },
  {
    // Chat history is uid-bounded in firestore rules, not control-plane.
    firestorePathPattern: /^chats\/[^/]+$/,
    rationale: 'per-user hoot chat history — user-owned, no control-plane impact',
  },
];

// file+function → capability + route. Matched in order; first match wins.
const CONTROL_PLANE_RULES = [
  {
    file: /^web\/hooks\/useDisplayActions\.ts$/,
    fn: /^(captureLayout|setAutoRestore|resetAutoRestoreBreaker)$/,
    capability: 'MACHINE_CONFIG_WRITE',
    route: 'PUT /api/sites/{siteId}/machines/{machineId}/display-layout',
  },
  {
    file: /^web\/hooks\/useDisplayActions\.ts$/,
    fn: /^clearLayout$/,
    capability: 'MACHINE_CONFIG_WRITE',
    route: 'DELETE /api/sites/{siteId}/machines/{machineId}/display-layout',
  },
  {
    file: /^web\/hooks\/useDisplayActions\.ts$/,
    fn: /^(dispatchTopologyCommand|applyLayout|ackLayout|enumerateDisplayModes|testDisplayApply)$/,
    capability: 'MACHINE_EXEC_COMMAND',
    route: 'POST /api/sites/{siteId}/machines/{machineId}/commands',
  },

  {
    file: /^web\/hooks\/useFirestore\.ts$/,
    fn: /^(createSite|updateSite|deleteSite)$/,
    capability: 'SITE_MEMBER_MANAGE',
    route: 'POST|PATCH|DELETE /api/sites/{siteId}',
  },
  {
    file: /^web\/hooks\/useFirestore\.ts$/,
    fn: /^(killProcess|sendMachineCommand|rebootMachine|shutdownMachine|cancelReboot|dismissRebootPending|captureScreenshot)$/,
    capability: 'MACHINE_EXEC_COMMAND',
    route: 'POST /api/sites/{siteId}/machines/{machineId}/commands',
  },
  {
    file: /^web\/hooks\/useFirestore\.ts$/,
    fn: /^setLaunchMode$/,
    capability: 'MACHINE_CONFIG_WRITE',
    route: 'PATCH /api/sites/{siteId}/machines/{machineId}/processes/{processId}/launch-mode',
  },
  {
    file: /^web\/hooks\/useFirestore\.ts$/,
    fn: /^(updateProcess|deleteProcess|createProcess)$/,
    capability: 'MACHINE_CONFIG_WRITE',
    route: 'POST|PATCH|DELETE /api/sites/{siteId}/machines/{machineId}/processes[/{processId}]',
  },
  {
    file: /^web\/hooks\/useFirestore\.ts$/,
    fn: /^updateRebootSchedule$/,
    capability: 'MACHINE_CONFIG_WRITE',
    route: 'PUT /api/sites/{siteId}/machines/{machineId}/reboot-schedule',
  },

  {
    // installer_templates crud is PRESET_MANAGE, not DEPLOYMENT_MANAGE.
    file: /^web\/hooks\/useDeployments\.ts$/,
    fn: /^(createTemplate|updateTemplate|deleteTemplate|createDeploymentTemplate|updateDeploymentTemplate|deleteDeploymentTemplate|saveTemplate|upsertTemplate)$/,
    capability: 'PRESET_MANAGE',
    route: 'POST|PATCH|DELETE /api/sites/{siteId}/presets/deployment-template[/{templateId}]',
  },
  {
    file: /^web\/hooks\/useDeployments\.ts$/,
    capability: 'DEPLOYMENT_MANAGE',
    route: 'POST|DELETE /api/sites/{siteId}/deployments[/{deploymentId}/cancel]',
  },

  {
    file: /^web\/hooks\/useUninstall\.ts$/,
    capability: 'UNINSTALL_TRIGGER',
    route: 'POST|DELETE /api/sites/{siteId}/machines/{machineId}/uninstall',
  },

  {
    file: /^web\/hooks\/useMachineOperations\.ts$/,
    capability: 'MACHINE_REMOVE',
    route: 'DELETE /api/sites/{siteId}/machines/{machineId}',
  },

  {
    file: /^web\/hooks\/useUserManagement\.ts$/,
    fn: /^(promoteToAdmin|demoteToMember|changeRole|updateUserRole)$/,
    capability: 'USER_ROLE_MANAGE',
    route: 'PATCH /api/admin/users/{userId}/role',
  },
  {
    file: /^web\/hooks\/useUserManagement\.ts$/,
    fn: /^(assignSites|removeSites|grantSiteAccess|revokeSiteAccess|addUserToSite|removeUserFromSite|assignSiteToUser|removeSiteFromUser)$/,
    capability: 'SITE_MEMBER_MANAGE',
    route: 'POST|DELETE /api/admin/users/{userId}/site-assignments',
  },
  {
    file: /^web\/hooks\/useUserManagement\.ts$/,
    fn: /^(deleteUser|removeUser)$/,
    capability: 'USER_DELETE',
    route: 'DELETE /api/admin/users/{userId}',
  },

  {
    file: /^web\/hooks\/useSchedulePresets\.ts$/,
    capability: 'PRESET_MANAGE',
    route: 'POST|PATCH|DELETE /api/sites/{siteId}/presets/schedule[/{presetId}]',
  },
  {
    file: /^web\/hooks\/useRebootPresets\.ts$/,
    capability: 'PRESET_MANAGE',
    route: 'POST|PATCH|DELETE /api/sites/{siteId}/presets/reboot[/{presetId}]',
  },
  {
    file: /^web\/hooks\/useProjectDistributionPresets\.ts$/,
    capability: 'PRESET_MANAGE',
    route: 'POST|PATCH|DELETE /api/sites/{siteId}/presets/distribution[/{presetId}]',
  },

  {
    file: /^web\/hooks\/useSystemPresets\.ts$/,
    capability: 'SYSTEM_PRESET_MANAGE',
    route: 'POST|PATCH|DELETE /api/admin/system-presets[/{presetId}]',
  },

  {
    file: /^web\/hooks\/useInstallerManagement\.ts$/,
    capability: 'INSTALLER_MANAGE',
    route: 'POST|DELETE /api/admin/installers[/{version}|/set-latest]',
  },

  // useHoot.ts has no rule: chat history is allowlisted as preference. Any
  // non-chat write there would be control-plane — none exist today.

  {
    file: /^web\/components\/WebhookSettingsDialog\.tsx$/,
    capability: 'WEBHOOK_MANAGE',
    route: 'POST|PATCH|DELETE /api/sites/{siteId}/webhooks[/{webhookId}]',
  },

  {
    file: /^web\/app\/admin\/alerts\/page\.tsx$/,
    capability: 'GLOBAL_SETTINGS_WRITE',
    route: 'PUT /api/admin/alerts',
  },

  {
    file: /^web\/app\/hoot\/components\/HootPowerToggle\.tsx$/,
    capability: 'MACHINE_CONFIG_WRITE',
    route: 'PATCH /api/sites/{siteId}/machines/{machineId}/hoot-enabled',
  },

  {
    file: /^web\/app\/logs\/page\.tsx$/,
    capability: 'GLOBAL_SETTINGS_WRITE',
    route: 'DELETE /api/sites/{siteId}/logs',
  },

  {
    file: /^web\/lib\/firebase\.ts$/,
    fn: /^sendOwletteUpdateCommand$/,
    capability: 'MACHINE_EXEC_COMMAND',
    route: 'POST /api/sites/{siteId}/machines/{machineId}/commands',
  },

  {
    file: /^web\/contexts\/AuthContext\.tsx$/,
    fn: /^(deleteAccount|deleteUser|deleteCurrentUser)$/,
    capability: 'USER_SELF_DELETE',
    route: 'DELETE /api/users/me',
  },
  {
    // User-doc creation on signup sets role/sites/mfa — control-plane, needs
    // a server bootstrap once rules lock down. `unsubscribe` matches the
    // listener-driven creation path (the onAuthStateChanged callback).
    file: /^web\/contexts\/AuthContext\.tsx$/,
    fn: /^(signup|signUp|AuthProvider|unsubscribe)$/,
    capability: 'USER_ROLE_MANAGE',
    route: 'POST /api/users/bootstrap',
  },
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (st.isFile()) {
      const dot = name.lastIndexOf('.');
      if (dot < 0) continue;
      const ext = name.slice(dot);
      if (INCLUDE_EXT.has(ext)) yield full;
    }
  }
}

function scanFile(absPath) {
  const source = readFileSync(absPath, 'utf8');

  // Only 'firebase/firestore' importers can hold client writes; the admin SDK
  // imports from 'firebase-admin/*'.
  if (!/from\s+['"]firebase\/firestore['"]/.test(source)) return [];

  const sf = ts.createSourceFile(
    absPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  // local binding name -> firestore export name, so aliased imports
  // (`import { setDoc as fsSet }`) still resolve.
  const firestoreBindings = new Map();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const mod = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(mod)) continue;
    if (mod.text !== 'firebase/firestore') continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const original = el.propertyName ? el.propertyName.text : el.name.text;
        firestoreBindings.set(el.name.text, original);
      }
    }
  }

  // Method-style writes (batch.delete(ref) etc.) still require writeBatch or
  // runTransaction to be a named import, so this bail is safe for them too.
  const importsAnyWrite = [...firestoreBindings.values()].some((n) => WRITE_FN_NAMES.has(n));
  if (!importsAnyWrite) return [];

  const hits = [];
  const fnStack = []; // function-name stack for surroundingFunction inference

  function lineNumber(pos) {
    const lc = sf.getLineAndCharacterOfPosition(pos);
    return lc.line + 1;
  }

  // Path template from `doc(db, 'sites', siteId, …)` / `collection(...)`:
  // literals verbatim, identifiers as `{name}`.
  function extractPathFromRefCall(node) {
    if (!ts.isCallExpression(node)) return null;
    const callee = node.expression;
    let calleeName = null;
    if (ts.isIdentifier(callee)) calleeName = callee.text;
    else if (ts.isPropertyAccessExpression(callee)) calleeName = callee.name.text;
    if (calleeName !== 'doc' && calleeName !== 'collection') return null;

    const parts = [];
    let firstSkipped = false;
    for (const arg of node.arguments) {
      // First arg is the db handle (or, in older overloads, a parent ref) —
      // skip it so paths start at a string literal. A string literal there
      // means the no-db overload, so keep it.
      if (!firstSkipped) {
        firstSkipped = true;
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
          parts.push(arg.text);
        }
        continue;
      }
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
        parts.push(arg.text);
      } else if (ts.isIdentifier(arg)) {
        parts.push(`{${arg.text}}`);
      } else if (ts.isPropertyAccessExpression(arg)) {
        parts.push(`{${arg.getText(sf)}}`);
      } else if (ts.isTemplateExpression(arg) || ts.isTemplateLiteral(arg)) {
        // approximate: raw text minus backticks
        parts.push(arg.getText(sf).replace(/^`|`$/g, '').replace(/\$\{[^}]+\}/g, (m) => m));
      } else {
        parts.push(`{${kindName(arg.kind)}}`);
      }
    }
    return parts.join('/');
  }

  // Chase identifier assignments in the same file to resolve a ref to a path
  // (`const ref = doc(…); setDoc(ref, …)`). null when undeterminable.
  function resolveRefToPath(expr) {
    if (!expr) return null;
    if (ts.isCallExpression(expr)) {
      const p = extractPathFromRefCall(expr);
      if (p) return p;
    }
    if (ts.isIdentifier(expr)) {
      const def = findVariableInitializer(expr.text);
      if (def) {
        if (ts.isCallExpression(def)) {
          const p = extractPathFromRefCall(def);
          if (p) return p;
        }
      }
    }
    return null;
  }

  function findVariableInitializer(name) {
    let result = null;
    function visit(node) {
      if (result) return;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer
      ) {
        result = node.initializer;
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
    return result;
  }

  function kindName(k) {
    return ts.SyntaxKind[k] || `kind_${k}`;
  }

  function surroundingFunctionName() {
    for (let i = fnStack.length - 1; i >= 0; i--) {
      if (fnStack[i]) return fnStack[i];
    }
    return null;
  }

  function pushFn(name) {
    fnStack.push(name || null);
  }
  function popFn() {
    fnStack.pop();
  }

  function nameOfFunctionLike(node) {
    if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      return node.name.text;
    }
    // Climb through hook wrappers (useCallback/useMemo/…) to the binding that
    // names the arrow function.
    let parent = node.parent;
    while (parent) {
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
      if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
      if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
      if (ts.isCallExpression(parent) || ts.isParenthesizedExpression(parent)) {
        parent = parent.parent;
        continue;
      }
      break; // left the assignment chain
    }
    return null;
  }

  function visit(node) {
    let pushed = false;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      pushFn(nameOfFunctionLike(node));
      pushed = true;
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;

      // named-import write: setDoc(ref, …) etc.
      if (ts.isIdentifier(callee)) {
        const local = callee.text;
        const original = firestoreBindings.get(local);
        if (original && WRITE_FN_NAMES.has(original)) {
          let firestorePath = null;
          if (
            (original === 'setDoc' ||
              original === 'updateDoc' ||
              original === 'deleteDoc' ||
              original === 'addDoc') &&
            node.arguments.length > 0
          ) {
            firestorePath = resolveRefToPath(node.arguments[0]);
          }
          // arrayUnion/arrayRemove/writeBatch/runTransaction take no ref —
          // path stays null, surrounding function supplies the context.
          hits.push({
            line: lineNumber(node.getStart(sf)),
            firestorePath,
            callType: original,
            surroundingFunction: surroundingFunctionName(),
          });
        }
      }

      // method-style: ref.set(…), batch.delete(ref), transaction.update(…).
      // Safe because the file already imports a firestore write fn.
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
        const methodName = callee.name.text;
        if (WRITE_METHOD_NAMES.has(methodName)) {
          // ref may be the first arg (batch.delete(ref)) or the receiver
          // (ref.set(data)).
          let firestorePath = null;
          if (node.arguments.length > 0) {
            firestorePath = resolveRefToPath(node.arguments[0]);
          }
          if (!firestorePath) {
            firestorePath = resolveRefToPath(callee.expression);
          }
          // Heuristic against unrelated .set/.add calls: accept only when a
          // path resolved or the receiver is named like a batch/tx/ref.
          const receiverText = callee.expression.getText(sf);
          const receiverIsLikelyFirestore =
            firestorePath !== null ||
            /^(batch|transaction|tx)$/.test(receiverText) ||
            /Ref$/.test(receiverText) ||
            /^doc\(/.test(receiverText) ||
            /^collection\(/.test(receiverText);
          if (receiverIsLikelyFirestore) {
            hits.push({
              line: lineNumber(node.getStart(sf)),
              firestorePath,
              callType: `${receiverText}.${methodName}`,
              surroundingFunction: surroundingFunctionName(),
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);

    if (pushed) popFn();
  }

  visit(sf);
  return hits;
}

function classifyHit(hit, relPath) {
  // Allowlist wins over the control-plane rules.
  for (const rule of PREFERENCE_ALLOWLIST) {
    if (!hit.firestorePath) continue;
    if (!rule.firestorePathPattern.test(hit.firestorePath)) continue;
    if (rule.surroundingFunctionPattern) {
      if (!hit.surroundingFunction) continue;
      if (!rule.surroundingFunctionPattern.test(hit.surroundingFunction)) continue;
    }
    return {
      classification: 'preference',
      rationale: rule.rationale,
    };
  }

  // Operands of a parent updateDoc, which carries the real classification.
  if (hit.callType === 'arrayUnion' || hit.callType === 'arrayRemove') {
    return {
      classification: 'no_action',
      rationale: 'array helper passed as updateDoc operand — parent updateDoc carries the classification',
    };
  }

  // Not writes themselves — the returned batch/tx methods are, and the
  // method-style scan already catches those.
  if (hit.callType === 'writeBatch' || hit.callType === 'runTransaction') {
    return {
      classification: 'no_action',
      rationale: 'opens batch/transaction; actual writes scanned via method-style .set/.update/.delete',
    };
  }

  // relPath is forward-slashed, no leading slash.
  for (const rule of CONTROL_PLANE_RULES) {
    if (rule.file && !rule.file.test(relPath)) continue;
    if (rule.fn) {
      if (!hit.surroundingFunction) continue;
      if (!rule.fn.test(hit.surroundingFunction)) continue;
    }
    return {
      classification: 'control_plane',
      capability: rule.capability,
      route: rule.route,
    };
  }

  // Fail loud: unclear hits exit nonzero so triage can't be skipped.
  return { classification: 'unclear' };
}

const allHits = [];
for (const file of walk(WEB_DIR)) {
  // Tests and mocks reference writes for assertions, not at runtime.
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (rel.startsWith('web/__tests__/')) continue;
  if (rel.startsWith('web/__mocks__/')) continue;
  if (rel.startsWith('web/lib/__tests__/')) continue;
  if (rel.startsWith('web/e2e/')) continue;

  const fileHits = scanFile(file);
  for (const h of fileHits) {
    const cls = classifyHit(h, rel);
    allHits.push({
      file: rel,
      line: h.line,
      firestorePath: h.firestorePath,
      callType: h.callType,
      surroundingFunction: h.surroundingFunction,
      ...cls,
    });
  }
}

allHits.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

const counts = {
  preference: 0,
  control_plane: 0,
  no_action: 0,
  unclear: 0,
};
for (const h of allHits) counts[h.classification]++;

const byCapability = {};
for (const h of allHits) {
  if (h.classification !== 'control_plane') continue;
  const k = h.capability || 'UNASSIGNED';
  byCapability[k] = (byCapability[k] || 0) + 1;
}

const jsonReport = {
  generatedAt: new Date().toISOString(),
  totals: { ...counts, total: allHits.length },
  byCapability,
  hits: allHits,
};

if (jsonOutPath) {
  writeFileSync(jsonOutPath, JSON.stringify(jsonReport, null, 2));
} else {
  process.stdout.write(JSON.stringify(jsonReport, null, 2) + '\n');
}

if (writeMd) {
  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
  const md = renderMarkdown(jsonReport);
  writeFileSync(REPORT_PATH, md);
  // stderr keeps stdout's json pipeable.
  process.stderr.write(`[scan-firestore-writes] wrote ${REPORT_PATH}\n`);
}

// ci enforces zero unclear hits via this exit code.
process.exit(counts.unclear > 0 ? 1 : 0);

function renderMarkdown(report) {
  const lines = [];
  lines.push('# firestore client-write inventory');
  lines.push('');
  lines.push(`generated: ${report.generatedAt}`);
  lines.push('source: `scripts/scan-firestore-writes.mjs`');
  lines.push('regenerate: `npm run scan:firestore-writes`');
  lines.push('');
  lines.push(
    'ast-based scan of `web/**/*.{ts,tsx}` for direct firestore *client* (`firebase/firestore`) write calls. excludes `__tests__/`, `__mocks__/`, `e2e/`. server-side admin sdk (`firebase-admin/firestore`) writes are out of scope — those run in trusted server context.',
  );
  lines.push('');
  lines.push('## totals');
  lines.push('');
  lines.push(`- total hits: **${report.totals.total}**`);
  lines.push(`- preference (allowlist): **${report.totals.preference}**`);
  lines.push(`- control-plane (must migrate): **${report.totals.control_plane}**`);
  lines.push(`- no-action (helper / batch open): **${report.totals.no_action}**`);
  lines.push(`- unclear (triage): **${report.totals.unclear}**`);
  lines.push('');
  if (Object.keys(report.byCapability).length > 0) {
    lines.push('## control-plane hits by capability');
    lines.push('');
    lines.push('| capability | count |');
    lines.push('| --- | --- |');
    for (const k of Object.keys(report.byCapability).sort()) {
      lines.push(`| \`${k}\` | ${report.byCapability[k]} |`);
    }
    lines.push('');
  }

  lines.push('## preference allowlist (explicit)');
  lines.push('');
  lines.push('these client writes are intentionally retained after rules lockdown. each entry is matched by firestore-path pattern + (optional) surrounding-function pattern. anything outside this list must migrate to a server route.');
  lines.push('');
  lines.push('| pattern | scope | rationale |');
  lines.push('| --- | --- | --- |');
  for (const rule of PREFERENCE_ALLOWLIST) {
    const scope = rule.surroundingFunctionPattern
      ? `function ~ \`${rule.surroundingFunctionPattern}\``
      : 'any function';
    lines.push(`| \`${rule.firestorePathPattern}\` | ${scope} | ${rule.rationale} |`);
  }
  lines.push('');

  lines.push('### preference hits (file:line)');
  lines.push('');
  const prefHits = report.hits.filter((h) => h.classification === 'preference');
  if (prefHits.length === 0) {
    lines.push('_no preference hits._');
  } else {
    lines.push('| file | line | path | call | function |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const h of prefHits) {
      lines.push(
        `| \`${h.file}\` | ${h.line} | \`${h.firestorePath || '(unresolved)'}\` | \`${h.callType}\` | \`${h.surroundingFunction || '(toplevel)'}\` |`,
      );
    }
  }
  lines.push('');

  lines.push('## control-plane hits (must migrate)');
  lines.push('');
  lines.push('every entry is mapped to a target capability + canonical api route per plan wave 3. wave 4 hook migrations replace the client write with a `fetch()` to the route below.');
  lines.push('');
  const cpHits = report.hits.filter((h) => h.classification === 'control_plane');
  if (cpHits.length === 0) {
    lines.push('_no control-plane hits._');
  } else {
    lines.push('| file | line | path | call | function | capability | target route |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const h of cpHits) {
      lines.push(
        `| \`${h.file}\` | ${h.line} | \`${h.firestorePath || '(unresolved)'}\` | \`${h.callType}\` | \`${h.surroundingFunction || '(toplevel)'}\` | \`${h.capability}\` | \`${h.route}\` |`,
      );
    }
  }
  lines.push('');

  lines.push('## no-action hits (informational)');
  lines.push('');
  lines.push('these matches are reported by the ast scanner but do not require migration on their own — the actual write is captured elsewhere. retained in the report for completeness so an auditor can confirm nothing slipped through.');
  lines.push('');
  const naHits = report.hits.filter((h) => h.classification === 'no_action');
  if (naHits.length === 0) {
    lines.push('_no no-action hits._');
  } else {
    lines.push('| file | line | call | function | reason |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const h of naHits) {
      lines.push(
        `| \`${h.file}\` | ${h.line} | \`${h.callType}\` | \`${h.surroundingFunction || '(toplevel)'}\` | ${h.rationale || ''} |`,
      );
    }
  }
  lines.push('');

  if (report.totals.unclear > 0) {
    lines.push('## unclear hits — TRIAGE REQUIRED');
    lines.push('');
    lines.push('these hits did not match any preference rule or control-plane rule. the scanner exits 1 when this section is non-empty so ci blocks the pr until each is triaged into preference / control_plane / no_action.');
    lines.push('');
    lines.push('| file | line | path | call | function |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const h of report.hits.filter((x) => x.classification === 'unclear')) {
      lines.push(
        `| \`${h.file}\` | ${h.line} | \`${h.firestorePath || '(unresolved)'}\` | \`${h.callType}\` | \`${h.surroundingFunction || '(toplevel)'}\` |`,
      );
    }
    lines.push('');
  }

  lines.push('## ci integration');
  lines.push('');
  lines.push('to enforce no-new-direct-writes on every pr, add the following to ci:');
  lines.push('');
  lines.push('```yaml');
  lines.push('- name: scan firestore writes');
  lines.push('  run: npm run scan:firestore-writes --silent > /dev/null');
  lines.push('```');
  lines.push('');
  lines.push("the scanner exits non-zero when any 'unclear' hit remains, so ci fails on any unclassified write introduced by a pr. once the security-boundary migration is complete, the same exit-non-zero behaviour will be tightened to fail on any *control_plane* hit too (every control-plane write must be a server route).");
  lines.push('');
  return lines.join('\n');
}
