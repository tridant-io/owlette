/** @jest-environment node */

/**
 * Alert-email HTML safety + the "manage alerts" footer.
 *
 * Stored-injection guard: alert emails interpolate operator-controlled free text
 * (the site name), which must be HTML-escaped or a malicious value renders
 * phishing markup in every co-recipient's inbox.
 */

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/resendClient.server', () => ({
  ENV_LABEL: 'DEVELOPMENT',
  isProduction: false,
}));

import {
  escapeHtml,
  safeEmailSubject,
  emailDataTable,
  wrapEmailLayout,
  buildDisplayDigestEmail,
  buildEmailVerificationEmail,
  buildIssueEmail,
  buildPasswordResetEmail,
  type IssueEmailInput,
  type PendingDisplayAlert,
} from '@/lib/emailTemplates.server';

const issueInput = (over: Partial<IssueEmailInput> = {}): IssueEmailInput => ({
  number: 42,
  categoryLabel: 'something broke',
  title: 'viewer goes black',
  text: 'the picture stayed black.\nreopening fixed it.',
  from: 'dana@studio.example',
  host: 'LOBBY-PC-01',
  siteId: 'downtown-gallery',
  appVersion: '4.1.13',
  source: 'agent',
  envLabel: 'DEVELOPMENT',
  attachments: { screenshots: 3, videos: 1, logs: true },
  issueUrl: 'https://dev.owlette.app/admin/issues/42',
  ...over,
});

const displayAlert = (over: Partial<PendingDisplayAlert> = {}): PendingDisplayAlert => ({
  docId: 'd',
  siteId: 's',
  machineId: 'm',
  eventType: 'display_monitor_removed',
  data: {},
  agentVersion: '3.0.0',
  correlatedApplyId: '',
  timestamp: null,
  ...over,
});

describe('escapeHtml', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('leaves clean text untouched', () => {
    expect(escapeHtml('TEC (default_site)')).toBe('TEC (default_site)');
  });
});

