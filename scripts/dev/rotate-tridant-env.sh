#!/usr/bin/env bash
# Rotate the R2 + Turnstile values of one Railway service to the tridant Cloudflare account.
# Reads values from .claude/.env.tridant (gitignored); never echoes them.
#   bash scripts/dev/rotate-tridant-env.sh owlette-dev [--dry-run]
#   bash scripts/dev/rotate-tridant-env.sh owlette-prod [--dry-run]
# One `railway variable` call sets all five keys, so the service redeploys once.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SERVICE="${1:?service name (owlette-dev | owlette-prod)}"
DRY="${2:-}"
ENVF="$ROOT/.claude/.env.tridant"
[ -f "$ENVF" ] || { echo "missing $ENVF"; exit 1; }
val() { grep -E "^$1=" "$ENVF" | head -1 | cut -d= -f2- | sed -E "s/^[\"']|[\"']$//g"; }
need() { [ -n "$(val "$1")" ] || { echo "empty: $1"; exit 1; }; }
for k in R2_S3_ENDPOINT R2_APP_S3_ACCESS_KEY_ID R2_APP_S3_SECRET_ACCESS_KEY NEXT_PUBLIC_TURNSTILE_SITE_KEY_TRIDANT TURNSTILE_SECRET_TRIDANT; do need "$k"; done
echo "target: service=$SERVICE environment=dev (Railway's single environment)"
echo "keys:   R2_S3_ENDPOINT R2_S3_ACCESS_KEY_ID R2_S3_SECRET_ACCESS_KEY NEXT_PUBLIC_TURNSTILE_SITE_KEY TURNSTILE_SECRET"
if [ "$DRY" = "--dry-run" ]; then echo "(dry run: nothing set)"; exit 0; fi
railway variable -s "$SERVICE" -e dev \
  --set "R2_S3_ENDPOINT=$(val R2_S3_ENDPOINT)" \
  --set "R2_S3_ACCESS_KEY_ID=$(val R2_APP_S3_ACCESS_KEY_ID)" \
  --set "R2_S3_SECRET_ACCESS_KEY=$(val R2_APP_S3_SECRET_ACCESS_KEY)" \
  --set "NEXT_PUBLIC_TURNSTILE_SITE_KEY=$(val NEXT_PUBLIC_TURNSTILE_SITE_KEY_TRIDANT)" \
  --set "TURNSTILE_SECRET=$(val TURNSTILE_SECRET_TRIDANT)" \
  >/dev/null
echo "set 5 variables on $SERVICE; Railway is redeploying it"
