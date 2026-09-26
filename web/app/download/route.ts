import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  normalizeInstallerFiles,
  platformFromOsParam,
  platformFromUserAgent,
} from '@/lib/installerPlatform';

/**
 * GET /download
 *
 * Public permalink that redirects to the latest installer for the visitor's
 * platform: `?os=windows|macos|linux` when given, the User-Agent otherwise.
 * No authentication required — the download URL itself is a signed Firebase
 * Storage URL with its own expiry.
 */
export async function GET(request: Request) {
  const os = new URL(request.url).searchParams.get('os');
  const platform = platformFromOsParam(os) ?? platformFromUserAgent(request.headers.get('user-agent'));

  try {
    const db = getAdminDb();
    const latestDoc = await db.collection('installer_metadata').doc('latest').get();
    const latestData = latestDoc.data();
    const version =
      typeof latestData?.version === 'string' && latestData.version.length > 0
        ? latestData.version
        : null;

    if (!latestDoc.exists || !version) {
      return loginRedirect();
    }

    const versionDoc = await db
      .collection('installer_metadata')
      .doc('data')
      .collection('versions')
      .doc(version)
      .get();
    const versionData = versionDoc.data();

    if (!versionDoc.exists || typeof versionData?.deletedAt === 'number') {
      return loginRedirect();
    }

    const file =
      normalizeInstallerFiles(versionData ?? {})[platform] ??
      normalizeInstallerFiles(latestData ?? {})[platform];

    if (!file) {
      // a permalink, not an api route: plain text, and never a silent exe
      const osWord = platform.split('_')[0];
      return new NextResponse(`no ${osWord} build in v${version}`, {
        status: 404,
        headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
      });
    }

    return NextResponse.redirect(file.download_url, {
      headers: { Vary: 'User-Agent', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[download] Failed to fetch latest installer:', error);
    return loginRedirect();
  }
}

function loginRedirect() {
  return NextResponse.redirect(new URL('/login', process.env.NEXT_PUBLIC_BASE_URL || 'https://owlette.app'));
}
