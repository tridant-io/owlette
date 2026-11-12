/** @jest-environment node */

import crypto from 'crypto';
import { cronSecretMatches, secretMatches } from '@/lib/secretMatches.server';

describe('secretMatches', () => {
  it('accepts the secret', () => {
    expect(secretMatches('s3cret-value', 's3cret-value')).toBe(true);
  });

  it.each([
    ['a wrong one', 's3cret-valuE'],
    ['a longer one', 's3cret-value-and-more'],
    ['a prefix of it', 's3cret'],
    ['an empty one', ''],
    ['none', null],
    ['undefined', undefined],
  ])('refuses %s', (_label, presented) => {
    expect(secretMatches(presented, 's3cret-value')).toBe(false);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('refuses everything when the secret is %s', (_label, secret) => {
    expect(secretMatches('', secret)).toBe(false);
    expect(secretMatches('anything', secret)).toBe(false);
  });

  it('compares in constant time, whatever length was presented', () => {
    const compare = jest.spyOn(crypto, 'timingSafeEqual');
    try {
      expect(secretMatches('x', 's3cret-value')).toBe(false);
      expect(compare).toHaveBeenCalledTimes(1);
    } finally {
      compare.mockRestore();
    }
  });
});

describe('cronSecretMatches', () => {
  const original = process.env.CRON_SECRET;

  afterEach(() => {
    process.env.CRON_SECRET = original;
  });

  it("checks against this environment's CRON_SECRET, read at call time", () => {
    process.env.CRON_SECRET = 'cron-secret';
    expect(cronSecretMatches('cron-secret')).toBe(true);
    expect(cronSecretMatches('cron-secreT')).toBe(false);
    delete process.env.CRON_SECRET;
    expect(cronSecretMatches('cron-secret')).toBe(false);
  });
});
