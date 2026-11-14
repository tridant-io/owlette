/** @jest-environment node */

/**
 * Guard for the live dev smoke suite (web/e2e-live; dev/active/live-smoke Task 3.5): no source
 * there may approve a hoot tier-3 call, by any of the three routes the app offers. The suite drives
 * live dev as real users, and its tier-3 check denies; approving is the one action it must never be
 * able to take.
 *
 * Every JavaScript/TypeScript source under e2e-live (the generated .output/ and .auth/ skipped) is
 * parsed with the TypeScript compiler, and its code text is checked:
 *
 *   The approve control. String, template and regex literals and JSX text fail on `approv` unless it
 *   reads `approval`: 'approve', /approv/i, 'Approve all' and 'approved' can all name or match the
 *   control, whose accessible name is 'approve'. 'awaiting approval' and 'approval-requested' are the
 *   tool card's status copy and part state, and pass. Identifiers fail on `approv` unless it reads
 *   `approval` or `approved`: `part.approval.approved` and `requireTier3Approval` are data;
 *   approveButton, onApprove and clickApprove are not.
 *
 *   The site's approval gate (sites/{siteId}/settings/cortex.requireTier3Approval). Switched off, it
 *   lets every tier-3 call run with no decision at all. So literals fail on the switch's name on the
 *   admin panel's hoot page ('require approval for privileged tools'), on the names of the toggle it
 *   replaced ('approval required', 'approval off') and on its confirm button ('disable approval'), on the
 *   settings route (hoot-settings), and on a JSON body setting "requireTier3Approval" false; the
 *   setter setHootRequireTier3Approval fails as an identifier; and a write of requireTier3Approval —
 *   object property, shorthand or assignment — fails unless its value is `true` or
 *   `FieldValue.delete()`, the seed's restore. Reads and comparisons pass.
 *
 *   An approving answer. The page answers a waiting call with addToolApprovalResponse({ id, approved }):
 *   that identifier fails, and so does a write of `approved` with any value but `false`.
 *
 * Comments are not code and are not checked, so the rule can be written down where it applies.
 *
 * A tripwire for honest mistakes, not a sandbox: a name assembled at runtime ('appr' + 'ove', a
 * computed key) gets past it. The detector cases at the bottom keep it able to fail.
 */

import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import ts from 'typescript';

const E2E_LIVE_DIR = path.join(__dirname, '..', 'e2e-live');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
/** Directories that hold no source of the suite's own. Dot-directories (.output, .auth) are skipped too. */
const SKIPPED_DIRS = new Set(['node_modules']);

const LITERAL_PATTERN = /approv(?!al)/i;
const GATE_LITERAL_PATTERN = /disable approval|approval (?:required|off)|require approval for privileged|hoot-settings|["']requireTier3Approval["']\s*:\s*false/i;
const IDENTIFIER_PATTERN = /approv(?!al|ed)/i;
const FORBIDDEN_IDENTIFIERS = new Set(['addToolApprovalResponse', 'setHootRequireTier3Approval']);

/** Properties the suite may write only with these values. */
const GUARDED_WRITES: Record<string, (value: ts.Expression) => boolean> = {
  approved: (value) => value.kind === ts.SyntaxKind.FalseKeyword,
  requireTier3Approval: (value) => value.kind === ts.SyntaxKind.TrueKeyword || isFieldValueDelete(value),
};

interface ApproveReference {
  line: number;
  column: number;
  kind: 'literal' | 'identifier' | 'write';
  text: string;
}

/** Suite sources under `dir`, as sorted forward-slash paths relative to e2e-live. */
function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name)) out.push(...listSources(full));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.relative(E2E_LIVE_DIR, full).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

function readSource(file: string): string {
  return readFileSync(path.join(E2E_LIVE_DIR, file), 'utf8');
}

/** The text of a literal node, escapes resolved (a regex literal keeps its source); null for anything else. */
function literalText(node: ts.Node): string | null {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isJsxText(node)
  ) {
    return node.text;
  }
  return null;
}

function unwrapParentheses(node: ts.Expression): ts.Expression {
  let inner = node;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

/** `FieldValue.delete()`: removing a field rather than setting it. */
function isFieldValueDelete(node: ts.Expression): boolean {
  const call = unwrapParentheses(node);
  return (
    ts.isCallExpression(call) &&
    call.arguments.length === 0 &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === 'delete' &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === 'FieldValue'
  );
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return null;
}

/** The property a node writes and the value it writes; null value for a shorthand `{ name }`. */
function writtenProperty(node: ts.Node): { name: string; value: ts.Expression | null } | null {
  if (ts.isPropertyAssignment(node)) {
    const name = propertyNameText(node.name);
    return name === null ? null : { name, value: node.initializer };
  }
  if (ts.isShorthandPropertyAssignment(node)) return { name: node.name.text, value: null };
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const target = node.left;
    if (ts.isPropertyAccessExpression(target)) return { name: target.name.text, value: node.right };
    if (ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)) {
      return { name: target.argumentExpression.text, value: node.right };
    }
  }
  return null;
}

