/** @jest-environment node */

/**
 * Tests for environment.ts — the host-derived environment helpers.
 *
 * The two behaviours worth pinning: production returns `null` (a badge that
 * renders nothing), and `/SERVER=` is emitted for dev *only* — never for
 * localhost or preview hosts, which the installer cannot target.
 */

import { environmentToken, pairingPreseedFor, serverFlagFor } from '@/lib/environment';

describe('environmentToken', () => {
  it("returns 'dev' for the dev dashboard host", () => {
    expect(environmentToken('dev.owlette.app')).toBe('dev');
  });

  it('returns null for the production dashboard host', () => {
    // Not 'prod': the consumer is a badge that must render nothing on prod.
    expect(environmentToken('owlette.app')).toBeNull();
  });

  it('returns the bare host for anything else', () => {
    expect(environmentToken('localhost:3000')).toBe('localhost:3000');
    expect(environmentToken('owlette-pr-42.up.railway.app')).toBe('owlette-pr-42.up.railway.app');
  });

  it('returns null for an empty or whitespace host', () => {
    expect(environmentToken('')).toBeNull();
    expect(environmentToken('   ')).toBeNull();
  });

  it('is case- and whitespace-insensitive', () => {
    expect(environmentToken('DEV.Owlette.App')).toBe('dev');
    expect(environmentToken(' owlette.app ')).toBeNull();
  });
});

describe('serverFlagFor', () => {
  it('emits the dev flag on the dev dashboard host', () => {
    expect(serverFlagFor('dev.owlette.app')).toBe(' /SERVER=dev');
  });

  it('emits nothing on production — the installer already defaults to prod', () => {
    expect(serverFlagFor('owlette.app')).toBe('');
  });

  it('emits nothing for hosts the installer cannot target', () => {
    // The flag accepts only dev|prod, so localhost and preview deploys get none.
    expect(serverFlagFor('localhost:3000')).toBe('');
    expect(serverFlagFor('owlette-pr-42.up.railway.app')).toBe('');
  });

  it('emits nothing for an empty host (SSR, host not yet known)', () => {
    expect(serverFlagFor('')).toBe('');
  });

  it('carries its own leading space so callers can concatenate unconditionally', () => {
    expect(`/ADD=silver-compass-drift${serverFlagFor('dev.owlette.app')} /SILENT`).toBe(
      '/ADD=silver-compass-drift /SERVER=dev /SILENT'
    );
    expect(`/ADD=silver-compass-drift${serverFlagFor('owlette.app')} /SILENT`).toBe(
      '/ADD=silver-compass-drift /SILENT'
    );
  });
});

describe('pairingPreseedFor', () => {
  it('names the dev server on the dev dashboard host', () => {
    expect(pairingPreseedFor('balance-time-loud', 'dev.owlette.app')).toBe(
      '{"phrase": "balance-time-loud", "server": "dev"}'
    );
  });

  it('names no server elsewhere, as the windows command carries no /SERVER=', () => {
    expect(pairingPreseedFor('balance-time-loud', 'owlette.app')).toBe('{"phrase": "balance-time-loud"}');
    expect(pairingPreseedFor('balance-time-loud', 'localhost:3000')).toBe('{"phrase": "balance-time-loud"}');
    expect(pairingPreseedFor('balance-time-loud', '')).toBe('{"phrase": "balance-time-loud"}');
  });

  it('is valid JSON the agent can parse', () => {
    expect(JSON.parse(pairingPreseedFor('balance-time-loud', 'dev.owlette.app'))).toEqual({
      phrase: 'balance-time-loud',
      server: 'dev',
    });
  });
});
