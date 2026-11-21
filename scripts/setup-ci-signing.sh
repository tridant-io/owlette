#!/usr/bin/env bash
#
# lets a tagged owlette build sign with tridantsigning and no stored secret: a separate entra app that
# trusts only this repo's `release` environment, holding only the signing role. safe to re-run.
# run it in git bash on windows, signed in to gh as a repo admin.

set -euo pipefail

REPO="tridant-io/owlette"
APP_NAME="owlette-ci-signing"
ROLE="Artifact Signing Certificate Profile Signer"
# git bash would rewrite /subscriptions/... arguments into windows paths
export MSYS_NO_PATHCONV=1
# no subscription picker after the browser sign-in
export AZURE_CORE_LOGIN_EXPERIENCE_V2=off
# the windows account picker failed this sign-in on TEC-A4D; the browser works
export AZURE_CORE_ENABLE_BROKER_ON_WINDOWS=false

stage() { printf '\n== %s\n' "$1"; }
ok() { printf '  ok: %s\n' "$1"; }
fail() { printf '  stopped: %s\n' "$1"; exit 1; }
pause() { printf '  %s ' "$1"; read -r _ || true; }

# az on windows ends its tsv lines with a carriage return
azv() { az "$@" --only-show-errors -o tsv | tr -d '\r'; }

federate() {
  local name="$1" subject="$2" file
  if [[ -n "$(azv ad app federated-credential list --id "$APP_ID" --query "[?name=='$name'].name")" ]]; then
    ok "$name was already there"
    return
  fi
  file="$(cygpath -m "$(mktemp)")"
  printf '{"name":"%s","issuer":"https://token.actions.githubusercontent.com","subject":"%s","audiences":["api://AzureADTokenExchange"]}' "$name" "$subject" > "$file"
  az ad app federated-credential create --id "$APP_ID" --parameters "@$file" --only-show-errors -o none
  rm -f "$file"
  ok "added $name"
}

grant() {
  if [[ -n "$(azv role assignment list --assignee "$SP_ID" --role "$ROLE" --scope "$1" --query '[].id')" ]]; then
    ok "signer role was already held on ${1##*/}"
    return
  fi
  az role assignment create --assignee-object-id "$SP_ID" --assignee-principal-type ServicePrincipal \
    --role "$ROLE" --scope "$1" --only-show-errors -o none
  ok "granted the signer role on ${1##*/}"
}

pause "This signs you in to Azure and sets up CI signing. Press Enter to start."

stage "Sign in to Azure"
TENANT="${AZURE_TENANT_ID:-$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('AZURE_TENANT_ID','User')" | tr -d '\r')}"
[[ -n "$TENANT" ]] || fail "AZURE_TENANT_ID is not set on this machine. Run this on TEC-A4D or TEC-B4A."
printf '  A browser opens. Sign in with the account that created moonshine-signing.\n'
az login --tenant "$TENANT" --only-show-errors -o none
trap 'az logout --only-show-errors >/dev/null 2>&1 || true' EXIT

ACCOUNT_ID=""
for sub in $(azv account list --query '[].id'); do
  ACCOUNT_ID="$(azv resource list --subscription "$sub" --name tridantsigning \
    --resource-type Microsoft.CodeSigning/codeSigningAccounts --query '[0].id')"
  [[ -n "$ACCOUNT_ID" ]] && break
done
[[ -n "$ACCOUNT_ID" ]] || fail "this account cannot see the tridantsigning signing account. Re-run with the account that can."
RG_ID="${ACCOUNT_ID%%/providers/*}"
ok "found tridantsigning"

stage "Create $APP_NAME and let only the release environment use it"
APP_ID="$(azv ad app list --display-name "$APP_NAME" --query '[0].appId')"
if [[ -z "$APP_ID" ]]; then
  APP_ID="$(azv ad app create --display-name "$APP_NAME" --sign-in-audience AzureADMyOrg --query appId)"
fi
SP_ID="$(azv ad sp list --filter "appId eq '$APP_ID'" --query '[0].id')"
if [[ -z "$SP_ID" ]]; then
  SP_ID="$(azv ad sp create --id "$APP_ID" --query id)"
fi
ok "the app is ready, with no client secret"

# this repo uses github's immutable subject format, and the azure portal's github form writes the other one.
# the by-name form is what github issues if the repo goes back to its default; it follows the repo's name.
PREFIX="$(gh api "repos/$REPO/actions/oidc/customization/sub" --jq .sub_claim_prefix | tr -d '\r')"
federate owlette-release "$PREFIX:environment:release"
federate owlette-release-by-name "repo:$REPO:environment:release"

# the same two scopes moonshine-signing signs with
grant "$ACCOUNT_ID"
grant "$RG_ID"

stage "Give the release environment the ids"
printf '%s' "$APP_ID" | gh secret set AZURE_CLIENT_ID --env release --repo "$REPO"
printf '%s' "$TENANT" | gh secret set AZURE_TENANT_ID --env release --repo "$REPO"
for name in AZURE_CLIENT_ID AZURE_TENANT_ID; do
  gh secret list --env release --repo "$REPO" --json name --jq '.[].name' | tr -d '\r' | grep -qx "$name" \
    || fail "$name did not land on the release environment."
  ok "set $name"
done

printf '\nSetup complete. You are signed out of Azure again.\n'
