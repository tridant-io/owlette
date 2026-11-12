import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { ApiAuthError, requireSessionOrIdToken } from '@/lib/apiAuth.server';
import { getResend, FROM_EMAIL, ENV_LABEL, isProduction } from '@/lib/resendClient.server';
import { wrapEmailLayout, emailDataTable, emailTimestamp, EMAIL_COLORS } from '@/lib/emailTemplates.server';
import { apiError } from '@/lib/apiErrorResponse';

const ADMIN_EMAIL = isProduction
  ? process.env.ADMIN_EMAIL_PROD
  : process.env.ADMIN_EMAIL_DEV;

interface UserCreatedPayload {
  email: string;
  displayName: string;
  authMethod: 'email' | 'google';
  createdAt: string;
}

export async function POST(request: NextRequest) {
  try {
    const sessionUserId = await requireSessionOrIdToken(request, { allowPreMfa: true });

    const payload: UserCreatedPayload = await request.json();

    if (!payload.email || !payload.displayName || !payload.authMethod) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Ensure the payload matches the authenticated user
    const db = getAdminDb();
    const userDoc = await db.collection('users').doc(sessionUserId).get();
    const userData = userDoc.exists ? userDoc.data() : null;
    if (!userData || userData.email !== payload.email) {
      return NextResponse.json(
        { error: 'Unauthorized: User mismatch' },
        { status: 403 }
      );
    }

    const resendClient = getResend();
    if (!resendClient) {
      console.error('RESEND_API_KEY not configured');
      return NextResponse.json(
        { error: 'Email service not configured' },
        { status: 500 }
      );
    }

    if (!ADMIN_EMAIL) {
      console.error('ADMIN_EMAIL not configured for current environment');
      return NextResponse.json(
        { error: 'Admin email not configured' },
        { status: 500 }
      );
    }

    // Admin notification email
    const adminContent = `
      <h2 style="color:${EMAIL_COLORS.cyan};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">new user registration</h2>
      <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">a new user has signed up on owlette.</p>
      ${emailDataTable([
        { label: 'name', value: payload.displayName },
        { label: 'email', value: payload.email },
        { label: 'sign-in method', value: payload.authMethod === 'google' ? 'Google OAuth' : 'Email/Password' },
        { label: 'registered at', value: emailTimestamp(new Date(payload.createdAt)) },
        { label: 'environment', value: ENV_LABEL },
      ])}
    `;

    const adminEmailResult = await resendClient.emails.send({
      from: FROM_EMAIL,
      to: ADMIN_EMAIL,
      subject: `[${ENV_LABEL}] new owlette user signup`,
      html: wrapEmailLayout(adminContent),
    });

    // Optional welcome email to user
    let welcomeEmailResult = null;
    if (process.env.SEND_WELCOME_EMAIL === 'true') {
      const linkStyle = `color:${EMAIL_COLORS.cyan};text-decoration:none;font-weight:600;`;
      const welcomeContent = `
        <h2 style="color:${EMAIL_COLORS.cyan};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">welcome to owlette</h2>
        <p style="margin:0 0 8px;">hi ${payload.displayName},</p>
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

      welcomeEmailResult = await resendClient.emails.send({
        from: FROM_EMAIL,
        to: payload.email,
        subject: 'welcome to owlette',
        html: wrapEmailLayout(welcomeContent),
      });
    }

    return NextResponse.json({
      success: true,
      adminEmailSent: !!adminEmailResult.data,
      welcomeEmailSent: !!welcomeEmailResult?.data,
      environment: ENV_LABEL,
    });

  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'webhooks/user-created');
  }
}
