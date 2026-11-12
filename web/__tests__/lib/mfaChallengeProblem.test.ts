/** @jest-environment node */

import { apiError } from '@/lib/apiErrorResponse';
import { mfaChallengeProblem } from '@/lib/apiErrors';

const refusal = Object.assign(new Error('complete two-factor verification first'), {
  code: 'mfa_challenge_required',
  status: 403,
});

describe('mfaChallengeProblem', () => {
  it('answers 403 with the code the client keys off', async () => {
    const res = mfaChallengeProblem(refusal);
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({
      code: 'mfa_challenge_required',
      detail: 'complete two-factor verification first',
    });
  });

  it('answers 403 with its code for an account that has to set up a factor', async () => {
    const res = mfaChallengeProblem({ code: 'mfa_setup_required', message: 'set up two-factor authentication first' });
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({ code: 'mfa_setup_required' });
  });

  it.each([[new Error('other')], [{ code: 'user_inactive' }], [null], [undefined], ['text']])(
    'leaves anything else alone: %p',
    (err) => {
      expect(mfaChallengeProblem(err)).toBeNull();
    },
  );

  it('is what apiError answers for a route with no auth branch of its own', async () => {
    const res = apiError(refusal, 'test');
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('mfa_challenge_required');
  });
});
