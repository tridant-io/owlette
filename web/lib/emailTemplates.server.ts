/**
 * Shared branded email layout and helpers. Server-side only — never import in a client
 * component. Every Owlette email goes through wrapEmailLayout() for a consistent
 * dark-themed look matching the dashboard.
 */

import { ENV_LABEL, isProduction } from '@/lib/resendClient.server';

// Color palette (OKLCH dashboard values → email-safe hex)

export const EMAIL_COLORS = {
  bodyBg: '#141726',
  cardBg: '#1e2235',
  altRow: '#262b40',
  border: '#343a56',
  muted: '#9ba2b8',
  text: '#f5f6fa',
  cyan: '#00bcd4',
  amber: '#d4a017',
  red: '#e53935',
  blue: '#42a5f5',
} as const;

// Severity + metric maps (moved from alerts/trigger/route.ts)

export const SEVERITY_COLORS: Record<string, string> = {
  info: EMAIL_COLORS.blue,
  warning: EMAIL_COLORS.amber,
  critical: EMAIL_COLORS.red,
};

export const METRIC_LABELS: Record<string, string> = {
  cpu_percent: 'CPU Usage (%)',
  memory_percent: 'Memory Usage (%)',
  disk_percent: 'Disk Usage (%)',
  gpu_percent: 'GPU Usage (%)',
  cpu_temp: 'CPU Temperature (\u00B0C)',
  gpu_temp: 'GPU Temperature (\u00B0C)',
  network_latency: 'Network Latency (ms)',
  network_packet_loss: 'Packet Loss (%)',
};

/**
 * Escape a dynamic value before interpolating it into email HTML. Alert emails carry
 * operator/admin-controlled free text (site, machine, process names, error messages) —
 * escaping stops stored markup (phishing links, broken layout) rendering for recipients.
 */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitize a value used as an email Subject. Subjects are plain text (Resend
 * JSON-serializes them), so HTML escaping is wrong — collapse CR/LF and other control
 * characters (header-injection-shaped values) and cap the length instead.
 */
export function safeEmailSubject(value: string): string {
  let out = '';
  for (const ch of String(value)) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 200);
}

interface DataRow {
  label: string;
  value: string;
  /** Optional color override for the value cell (e.g. severity color). */
  highlight?: string;
}

/** Build a styled two-column key-value table for email content. */
export function emailDataTable(rows: DataRow[]): string {
  const trs = rows
    .map(
      (r) => {
        const valColor = r.highlight || EMAIL_COLORS.text;
        // Span wrapper overrides email-client auto-link styling.
        const valHtml = `<span style="color:${valColor};${r.highlight ? 'font-weight:700;' : ''}">${escapeHtml(r.value)}</span>`;
        return `<tr><td style="padding:10px 14px;font-weight:600;color:${EMAIL_COLORS.muted};background:${EMAIL_COLORS.altRow};border-bottom:1px solid ${EMAIL_COLORS.border};white-space:nowrap;font-size:13px;">${r.label}</td><td style="padding:10px 14px;color:${valColor};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${valHtml}</td></tr>`;
      }
    )
    .join('');

  return `<table width="100%" style="border-collapse:collapse;border:1px solid ${EMAIL_COLORS.border};border-radius:6px;overflow:hidden;" cellpadding="0" cellspacing="0">${trs}</table>`;
}

interface EmailLayoutOptions {
  /** Show the environment badge in the header (default: true). */
  showEnvBadge?: boolean;
  /** If provided, adds an unsubscribe link in the footer. */
  unsubscribeUrl?: string;
  /** Hidden preheader text shown in inbox preview. */
  preheader?: string;
}

/**
 * Wrap email body content in the branded Owlette layout: dark outer bg → 600px card →
 * header (logo + brand) → content → footer. All CSS inline for email-client compatibility.
 */
