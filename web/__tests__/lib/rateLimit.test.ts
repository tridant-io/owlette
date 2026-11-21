/** @jest-environment node */

import { NextRequest } from 'next/server';
import type { Ratelimit } from '@upstash/ratelimit';
import { getClientIp, checkRateLimit, getRateLimitHeaders } from '@/lib/rateLimit';

describe('getClientIp', () => {
  it('prefers CF-Connecting-IP (Cloudflare-set, unspoofable) over X-Forwarded-For', () => {
    const req = new NextRequest(new URL('http://localhost/test'), {
      headers: {
        'cf-connecting-ip': '203.0.113.7',
        'x-forwarded-for': '1.2.3.4, 5.6.7.8', // client-seeded — must be ignored
      },
    });
    expect(getClientIp(req)).toBe('203.0.113.7');
  });

  describe('with an edge secret configured', () => {
    const before = process.env.EDGE_SHARED_SECRET;
    beforeEach(() => {
      process.env.EDGE_SHARED_SECRET = 'edge-secret-for-this-test';
    });
    afterEach(() => {
      if (before === undefined) delete process.env.EDGE_SHARED_SECRET;
      else process.env.EDGE_SHARED_SECRET = before;
    });

    it('believes CF-Connecting-IP when the request carries the edge secret', () => {
      const req = new NextRequest(new URL('http://localhost/test'), {
        headers: {
          'cf-connecting-ip': '203.0.113.7',
          'x-owlette-edge': 'edge-secret-for-this-test',
          'x-forwarded-for': '1.2.3.4, 5.6.7.8',
        },
      });
      expect(getClientIp(req)).toBe('203.0.113.7');
    });

    it('ignores a CF-Connecting-IP that arrived around the edge and takes the proxy-appended hop', () => {
      // direct to the origin: the client set CF-Connecting-IP itself and the
      // platform proxy appended the real address to X-Forwarded-For
      const req = new NextRequest(new URL('http://localhost/test'), {
        headers: {
          'cf-connecting-ip': '203.0.113.9',
          'x-forwarded-for': '203.0.113.9, 198.51.100.5',
        },
      });
      expect(getClientIp(req)).toBe('198.51.100.5');
    });

    it('ignores CF-Connecting-IP beside a wrong edge secret', () => {
      const req = new NextRequest(new URL('http://localhost/test'), {
        headers: {
          'cf-connecting-ip': '203.0.113.9',
          'x-owlette-edge': 'not-the-secret',
          'x-forwarded-for': '198.51.100.5',
        },
      });
      expect(getClientIp(req)).toBe('198.51.100.5');
    });
  });

  it('takes the RIGHT-most x-forwarded-for hop (proxy-appended), not the client-seeded left', () => {
    const req = new NextRequest(new URL('http://localhost/test'), {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    });
    expect(getClientIp(req)).toBe('5.6.7.8');
  });

  it('resists X-Forwarded-For rotation — a forged left entry cannot mint a fresh bucket', () => {
    // Attacker prepends a rotating fake; the trusted edge appends the real IP.
    // Both requests must resolve to the SAME (real) IP so the rate-limit bucket
    // is stable regardless of what the client pre-seeds.
    const a = new NextRequest(new URL('http://localhost/test'), {
      headers: { 'x-forwarded-for': '9.9.9.9, 198.51.100.5' },
    });
    const b = new NextRequest(new URL('http://localhost/test'), {
      headers: { 'x-forwarded-for': '8.8.8.8, 198.51.100.5' },
    });
    expect(getClientIp(a)).toBe('198.51.100.5');
    expect(getClientIp(b)).toBe('198.51.100.5');
  });

  it('returns x-real-ip when no cf / x-forwarded-for', () => {
    const req = new NextRequest(new URL('http://localhost/test'), {
      headers: { 'x-real-ip': '10.0.0.1' },
    });
    expect(getClientIp(req)).toBe('10.0.0.1');
  });

  it('returns x-railway-ip as last resort', () => {
    const req = new NextRequest(new URL('http://localhost/test'), {
      headers: { 'x-railway-ip': '172.16.0.1' },
    });
    expect(getClientIp(req)).toBe('172.16.0.1');
  });

  it('returns unknown when no proxy headers', () => {
    const req = new NextRequest(new URL('http://localhost/test'));
    expect(getClientIp(req)).toBe('unknown');
  });

  it('clamps a malformed IP header to unknown (no injected rate-limit key)', () => {
    const req = new NextRequest(new URL('http://localhost/test'), {
      headers: { 'cf-connecting-ip': 'not-an-ip <script>' },
    });
    expect(getClientIp(req)).toBe('unknown');
  });

  it('caps an over-long IP token at 64 chars', () => {
    const req = new NextRequest(new URL('http://localhost/test'), {
      headers: { 'cf-connecting-ip': '1'.repeat(100) },
    });
    expect(getClientIp(req).length).toBe(64);
  });

  it('shape-clamps the right-most X-Forwarded-For hop too — the value used as the rate-limit key', () => {
    // The XFF branch is the identifier on the non-Cloudflare path, so its clamp
    // must be pinned, not just CF-Connecting-IP's.
    const malformed = new NextRequest(new URL('http://localhost/test'), {
      headers: { 'x-forwarded-for': '5.6.7.8, junk!<script>' },
    });
    expect(getClientIp(malformed)).toBe('unknown');

    const overlong = new NextRequest(new URL('http://localhost/test'), {
      headers: { 'x-forwarded-for': `1.2.3.4, ${'9'.repeat(100)}` },
    });
    expect(getClientIp(overlong).length).toBe(64);
  });

  it('preserves an IPv6 client address', () => {
    const req = new NextRequest(new URL('http://localhost/test'), {
      headers: { 'cf-connecting-ip': '2001:db8::1' },
    });
    expect(getClientIp(req)).toBe('2001:db8::1');
  });
});

