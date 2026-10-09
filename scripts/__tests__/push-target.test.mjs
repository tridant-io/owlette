// run with `npm run test:scripts`; ci: .github/workflows/claude-hooks.yml
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  COMMIT_OR_PUSH, landsInProject, mergedPrRef, mergeRepo, namedBranch, nativePath, pushRemote, repoSlug, runDirs, segments,
} from '../../.claude/hooks/lib/push-target.mjs';
import { sessionEdits } from '../../.claude/hooks/lib/edit-log.mjs';

const gated = (command) => segments(command).some((s) => COMMIT_OR_PUSH.test(s));

test('a push names its target branch', () => {
  assert.equal(namedBranch('git push origin dev'), 'dev');
  assert.equal(namedBranch('git push origin HEAD:main'), 'main');
  assert.equal(namedBranch('cd ../wt && git push -u origin main'), 'main');
  assert.equal(namedBranch('git -C ../wt push origin dev'), 'dev');
  assert.equal(namedBranch('GIT_TRACE=1 git push origin dev'), 'dev');
  assert.equal(namedBranch('(git push origin dev)'), 'dev');
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

test('the commit gate sees every way a commit or push is written', () => {
  for (const c of [
    'git commit -m "fix: x"',
    'cd ../skills && git commit -m x',
    'git -C ../wt push origin dev',
    'GIT_EDITOR=true git commit -m x',
    'env X=1 git commit -m x',
    '(git commit -m x)',
    'bash -c "git commit -m x"',
    'git -c core.hooksPath=x commit -m x',
    'git --no-pager -C ../wt push origin dev',
  ]) assert.ok(gated(c), c);
  for (const c of ['echo git commit', 'git log --grep commit']) assert.ok(!gated(c), c);
});

test('each push or commit runs where the command put it', () => {
  const cwd = resolve('/work/owlette');
  const exists = () => true;
  const dirs = (c) => runDirs(c, cwd, COMMIT_OR_PUSH, exists);
  assert.deepEqual(dirs('git push origin main'), [cwd]);
  assert.deepEqual(dirs('cd ../skills && git push -u origin main'), [resolve(cwd, '../skills')]);
  assert.deepEqual(dirs('cd "../my skills" && git push'), [resolve(cwd, '../my skills')]);
  assert.deepEqual(dirs('pushd ../skills && git push'), [resolve(cwd, '../skills')]);
  assert.deepEqual(dirs('git -C ../latticus push origin main'), [resolve(cwd, '../latticus')]);
  assert.deepEqual(dirs('git -c user.name=x -C ../latticus commit -m x'), [resolve(cwd, '../latticus')]);
  // -C after the subcommand is commit's reuse-message option, not a folder
  assert.deepEqual(dirs('git commit -C HEAD'), [cwd]);
  // every commit and push counts, not only the first
  assert.deepEqual(dirs('git -C ../skills commit -m x && git push'), [resolve(cwd, '../skills'), cwd]);
});

test('a cd the session already applied is not applied twice', () => {
  // the reported cwd can already be the in-project folder the command moved to
  const cwd = resolve('/work/owlette/web');
  const exists = (p) => p !== resolve(cwd, 'web');
  assert.deepEqual(runDirs('cd web && git push origin dev', cwd, COMMIT_OR_PUSH, exists), [cwd]);
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

test('a commit lands in the project only when its repo is the project', () => {
  // two real repos with different origins; kept between runs so nothing is ever deleted
  const root = join(tmpdir(), 'owlette-push-target-test');
  const repo = (name, url) => {
    const dir = join(root, name);
    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q', dir]);
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url]);
    }
    return dir;
  };
  const project = repo('owlette', 'https://github.com/tridant-io/owlette.git');
  const other = repo('skills', 'https://github.com/tridant-io/skills.git');
  const saved = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = project;
  try {
    const lands = (command) => landsInProject({ tool_input: { command }, cwd: project }, COMMIT_OR_PUSH);
    assert.equal(lands('git commit -m x'), true);
    assert.equal(lands(`cd "${other}" && git commit -m x`), false);
    assert.equal(lands(`git -C "${other}" commit -m x && git push`), true);
    assert.equal(lands(`cd "${other}" && git commit -m x && cd "${project}" && git push`), true);
    assert.equal(lands('git status'), false);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = saved;
  }
});

test('the commit gate reads only its own session\'s edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'edit-log-'));
  const file = join(dir, 'session-edits.json');
  writeFileSync(file, JSON.stringify([
    { path: 'web/a.tsx', session: 'other' },
    { path: 'agent/src/b.py', session: 'mine' },
    { path: 'agent/src/b.py', session: 'mine' },
  ]));
  try {
    assert.deepEqual(sessionEdits('mine', file), ['agent/src/b.py']);
    assert.deepEqual(sessionEdits('nobody', file), []);
  } finally {
    unlinkSync(file);
    rmdirSync(dir);
  }
});
