import { NextRequest, NextResponse } from 'next/server';
import { ApiAuthError, requireAdmin } from '@/lib/apiAuth.server';
import { getResend, FROM_EMAIL, ENV_LABEL, isProduction, trustedBaseUrl } from '@/lib/resendClient.server';
import { apiError } from '@/lib/apiErrorResponse';
import {
  wrapEmailLayout,
  emailDataTable,
  emailTimestamp,
  buildApiKeyExpiryEmail,
  buildIssueEmail,
  EMAIL_COLORS,
  SEVERITY_COLORS,
  METRIC_LABELS,
} from '@/lib/emailTemplates.server';

const ADMIN_EMAIL = isProduction
  ? process.env.ADMIN_EMAIL_PROD
  : process.env.ADMIN_EMAIL_DEV;

/* Template types */

export const EMAIL_TEMPLATES = [
  { id: 'test', label: 'test email', description: 'generic config verification' },
  { id: 'process_crash', label: 'process crashed', description: 'monitored process stopped unexpectedly' },
  { id: 'process_start_failed', label: 'process failed to start', description: 'monitored process could not be launched' },
  { id: 'agent_alert', label: 'agent connection failure', description: 'agent lost connection to cloud' },
  { id: 'threshold_alert', label: 'threshold alert', description: 'metric breached a configured threshold' },
  { id: 'machines_offline', label: 'machines offline', description: 'stale heartbeat detected by health check' },
  { id: 'cortex_escalation', label: 'hoot escalation', description: 'autonomous investigation could not resolve issue' },
  { id: 'api_key_expiring', label: 'api key expiring', description: 'daily notice ladder before an api key expires' },
  { id: 'issue', label: 'new issue', description: 'owlette support notified of a submitted issue' },
  { id: 'welcome', label: 'welcome email', description: 'sent to new users on signup' },
  { id: 'user_signup', label: 'admin signup notification', description: 'admin notified of new user registration' },
] as const;

export type EmailTemplateId = (typeof EMAIL_TEMPLATES)[number]['id'];

/* Sample data builders */

