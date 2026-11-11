// run with `npm run test:scripts` (node's own test runner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeLockfileVersion } from '../sync-versions.js';

const LOCK = [
  '{',
  '  "name": "web",',
  '  "version": "4.1.25",',
  '  "lockfileVersion": 3,',
  '  "requires": true,',
  '  "packages": {',
  '    "": {',
  '      "name": "web",',
  '      "version": "4.1.25",',
  '      "dependencies": {',
  '        "next": "^16.0.0"',
  '      }',
  '    },',
  '    "node_modules/next": {',
  '      "version": "16.0.0"',
  '    }',
  '  }',
  '}',
  '',
];

function tempLockfile(t, content) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-versions-'));
  const file = join(dir, 'package-lock.json');
  writeFileSync(file, content, 'utf8');
  t.after(() => {
    unlinkSync(file);
    rmdirSync(dir);
  });
  return file;
}

test('a bump sets the lockfile\'s own two version fields and nothing else', (t) => {
  const file = tempLockfile(t, LOCK.join('\n'));
  assert.equal(writeLockfileVersion(file, '4.1.28'), true);
  const expected = LOCK.join('\n')
    .replace('  "version": "4.1.25",', '  "version": "4.1.28",')
    .replace('      "version": "4.1.25",', '      "version": "4.1.28",');
  assert.equal(readFileSync(file, 'utf8'), expected);
});

test('a crlf checkout keeps its line endings', (t) => {
  const file = tempLockfile(t, LOCK.join('\r\n'));
  assert.equal(writeLockfileVersion(file, '4.1.28'), true);
  const after = readFileSync(file, 'utf8');
  assert.equal(after.split('\r\n').length, LOCK.length);
  assert.equal(JSON.parse(after).packages[''].version, '4.1.28');
  assert.equal(JSON.parse(after).packages['node_modules/next'].version, '16.0.0');
});

test('a lockfile laid out some other way is left untouched', (t) => {
  const content = LOCK.join('\n').replace('      "name": "web",\n', '');
  const file = tempLockfile(t, content);
  assert.equal(writeLockfileVersion(file, '4.1.28'), false);
  assert.equal(readFileSync(file, 'utf8'), content);
});
