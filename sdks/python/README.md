# owlette-sdk — python SDK

Async Python SDK for the [roost](https://owlette.app) public API. Built on
`httpx.AsyncClient`, typed end-to-end, mypy-strict clean.

Requires Python ≥ 3.10.

## install

```bash
pip install --pre owlette-sdk
```

`owlette-sdk` pre-release install is the public launch target. Until the Wave 5.3 distribution gate is complete and the PyPI pre-release is visible, install from the monorepo source checkout.

## quickstart

```python
import asyncio
from roost import Roost, PushOptions

async def main() -> None:
    async with Roost(token="owk_live_...") as client:
        identity = await client.account.whoami()
        site_id = identity.primary_site_id or "site-1"

        result = await client.roosts.push(
            "./dist",
            "rst_abc",
            PushOptions(
                site_id=site_id,
                description="fixed broken video",
                on_progress=lambda evt: print(evt),
            ),
        )
        print("published v" + str(result.version_number), result.version_id)

asyncio.run(main())
```

## client options

```python
Roost(
    token="owk_live_...",             # required
    api_url="https://owlette.app",    # default
    environment="live",               # 'live' | 'test'
    roost_version="2026-04-22",       # default
    retry=RetryPolicy(max_attempts=3),  # optional
    transport=my_httpx_transport,     # for proxy / mTLS / recording
    timeout=30.0,
    on_billing_warning=logger.warning,  # accepted for compatibility; never fires
)
```

### plan refusals

Plans are not enforced during the beta. Once they apply, a request that the
site owner's plan does not cover raises `RoostApiError` with
`code == "plan_required"` and `status == 402`, and is not retried.
`error.problem["entitlement"]` names what the plan lacks — `owlette.api_keys`
for every request made with a key on a plan without API keys. See
[plans](https://owlette.app/docs/plans).

`on_billing_warning` is still accepted for compatibility but never fires: the
api stopped sending the `X-Owlette-Billing-Warning` header when billing was
removed.

## resources

| resource          | methods                                                                 |
|-------------------|-------------------------------------------------------------------------|
| `roost.account`   | `whoami`, `version`, `api_keys.list`, `api_keys.create`, `api_keys.revoke` |
| `roost.roosts`    | `list`, `list_page`, `get`, `create`, `patch`, `remove`, `push`, `rollback`, `deploy` |
| `roost.chunks`    | `check`, `upload_urls`, `download_urls`, `mount`, `referrers`           |
| `roost.versions`  | `list`, `list_page`, `get`, `patch`, `files`, `diff`                    |
| `roost.deployments` | `list`, `list_page`, `get`                                            |
| `roost.keys`      | legacy session/ID-token key admin: `create`, `list`, `rotate`, `revoke` |
| `roost.webhooks`  | `subscribe`, `list`, `get`, `update`, `remove`, `rotate_secret`, `probe` |
| `roost.sites`     | `list`, `get`                                                           |
| `roost.machines`  | `list`, `get`, `deployments`, `dispatch_command`, `get_command`, `capture_screenshot` |
| `roost.quotas`    | `current`, `history`                                                    |

Roost, version, deployment, and chunk-referrer paginated lists expose
**async generators** that auto-walk the `nextPageToken` cursor:

```python
async with Roost(token=...) as client:
    async for r in client.roosts.list(site_id="site-1"):
        print(r.roost_id, r.name)
```

If you need explicit control of roost/version/deployment paging, use
`list_page()` instead. Some account/admin resources intentionally return a
single list or page envelope because that matches their API route.

## account

```python
identity = await client.account.whoami()
print(identity.email or identity.user_id, identity.key.key_prefix if identity.key else None)

version = await client.account.version()
print(version.current, version.supported)

# API-key-compatible key management. New keys inherit the caller's allowed
# scopes, so an API-key caller cannot widen its own privileges.
created = await client.account.api_keys.create(name="preview publisher")
keys = await client.account.api_keys.list()
await client.account.api_keys.revoke(created["keyId"])
```

For complete runnable scripts, see `examples/`: auth/inventory,
token-to-publish, command polling, and webhook verification.

## push progress

```python
from roost import Roost, PushOptions

def on_progress(evt):
    # evt is tagged by .phase: 'discover' | 'hash' | 'check-missing'
    #                          | 'upload' | 'publish'
    print(evt)

async with Roost(token="owk_live_...") as client:
    await client.roosts.push(
        "./dist",
        "rst_abc",
        PushOptions(site_id="site-1", on_progress=on_progress),
    )
```

`on_progress` may be a plain callable or an async coroutine — both are
awaited correctly.

## webhook signature verification

```python
from roost import verify_signature

result = verify_signature(
    request.headers.get("roost-signature"),
    await request.body(),           # raw bytes
    secret="whsec_...",
)
if not result.ok:
    return Response(status_code=401, content=result.reason)
```

Matches the server dispatcher exactly: `t=<unix>,v1=<hmac-sha256-hex>`
with a 5-minute replay tolerance. Uses `hmac.compare_digest` internally.

## errors

All non-2xx responses raise `RoostApiError`:

```python
from roost import Roost, RoostApiError

async with Roost(token=...) as client:
    try:
        await client.roosts.get("rst_missing", site_id="site-1")
    except RoostApiError as err:
        print(err.status, err.code, err.request_id)
```

The SDK auto-retries `429` and `5xx` with exponential backoff + jitter,
honoring server `retryAfter` hints. Everything else bubbles.

## license

FSL-1.1-Apache-2.0