function isForbiddenWrite(node: ts.Node): boolean {
  const written = writtenProperty(node);
  if (!written || !Object.hasOwn(GUARDED_WRITES, written.name)) return false;
  return written.value === null || !GUARDED_WRITES[written.name](unwrapParentheses(written.value));
}

function referenceKind(node: ts.Node): ApproveReference['kind'] | null {
  const literal = literalText(node);
  if (literal !== null && (LITERAL_PATTERN.test(literal) || GATE_LITERAL_PATTERN.test(literal))) return 'literal';
  const identifier = ts.isIdentifier(node) || ts.isPrivateIdentifier(node) ? node.text : null;
  if (identifier !== null && (IDENTIFIER_PATTERN.test(identifier) || FORBIDDEN_IDENTIFIERS.has(identifier))) {
    return 'identifier';
  }
  return isForbiddenWrite(node) ? 'write' : null;
}

function findApproveReferences(fileName: string, text: string): ApproveReference[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: ApproveReference[] = [];
  const visit = (node: ts.Node): void => {
    const kind = referenceKind(node);
    if (kind) {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push({ line: line + 1, column: character + 1, kind, text: node.getText(source).slice(0, 120) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Syntax errors only: a region the parser had to recover from could hide a literal from the scan. */
function syntaxErrors(fileName: string, text: string): string[] {
  const { diagnostics = [] } = ts.transpileModule(text, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { allowJs: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest },
  });
  return diagnostics
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
}

describe('web/e2e-live never approves a tier-3 call', () => {
  const files = listSources(E2E_LIVE_DIR);

  it('scans the suite sources, specs included', () => {
    // A broken walk that found nothing would pass the scan below vacuously.
    expect(files).toEqual(expect.arrayContaining(['fixtures.ts', 'lib/seed.mjs', 'run.mjs', 'stub-agent.mjs']));
    expect(files.filter((file) => /^specs\/[^/]+\.spec\.ts$/.test(file)).length).toBeGreaterThan(0);
  });

  it('parses every source without syntax errors', () => {
    const errors = files.flatMap((file) => syntaxErrors(file, readSource(file)).map((error) => `${file}: ${error}`));
    expect(errors).toEqual([]);
  });

  it('finds no approve control, approval-gate switch or approving answer', () => {
    const found = files.flatMap((file) =>
      findApproveReferences(file, readSource(file)).map(
        ({ line, column, kind, text }) => `${file}:${line}:${column} ${kind} ${text}`,
      ),
    );
    expect(found).toEqual([]);
  });
});

describe('the approve detector', () => {
  it.each([
    // the approve control
    "page.getByRole('button', { name: 'approve' });",
    'page.getByRole("button", { name: /approv/i });',
    "page.getByText('Approve');",
    'const label = `${verb} approve`;',
    "card.filter({ hasText: 'approved' });",
    "const label = 'appr\\u006fve';",
    'const approveButton = null;',
    "import { clickApprove } from './helpers';",
    "import { deny } from './approve-helpers';",
    // the site's approval gate
    "page.getByRole('button', { name: 'approval required' });",
    'toolbar.getByRole("button", { name: /approval off/ });',
    "dialog.getByRole('button', { name: 'disable approval' });",
    "page.getByRole('switch', { name: 'require approval for privileged tools' });",
    'await page.request.patch(`/api/sites/${siteId}/hoot-settings`, { data });',
    'await cortexRef.set({ requireTier3Approval: false }, { merge: true });',
    "await cortexRef.set({ 'requireTier3Approval': enabled }, { merge: true });",
    'await cortexRef.set({ requireTier3Approval }, { merge: true });',
    'settings.requireTier3Approval = false;',
    "settings['requireTier3Approval'] = (false);",
    `const body = '{"requireTier3Approval": false}';`,
    "import { setHootRequireTier3Approval } from '../lib/actions/setHootRequireTier3Approval.server';",
    // an approving answer
    'addToolApprovalResponse({ id, approved: false });',
    'const answer = { id, approved: true };',
    'const answer = { id, approved: decision };',
    'const answer = { id, approved };',
    'answer.approved = !denied;',
  ])('flags %s', (snippet) => {
    expect(findApproveReferences('probe.ts', snippet)).not.toEqual([]);
  });

  it.each([
    'expect(part.approval?.approved).toBe(false);',
    "cards.filter({ hasText: 'awaiting approval' });",
    "const pending = part.state === 'approval-requested';",
    'const requireTier3Approval = data.requireTier3Approval !== false;',
    "expect(cortex?.requireTier3Approval, 'the gate').not.toBe(false);",
    'await cortexRef.update({ requireTier3Approval: FieldValue.delete() });',
    'await cortexRef.set({ requireTier3Approval: true }, { merge: true });',
    'const log = `${ref.path}: remove requireTier3Approval=false`;',
    'const answer = { id, approved: false };',
    'interface Part { approval?: { approved?: unknown } | null }',
    "page.getByRole('button', { name: 'deny', exact: true });",
    '// only deny: never approve\nconst x = 1;',
    '/** approve is off limits */\nconst y = 2;',
  ])('passes %s', (snippet) => {
    expect(findApproveReferences('probe.ts', snippet)).toEqual([]);
  });
});
