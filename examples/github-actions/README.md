# Owlette GitHub Actions examples

Copy these workflow templates into consumer repositories once `@owlette/cli` is published to npm. It is not yet, so until then the action's install step fails.

| file | purpose |
|---|---|
| `roost-deploy.yml` | build an artifact, publish it as a Roost version, and deploy it with the Owlette CLI action |

Required repository configuration:

- secret `OWLETTE_TOKEN`: scoped Owlette API key
- variable `OWLETTE_SITE_ID`: target site id
- variable `OWLETTE_ROOST_ID`: target Roost id
- optional variable `OWLETTE_API_URL`: defaults to `https://owlette.app`

Recommended key scope:

- `site=<site-id>:write`
- `roost=<roost-id>:write,deploy`