export function wrapEmailLayout(content: string, options: EmailLayoutOptions = {}): string {
  const { showEnvBadge = true, unsubscribeUrl, preheader } = options;

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || (isProduction ? 'https://owlette.app' : 'https://dev.owlette.app');
  const logoUrl = `${baseUrl}/email-logo.png`;

  const envBadgeHtml = showEnvBadge
    ? `<td style="padding-left:10px;"><span style="display:inline-block;background:${isProduction ? EMAIL_COLORS.cyan : EMAIL_COLORS.amber};color:${EMAIL_COLORS.bodyBg};padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:0.5px;line-height:1;">${ENV_LABEL}</span></td>`
    : '';

  const preheaderHtml = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>`
    : '';

  // One-line footer actions: "manage alerts · unsubscribe". Passing the `unsubscribeUrl`
  // key AT ALL marks an alert email (alert senders always pass it, sometimes undefined for
  // the tokenless admin fallback; transactional emails never do). "manage alerts" shows on
  // every alert email; one-click unsubscribe only when we have a per-user token.
  const isAlertEmail = 'unsubscribeUrl' in options;
  const footerLinks: string[] = [];
  if (isAlertEmail) {
    footerLinks.push(`<a href="${baseUrl}/settings/alerts" style="color:${EMAIL_COLORS.cyan};text-decoration:underline;">manage alerts</a>`);
  }
  if (unsubscribeUrl) {
    footerLinks.push(`<a href="${unsubscribeUrl}" style="color:${EMAIL_COLORS.muted};text-decoration:underline;">unsubscribe</a>`);
  }
  const sep = `<span style="color:${EMAIL_COLORS.border};padding:0 6px;">·</span>`;
  const actionsHtml = footerLinks.length
    ? `<p style="margin:0 0 6px;font-size:12px;">${footerLinks.join(sep)}</p>`
    : '';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>owlette</title></head><body style="margin:0;padding:0;background-color:${EMAIL_COLORS.bodyBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;">${preheaderHtml}<table width="100%" bgcolor="${EMAIL_COLORS.bodyBg}" cellpadding="0" cellspacing="0" role="presentation" style="background-color:${EMAIL_COLORS.bodyBg};"><tr><td align="center" style="padding:32px 16px;"><table width="600" style="max-width:600px;background-color:${EMAIL_COLORS.cardBg};border-radius:8px;border:1px solid ${EMAIL_COLORS.border};" cellpadding="0" cellspacing="0" role="presentation"><tr><td style="padding:28px 32px 20px;text-align:center;border-bottom:1px solid ${EMAIL_COLORS.border};"><a href="https://owlette.app" style="text-decoration:none;"><img src="${logoUrl}" width="48" height="48" alt="owlette" style="display:block;margin:0 auto 12px;border-radius:50%;"></a><table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 auto;"><tr><td><a href="https://owlette.app" style="color:${EMAIL_COLORS.cyan};font-size:20px;font-weight:700;text-transform:lowercase;letter-spacing:0.5px;text-decoration:none;line-height:1;">owlette</a></td>${envBadgeHtml}</tr></table></td></tr><tr><td style="padding:28px 32px;color:${EMAIL_COLORS.text};font-size:14px;line-height:1.7;">${content}</td></tr><tr><td style="padding:20px 32px;border-top:1px solid ${EMAIL_COLORS.border};text-align:center;">${actionsHtml}<p style="color:${EMAIL_COLORS.muted};font-size:11px;margin:0;"><a href="https://owlette.app" style="color:${EMAIL_COLORS.cyan};text-decoration:none;">owlette.app</a></p></td></tr></table></td></tr></table></body></html>`;
}

/** Cyan call-to-action button for a transactional email's one link. */
function emailCtaButton(url: string, label: string): string {
  return (
    `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:24px 0;">` +
    `<tr><td style="border-radius:6px;background:${EMAIL_COLORS.cyan};">` +
    `<a href="${url}" style="display:inline-block;padding:12px 28px;color:${EMAIL_COLORS.bodyBg};text-decoration:none;font-weight:700;font-size:14px;border-radius:6px;">${label}</a>` +
    `</td></tr></table>`
  );
}