function buildTemplateEmail(templateId: string): { subject: string; html: string } {
  const ts = emailTimestamp(new Date(), 'America/New_York');

  switch (templateId) {
    case 'process_crash': {
      const content = `
        <h2 style="color:${EMAIL_COLORS.red};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">process crashed: TouchDesigner</h2>
        <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">a monitored process has crashed on one of your machines.</p>
        ${emailDataTable([
          { label: 'site', value: 'downtown-gallery' },
          { label: 'machine', value: 'LOBBY-PC-01' },
          { label: 'process', value: 'TouchDesigner' },
          { label: 'event', value: 'crashed' },
          { label: 'error', value: 'Process stopped unexpectedly (PID 12408 no longer running)' },
          { label: 'agent version', value: '2.4.1' },
          { label: 'time', value: ts },
          { label: 'environment', value: ENV_LABEL },
        ])}
        <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">please check the machine and service logs for more details.</p>
      `;
      return {
        subject: `process crashed: TouchDesigner on LOBBY-PC-01`,
        html: wrapEmailLayout(content, { preheader: 'process crashed: TouchDesigner on LOBBY-PC-01', unsubscribeUrl: '#unsubscribe-preview' }),
      };
    }

    case 'process_start_failed': {
      const content = `
        <h2 style="color:${EMAIL_COLORS.red};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">process failed to start: Resolume Arena</h2>
        <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">a monitored process has failed to start on one of your machines.</p>
        ${emailDataTable([
          { label: 'site', value: 'main-stage' },
          { label: 'machine', value: 'STAGE-PC-03' },
          { label: 'process', value: 'Resolume Arena' },
          { label: 'event', value: 'failed to start' },
          { label: 'error', value: 'Executable not found at configured path' },
          { label: 'agent version', value: '2.4.1' },
          { label: 'time', value: ts },
          { label: 'environment', value: ENV_LABEL },
        ])}
        <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">please check the machine and service logs for more details.</p>
      `;
      return {
        subject: `process failed to start: Resolume Arena on STAGE-PC-03`,
        html: wrapEmailLayout(content, { preheader: 'process failed to start: Resolume Arena on STAGE-PC-03', unsubscribeUrl: '#unsubscribe-preview' }),
      };
    }

    case 'agent_alert': {
      const content = `
        <h2 style="color:${EMAIL_COLORS.red};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">agent alert</h2>
        <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">an error was detected on an owlette agent.</p>
        ${emailDataTable([
          { label: 'site', value: 'downtown-gallery' },
          { label: 'machine', value: 'KIOSK-02' },
          { label: 'error code', value: 'CONN_TIMEOUT' },
          { label: 'message', value: 'Failed to reach Firestore after 5 retries' },
          { label: 'agent version', value: '2.4.1' },
          { label: 'time', value: ts },
          { label: 'environment', value: ENV_LABEL },
        ])}
        <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">please check the machine and service logs for more details.</p>
      `;
      return {
        subject: `[ALERT] owlette agent error on KIOSK-02`,
        html: wrapEmailLayout(content, { unsubscribeUrl: '#unsubscribe-preview' }),
      };
    }

    case 'threshold_alert': {
      const severity = 'critical';
      const color = SEVERITY_COLORS[severity];
      const metricLabel = METRIC_LABELS['cpu_percent'];
      const content = `
        <h2 style="color:${color};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">threshold alert: high CPU usage</h2>
        <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">a metric threshold has been breached on one of your machines.</p>
        ${emailDataTable([
          { label: 'site', value: 'render-farm' },
          { label: 'machine', value: 'RENDER-NODE-01' },
          { label: 'rule', value: 'High CPU Usage' },
          { label: 'metric', value: metricLabel },
          { label: 'condition', value: `${metricLabel} > 90` },
          { label: 'current value', value: '97.3', highlight: color },
          { label: 'severity', value: 'CRITICAL', highlight: color },
          { label: 'time', value: ts },
          { label: 'environment', value: ENV_LABEL },
        ])}
        <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">please check the machine and service metrics for more details.</p>
      `;
      return {
        subject: `[CRITICAL] high CPU usage — RENDER-NODE-01`,
        html: wrapEmailLayout(content, { preheader: 'CRITICAL: high CPU usage on RENDER-NODE-01', unsubscribeUrl: '#unsubscribe-preview' }),
      };
    }

    case 'machines_offline': {
      const machines = [
        { id: 'LOBBY-PC-01', minutes: 12 },
        { id: 'KIOSK-02', minutes: 7 },
      ];
      const rows = machines
        .map(
          (m) => `
          <tr>
            <td style="padding:10px 14px;color:${EMAIL_COLORS.text};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${m.id}</td>
            <td style="padding:10px 14px;color:${EMAIL_COLORS.muted};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${m.minutes} minute(s) ago</td>
          </tr>`
        )
        .join('');

      const content = `
        <h2 style="color:${EMAIL_COLORS.red};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">machines offline</h2>
        <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">2 machine(s) in site <strong style="color:${EMAIL_COLORS.text};">downtown-gallery</strong> appear to be offline.</p>
        <table width="100%" style="border-collapse:collapse;border:1px solid ${EMAIL_COLORS.border};border-radius:6px;overflow:hidden;" cellpadding="0" cellspacing="0">
          <thead>
            <tr>
              <th style="padding:10px 14px;text-align:left;background:${EMAIL_COLORS.altRow};color:${EMAIL_COLORS.muted};font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid ${EMAIL_COLORS.border};">machine</th>
              <th style="padding:10px 14px;text-align:left;background:${EMAIL_COLORS.altRow};color:${EMAIL_COLORS.muted};font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid ${EMAIL_COLORS.border};">last seen</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">please check each machine and verify that the owlette service is running.</p>
        <p style="margin:8px 0 0;color:${EMAIL_COLORS.border};font-size:11px;">alerts are sent at most once per hour per machine.</p>
      `;
      return {
        subject: `2 machine(s) offline in downtown-gallery`,
        html: wrapEmailLayout(content, { preheader: '2 machine(s) offline in downtown-gallery', unsubscribeUrl: '#unsubscribe-preview' }),
      };
    }

    case 'cortex_escalation': {
      const sampleReport = `Investigating process crash: TouchDesigner on LOBBY-PC-01\n\n1. Checked process status — confirmed not running (PID 12408 terminated)\n2. Reviewed recent Windows Event Log — found application error 1000\n3. Attempted restart via configured path — process started but exited after 3s\n4. Checked disk space — 2.1 GB free (low)\n5. Unable to resolve automatically — disk space may be root cause\n\nRecommendation: Free disk space on LOBBY-PC-01 and restart TouchDesigner manually.`;

      const escapedReport = sampleReport
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');

      const content = `
        <h2 style="color:${EMAIL_COLORS.amber};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">hoot escalation: TouchDesigner</h2>
        <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">owlette hoot investigated an issue autonomously but was unable to resolve it. human attention is needed.</p>
        ${emailDataTable([
          { label: 'site', value: 'downtown-gallery' },
          { label: 'machine', value: 'LOBBY-PC-01' },
          { label: 'process', value: 'TouchDesigner' },
          { label: 'event id', value: 'evt_abc123def456' },
          { label: 'time', value: ts },
          { label: 'environment', value: ENV_LABEL },
        ])}
        <h3 style="color:${EMAIL_COLORS.cyan};margin:24px 0 12px;font-size:15px;font-weight:600;text-transform:lowercase;">hoot investigation report</h3>
        <div style="background:${EMAIL_COLORS.bodyBg};border:1px solid ${EMAIL_COLORS.border};padding:14px;border-radius:6px;font-family:'Courier New',Courier,monospace;font-size:12px;line-height:1.6;color:${EMAIL_COLORS.muted};overflow:auto;">
          ${escapedReport}
        </div>
        <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">review the autonomous conversation in the hoot dashboard for full details.</p>
      `;
      return {
        subject: `hoot escalation: TouchDesigner on LOBBY-PC-01`,
        html: wrapEmailLayout(content, { preheader: 'hoot escalation: TouchDesigner on LOBBY-PC-01', unsubscribeUrl: '#unsubscribe-preview' }),
      };
    }

    case 'api_key_expiring': {
      // Renders through the real builder rather than a hand-copied body, so the
      // preview cannot drift from what the cron actually sends.
      const day = 24 * 60 * 60 * 1000;
      return {
        subject: `2 api keys expiring`,
        html: buildApiKeyExpiryEmail(
          [
            { name: 'ci-deploy', keyPrefix: 'owk_live_9f2c1ab', expiresAt: Date.now() + 3 * day, daysRemaining: 3 },
            { name: 'grafana-readonly', keyPrefix: 'owk_live_4d80e17', expiresAt: Date.now() + 14 * day, daysRemaining: 14 },
          ],
          '#unsubscribe-preview',
          'America/New_York',
        ),
      };
    }

    case 'issue': {
      // the real builder, so the preview cannot drift from what bug-report sends
      return buildIssueEmail({
        number: 42,
        categoryLabel: 'something broke',
        title: 'swoop viewer goes black after the machine reconnects',
        text:
          'we lost wifi in the lobby for about a minute this morning. when LOBBY-PC-01 came back online the swoop viewer reconnected but the picture stayed black, even though the status said connected and the cursor still moved.\n\n' +
          'closing the viewer and opening it again fixed it straight away. it happened twice today, both times right after the network dropped. the installation itself kept running fine, it is only the remote view.\n\n' +
          'steps: 1. open swoop on LOBBY-PC-01 2. pull the network cable for 30 seconds 3. plug it back in. the viewer says connected, the picture never comes back. happy to send more logs if that helps.',
        from: 'dana@studio.example',
        host: 'LOBBY-PC-01',
        siteId: 'downtown-gallery',
        appVersion: '4.1.13',
        source: 'agent',
        envLabel: ENV_LABEL,
        attachments: { screenshots: 3, videos: 1, logs: true },
        issueUrl: `${trustedBaseUrl()}/admin/issues/42`,
      });
    }

    case 'welcome': {
      const linkStyle = `color:${EMAIL_COLORS.cyan};text-decoration:none;font-weight:600;`;
      const content = `
        <h2 style="color:${EMAIL_COLORS.cyan};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">welcome to owlette</h2>
        <p style="margin:0 0 8px;">hi Demo User,</p>
        <p style="margin:0 0 24px;color:${EMAIL_COLORS.muted};">thanks for signing up. owlette is your cloud-connected process management system for managing Windows machines remotely.</p>
        <h3 style="color:${EMAIL_COLORS.cyan};margin:0 0 14px;font-size:15px;font-weight:600;text-transform:lowercase;">getting started</h3>
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
          <tr><td style="padding:8px 0;color:${EMAIL_COLORS.text};font-size:14px;">
            <span style="color:${EMAIL_COLORS.cyan};font-weight:700;margin-right:8px;">1.</span> create your first site in the <a href="https://owlette.app/dashboard" style="${linkStyle}">dashboard</a>
          </td></tr>
          <tr><td style="padding:8px 0;color:${EMAIL_COLORS.text};font-size:14px;">
            <span style="color:${EMAIL_COLORS.cyan};font-weight:700;margin-right:8px;">2.</span> <a href="https://owlette.app/download" style="${linkStyle}">download</a> and install the owlette agent on your machines
          </td></tr>
          <tr><td style="padding:8px 0;color:${EMAIL_COLORS.text};font-size:14px;">
            <span style="color:${EMAIL_COLORS.cyan};font-weight:700;margin-right:8px;">3.</span> <a href="https://owlette.app/docs/agent/process-monitoring" style="${linkStyle}">configure processes</a> to monitor
          </td></tr>
        </table>
        <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">need help? check the <a href="https://owlette.app/docs" style="${linkStyle}">docs</a> or reach out to our support team.</p>
      `;
      return {
        subject: 'welcome to owlette',
        html: wrapEmailLayout(content),
      };
    }

    case 'user_signup': {
      const content = `
        <h2 style="color:${EMAIL_COLORS.cyan};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">new user registration</h2>
        <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">a new user has signed up on owlette.</p>
        ${emailDataTable([
          { label: 'name', value: 'Demo User' },
          { label: 'email', value: 'demo@example.com' },
          { label: 'sign-in method', value: 'Google OAuth' },
          { label: 'registered at', value: ts },
          { label: 'environment', value: ENV_LABEL },
        ])}
      `;
      return {
        subject: `new owlette user signup`,
        html: wrapEmailLayout(content),
      };
    }

    // Default: generic test email
    default: {
      const content = `
        <h2 style="color:${EMAIL_COLORS.cyan};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">email test successful</h2>
        <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">this is a test email from your owlette <strong style="color:${EMAIL_COLORS.text};">${ENV_LABEL.toLowerCase()}</strong> environment.</p>
        ${emailDataTable([
          { label: 'from', value: FROM_EMAIL },
          { label: 'environment', value: ENV_LABEL },
          { label: 'sent at', value: ts },
        ])}
      `;
      return {
        subject: `owlette email test`,
        html: wrapEmailLayout(content),
      };
    }
  }
}

