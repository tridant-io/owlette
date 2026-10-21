/** @jest-environment node */

import { GET } from '@/app/download/swoop-viewer/route';

describe('GET /download/swoop-viewer', () => {
  it("sends the visitor to the swoop docs' owlette swoop section, uncached", () => {
    const res = GET();

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/docs/dashboard/swoop#owlette-swoop');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