/** The same link as plain text, for clients that strip or block the button. */
function emailLinkFallback(url: string): string {
  return `<p style="margin:0;color:${EMAIL_COLORS.muted};font-size:12px;">if the button doesn't work, copy and paste this link into your browser:<br><span style="color:${EMAIL_COLORS.cyan};word-break:break-all;">${url}</span></p>`;
}

/**
 * Branded password-reset email — replaces Firebase's plain built-in template.
 * `resetUrl` is the in-app /reset-password link carrying the oobCode; `expiryMinutes` is
 * body copy only (Firebase codes default to 1 hour). Transactional — no unsubscribe link.
 */
export function buildPasswordResetEmail(resetUrl: string, expiryMinutes = 60): string {
  const content = `
    <h2 style="color:${EMAIL_COLORS.cyan};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">reset your password</h2>
    <p style="margin:0 0 8px;color:${EMAIL_COLORS.muted};">we received a request to reset the password for your owlette account. click the button below to choose a new one.</p>
    ${emailCtaButton(resetUrl, 'reset password')}
    <p style="margin:0 0 12px;color:${EMAIL_COLORS.muted};font-size:13px;">this link expires in ${expiryMinutes} minutes and can only be used once. if you didn't request a password reset, you can safely ignore this email — your password won't change.</p>
    ${emailLinkFallback(resetUrl)}
  `;

  return wrapEmailLayout(content, { preheader: 'reset your owlette password' });
}

/**
 * Branded email-verification email for password sign-ups. `verifyUrl` is the in-app
 * /verify-email link carrying the oobCode. Transactional — no unsubscribe link.
 */
export function buildEmailVerificationEmail(verifyUrl: string): string {
  const content = `
    <h2 style="color:${EMAIL_COLORS.cyan};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">verify your email</h2>
    <p style="margin:0 0 8px;color:${EMAIL_COLORS.muted};">thanks for signing up for owlette. confirm this is your email address by clicking the button below.</p>
    ${emailCtaButton(verifyUrl, 'verify email')}
    <p style="margin:0 0 12px;color:${EMAIL_COLORS.muted};font-size:13px;">the link can only be used once. if you didn't create an owlette account, you can safely ignore this email.</p>
    ${emailLinkFallback(verifyUrl)}
  `;

  return wrapEmailLayout(content, { preheader: 'confirm your email address for owlette' });
}

/**
 * Format a date for email display, locale-independently.
 * `timezone` must be an IANA name — Intl throws RangeError on Windows registry names like
 * "Eastern Standard Time", which would silently abort an alert email. Falls back to UTC.
 */
export function emailTimestamp(date: Date = new Date(), timezone?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  };

  if (timezone) {
    try {
      const formatted = date.toLocaleString('en-US', { ...options, timeZone: timezone });
      const tzPart = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'short',
      })
        .formatToParts(date)
        .find((p) => p.type === 'timeZoneName');
      return `${formatted} ${tzPart?.value ?? timezone}`;
    } catch {
      // Invalid timezone (e.g. a Windows registry name) — fall through to UTC.
    }
  }

  return `${date.toLocaleString('en-US', options)} UTC`;
}

// [B3.2] Display digest email

/**
 * Single pending display alert as written to `pending_display_alerts` by /api/agent/alert
 * (B3.1) — shared by the cron digest and the immediate-send path (B3.3).
 */
export interface PendingDisplayAlert {
  docId: string;
  siteId: string;
  machineId: string;
  eventType: string;
  data: Record<string, unknown>;
  agentVersion: string;
  correlatedApplyId: string;
  timestamp: FirebaseFirestore.Timestamp | Date | null;
}

/**
 * Operator-facing event labels (snake_case agent type → human phrase). Critical events
 * read as actions ("monitor removed"), warnings as states. Lowercase per UI copy style.
 */
const DISPLAY_EVENT_LABEL: Record<string, string> = {
  display_monitor_removed: 'monitor removed',
  display_apply_failed: 'display apply failed',
  display_auto_revert_fired: 'display auto-reverted',
  display_sync_lost: 'display sync lost',
  display_drift: 'display drift detected',
  display_monitor_swapped: 'monitor swapped',
  display_mosaic_disabled: 'nvidia mosaic disabled',
  display_apply_refused_mosaic: 'display apply refused (mosaic active)',
  display_monitor_added: 'monitor added',
  display_apply_succeeded: 'display apply succeeded',
};

