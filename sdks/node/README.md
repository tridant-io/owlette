# @owlette/sdk — node sdk

Programmatic access to the [owlette](https://owlette.app) public api from
Node 20+. Zero runtime dependencies — uses the built-in `fetch`, `crypto`,
and `fs` modules.

## install

```bash
npm install @owlette/sdk@rc
```

`@owlette/sdk@rc` is the public launch target. Until the Wave 5.3 distribution gate is complete and the npm `rc` tag is visible, install from the monorepo source checkout.

## quickstart

```ts
import { Owlette } from '@owlette/sdk';

const owlette = new Owlette({
  token: process.env.OWLETTE_TOKEN!,
  apiUrl: 'https://owlette.app',
});

// verify auth and inspect the target site
const identity = await owlette.account.whoami();
const site = await owlette.sites.get(identity.primarySiteId ?? 'site-1');
console.log('authenticated as', identity.email ?? identity.userId);
console.log('site', site.id, site.name);

// publish a directory as a new version
const result = await owlette.roosts.push('./dist', 'rst_abc', {
  siteId: site.id,
  description: 'fixed broken video',
  onProgress: (evt) => console.log(evt),
});

console.log('published', result.versionId, `#${result.versionNumber}`);
console.log('uploaded', result.stats.uploadedChunks, 'chunks');
```

## client options

```ts
new Owlette({
  token: 'owk_live_...',          // required
  apiUrl: 'https://owlette.app',  // default
  environment: 'live',            // optional — 'live' | 'test'
  roostVersion: '2026-04-22',     // default, sent as Roost-Version header
  fetch: customFetch,             // optional — drop-in override for proxy / mtls
  retry: { maxAttempts: 3 },      // optional — overrides default policy
  onBillingWarning: (w) => {},    // accepted for compatibility; never fires
});
```

The sdk auto-generates an `Idempotency-Key` header on every mutating
request so transparent retries can't create duplicate rollouts, roosts,
or api keys.

### plan refusals

Plans are not enforced during the beta. Once they apply, a request that the
site owner's plan does not cover throws `OwletteApiError` with
`code === 'plan_required'` and `status === 402`, and is not retried.
`error.problem.entitlement` names what the plan lacks — `owlette.api_keys`
for every request made with a key on a plan without API keys. See
[plans](https://owlette.app/docs/plans).

`onBillingWarning` is still accepted for compatibility but never fires: the
api stopped sending the `X-Owlette-Billing-Warning` header when billing was
removed.

## resources

| resource        | methods                                                            |
|-----------------|--------------------------------------------------------------------|
| `owlette.account` | `whoami`, `version`, `apiKeys.list`, `apiKeys.create`, `apiKeys.revoke` |
| `owlette.roosts`  | `list`, `get`, `create`, `patch`, `remove`, `push`, `rollback`, `deploy` |
| `owlette.chunks`  | `check`, `uploadUrls`, `downloadUrls`, `mount`, `referrers`        |
| `owlette.versions` | `list`, `get`, `patch`, `files`, `diff`                           |
| `owlette.deployments` | `list`, `get`                                                  |
| `owlette.keys`    | legacy session/ID-token key admin: `create`, `list`, `rotate`, `revoke` |
| `owlette.webhooks` | `subscribe`, `list`, `get`, `update`, `remove`, `rotateSecret`, `probe`, `deliveries`, `delivery`, `retryDelivery` |
| `owlette.sites`   | `list`, `get`                                                      |
| `owlette.machines` | `list`, `get`, `deployments`, `dispatchCommand`, `getCommand`, `captureScreenshot` |
| `owlette.installerDeployments` | `list`, `get`, `create`, `retry`, `cancel`, `uninstall`, `delete` |
| `owlette.installer` | `list`, `latest`, `upload`, `setLatest`, `delete`                |
| `owlette.processes(siteId, machineId)` | `list`, `create`, `update`, `start`, `stop`, `restart`, `kill`, `schedule`, `delete` |
| `owlette.chat`    | `new`, `list`, `send`, `rename`, `delete`                          |
| `owlette.users`   | `list`, `promote`, `demote`, `assignSites`, `removeSites`, `delete` |
| `owlette.members(siteId)` | `list`, `add`, `remove`                                    |
| `owlette.quotas`  | `current`, `history`                                               |

For complete runnable scripts, see `examples/`: auth/inventory,
token-to-publish, command polling, and webhook verification.

## push progress

`owlette.roosts.push()` reports live progress through `onProgress`:

```ts
await owlette.roosts.push('./dist', 'rst_abc', {
  siteId: 'site-1',
  onProgress: (evt) => {
    if (evt.phase === 'hash') console.log(`hashing ${evt.file}`);
    if (evt.phase === 'upload') console.log(`${evt.uploaded}/${evt.total}`);
  },
});
```

## webhook signature verification

```ts
import { verifySignature } from '@owlette/sdk';

// In your raw-body webhook handler:
const result = verifySignature(
  req.headers['roost-signature'],
  req.rawBody,
  process.env.WEBHOOK_SECRET!,
);
if (!result.ok) {
  return res.status(401).json({ error: result.reason });
}
```

The verifier enforces a default replay-tolerance window of 5 minutes
(configurable via `toleranceSeconds`) and uses `crypto.timingSafeEqual`
to compare hashes.

## errors

All non-2xx api responses throw `OwletteApiError`:

```ts
import { Owlette, OwletteApiError } from '@owlette/sdk';

try {
  await owlette.roosts.get('rst_missing', { siteId: 'site-1' });
} catch (err) {
  if (err instanceof OwletteApiError) {
    console.log(err.status, err.code, err.requestId);
  }
  throw err;
}
```

The sdk auto-retries `429` and `5xx` errors with exponential backoff +
jitter. `401`, `403`, `404`, `412`, `422`, etc. bubble immediately.

## license

FSL-1.1-Apache-2.0 (same as Owlette core).
