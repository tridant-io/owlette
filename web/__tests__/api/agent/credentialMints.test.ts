/**
 * @jest-environment node
 *
 * where agent credentials are minted: pairing through a device code, and refresh
 * rotating them. a route outside that list is another copy of the mint sequence
 * to keep in step, so adding one has to change this test.
 */

import fs from 'fs';
import path from 'path';

const API_ROOT = path.resolve(__dirname, '..', '..', '..', 'app', 'api');

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === 'route.ts' ? [full] : [];
  });
}

/** route ids, relative to app/api, whose source contains `marker`. */
function routesContaining(marker: string): string[] {
  return routeFiles(API_ROOT)
    .filter((file) => fs.readFileSync(file, 'utf8').includes(marker))
    .map((file) => path.relative(API_ROOT, path.dirname(file)).split(path.sep).join('/'))
    .sort();
}

describe('agent credential mints', () => {
  it('happen only in device-code pairing and refresh', () => {
    expect(routesContaining('signInWithCustomToken')).toEqual([
      'agent/auth/device-code/authorize',
      'agent/auth/device-code/poll',
      'agent/auth/refresh',
    ]);
  });

  it('never redeem or issue registration codes', () => {
    expect(routesContaining('agent_tokens')).toEqual([]);
  });
});