/** Severity color for an event: critical red, warning amber, else blue. */
function displayEventColor(eventType: string): string {
  if (
    eventType === 'display_monitor_removed' ||
    eventType === 'display_apply_failed' ||
    eventType === 'display_auto_revert_fired' ||
    eventType === 'display_sync_lost'
  ) {
    return EMAIL_COLORS.red;
  }
  if (
    eventType === 'display_drift' ||
    eventType === 'display_monitor_swapped' ||
    eventType === 'display_mosaic_disabled' ||
    eventType === 'display_apply_refused_mosaic'
  ) {
    return EMAIL_COLORS.amber;
  }
  return EMAIL_COLORS.blue;
}

/**
 * Pull `monitor.friendlyName` out of the alert's `data` payload — agent display events
 * (B2.2) carry `monitor: {friendlyName, port, edidHash}`. Empty string when absent.
 */
function monitorLabel(data: Record<string, unknown>): string {
  const monitor = data?.monitor as Record<string, unknown> | undefined;
  if (!monitor) return '';
  const name = (monitor.friendlyName ?? monitor.id ?? '') as string;
  const port = (monitor.port ?? '') as string;
  if (name && port) return `${name} (${port})`;
  return name || port || '';
}

/** Per-event detail: drift lists changed fields, apply_failed the error, else ''. */
function displayEventDetail(eventType: string, data: Record<string, unknown>): string {
  if (eventType === 'display_drift' && Array.isArray(data?.changes)) {
    const changes = (data.changes as unknown[]).filter(
      (c): c is string => typeof c === 'string',
    );
    if (changes.length > 0) return `changes: ${changes.join(', ')}`;
  }
  const error = (data?.error ?? data?.errorMessage ?? '') as string;
  if (error) return error;
  return '';
}

function displayAlertRow(label: string, value: string, alt: boolean, highlight?: string): string {
  const bg = alt ? `background:${EMAIL_COLORS.altRow};` : '';
  const color = highlight || EMAIL_COLORS.text;
  const safeValue = escapeHtml(value || '—');
  return `
    <tr>
      <td style="padding:10px 14px;${bg}color:${EMAIL_COLORS.muted};font-size:13px;font-weight:600;white-space:nowrap;border-bottom:1px solid ${EMAIL_COLORS.border};width:140px;">${label}</td>
      <td style="padding:10px 14px;${bg}color:${color};font-size:13px;border-bottom:1px solid ${EMAIL_COLORS.border};">${safeValue}</td>
    </tr>`;
}

/**
 * Render the email body for a batch of pending display alerts: single-alert payloads get
 * a focused key/value layout, multi-alert payloads a digest table color-coded by severity.
 * Used by the digest cron (B3.2, drains `pending_display_alerts` every 3 min) and the
 * immediate-send path (B3.3, display_monitor_removed / display_auto_revert_fired).
 */