/* Route handler */

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);

    const resendClient = getResend();
    if (!resendClient) {
      return NextResponse.json(
        { error: 'RESEND_API_KEY not configured' },
        { status: 500 }
      );
    }

    if (!ADMIN_EMAIL) {
      return NextResponse.json(
        { error: `ADMIN_EMAIL not configured for ${isProduction ? 'production' : 'development'}` },
        { status: 500 }
      );
    }

    // Parse request body
    let bodyTo: string | string[] | undefined;
    let bodyCc: string[] | undefined;
    let templateId = 'test';
    try {
      const body = await request.json();
      if (body.to) bodyTo = Array.isArray(body.to) ? body.to : [body.to];
      if (body.cc) bodyCc = Array.isArray(body.cc) ? body.cc : [body.cc];
      if (body.template && typeof body.template === 'string') templateId = body.template;
    } catch {
      // No body or invalid JSON — use defaults
    }

    const toAddresses = bodyTo || [ADMIN_EMAIL];
    const { subject, html } = buildTemplateEmail(templateId);

    const result = await resendClient.emails.send({
      from: FROM_EMAIL,
      to: toAddresses,
      ...(bodyCc && bodyCc.length > 0 ? { cc: bodyCc } : {}),
      subject,
      html,
    });

    if (result.error) {
      return NextResponse.json(
        { success: false, error: 'Resend API error', details: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Test email sent successfully',
      emailId: result.data?.id,
      template: templateId,
      from: FROM_EMAIL,
      to: toAddresses,
      ...(bodyCc ? { cc: bodyCc } : {}),
      environment: ENV_LABEL,
      timestamp: emailTimestamp(new Date(), 'America/New_York'),
    });

  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'test-email');
  }
}
