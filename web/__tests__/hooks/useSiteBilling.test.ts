/**
 * @jest-environment jsdom
 *
 * `useSiteBilling` — the owner's changes to a site's billing. pins the verb,
 * path and body of each call, a change being sent once (never again at the list
 * price when the founders places ran out), a refusal coming back as the
 * problem's code and detail rather than a throw, and the site and account plans
 * reloading after a change that landed and not before.
 */

import { renderHook } from '@testing-library/react';

const mockRefreshAccount = jest.fn(async () => undefined);
const mockRefreshSite = jest.fn(async () => undefined);
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ plan: undefined, refresh: mockRefreshAccount }),
}));
jest.mock('@/hooks/useSitePlan', () => ({
  useSitePlan: () => ({ plan: undefined, refresh: mockRefreshSite }),
}));

import { useSiteBilling } from '@/hooks/useSiteBilling';

const fetchMock = jest.fn();

function answer(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const problem = (status: number, code: string, detail: string) => answer(status, { status, code, detail });

const BILLING = { tier: 'pro', founders: true, endsAt: null };

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

const billing = (siteId = 'site-a') => renderHook(() => useSiteBilling(siteId)).result.current;

function sent(call = 0): { url: string; method: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return { url, method: String(init.method), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) };
}

const refreshed = () => [mockRefreshSite.mock.calls.length, mockRefreshAccount.mock.calls.length];

describe('upgrade', () => {
  it("posts the plan and the rate to the site's billing, and hands back the checkout url without reloading", async () => {
    fetchMock.mockResolvedValue(answer(200, { checkoutUrl: 'https://checkout.example/c/1' }));

    const result = await billing('a/b c').upgrade('pro', true);

    expect(result).toEqual({ ok: true, checkoutUrl: 'https://checkout.example/c/1' });
    expect(sent()).toEqual({
      url: '/api/sites/a%2Fb%20c/billing',
      method: 'POST',
      body: { tier: 'pro', founders: true },
    });
    expect(refreshed()).toEqual([0, 0]);
  });

  it('reloads both plans when the site went straight onto the subscription', async () => {
    fetchMock.mockResolvedValue(answer(200, { added: true }));

    const result = await billing().upgrade('core', true);

    expect(result).toEqual({ ok: true, added: true });
    expect(refreshed()).toEqual([1, 1]);
  });

  // a second request at the list price would bill the card on file a price the owner never saw
  it('hands back the refusal when the founders places ran out, and asks nothing more', async () => {
    fetchMock
      .mockResolvedValueOnce(problem(409, 'founders_sold_out', 'the founders places for this plan are taken.'))
      .mockResolvedValueOnce(answer(200, { added: true }));

    expect(await billing().upgrade('pro', true)).toEqual({
      ok: false,
      status: 409,
      code: 'founders_sold_out',
      detail: 'the founders places for this plan are taken.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent().body).toEqual({ tier: 'pro', founders: true });
    expect(refreshed()).toEqual([0, 0]);
  });

  it("hands back a refusal's status, code and detail", async () => {
    fetchMock.mockResolvedValue(problem(409, 'link_required', 'your email already has a tridant account.'));

    expect(await billing().upgrade('pro', false)).toEqual({
      ok: false,
      status: 409,
      code: 'link_required',
      detail: 'your email already has a tridant account.',
    });
    expect(refreshed()).toEqual([0, 0]);
  });

  it('answers a refusal for a body that is not a problem, and for no answer at all', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    });
    expect(await billing().upgrade('pro', false)).toEqual({
      ok: false,
      status: 502,
      code: '',
      detail: 'the request failed (502).',
    });

    fetchMock.mockRejectedValueOnce(new TypeError('failed to fetch'));
    expect(await billing().upgrade('pro', false)).toEqual({
      ok: false,
      status: 0,
      code: '',
      detail: 'could not reach owlette. check your connection and try again.',
    });
  });
});

