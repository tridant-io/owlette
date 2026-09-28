#!/bin/bash
# the owlette package for linux (tri-platform 5.2, multi-platform releases
# 1.2): one `Owlette-Installer-v<ver>.deb` — the service runtime under
# /opt/owlette, its system unit, the app's user unit, the polkit rule, and the
# desktop app itself (the Tauri build's deb, unpacked into the payload with
# its Depends carried over). the package stays `owlette-agent` and provides,
# replaces and conflicts with the old `owlette` app package, so a box on the
# two-package install upgrades in one apt-get install. runs on the
# architecture it packages for (x86_64 or aarch64) with the Tauri build
# dependencies, cargo and node installed; nothing here needs root, and
# dpkg-deb owns the payload to root itself.
#
#   agent/build/linux/build.sh [--skip-app]
#
# --skip-app reuses the newest deb under desktop/src-tauri/target/release/
# bundle/deb instead of building the app.
#
# release order (CLAUDE.md): the version is read from agent/VERSION, so bump
# and commit before building — the file name and the payload carry it.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="${REPO}/agent/build/linux"
WORK="${OUT}/work"
PAYLOAD="${WORK}/payload"
PACKAGING="${REPO}/agent/packaging/linux"
VERSION="$(tr -d '[:space:]' < "${REPO}/agent/VERSION")"
DEB="${OUT}/Owlette-Installer-v${VERSION}.deb"
# the interpreter is pinned to one python-build-standalone release; the sums
# are the release's SHA256SUMS, and the three move together.
PYTHON_BUILD="3.11.16+20260924"
PBS_SHA256_x86_64="49a52eb189878431a36efd137e7cd08f6429e59dc049b9cfb030bf706eb33fd4"
PBS_SHA256_aarch64="96f6f6af710762a34507ba222435a8d58d0b2a97c48cb84c0a0c73cdff199bb0"
SKIP_APP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-app) SKIP_APP=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$(uname -m)" in
  x86_64) ARCH=amd64; PBS_ARCH=x86_64-unknown-linux-gnu; PBS_SHA256="${PBS_SHA256_x86_64}" ;;
  aarch64) ARCH=arm64; PBS_ARCH=aarch64-unknown-linux-gnu; PBS_SHA256="${PBS_SHA256_aarch64}" ;;
  *) echo "build.sh: unsupported architecture $(uname -m)" >&2; exit 2 ;;
esac
say() { echo "== $*"; }

rm -rf "${WORK}"
mkdir -p "${PAYLOAD}/opt/owlette" "${PAYLOAD}/usr/lib/systemd/system" "${PAYLOAD}/usr/lib/systemd/user" \
         "${PAYLOAD}/etc/polkit-1/rules.d" "${PAYLOAD}/DEBIAN" "${OUT}/cache"
RUNTIME="${PAYLOAD}/opt/owlette"

# --- the interpreter: python-build-standalone, cached by exact build ---------
TAG="${PYTHON_BUILD#*+}"
TARBALL="cpython-${PYTHON_BUILD}-${PBS_ARCH}-install_only.tar.gz"
if [ ! -f "${OUT}/cache/${TARBALL}" ]; then
  say "fetching ${TARBALL}"
  curl -sSL --fail -o "${OUT}/cache/${TARBALL}.part" \
    "https://github.com/astral-sh/python-build-standalone/releases/download/${TAG}/${TARBALL}"
  mv "${OUT}/cache/${TARBALL}.part" "${OUT}/cache/${TARBALL}"
fi
# checked on every run, not only after a download: a warm cache is not a
# verified one. a mismatch is left in place for a look.
say "verifying ${TARBALL}"
echo "${PBS_SHA256}  ${OUT}/cache/${TARBALL}" | sha256sum -c - \
  || { echo "build.sh: ${OUT}/cache/${TARBALL} does not match its pinned sha256" >&2; exit 1; }
say "unpacking the runtime"
tar -xzf "${OUT}/cache/${TARBALL}" -C "${RUNTIME}"
PY="${RUNTIME}/python/bin/python3"
"${PY}" --version

