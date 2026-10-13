import { NextResponse } from 'next/server';

/**
 * GET /download/swoop-viewer
 *
 * public permalink for owlette swoop, the viewer app. the "get it" action on the
 * not-installed toast points here, so the url stays put while its target moves:
 * there is no hosted standalone build yet, so it sends visitors to the docs
 * section that says where the app comes from.
 */
export function GET() {
  // relative, so the browser resolves it against the host it asked, whatever proxy sits in front.
  return new NextResponse(null, {
    status: 302,
    headers: { Location: '/docs/dashboard/swoop#owlette-swoop', 'Cache-Control': 'no-store' },
  });
}
