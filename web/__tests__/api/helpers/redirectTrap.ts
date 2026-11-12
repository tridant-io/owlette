import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RedirectTrap {
  /** answers every request with a 302 to a second local server */
  url: string;
  /** requests that reached the second server */
  hits: () => number;
  close: () => Promise<void>;
}

/**
 * a webhook url whose host redirects to an internal address, played by two
 * loopback servers. the url validator would refuse loopback, so a test stubs it
 * to accept `url`, which is the public host's part.
 */
export async function startRedirectTrap(): Promise<RedirectTrap> {
  let hits = 0;
  const internal = http.createServer((req, res) => {
    hits += 1;
    req.resume();
    res.end('internal');
  });
  const internalUrl = `http://127.0.0.1:${(await listen(internal)).port}/`;
  const redirector = http.createServer((req, res) => {
    req.resume();
    res.writeHead(302, { location: internalUrl });
    res.end();
  });
  const { port } = await listen(redirector);
  return {
    url: `http://127.0.0.1:${port}/hook`,
    hits: () => hits,
    close: async () => {
      await Promise.all([stop(internal), stop(redirector)]);
    },
  };
}

function listen(server: http.Server): Promise<AddressInfo> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address() as AddressInfo));
  });
}

function stop(server: http.Server): Promise<void> {
  // fetch keeps connections alive, and close() waits for them
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}
