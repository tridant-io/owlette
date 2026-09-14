# public launch assets

**Last updated**: 2026-04-29 | **moved** 2026-09-05 from `docs/api/launch-assets.md` | **reviewed** 2026-09-05

**INTERNAL — keep inside `docs/internal/`**, which the fumadocs migration excludes from
publishing (`excludedPrefixes` in `web/scripts/migrate-docs-to-fumadocs.mjs`). This page was
written for the MkDocs site that was deleted 2026-05-20 and never reached a published docs
route. It is a launch-marketing worksheet — draft registry copy, unclosed gates — not customer
documentation.

> **2026-09-05 accuracy review.** Corrected against HEAD: the dead `theexperiential.github.io`
> docs URL, and every `docs/api/*.md` example source, which now lives in fumadocs under
> `web/content/docs/api/`. Verified still true: the SDK example directories, the reusable
> GitHub Action, the copyable workflow template, and the landing/signup/download routes.
> Verified changed and flagged inline: billing was removed end to end (`adbfd06f`), so the
> "truthful pricing/signup path" the page opens with now means beta copy, not a checkout. Not
> verifiable from the repo: the marketplace listing copy below has never been submitted
> anywhere, so treat it as a draft.

External public launch needs more than working routes. The launch surface must give developers a clear place to land, a truthful pricing/signup path, copy-paste examples, and supportable marketplace assets.

Developer preview can proceed without this page being complete. External launch should not.

Use the [public API launch runbook](public-api-launch-runbook.md) to move from preview to launch-ready, staff support, monitor the first week, and choose rollback paths.

---

## launch gate

5.4 is externally complete when:

- the landing page, pricing copy, docs links, signup path, and download path have been checked against the current product state
- public API docs link to the launch-critical pages: quickstart, SDKs, CLI, status, load testing/SLOs, distribution, and examples
- the GitHub Actions roost deploy asset has a usage doc, a copyable workflow template, and a scoped-key recommendation
- Node and Python SDK examples are grouped into launch-ready workflows, not only internal fixtures
- marketplace/listing copy is ready for npm, PyPI, and GitHub Actions
- the launch ticket links the public launch runbook and records support, rollback, status-page, package, and load-test owners
- external example repositories are created or deliberately waived in favor of in-repo templates
- no public page claims npm, PyPI, Homebrew, Scoop, winget, custom-domain status, or paid billing is live before the corresponding Wave 5 gate is closed
  > **status 2026-09-05:** every one of those is still open. `@owlette/cli` and `@owlette/sdk`
  > return 404 from npm and `owlette-sdk` is unpublished; `status.owlette.app` does not resolve;
  > and paid billing does not exist at all — `adbfd06f` removed the billing system end to end,
  > so `web/lib/billing` and the Stripe integration are gone and the landing tiers read "free
  > during beta" with post-beta rates quoted from `web/lib/product-facts.ts`.

---

## launch URLs

| surface | URL | gate |
|---|---|---|
| landing page | `https://owlette.app/` | must load with signup, docs, pricing, and download links |
| signup | `https://owlette.app/register` | must create or request access for the launch cohort |
| download | `https://owlette.app/download` | must serve the current installer path or clear setup instructions |
| API reference | `https://owlette.app/docs/api` | backed by `/api/openapi` |
| full docs | `https://owlette.app/docs` | fumadocs, built with the app (`npm run build`); the old `tridant-io.github.io/owlette` MkDocs site was deleted 2026-05-20 |
| status page | Instatus hosted URL | Wave 5.1 blocked until configured |
| npm CLI | `@owlette/cli@rc` | Wave 5.3 blocked until published |
| npm SDK | `@owlette/sdk@rc` | Wave 5.3 blocked until published |
| PyPI SDK | `owlette-sdk` pre-release | Wave 5.3 blocked until published |

---

## example assets

| asset | source | launch use |
|---|---|---|
| public API quickstart | `web/content/docs/api/quickstart.mdx` → `/docs/api/quickstart` | first REST smoke workflow |
| SDK workflow guide | `web/content/docs/api/examples/sdk-workflows.mdx` → `/docs/api/examples/sdk-workflows` | Node and Python example index |
| Node examples | `sdks/node/examples/*.ts` | executable SDK starters |
| Python examples | `sdks/python/examples/*.py` | executable SDK starters |
| GitHub Actions guide | `web/content/docs/api/examples/ci-cd-github-actions.mdx` → `/docs/api/examples/ci-cd-github-actions` | CI/CD setup docs |
| reusable GitHub Action | `.github/actions/owlette-roost-deploy/` | publish/deploy roost from CI |
| copyable workflow template | `examples/github-actions/roost-deploy.yml` | starter workflow for customer repos |

External example repositories remain optional for the first launch if the in-repo templates above are linked from docs and verified against a clean checkout.

---

## marketplace copy

### GitHub Action

**Name**: Owlette roost deploy

**Tagline**: Publish and deploy Owlette roost versions from GitHub Actions.

**Description**: Build an artifact, publish the output directory as a content-addressed Owlette roost version, and optionally deploy it to your fleet. The action uses `@owlette/cli`, scoped API keys, and public API routes.

**Recommended categories/tags**: deployment, ci, release, automation, windows, signage.

**Required secret**: `OWLETTE_TOKEN`.

**Required variables**: `OWLETTE_SITE_ID`, `OWLETTE_ROOST_ID`.

### npm CLI

**Package**: `@owlette/cli`

**Short description**: Command-line client for the Owlette public API.

**Keywords**: owlette, deployment, monitoring, windows, signage, touchdesigner, ci.

### npm SDK

**Package**: `@owlette/sdk`

**Short description**: TypeScript SDK for the Owlette public API.

**Keywords**: owlette, sdk, api, deployment, monitoring, webhooks.

### PyPI SDK

**Package**: `owlette-sdk`

**Short description**: Async Python SDK for the Owlette public API.

**Keywords**: owlette, sdk, api, async, deployment, monitoring, webhooks.

---

## current status

The launch asset foundation is in-repo. External completion remains blocked until the public site is deployed with final pricing/signup decisions, package distribution is live, and at least one clean consumer workflow runs against a dev or staging roost fixture.
