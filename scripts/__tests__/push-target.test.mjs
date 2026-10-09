// run with `npm run test:scripts`; ci: .github/workflows/claude-hooks.yml
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { namedBranch, mergedPrRef } from '../../.claude/hooks/lib/push-target.mjs';

test('a push names its target branch', () => {
  assert.equal(namedBranch('git push origin dev'), 'dev');
  assert.equal(namedBranch('git push origin HEAD:main'), 'main');
  assert.equal(namedBranch('cd ../wt && git push -u origin main'), 'main');
});

test('a feature-branch push names nothing, whatever the rest of the line says', () => {
  assert.equal(namedBranch('git push -u origin fix/x && gh pr create --base dev --head fix/x'), null);
  assert.equal(namedBranch('git push origin feat/main-menu'), null);
});

test('a merge reads its pr number from its own command only', () => {
  assert.equal(mergedPrRef('gh pr merge 318 --merge'), '318');
  assert.equal(mergedPrRef('gh pr merge https://github.com/o/r/pull/42 --squash'), '42');
  assert.equal(mergedPrRef('gh pr merge --squash && gh run list --limit 5'), '');
});

test('a command that only mentions a push or merge is neither', () => {
  assert.equal(namedBranch(`echo 'git push origin dev' > notes.txt`), null);
  assert.equal(mergedPrRef(`echo '{"command":"gh pr merge 316"}' | node hook.mjs`), null);
});
