// run with `npm run test:scripts`; ci: .github/workflows/claude-hooks.yml
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { namedBranch, mergedPrRef, mergeRepo, pushRemote, repoSlug, runDir, nativePath } from '../../.claude/hooks/lib/push-target.mjs';

test('a push names its target branch', () => {
  assert.equal(namedBranch('git push origin dev'), 'dev');
  assert.equal(namedBranch('git push origin HEAD:main'), 'main');
  assert.equal(namedBranch('cd ../wt && git push -u origin main'), 'main');
  assert.equal(namedBranch('git -C ../wt push origin dev'), 'dev');
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
  assert.equal(namedBranch(`cat > notes.md <<'EOF'\ngit push origin dev\nEOF`), null);
  assert.equal(mergedPrRef(`cat > notes.md <<EOF\ngh pr merge 316\nEOF\necho done`), null);
});

test('a push or merge runs where the command put it, not where the session started', () => {
  const cwd = resolve('/work/owlette');
  const exists = () => true;
  assert.equal(runDir('git push origin main', cwd, exists), cwd);
  assert.equal(runDir('cd ../skills && git push -u origin main', cwd, exists), resolve(cwd, '../skills'));
  assert.equal(runDir('cd "../my skills" && git push', cwd, exists), resolve(cwd, '../my skills'));
  assert.equal(runDir('pushd ../skills && git push', cwd, exists), resolve(cwd, '../skills'));
  assert.equal(runDir('git -C ../latticus push origin main', cwd, exists), resolve(cwd, '../latticus'));
  assert.equal(runDir('cd ../latticus && gh pr merge 20 --merge', cwd, exists), resolve(cwd, '../latticus'));
});

test('a cd the session already applied is not applied twice', () => {
  // the reported cwd can already be the in-project folder the command moved to
  const cwd = resolve('/work/owlette/web');
  const exists = (p) => p !== resolve(cwd, 'web');
  assert.equal(runDir('cd web && git push origin dev', cwd, exists), cwd);
});

test('git bash paths become windows paths, and only on windows', () => {
  assert.equal(nativePath('/c/Users/admin/x'), process.platform === 'win32' ? 'c:/Users/admin/x' : '/c/Users/admin/x');
  assert.equal(nativePath('../x'), '../x');
});

test('a merge names the repo it targets, by flag or by url', () => {
  assert.equal(mergeRepo('gh pr merge 20 -R tridant-io/latticus --merge'), 'tridant-io/latticus');
  assert.equal(mergeRepo('gh pr merge 20 --repo=tridant-io/moonshine'), 'tridant-io/moonshine');
  assert.equal(mergeRepo('gh pr merge 20 -R github.com/tridant-io/owlette'), 'tridant-io/owlette');
  assert.equal(mergeRepo('gh pr merge https://github.com/tridant-io/latticus/pull/20 --merge'), 'tridant-io/latticus');
  assert.equal(mergeRepo('gh pr merge 318 --merge'), null);
});

test('a push names its remote', () => {
  assert.equal(pushRemote('git push mba dev'), 'mba');
  assert.equal(pushRemote('git push -u origin main'), 'origin');
  assert.equal(pushRemote('git -C ../wt push --force origin dev'), 'origin');
  assert.equal(pushRemote('git push'), null);
});

test('remotes compare by owner/repo, whatever the url form', () => {
  assert.equal(repoSlug('https://github.com/tridant-io/owlette.git'), 'tridant-io/owlette');
  assert.equal(repoSlug('git@github.com:tridant-io/Owlette.git'), 'tridant-io/owlette');
  assert.equal(repoSlug('https://github.com/tridant-io/skills'), 'tridant-io/skills');
});
