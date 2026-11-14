# @owlette/cli

command-line client for the [owlette.app](https://owlette.app) public api. authenticate, push roosts, manage sites and machines, mint api keys, inspect audit logs - from your terminal or ci pipeline.

## install

`@owlette/cli` is not on npm yet. Until the `rc` tag is published, install from a checkout of this repository:

```bash
cd cli
npm install
npm run build
npm link
owlette --version
```

Once it is published:

```bash
npm install -g @owlette/cli@rc
```

## 30-second auth + push

```bash
owlette auth login
owlette whoami
owlette roost push ./my-project --to rst_my_project_id --site site-1
```

## commands

- `roost` - push, list, inspect, diff, and deploy content-addressed project bundles; use top-level `rollback` to revert versions.
- `machine` - list machines, inspect machine state, view deployments, and run supported machine actions.
- `swoop` - open the swoop remote-desktop viewer for a machine in owlette swoop, the desktop viewer app, when it is installed and the profile points at owlette.app or dev.owlette.app, else in your browser (`--browser` forces the browser).
- `audit-log` - list and inspect site audit-log records for operational history.
- `quota` - inspect current quota usage and usage history for a site.
- `chat` - create, list, send, rename, and delete hoot chat sessions.
- `deploy` - manage classic installer deploys; use `roost deploy` for content-addressed project deploys.
- `process` - manage process lifecycle on site machines.
- `key` - list your api keys and mint new ones with the calling key's scopes, with a superadmin key (`user=*:admin`); rotate and revoke them, and anything a non-superadmin needs, in the dashboard.
- `site` - list accessible sites, inspect site details, and manage members: list, add, set a role, remove, and transfer ownership.
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
site's plan does not cover fails with `402 plan_required`, and the
message says what the plan lacks. API keys are part of pro, checked against
the plan of the site each command acts on: on a site without them every
command made with a key fails that way. `owlette auth login` and creating a
key are never refused by a plan. See [plans](https://owlette.app/docs/plans).

full docs at [owlette.app/docs/cli/overview](https://owlette.app/docs/cli/overview).

## license

FSL-1.1-Apache-2.0 - see LICENSE.