describe('alert-email value escaping (stored-injection regression)', () => {
  it('emailDataTable escapes dynamic values', () => {
    const html = emailDataTable([{ label: 'site', value: '<img src=x onerror=alert(1)>' }]);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('buildDisplayDigestEmail escapes a malicious site name', () => {
    const alert: PendingDisplayAlert = {
      docId: 'd',
      siteId: 's',
      machineId: 'm',
      eventType: 'display_monitor_removed',
      data: {},
      agentVersion: '3.0.0',
      correlatedApplyId: '',
      timestamp: null,
    };
    const html = buildDisplayDigestEmail('<script>evil</script> (s)', [alert], undefined, 'UTC');
    expect(html).not.toContain('<script>evil');
    expect(html).toContain('&lt;script&gt;evil');
  });
});

describe('multi-alert display digest escaping', () => {
  it('escapes machineId in the multi-alert digest table (not just single-alert)', () => {
    const alerts = [
      displayAlert({ machineId: '<img src=x onerror=alert(1)>' }),
      displayAlert({ machineId: 'm2' }),
    ];
    const html = buildDisplayDigestEmail('TEC (s)', alerts, undefined, 'UTC');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});

describe('wrapEmailLayout — manage alerts / unsubscribe footer', () => {
  it('shows "manage alerts" on EVERY alert email — including the tokenless fallback (unsubscribeUrl undefined)', () => {
    // The fallback admin has no per-user token but must still be able to turn
    // alerts off; the key being PRESENT (even undefined) marks an alert email.
    const fallback = wrapEmailLayout('<p>x</p>', { unsubscribeUrl: undefined });
    expect(fallback).toContain('manage alerts');
    expect(fallback).toContain('/settings/alerts');
    expect(fallback).not.toContain('unsubscribe'); // no token → no one-click

    const withToken = wrapEmailLayout('<p>x</p>', {
      unsubscribeUrl: 'https://dev.owlette.app/api/unsubscribe?token=t',
    });
    expect(withToken).toContain('manage alerts');
    expect(withToken).toContain('unsubscribe');
  });

  it('does NOT show manage/unsubscribe on transactional emails (no unsubscribeUrl key)', () => {
    const transactional = wrapEmailLayout('<p>x</p>', { preheader: 'reset your password' });
    expect(transactional).not.toContain('manage alerts');
    expect(transactional).not.toContain('unsubscribe');
  });

  it('uses the simplified footer — no tagline, tridant attribution, or boilerplate', () => {
    const html = wrapEmailLayout('<p>x</p>', {
      unsubscribeUrl: 'https://dev.owlette.app/api/unsubscribe?token=t',
    });
    expect(html).not.toContain('keep your installation running');
    expect(html).not.toContain('is made by');
    expect(html).not.toContain('automated message');
    expect(html).toContain('owlette.app');
  });
});

describe('buildIssueEmail', () => {
  it('puts the env, number, category and title in the subject', () => {
    expect(buildIssueEmail(issueInput()).subject).toBe(
      '[DEVELOPMENT] issue #42 · something broke — viewer goes black',
    );
  });

  it('strips header-injection characters from the subject', () => {
    const { subject } = buildIssueEmail(issueInput({ title: 'broke\r\nBcc: evil@x' }));
    expect(subject).toBe('[DEVELOPMENT] issue #42 · something broke — broke Bcc: evil@x');
  });

  it('links one button to the issue page', () => {
    const { html } = buildIssueEmail(issueInput());
    expect(html).toContain('href="https://dev.owlette.app/admin/issues/42"');
    expect(html).toContain('>open issue #42</a>');
    expect(html.match(/<a href="https:\/\/dev\.owlette\.app\/admin\/issues/g)).toHaveLength(1);
  });

  it('escapes every user value', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { html } = buildIssueEmail(
      issueInput({
        title: evil,
        text: evil,
        from: evil,
        host: evil,
        siteId: evil,
        categoryLabel: evil,
        issueUrl: 'https://x/"><script>',
      }),
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('"><script>');
    expect(html).toContain('&lt;img src=x');
  });

  it('keeps line breaks in the text as <br>', () => {
    const { html } = buildIssueEmail(issueInput());
    expect(html).toContain('the picture stayed black.<br>reopening fixed it.');
  });

  it('cuts long text at about 600 characters with an ellipsis', () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const { html } = buildIssueEmail(issueInput({ text: words }));
    // the body paragraph, not the preheader
    const shown = html.match(/<p [^>]*>(word0 [^<]*)<\/p>/)?.[1] ?? '';
    expect(shown.endsWith('…')).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(601);
    expect(shown.length).toBeGreaterThan(480);
    // ends on a whole word
    expect(words.startsWith(`${shown.slice(0, -1)} `)).toBe(true);
    expect(html).not.toContain('word199');
  });

  it('leaves text under the limit whole', () => {
    const text = 'a'.repeat(600);
    const { html } = buildIssueEmail(issueInput({ text }));
    expect(html).toContain(text);
    expect(html).not.toContain(`${text}…`);
  });

  it('carries no system info or log tail', () => {
    const { html } = buildIssueEmail(issueInput());
    expect(html).not.toContain('--- system info ---');
    expect(html).not.toContain('--- recent logs');
    expect(html).not.toMatch(/system info|log tail/);
  });

  it('uses the first line of the text as the preheader', () => {
    const { html } = buildIssueEmail(issueInput({ text: '\n\nfirst line here\nsecond line' }));
    expect(html).toMatch(/<div style="display:none;[^>]*>first line here<\/div>/);
  });

  it('summarises attachments on one line, and omits the row when there are none', () => {
    expect(buildIssueEmail(issueInput()).html).toContain('logs, 3 screenshots and 1 video');
    expect(
      buildIssueEmail(issueInput({ attachments: { screenshots: 1, videos: 0, logs: false } })).html,
    ).toContain('>1 screenshot<');
    const none = buildIssueEmail(
      issueInput({ attachments: { screenshots: 0, videos: 0, logs: false } }),
    ).html;
    expect(none).not.toContain('attached');
  });

  it('uses the shared button, which carries the Outlook fix', () => {
    const { html } = buildIssueEmail(issueInput());
    expect(html).toContain(
      '<td bgcolor="#00bcd4" style="border-radius:6px;background:#00bcd4;mso-padding-alt:12px 28px;"><a href="https://dev.owlette.app/admin/issues/42"',
    );
  });

  it('omits the machine and site facts a web issue does not have', () => {
    const { html } = buildIssueEmail(issueInput({ host: null, siteId: null, source: 'web' }));
    expect(html).not.toContain('>machine<');
    expect(html).not.toContain('>site<');
    expect(html).toContain('dashboard · 4.1.13');
  });
});

describe('transactional email buttons', () => {
  it.each([
    ['password reset', buildPasswordResetEmail('https://dev.owlette.app/reset-password?oobCode=x')],
    ['email verification', buildEmailVerificationEmail('https://dev.owlette.app/verify-email?oobCode=x')],
  ])('the %s button carries bgcolor and mso-padding-alt for Outlook', (_name, html) => {
    expect(html).toContain(
      '<td bgcolor="#00bcd4" style="border-radius:6px;background:#00bcd4;mso-padding-alt:12px 28px;"><a href="https://dev.owlette.app/',
    );
  });
});

describe('safeEmailSubject', () => {
  it('strips CR/LF/control chars, collapses whitespace, preserves hyphens', () => {
    expect(safeEmailSubject('offline in TEC-A4D\r\nBcc: evil@x')).toBe('offline in TEC-A4D Bcc: evil@x');
  });
  it('caps length at 200', () => {
    expect(safeEmailSubject('a'.repeat(500)).length).toBe(200);
  });
});
