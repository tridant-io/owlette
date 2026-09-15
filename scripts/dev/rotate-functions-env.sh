#!/usr/bin/env bash
# Point the Cloud Functions R2 credentials of one Firebase project at the tridant
# Cloudflare account, then redeploy the only function that reads them (chunkGcNightly).
# Values come from .claude/.env.tridant (gitignored) and are never echoed.
#   bash scripts/dev/rotate-functions-env.sh dev  [--dry-run]
#   bash scripts/dev/rotate-functions-env.sh prod [--dry-run]
# The previous env file is copied to .claude/.env.functions-<project>-backup first.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_NAME="${1:?dev | prod}"
DRY="${2:-}"
case "$ENV_NAME" in
  dev) PROJECT=owlette-dev-3838a ;;
  prod) PROJECT=owlette-prod-90a12 ;;
  *) echo "unknown env: $ENV_NAME"; exit 1 ;;
esac
SRC="$ROOT/.claude/.env.tridant"
TARGET="$ROOT/functions/.env.$PROJECT"
BACKUP="$ROOT/.claude/.env.functions-$PROJECT-backup"
[ -f "$SRC" ] || { echo "missing $SRC"; exit 1; }
[ -f "$TARGET" ] || { echo "missing $TARGET"; exit 1; }
val() { grep -E "^$1=" "$SRC" | head -1 | cut -d= -f2- | sed -E "s/^[\"']|[\"']$//g"; }
for k in R2_S3_ENDPOINT R2_APP_S3_ACCESS_KEY_ID R2_APP_S3_SECRET_ACCESS_KEY; do
  [ -n "$(val "$k")" ] || { echo "empty in .env.tridant: $k"; exit 1; }
done
echo "target: $TARGET (project $PROJECT)"
echo "keys:   R2_S3_ENDPOINT R2_S3_ACCESS_KEY_ID R2_S3_SECRET_ACCESS_KEY (ROOST_ENV and the rest untouched)"
if [ "$DRY" = "--dry-run" ]; then echo "(dry run: nothing written, nothing deployed)"; exit 0; fi

# Back up once: a re-run after a failed deploy must not overwrite the original with the rewritten file.
if [ -f "$BACKUP" ]; then echo "backup already exists, keeping it: $BACKUP"; else cp "$TARGET" "$BACKUP"; echo "backup: $BACKUP"; fi
NEW_ENDPOINT="$(val R2_S3_ENDPOINT)" NEW_KEY="$(val R2_APP_S3_ACCESS_KEY_ID)" NEW_SECRET="$(val R2_APP_S3_SECRET_ACCESS_KEY)" \
python - "$TARGET" <<'PY'
import os, sys
path = sys.argv[1]
repl = {
    'R2_S3_ENDPOINT': os.environ['NEW_ENDPOINT'],
    'R2_S3_ACCESS_KEY_ID': os.environ['NEW_KEY'],
    'R2_S3_SECRET_ACCESS_KEY': os.environ['NEW_SECRET'],
}
seen = set()
out = []
for line in open(path, encoding='utf-8').read().splitlines():
    key = line.split('=', 1)[0].strip() if '=' in line and not line.lstrip().startswith('#') else None
    if key in repl:
        out.append(f'{key}={repl[key]}')
        seen.add(key)
    else:
        out.append(line)
missing = set(repl) - seen
if missing:
    sys.exit(f'keys not present in {path}: {sorted(missing)}')
open(path, 'w', encoding='utf-8', newline='\n').write('\n'.join(out) + '\n')
changed = sum(1 for k in repl if k in seen)
print(f'rewrote {changed} keys in {path}')
PY

# verify by equality only
python - "$TARGET" "$SRC" <<'PY'
import sys
def load(p):
    d = {}
    for l in open(p, encoding='utf-8'):
        l = l.strip()
        if not l or l.startswith('#') or '=' not in l: continue
        k, v = l.split('=', 1); d[k] = v.strip().strip('"').strip("'")
    return d
t, s = load(sys.argv[1]), load(sys.argv[2])
ok = (t['R2_S3_ENDPOINT'] == s['R2_S3_ENDPOINT'] and t['R2_S3_ACCESS_KEY_ID'] == s['R2_APP_S3_ACCESS_KEY_ID']
      and t['R2_S3_SECRET_ACCESS_KEY'] == s['R2_APP_S3_SECRET_ACCESS_KEY'])
print('functions env now matches .env.tridant (endpoint + app key + secret):', ok)
print('ROOST_ENV:', t.get('ROOST_ENV'))
sys.exit(0 if ok else 1)
PY

echo "deploying chunkGcNightly to $PROJECT (predeploy runs the tsc build)"
cd "$ROOT"
# FUNCTIONS_DISCOVERY_TIMEOUT is in seconds; the CLI default of 10 s lost a startup race on 2026-09-14.
FUNCTIONS_DISCOVERY_TIMEOUT=60 firebase deploy --only functions:chunkGcNightly --project "$PROJECT" --non-interactive 2>&1 \
  | grep -viE 'token|secret' | sed -E 's/[A-Za-z0-9_-]{28,}/***/g'
echo "done: $PROJECT chunkGcNightly redeployed with tridant R2 credentials"
