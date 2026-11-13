# Owlette Roost Deploy action

Publishes a directory as a new Owlette Roost version and optionally deploys that exact version to the Roost target fleet.

This action is a launch asset. It installs `@owlette/cli@rc` from npm, which is not published yet, so until it is the install step fails (see [distribution](https://owlette.app/docs/api/distribution)).

## Usage

```yaml
name: deploy with owlette

on:
  push:
    tags:
      - 'v*.*.*'

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-node@v6
        with:
          node-version: '20'

      - run: npm ci
      - run: npm run build

      - uses: tridant-io/owlette/.github/actions/owlette-roost-deploy@main
        with:
          token: ${{ secrets.OWLETTE_TOKEN }}
          site-id: ${{ vars.OWLETTE_SITE_ID }}
          roost-id: ${{ vars.OWLETTE_ROOST_ID }}
          path: dist
          description: ${{ github.ref_name }}
```

## Required Owlette key scope

Use a dedicated CI key with the narrowest scope that supports the workflow:

- `site=<site-id>:write` for the chunk dedup check and signed upload URLs
- `roost=<roost-id>:write,deploy` for the version publish and the deploy

Use `deploy: false` when you only want to publish a version and trigger deployment manually; the key can then omit roost `deploy`.
