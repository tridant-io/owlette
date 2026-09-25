#!/bin/bash
# the owlette packages for linux (tri-platform 5.2): `owlette-agent_<ver>_<arch>.deb`
# (the service runtime under /opt/owlette, its system unit, the app's user unit
# and the polkit rule) beside the app's own `owlette_<ver>_<arch>.deb` from the
# Tauri build. runs on the architecture it packages for (x86_64 or aarch64)
# with the Tauri build dependencies, cargo and node installed; nothing here
# needs root, and dpkg-deb owns the payload to root itself.
#
#   agent/build/linux/build.sh [--python 3.11.16+20260924] [--skip-app]
#
# release order (CLAUDE.md): the version is read from agent/VERSION, so bump
# and commit before building — the file names and the payload carry it.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="${REPO}/agent/build/linux"
WORK="${OUT}/work"
PAYLOAD="${WORK}/payload"
PACKAGING="${REPO}/agent/packaging/linux"
VERSION="$(tr -d '[:space:]' < "${REPO}/agent/VERSION")"
PYTHON_BUILD="3.11.16+20260924"
SKIP_APP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --python) PYTHON_BUILD="$2"; shift 2 ;;
    --skip-app) SKIP_APP=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$(uname -m)" in
  x86_64) ARCH=amd64; PBS_ARCH=x86_64-unknown-linux-gnu ;;
  aarch64) ARCH=arm64; PBS_ARCH=aarch64-unknown-linux-gnu ;;
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
Depends: owlette (>= ${VERSION}), polkitd | policykit-1
Maintainer: Tridant <support@owlette.app>
Homepage: https://owlette.app
Description: owlette agent — the process monitoring and remote management service
 The owlette service with its own Python runtime under /opt/owlette, the
 systemd unit that runs it, the user unit that starts the owlette desktop app
 for every login, and the polkit rule that lets the owlette group control the
 service.
EOF

# --- the app --------------------------------------------------------------------
if [ "${SKIP_APP}" = "0" ]; then
  say "building the app"
  ( cd "${REPO}/desktop" && npm ci --no-audit --no-fund --silent && npx tauri build --bundles deb --ci )
fi
APP_DEB="$(ls -t "${REPO}"/desktop/src-tauri/target/release/bundle/deb/*.deb 2>/dev/null | head -1 || true)"
[ -n "${APP_DEB}" ] || { echo "build.sh: no app .deb under desktop/src-tauri/target/release/bundle/deb" >&2; exit 1; }

# --- the packages ----------------------------------------------------------------
say "building owlette-agent_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "${PAYLOAD}" "${OUT}/owlette-agent_${VERSION}_${ARCH}.deb" >/dev/null
cp "${APP_DEB}" "${OUT}/"

say "done"
ls -la "${OUT}"/*.deb
sha256sum "${OUT}"/*.deb
dpkg-deb --info "${OUT}/owlette-agent_${VERSION}_${ARCH}.deb" | sed -n '1,12p'
