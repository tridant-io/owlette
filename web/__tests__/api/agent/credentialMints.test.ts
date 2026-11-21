/**
 * @jest-environment node
 *
 * where agent credentials are minted: one helper signs agent ID tokens in, used by
 * device-code pairing and a machine's move, and refresh rotates them on its own.
 * a new mint goes through the helper, so adding a caller has to change this test.
 */

import fs from 'fs';
import path from 'path';

const WEB_ROOT = path.resolve(__dirname, '..', '..', '..');
const API_ROOT = path.join(WEB_ROOT, 'app', 'api');
const LIB_ROOT = path.join(WEB_ROOT, 'lib');

function files(dir: string, keep: (name: string) => boolean): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full, keep);
    return keep(entry.name) ? [full] : [];
  });
}

const routeFiles = () => files(API_ROOT, (name) => name === 'route.ts');
const contains = (marker: string) => (file: string) => fs.readFileSync(file, 'utf8').includes(marker);
const posix = (p: string) => p.split(path.sep).join('/');

/** route ids, relative to app/api, whose source contains `marker`. */
function routesContaining(marker: string): string[] {
  return routeFiles()
    .filter(contains(marker))
    .map((file) => posix(path.relative(API_ROOT, path.dirname(file))))
    .sort();
}

/**
 * server files, relative to web/, whose source contains `marker`: api routes and
 * the `.server.ts` files under lib. client code is left out, it signs users in
 * with the sdk.
 */
function serverFilesContaining(marker: string): string[] {
  return [...routeFiles(), ...files(LIB_ROOT, (name) => name.endsWith('.server.ts'))]
    .filter(contains(marker))
    .map((file) => posix(path.relative(WEB_ROOT, file)))
    .sort();
}

describe('agent credential mints', () => {
  it('sign in only in the mint helper and refresh', () => {
    expect(serverFilesContaining('signInWithCustomToken')).toEqual([
      'app/api/agent/auth/refresh/route.ts',
      'lib/agentCredentials.server.ts',
    ]);
  });

  it('go through the helper only in device-code pairing and a move', () => {
    const minting = ['agent/auth/device-code/authorize', 'agent/auth/device-code/poll', 'agent/auth/move'];
    // the move route lands later; until then it is simply absent.
    expect(routesContaining('mintAgentIdToken')).toEqual(
      minting.filter((id) => fs.existsSync(path.join(API_ROOT, id, 'route.ts'))),
    );
  });

  it('never redeem or issue registration codes', () => {
    expect(routesContaining('agent_tokens')).toEqual([]);
  });
});
