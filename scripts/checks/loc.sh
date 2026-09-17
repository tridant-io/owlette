#!/bin/sh
# The line-count metric the tri-platform and swoop plans are budgeted against:
# every tracked file in the extension set below, plus the fixed-name POSIX
# maintainer scripts. Declarative data (.json, .plist, .service, .desktop,
# .md/.mdx) is free and named in each plan's ledger instead of counted here.
# POSIX sh on purpose — it runs under Git Bash on windows and dash on ubuntu.
set -eu

RE='(\.(py|rs|ts|tsx|js|mjs|cjs|css|sh|bat|ps1|iss|toml|yml|yaml)|/(postinstall|postinst|preinst|prerm|postrm))$'

usage() {
  cat <<'EOF'
usage: loc.sh [--per-dir | --against <n> | --between <baseRef> <headRef>]
       with no argument: the total tracked lines in the metric's file set
EOF
}

# wc prints a "total" row per xargs batch, and none at all for a batch of one,
# so both readers below sum the per-file rows and drop the batch totals. The
# index still lists a file deleted in the working tree until it is committed,
# so paths that no longer exist are dropped before wc sees them.
counts() {
  git ls-files -z | grep -zE "$RE" \
    | xargs -0 -n 200 sh -c 'for f; do [ -f "$f" ] && printf "%s\0" "$f"; done; :' sh \
    | xargs -0 wc -l
}

count_total() {
  counts | awk '$NF != "total" { n += $1 } END { print n + 0 }'
}

per_dir() {
  counts | awk '
    $NF == "total" { next }
    {
      name = $0
      sub(/^[ \t]*[0-9]+[ \t]+/, "", name)
      depth = split(name, seg, "/")
      if (depth == 1) key = "(root)"
      else if (depth == 2) key = seg[1]
      else key = seg[1] "/" seg[2]
      dir[key] += $1
    }
    END { for (k in dir) printf "%8d  %s\n", dir[k], k }
  ' | sort -rn
}

# --no-renames so a rename becomes a delete plus an add: both paths are then
# tested against the file set, and one renamed out of it counts as the loss it
# is. Binary rows carry "-" for both counts and are skipped. A pipeline hides
# git's own exit status, so both refs are resolved before the diff runs.
between() {
  for ref in "$1" "$2"; do
    git rev-parse --verify --quiet "$ref^{commit}" >/dev/null || { echo "loc.sh: no such commit: $ref" >&2; exit 2; }
  done
  git -c core.quotepath=false diff --numstat --no-renames "$1..$2" |
    grep -E "$RE" |
    awk -F'\t' '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ { d += $1 - $2 } END { printf "%+d\n", d + 0 }'
}

cd "$(git rev-parse --show-toplevel)"

case "${1-}" in
  '') count_total ;;
  --per-dir) [ $# -eq 1 ] || { usage >&2; exit 2; }; per_dir ;;
  --against)
    [ $# -eq 2 ] || { usage >&2; exit 2; }
    case "$2" in
      '' | *[!0-9]*) echo "loc.sh: --against wants a whole number, got '$2'" >&2; exit 2 ;;
    esac
    TOTAL="$(count_total)"
    echo "$TOTAL"
    [ "$TOTAL" -le "$2" ] || { echo "over $2 by $((TOTAL - $2))"; exit 1; }
    echo "within $2"
    ;;
  --between)
    [ $# -eq 3 ] || { usage >&2; exit 2; }
    between "$2" "$3"
    ;;
  -h | --help) [ $# -eq 1 ] || { usage >&2; exit 2; }; usage ;;
  *) usage >&2; exit 2 ;;
esac