describe('switchTier', () => {
  it('patches the plan and the rate, hands back the billing and reloads both plans', async () => {
    fetchMock.mockResolvedValue(answer(200, { billing: BILLING }));

    const result = await billing().switchTier('pro', true);

    expect(result).toEqual({ ok: true, billing: BILLING });
    expect(sent()).toEqual({ url: '/api/sites/site-a/billing', method: 'PATCH', body: { tier: 'pro', founders: true } });
    expect(refreshed()).toEqual([1, 1]);
  });

  it('hands back the refusal when the founders places ran out, and asks nothing more', async () => {
    fetchMock
      .mockResolvedValueOnce(problem(409, 'founders_sold_out', 'taken.'))
      .mockResolvedValueOnce(answer(200, { billing: { ...BILLING, founders: false } }));

    expect(await billing().switchTier('pro', true)).toMatchObject({ ok: false, code: 'founders_sold_out' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshed()).toEqual([0, 0]);
  });

  it('reloads nothing when it is refused', async () => {
    fetchMock.mockResolvedValue(problem(409, 'billed_by_previous_owner', 'billed to its previous owner.'));

    expect(await billing().switchTier('core', false)).toMatchObject({ ok: false, code: 'billed_by_previous_owner' });
    expect(refreshed()).toEqual([0, 0]);
  });
});

describe('stop', () => {
  it('deletes with no body, hands back the billing with its end and reloads both plans', async () => {
    const stopped = { ...BILLING, endsAt: 1_800_000_000_000 };
    fetchMock.mockResolvedValue(answer(200, { billing: stopped }));

    const result = await billing().stop();

    expect(result).toEqual({ ok: true, billing: stopped });
    expect(sent()).toEqual({ url: '/api/sites/site-a/billing', method: 'DELETE', body: undefined });
    expect(refreshed()).toEqual([1, 1]);
  });

  it('reloads nothing when it is refused', async () => {
    fetchMock.mockResolvedValue(problem(503, 'billing_unavailable', 'billing is not available right now.'));

    expect(await billing().stop()).toEqual({
      ok: false,
      status: 503,
      code: 'billing_unavailable',
      detail: 'billing is not available right now.',
    });
    expect(refreshed()).toEqual([0, 0]);
  });

  // the server closed owlette's record of billing tridant id had already ended, so the section reloads
  // to offer an upgrade.
  it.each([
    ['stop', () => billing().stop()],
    ['switch', () => billing().switchTier('core', false)],
  ])('reloads both plans when a %s finds the site no longer billed', async (_verb, call) => {
    const detail = 'this site is no longer billed: its billing has ended. upgrade it to put it on core or pro again.';
    fetchMock.mockResolvedValue(problem(404, 'not_billed', detail));

    expect(await call()).toEqual({ ok: false, status: 404, code: 'not_billed', detail });
    expect(refreshed()).toEqual([1, 1]);
  });
});

describe('confirmCheckout', () => {
  it('asks about the session, and reloads both plans once it is complete', async () => {
    fetchMock.mockResolvedValue(answer(200, { status: 'complete', siteId: 'site-a', tier: 'pro' }));

    const result = await billing().confirmCheckout('cs_test_1');

    expect(result).toEqual({ ok: true, status: 'complete', tier: 'pro' });
    expect(sent()).toMatchObject({ url: '/api/billing/checkout/cs_test_1', method: 'GET', body: undefined });
    expect(refreshed()).toEqual([1, 1]);
  });

  it.each(['pending', 'failed'] as const)('reloads nothing while it is %s', async (status) => {
    fetchMock.mockResolvedValue(answer(200, { status, siteId: 'site-a', tier: 'core' }));

    expect(await billing().confirmCheckout('cs_test_1')).toEqual({ ok: true, status, tier: 'core' });
    expect(refreshed()).toEqual([0, 0]);
  });

  it("hands back the refusal for someone else's checkout", async () => {
    fetchMock.mockResolvedValue(problem(404, 'not_found', 'checkout not found'));

    expect(await billing().confirmCheckout('cs_other')).toEqual({
      ok: false,
      status: 404,
      code: 'not_found',
      detail: 'checkout not found',
    });
  });
});
