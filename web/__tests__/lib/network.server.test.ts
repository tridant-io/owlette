/** @jest-environment node */

import { NextRequest } from 'next/server';
import { addressPrefix, requestNetwork } from '@/lib/network.server';

const SECRET = 'edge-secret-for-tests';

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/x', { headers });
}

describe('requestNetwork', () => {
  const previous = process.env.EDGE_SHARED_SECRET;
  beforeEach(() => {
    process.env.EDGE_SHARED_SECRET = SECRET;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.EDGE_SHARED_SECRET;
    else process.env.EDGE_SHARED_SECRET = previous;
  });

  it('keys the network on the asn when the edge secret matches', () => {
    expect(
      requestNetwork(
        request({ 'x-owlette-edge': SECRET, 'x-owlette-asn': '13335', 'cf-connecting-ip': '203.0.113.77' }),
      ),
    ).toEqual({ asn: '13335', prefix: '203.0.113.0/24', viaEdge: true, key: 'asn:13335' });
  });

  it('reads a request whose edge secret does not match as unknown, asn and all', () => {
    expect(
      requestNetwork(request({ 'x-owlette-edge': 'guess', 'x-owlette-asn': '13335', 'cf-connecting-ip': '203.0.113.77' })),
    ).toEqual({ asn: null, prefix: '203.0.113.0/24', viaEdge: false, key: 'unknown' });
  });

  it('reads a request with no edge headers as unknown, keeping the prefix for the log', () => {
    expect(requestNetwork(request({ 'cf-connecting-ip': '2001:db8:abcd:12::1' }))).toEqual({
      asn: null,
      prefix: '2001:db8:abcd:12::/64',
      viaEdge: false,
      key: 'unknown',
    });
  });

  it('trusts no edge at all when the origin holds no secret', () => {
    delete process.env.EDGE_SHARED_SECRET;
    const network = requestNetwork(request({ 'x-owlette-edge': '', 'x-owlette-asn': '13335' }));
    expect(network.viaEdge).toBe(false);
    expect(network.key).toBe('unknown');
  });

  it('reads a vouched-for but malformed asn as unknown', () => {
    for (const asn of ['', '0', '-1', '12a', '4294967296', '00123']) {
      const network = requestNetwork(request({ 'x-owlette-edge': SECRET, 'x-owlette-asn': asn }));
      expect([asn, network.viaEdge, network.key]).toEqual([asn, true, 'unknown']);
    }
  });

  it('has no prefix when the address is unknown', () => {
    expect(requestNetwork(request({ 'x-owlette-edge': SECRET, 'x-owlette-asn': '7922' })).prefix).toBeNull();
  });
});

describe('addressPrefix', () => {
  it.each([
    ['203.0.113.77', '203.0.113.0/24'],
    ['10.001.2.3', '10.1.2.0/24'],
    ['::ffff:198.51.100.9', '198.51.100.0/24'],
    ['2001:0db8:0000:0042:0000:8a2e:0370:7334', '2001:db8:0:42::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::', 'fe80:0:0:0::/64'],
  ])('%s sits in %s', (ip, prefix) => {
    expect(addressPrefix(ip)).toBe(prefix);
  });

  it.each(['300.1.1.1', '1.2.3', '1:2:3:4:5:6:7', '1::2::3', '1:2:3:4:5:6:7:8::', 'abcde::1', 'unknown'])(
    'refuses %s',
    (ip) => {
      expect(addressPrefix(ip)).toBeNull();
    },
  );
});
