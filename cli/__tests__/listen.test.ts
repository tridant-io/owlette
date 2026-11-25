import { Command } from 'commander';
import { _internals, registerListenCommand } from '../src/commands/listen';
import { _resetConfigCache } from '../src/config';
import { createHmac } from 'crypto';

const { parseSseBlock, buildForwardHeaders } = _internals;

describe('owlette listen', () => {
  let originalFetch: typeof global.fetch;
  let sigintBefore: NodeJS.SignalsListener[];

  beforeEach(() => {
    originalFetch = global.fetch;
    sigintBefore = process.listeners('SIGINT') as NodeJS.SignalsListener[];
    _resetConfigCache();
    process.env.OWLETTE_TOKEN = 'owk_live_testtoken';
    process.env.OWLETTE_API_URL = 'https://dev.test';
    process.env.OWLETTE_PROFILE = 'default';
    process.exitCode = 0;
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const listener of process.listeners('SIGINT')) {
      if (!sigintBefore.includes(listener as NodeJS.SignalsListener)) process.off('SIGINT', listener);
    }
    delete process.env.OWLETTE_TOKEN;
    delete process.env.OWLETTE_API_URL;
    delete process.env.OWLETTE_PROFILE;
    process.exitCode = 0;
    jest.restoreAllMocks();
  });

  it('sends the key only in the Authorization header, and forwards what the stream carries', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: connected\ndata: {}\n\nevent: closing\ndata: {"reason":"max_duration_reached"}\n\n',
          ),
        );
        controller.close();
      },
    });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return calls.length === 1
        ? ({ ok: true, status: 200, headers: new Headers(), body: stream } as Response)
        : ({ ok: true, status: 204, headers: new Headers() } as Response);
    }) as unknown as typeof global.fetch;

    const program = new Command();
    program.name('owlette').exitOverride().option('--profile <name>');
    registerListenCommand(program);
    await program.parseAsync(
      ['listen', '--site', 'site-1', '--forward-to', 'http://localhost:3999/hook'],
      { from: 'user' },
    );

    const streamUrl = new URL(calls[0]!.url);
    expect(streamUrl.origin + streamUrl.pathname).toBe('https://dev.test/api/events/stream');
    expect(streamUrl.searchParams.get('siteId')).toBe('site-1');
    expect(calls[0]!.url).not.toContain('owk_');
    expect([...streamUrl.searchParams.keys()]).toEqual(['siteId']);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer owk_live_testtoken',
    );
    expect(calls[1]!.url).toBe('http://localhost:3999/hook');
    expect((calls[1]!.init.headers as Record<string, string>)['Roost-Event']).toBe('closing');
  });
});

describe('parseSseBlock', () => {
  it('parses a canonical event+data pair', () => {
    const evt = parseSseBlock('event: connected\ndata: {"ok":true}');
    expect(evt).toEqual({ kind: 'connected', id: null, data: '{"ok":true}' });
  });

  it('defaults the event kind to "message" when none is set', () => {
    const evt = parseSseBlock('data: hello');
    expect(evt?.kind).toBe('message');
    expect(evt?.data).toBe('hello');
  });

  it('ignores comment lines (leading ":")', () => {
    const evt = parseSseBlock(': ping\nevent: keepalive\ndata: {}');
    expect(evt?.kind).toBe('keepalive');
  });

  it('returns null for completely empty blocks', () => {
    expect(parseSseBlock('')).toBeNull();
    expect(parseSseBlock(': comment only')).toBeNull();
  });

  it('captures the id field when present', () => {
    const evt = parseSseBlock('id: abc-123\nevent: x\ndata: y');
    expect(evt?.id).toBe('abc-123');
  });
});

describe('buildForwardHeaders', () => {
  it('always sets Content-Type + Roost-Event', () => {
    const h = buildForwardHeaders(
      { kind: 'connected', id: null, data: '{}' },
      undefined,
    );
    expect(h['Content-Type']).toBe('application/json');
    expect(h['Roost-Event']).toBe('connected');
    expect(h['Roost-Signature']).toBeUndefined();
  });

  it('propagates the SSE id into Roost-Delivery', () => {
    const h = buildForwardHeaders(
      { kind: 'keepalive', id: 'delivery-42', data: '{}' },
      undefined,
    );
    expect(h['Roost-Delivery']).toBe('delivery-42');
  });

  it('signs the payload with the stripe-style t=<unix>,v1=<hmac> scheme when a secret is supplied', () => {
    const h = buildForwardHeaders(
      { kind: 'x', id: null, data: '{"a":1}' },
      'shhh-secret',
    );
    const sig = h['Roost-Signature'];
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    // Recompute the hmac with the same secret + timestamp and confirm it matches.
    const [tPart, v1Part] = sig!.split(',');
    const t = Number(tPart!.slice(2));
    const v1 = v1Part!.slice(3);
    const expected = createHmac('sha256', 'shhh-secret')
      .update(`${t}.{"a":1}`)
      .digest('hex');
    expect(v1).toBe(expected);
  });

  it('falls back to event.data.roostSignature when the server pre-signed the payload', () => {
    const h = buildForwardHeaders(
      {
        kind: 'x',
        id: null,
        data: JSON.stringify({ roostSignature: 't=123,v1=deadbeef' }),
      },
      undefined,
    );
    expect(h['Roost-Signature']).toBe('t=123,v1=deadbeef');
  });

  it('leaves signature untouched when data is non-JSON and no secret is supplied', () => {
    const h = buildForwardHeaders(
      { kind: 'x', id: null, data: 'not-json' },
      undefined,
    );
    expect(h['Roost-Signature']).toBeUndefined();
  });
});