export function buildDisplayDigestEmail(
  siteLabel: string,
  alerts: PendingDisplayAlert[],
  unsubscribeUrl?: string,
  timezone?: string,
): string {
  // Single alert: focused key/value layout, matching the single-process email shape.
  if (alerts.length === 1) {
    const a = alerts[0];
    const label = DISPLAY_EVENT_LABEL[a.eventType] ?? a.eventType;
    const color = displayEventColor(a.eventType);
    const monitor = monitorLabel(a.data);
    const detail = displayEventDetail(a.eventType, a.data);
    const ts = a.timestamp && typeof a.timestamp === 'object' && 'toDate' in a.timestamp
      ? (a.timestamp as FirebaseFirestore.Timestamp).toDate()
      : (a.timestamp instanceof Date ? a.timestamp : new Date());
    const content = `
      <h2 style="color:${color};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">${label}</h2>
      <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">a display event was detected on one of your machines.</p>
      <table width="100%" style="border-collapse:collapse;border:1px solid ${EMAIL_COLORS.border};border-radius:6px;overflow:hidden;" cellpadding="0" cellspacing="0">
        ${displayAlertRow('site', siteLabel, false)}
        ${displayAlertRow('machine', a.machineId, true)}
        ${displayAlertRow('event', label, false, color)}
        ${displayAlertRow('monitor', monitor, true)}
        ${detail ? displayAlertRow('details', detail, false) : ''}
        ${displayAlertRow('agent version', a.agentVersion, !detail)}
        ${displayAlertRow('time', emailTimestamp(ts, timezone), !!detail)}
      </table>
      <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">open the dashboard to inspect the layout and take action.</p>
    `;
    return wrapEmailLayout(content, {
      preheader: `${label} on ${a.machineId}`,
      unsubscribeUrl,
    });
  }

  // Multi-alert digest: per-event row, color-coded by severity.
  const rows = alerts
    .map((a, i) => {
      const label = DISPLAY_EVENT_LABEL[a.eventType] ?? a.eventType;
      const color = displayEventColor(a.eventType);
      const monitor = monitorLabel(a.data) || '—';
      const detail = displayEventDetail(a.eventType, a.data) || '—';
      const bg = i % 2 === 1 ? `background:${EMAIL_COLORS.altRow};` : '';
      return `
      <tr>
        <td style="padding:10px 14px;${bg}color:${EMAIL_COLORS.text};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${escapeHtml(a.machineId)}</td>
        <td style="padding:10px 14px;${bg}color:${color};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${label}</td>
        <td style="padding:10px 14px;${bg}color:${EMAIL_COLORS.text};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${escapeHtml(monitor)}</td>
        <td style="padding:10px 14px;${bg}color:${EMAIL_COLORS.muted};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${escapeHtml(detail)}</td>
      </tr>`;
    })
    .join('');

  const thStyle = `padding:10px 14px;text-align:left;background:${EMAIL_COLORS.altRow};color:${EMAIL_COLORS.muted};font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid ${EMAIL_COLORS.border};`;

  const content = `
    <h2 style="color:${EMAIL_COLORS.amber};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">display alerts: ${alerts.length} event(s)</h2>
    <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">${alerts.length} display event(s) detected in site <strong style="color:${EMAIL_COLORS.text};">${escapeHtml(siteLabel)}</strong>.</p>
    <table width="100%" style="border-collapse:collapse;border:1px solid ${EMAIL_COLORS.border};border-radius:6px;overflow:hidden;" cellpadding="0" cellspacing="0">
      <thead>
        <tr>
          <th style="${thStyle}">machine</th>
          <th style="${thStyle}">event</th>
          <th style="${thStyle}">monitor</th>
          <th style="${thStyle}">details</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">open the dashboard to inspect each machine's layout and take action.</p>
    <p style="margin:8px 0 0;color:${EMAIL_COLORS.border};font-size:11px;">checked at ${emailTimestamp(new Date(), timezone)}</p>
  `;

  return wrapEmailLayout(content, {
    preheader: `${alerts.length} display event(s) in ${siteLabel}`,
    unsubscribeUrl,
  });
}

// api key expiry notices

/**
 * One expiring key as rendered in the notice email. Metadata ONLY: no `keyHash`
 * (the stored form of the credential) and no `scopes` (a map of what the key can
 * reach). An expiry reminder must not make an inbox worth more than it was.
 */
export interface ExpiringApiKey {
  name: string;
  keyPrefix: string;
  expiresAt: number;
  /** Whole days until expiry, floored — NEGATIVE once the key is already past it. */
  daysRemaining: number;
}

/**
 * Lowercase phrase for a key's remaining life. Deliberately avoids "today" and
 * "tomorrow": those are calendar claims, and the recipient's calendar is not the
 * one this ran on. Under a day is stated as exactly that.
 */
export function apiKeyExpiryPhrase(daysRemaining: number): string {
  if (daysRemaining < 0) return 'already expired';
  if (daysRemaining === 0) return 'expires in under a day';
  return `expires in ${daysRemaining} day(s)`;
}