# --- the agent and its dependencies -----------------------------------------
say "installing agent dependencies into the runtime"
"${PY}" -m pip install --quiet --no-warn-script-location --upgrade pip
"${PY}" -m pip install --quiet --no-warn-script-location -r "${REPO}/agent/requirements.txt"
say "staging agent/src"
mkdir -p "${RUNTIME}/agent"
rsync -a --exclude '__pycache__' --exclude '*.pyc' --exclude '.venv' \
  "${REPO}/agent/src" "${REPO}/agent/VERSION" "${REPO}/agent/requirements.txt" "${RUNTIME}/agent/"
find "${RUNTIME}/python" -name '__pycache__' -type d -prune -exec rm -rf {} +
# the runtime is executed as root and read by nobody else: no group or world
# write bits anywhere in it.
chmod -R go-w "${RUNTIME}"

# --- the app --------------------------------------------------------------------
if [ "${SKIP_APP}" = "0" ]; then
  say "building the app"
  ( cd "${REPO}/desktop" && npm ci --no-audit --no-fund --silent && npx tauri build --bundles deb --ci )
fi
APP_DEB="$(ls -t "${REPO}"/desktop/src-tauri/target/release/bundle/deb/*.deb 2>/dev/null | head -1 || true)"
[ -n "${APP_DEB}" ] || { echo "build.sh: no app .deb under desktop/src-tauri/target/release/bundle/deb" >&2; exit 1; }
# the app's tree (/usr/bin/owlette-desktop, its .desktop file, its icons) joins
# the payload and its runtime libraries join Depends: one package, one install.
say "merging ${APP_DEB##*/} into the payload"
dpkg-deb -x "${APP_DEB}" "${PAYLOAD}"
APP_DEPENDS="$(dpkg-deb -f "${APP_DEB}" Depends)"
[ -n "${APP_DEPENDS}" ] || { echo "build.sh: ${APP_DEB##*/} declares no Depends" >&2; exit 1; }

# --- the package ------------------------------------------------------------------
cp "${PACKAGING}/owlette-agent.service" "${PAYLOAD}/usr/lib/systemd/system/"
cp "${PACKAGING}/owlette-desktop.service" "${PAYLOAD}/usr/lib/systemd/user/"
cp "${PACKAGING}/49-owlette.rules" "${PAYLOAD}/etc/polkit-1/rules.d/"
chmod 644 "${PAYLOAD}/usr/lib/systemd/system/"* "${PAYLOAD}/usr/lib/systemd/user/"* "${PAYLOAD}/etc/polkit-1/rules.d/"*
cp "${PACKAGING}/debian/postinst" "${PACKAGING}/debian/prerm" "${PAYLOAD}/DEBIAN/"
chmod 755 "${PAYLOAD}/DEBIAN/postinst" "${PAYLOAD}/DEBIAN/prerm"
SIZE_KB=$(du -sk "${PAYLOAD}/opt" "${PAYLOAD}/usr" "${PAYLOAD}/etc" | awk '{s+=$1} END {print s}')
cat > "${PAYLOAD}/DEBIAN/control" <<EOF
Package: owlette-agent
Version: ${VERSION}
Section: admin
Priority: optional
Architecture: ${ARCH}
Installed-Size: ${SIZE_KB}
Depends: ${APP_DEPENDS}, polkitd | policykit-1
Provides: owlette
Replaces: owlette
Conflicts: owlette
Maintainer: Tridant <support@owlette.app>
Homepage: https://owlette.app
Description: owlette — the process monitoring and remote management service and its app
 The owlette service with its own Python runtime under /opt/owlette, the
 systemd unit that runs it, the desktop app with the user unit that starts it
 for every login, and the polkit rule that lets the owlette group control the
 service. Supersedes the separate owlette app package.
EOF

say "building ${DEB##*/}"
dpkg-deb --build --root-owner-group "${PAYLOAD}" "${DEB}" >/dev/null

say "done"
ls -la "${DEB}"
sha256sum "${DEB}"
dpkg-deb --info "${DEB}"
