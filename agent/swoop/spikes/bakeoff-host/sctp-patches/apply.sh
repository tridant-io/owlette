#!/usr/bin/env bash
# Materialise the patched SCTP stack into `vendor/`, for the
# `--config .cargo/sctp-patched.toml` build of arm A.
#
#   cd agent/swoop/spikes/bakeoff-host
#   bash sctp-patches/apply.sh                 # the two patches worth keeping
#   SWOOP_SCTP_SENDBUFFER=1 bash sctp-patches/apply.sh   # …plus the 2 MB cap
#   cargo run --release --config .cargo/sctp-patched.toml -- \
#       serve --arm a --dc-load 50000000
#
# The sources are copied out of the local cargo registry rather than committed,
# so the repository carries the diffs and not 3.5 MB of somebody else's crate.
# `vendor/` is gitignored; the default build does not need it, and
# `cargo clippy -- -D warnings` / `cargo test` run against the released crates.
#
# The patch set, and what each one measured (review-1-latency.md F1 names the
# constants; the reason for each is in the comment the patch inserts):
#
#   sctp-proto.patch        initial cwnd 4380 B -> IW10, and the post-RTO cwnd
#                           floor 1 MTU -> 4 MTU. Neutral on loopback, which is
#                           the expected result: both only bite on loss or RTT.
#                           50/100/200 Mbps offered gave 50.0/100.0/166.3 Mbps
#                           against 50.0/100.0/164.0 stock.
#   str0m-rto.patch         RTO_INITIAL 3000 -> 500 ms, RTO_MIN 1000 -> 400 ms,
#                           through sctp-proto's existing public setters, which
#                           str0m simply never calls. Also neutral on loopback.
#   str0m-sendbuffer.patch  MAX_BUFFERED_ACROSS_STREAMS 128 KiB -> 2 MB.
#                           **Harmful here and therefore opt-in**: over a 17.5 s
#                           window it carried 43.7 Mbps against a 100 Mbps offer
#                           with the buffer pegged at 1 999 999 bytes, versus
#                           100.0 Mbps and 131 063 bytes unpatched over 17.1 s.
#                           sctp-proto has no pacer and no `max_burst`, so the
#                           extra room becomes a standing queue, not throughput.
#                           It is
#                           still the constraint at a real RTT (128 KiB / 40 ms =
#                           26 Mbps), which is stage 3's measurement, not this
#                           one's.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
reg="${CARGO_HOME:-$HOME/.cargo}/registry/src"
src="$(find "$reg" -maxdepth 1 -type d -name 'index.crates.io-*' | head -1)"
[ -n "$src" ] || { echo "no crates.io registry under $reg; run 'cargo fetch' first" >&2; exit 1; }

apply_one() {
  local name="$1" crate="$2"
  shift 2
  [ -d "$src/$crate" ] || { echo "$crate is not in the registry; run 'cargo fetch' first" >&2; exit 1; }
  local target="$root/vendor/$name"
  if [ -e "$target" ]; then
    echo "vendor/$name already exists — move it aside yourself if you want it rebuilt" >&2
    return 0
  fi
  mkdir -p "$root/vendor"
  cp -r "$src/$crate" "$target"
  chmod -R u+w "$target"
  for p in "$@"; do
    ( cd "$target" && patch -p1 --forward < "$here/$p" )
  done
  echo "vendor/$name patched from $crate with: $*"
}

str0m_patches=(str0m-rto.patch)
if [ "${SWOOP_SCTP_SENDBUFFER:-0}" = "1" ]; then
  str0m_patches+=(str0m-sendbuffer.patch)
fi

apply_one sctp-proto sctp-proto-0.10.4 sctp-proto.patch
apply_one str0m str0m-0.23.1 "${str0m_patches[@]}"