function expiringKeyRowsHtml(keys: ExpiringApiKey[], timezone?: string): string {
  return keys
    .map((k, i) => {
      const bg = i % 2 === 1 ? `background:${EMAIL_COLORS.altRow};` : '';
      const accent = k.daysRemaining < 0 ? EMAIL_COLORS.red : EMAIL_COLORS.amber;
      return `
      <tr>
        <td style="padding:10px 14px;${bg}color:${EMAIL_COLORS.text};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${escapeHtml(k.name)}</td>
        <td style="padding:10px 14px;${bg}color:${EMAIL_COLORS.muted};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;font-family:'Courier New',Courier,monospace;">${escapeHtml(k.keyPrefix)}&#8226;&#8226;&#8226;</td>
        <td style="padding:10px 14px;${bg}color:${EMAIL_COLORS.muted};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${escapeHtml(emailTimestamp(new Date(k.expiresAt), timezone))}</td>
        <td style="padding:10px 14px;${bg}color:${accent};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;font-weight:700;">${apiKeyExpiryPhrase(k.daysRemaining)}</td>
      </tr>`;
    })
    .join('');
}

/**
 * Expiry notice for one owner's api keys, sent by `GET /api/cron/api-key-expiry`
 * on the 14 / 3 / 0 day ladder. A single key gets the focused key/value layout,
 * several get a table — the same split as the display digest.
 *
 * Every key listed belongs to the ONE recipient this is addressed to; the caller
 * asserts that before rendering, because a collection-group scan returns every
 * customer's keys flat and a grouping bug would put one in another's inbox.
 */
export function buildApiKeyExpiryEmail(
  keys: ExpiringApiKey[],
  unsubscribeUrl?: string,
  timezone?: string,
): string {
  const soonest = keys.reduce((min, k) => Math.min(min, k.daysRemaining), Infinity);
  const heading = soonest < 0 ? EMAIL_COLORS.red : EMAIL_COLORS.amber;
  const advice = `<p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">rotate a key from account settings &#8594; api keys to get a fresh secret with the same scopes. an expired key stops authenticating — every request with it returns 401.</p>`;

  if (keys.length === 1) {
    const k = keys[0];
    const content = `
      <h2 style="color:${heading};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">api key ${apiKeyExpiryPhrase(k.daysRemaining)}</h2>
      <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">one of your owlette api keys is at the end of its life.</p>
      ${emailDataTable([
        { label: 'key', value: k.name },
        { label: 'prefix', value: `${k.keyPrefix}•••` },
        { label: 'expires', value: emailTimestamp(new Date(k.expiresAt), timezone) },
        {
          label: 'status',
          value: apiKeyExpiryPhrase(k.daysRemaining),
          highlight: k.daysRemaining < 0 ? EMAIL_COLORS.red : EMAIL_COLORS.amber,
        },
      ])}
      ${advice}
    `;
    return wrapEmailLayout(content, {
      preheader: `api key ${k.name} ${apiKeyExpiryPhrase(k.daysRemaining)}`,
      unsubscribeUrl,
    });
  }

  const thStyle = `padding:10px 14px;text-align:left;background:${EMAIL_COLORS.altRow};color:${EMAIL_COLORS.muted};font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid ${EMAIL_COLORS.border};`;

  const content = `
    <h2 style="color:${heading};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">${keys.length} api keys expiring</h2>
    <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">${keys.length} of your owlette api keys are at the end of their life.</p>
    <table width="100%" style="border-collapse:collapse;border:1px solid ${EMAIL_COLORS.border};border-radius:6px;overflow:hidden;" cellpadding="0" cellspacing="0">
      <thead>
        <tr>
          <th style="${thStyle}">key</th>
          <th style="${thStyle}">prefix</th>
          <th style="${thStyle}">expires</th>
          <th style="${thStyle}">status</th>
        </tr>
      </thead>
      <tbody>${expiringKeyRowsHtml(keys, timezone)}</tbody>
    </table>
    ${advice}
  `;

  return wrapEmailLayout(content, {
    preheader: `${keys.length} api keys expiring`,
    unsubscribeUrl,
  });
}
