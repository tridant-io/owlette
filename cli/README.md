# @owlette/cli

command-line client for the [owlette.app](https://owlette.app) public api. authenticate, push roosts, manage sites and machines, mint api keys, inspect audit logs - from your terminal or ci pipeline.

## install

```bash
npm install -g @owlette/cli@rc
owlette --version
```

`@owlette/cli@rc` is the public launch target. Until the Wave 5.3 distribution gate is complete and the npm `rc` tag is visible, install from the monorepo source checkout.

## 30-second auth + push

```bash
owlette auth login
owlette whoami
owlette roost push ./my-project --to rst_my_project_id --site site-1
```

## commands

- `roost` - push, list, inspect, diff, and deploy content-addressed project bundles; use top-level `rollback` to revert versions.
- `machine` - list machines, inspect machine state, view deployments, and run supported machine actions.
- `swoop` - open the swoop remote-desktop viewer for a machine in your browser.
- `audit-log` - list and inspect site audit-log records for operational history.
- `quota` - inspect current quota usage and usage history for a site.
- `chat` - create, list, send, rename, and delete hoot chat sessions.
- `deploy` - manage classic installer deploys; use `roost deploy` for content-addressed project deploys.
- `process` - manage process lifecycle on site machines.
- `key` - create, list, rotate, and revoke api keys.
- `site` - list accessible sites and inspect site details.
- `user` - manage platform users when your key has superadmin scope.
- `installer` - list, inspect latest, upload, set latest, and delete installer binaries.
- `auth` - log in, log out, and inspect the active authentication state.
- `rollback` - preview and perform a roost version rollback.
- `listen` - forward the scoped SSE liveness stream to a local receiver.
- `trigger` - fire a synthetic webhook payload directly or through the probe API.
- `whoami` - print the active user, scopes, environment, profile, and api host.
- `version` - print cli and server version compatibility details.

## plans

Plans are not enforced during the beta. Once they apply, a command that the
site owner's plan does not cover fails with `402 plan_required`, and the
message says what the plan lacks. API keys are part of the paid plans: on a
plan without them every command made with a key fails that way, and
`owlette auth login` cannot complete — the browser shows why, and the cli
reports the phrase as expired. See [plans](https://owlette.app/docs/plans).

full docs at [docs/cli/overview.md](https://github.com/tridant-io/owlette/tree/main/docs/cli/overview.md) (or owlette.app/docs/cli once published).

## license

FSL-1.1-Apache-2.0 - see LICENSE.