describe('checkRateLimit', () => {
  it('returns success when ratelimiter is null (in-memory allows first request)', async () => {
    const result = await checkRateLimit(null, 'null-first-request');
    expect(result.success).toBe(true);
    expect(result.limit).toBe(15);
    expect(result.remaining).toBe(14);
    expect(result.reset).toBeDefined();
  });

  it('returns failure after exceeding in-memory limit (15/min)', async () => {
    const id = 'exceed-limit-test';
    for (let i = 0; i < 15; i++) {
      const r = await checkRateLimit(null, id);
      expect(r.success).toBe(true);
    }
    const denied = await checkRateLimit(null, id);
    expect(denied.success).toBe(false);
    expect(denied.limit).toBe(15);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfter).toBeGreaterThan(0);
  });

  it('returns success with metadata when Redis limiter succeeds', async () => {
    const mockLimiter = {
      limit: jest.fn().mockResolvedValue({
        success: true,
        limit: 10,
        remaining: 9,
        reset: Date.now() + 60000,
      }),
    };
    const result = await checkRateLimit(mockLimiter as unknown as Ratelimit, 'redis-success');
    expect(result.success).toBe(true);
    expect(result.limit).toBe(10);
    expect(result.remaining).toBe(9);
    expect(result.reset).toBeDefined();
    expect(result.retryAfter).toBeUndefined();
  });

  it('returns retryAfter when Redis limiter denies', async () => {
    const resetTime = Date.now() + 30000;
    const mockLimiter = {
      limit: jest.fn().mockResolvedValue({
        success: false,
        limit: 10,
        remaining: 0,
        reset: resetTime,
      }),
    };
    const result = await checkRateLimit(mockLimiter as unknown as Ratelimit, 'redis-denied');
    expect(result.success).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(result.remaining).toBe(0);
  });

  it('falls back to in-memory when Redis .limit() throws', async () => {
    const mockLimiter = {
      limit: jest.fn().mockRejectedValue(new Error('Redis connection failed')),
    };
    const result = await checkRateLimit(mockLimiter as unknown as Ratelimit, 'redis-error-fallback');
    expect(result.success).toBe(true);
  });
});

describe('getRateLimitHeaders', () => {
  it('returns both IETF and legacy headers when all fields present', () => {
    const resetMs = Date.now() + 60_000;
    const headers = getRateLimitHeaders({
      limit: 10,
      remaining: 5,
      reset: resetMs,
      retryAfter: 30,
    });
    expect(headers['RateLimit-Limit']).toBe('10');
    expect(headers['RateLimit-Remaining']).toBe('5');
    expect(headers['RateLimit-Reset']).toMatch(/^\d+$/);
    expect(headers['X-RateLimit-Limit']).toBe('10');
    expect(headers['X-RateLimit-Remaining']).toBe('5');
    expect(headers['X-RateLimit-Reset']).toBe(String(resetMs));
    expect(headers['Retry-After']).toBe('30');
  });

  it('emits RateLimit-Reset as delta-seconds (ietf), X- form as unix-ms', () => {
    const now = Date.now();
    const future = now + 90_000;
    const headers = getRateLimitHeaders({ reset: future });
    const delta = Number(headers['RateLimit-Reset']);
    expect(delta).toBeGreaterThanOrEqual(89);
    expect(delta).toBeLessThanOrEqual(91);
    expect(headers['X-RateLimit-Reset']).toBe(String(future));
  });

  it('includes Roost-Rate-Limited-Reason when reason supplied', () => {
    const headers = getRateLimitHeaders({ retryAfter: 5, reason: 'key-rate' });
    expect(headers['Roost-Rate-Limited-Reason']).toBe('key-rate');
  });

  it('omits Roost-Rate-Limited-Reason when reason unspecified', () => {
    const headers = getRateLimitHeaders({ limit: 10 });
    expect(headers).not.toHaveProperty('Roost-Rate-Limited-Reason');
  });

  it('omits undefined fields from headers', () => {
    const headers = getRateLimitHeaders({ limit: 10 });
    expect(headers['RateLimit-Limit']).toBe('10');
    expect(headers['X-RateLimit-Limit']).toBe('10');
    expect(headers).not.toHaveProperty('RateLimit-Remaining');
    expect(headers).not.toHaveProperty('RateLimit-Reset');
    expect(headers).not.toHaveProperty('Retry-After');
  });
});
