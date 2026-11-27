/** @jest-environment node */

/**
 * The one way every site alert sender emails a recipient on "as it happens":
 * their own unsubscribe link (none for the ADMIN_EMAIL fallback), their cc list,
 * and RFC 8058 one-click headers only on a copy nobody else receives.
 */

const mockSend = jest.fn();
let mockResend: { emails: { send: jest.Mock } } | null = null;
jest.mock('@/lib/resendClient.server', () => ({
  getResend: () => mockResend,
  FROM_EMAIL: 'owlette <alerts@owlette.test>',
  ENV_LABEL: 'TEST',
  isProduction: false,
}));
jest.mock('@/app/api/unsubscribe/route', () => ({ generateUnsubscribeToken: (uid: string) => `tok-${uid}` }));

import { sendAlertEmailNow } from '@/lib/alerts/sendNow.server';
import type { SiteRecipient } from '@/lib/adminUtils.server';

const recipient = (over: Partial<SiteRecipient> = {}): SiteRecipient => ({
  userId: 'u1',
  email: 'u1@example.test',
  ccEmails: [],
  mutedMachines: [],
  machineIds: null,
  delivery: 'immediate',
  ...over,
});

const send = (r: SiteRecipient) =>
  sendAlertEmailNow({
    log: '[test]',
    recipient: r,
    baseUrl: 'https://owlette.test',
    subject: 'machines offline',
    html: (unsubscribeUrl) => `<p>${unsubscribeUrl ?? 'no link'}</p>`,
  });

beforeEach(() => {
  mockSend.mockReset().mockResolvedValue({ error: null });
  mockResend = { emails: { send: mockSend } };
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

it('sends with the recipient’s own unsubscribe link and one-click headers', async () => {
  expect(await send(recipient())).toBe(true);
  expect(mockSend).toHaveBeenCalledWith({
    from: 'owlette <alerts@owlette.test>',
    to: ['u1@example.test'],
    subject: 'machines offline',
    html: '<p>https://owlette.test/api/unsubscribe?token=tok-u1</p>',
    headers: {
      'List-Unsubscribe': '<https://owlette.test/api/unsubscribe?token=tok-u1>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
});

it('copies the cc list and leaves the one-click headers off', async () => {
  await send(recipient({ ccEmails: ['colleague@example.test'] }));
  const [mail] = mockSend.mock.calls[0];
  expect(mail.cc).toEqual(['colleague@example.test']);
  expect(mail).not.toHaveProperty('headers');
  // the link in the body stays: it opens the confirm page, which asks first
  expect(mail.html).toContain('/api/unsubscribe?token=tok-u1');
});

it('gives the ADMIN_EMAIL fallback no unsubscribe link and no headers', async () => {
  await send(recipient({ userId: 'fallback', email: 'admin@owlette.test' }));
  const [mail] = mockSend.mock.calls[0];
  expect(mail.html).toBe('<p>no link</p>');
  expect(mail).not.toHaveProperty('headers');
});

it('reports a Resend error, and Resend not configured, as not sent', async () => {
  mockSend.mockResolvedValueOnce({ error: { name: 'validation_error', statusCode: 422 } });
  expect(await send(recipient())).toBe(false);

  mockResend = null;
  expect(await send(recipient())).toBe(false);
});
