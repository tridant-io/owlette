#!/bin/zsh
# the owlette installer for macOS (tri-platform 5.1): one .pkg carrying the
# service runtime, the two launchd plists and the app. runs on an Apple silicon
# Mac with the Command Line Tools, node and cargo; nothing here needs root.
#
#   agent/build/macos/build.sh [--python 3.11.16+20260924] [--skip-app]
#                              [--installer-identity "Developer ID Installer: …"]
#                              [--notarize <notarytool keychain profile>]
#
# unsigned by default, which installs on a box that allows it and is what the
# spike work runs on. with an identity the product is signed; with a profile
# it is notarized and stapled too. the app's own signature is the Tauri
# build's (`bundle.macOS.signingIdentity`, or APPLE_SIGNING_IDENTITY in the
# environment): an ad-hoc app loses its Screen Recording grant on every
# update (spike 0.2), so a release build must carry a Developer ID.
#
# release order (CLAUDE.md): the version is read from agent/VERSION, so bump
# and commit before building — the file name and the payload carry it.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="${REPO}/agent/build/macos"
WORK="${OUT}/work"
PAYLOAD="${WORK}/payload"
PACKAGING="${REPO}/agent/packaging/macos"
VERSION="$(tr -d '[:space:]' < "${REPO}/agent/VERSION")"
PYTHON_BUILD="3.11.16+20260924"
SKIP_APP=0
INSTALLER_IDENTITY=""
NOTARIZE_PROFILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --python) PYTHON_BUILD="$2"; shift 2 ;;
    --skip-app) SKIP_APP=1; shift ;;
    --installer-identity) INSTALLER_IDENTITY="$2"; shift 2 ;;
    --notarize) NOTARIZE_PROFILE="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ "$(uname -m)" = "arm64" ] || { echo "build.sh: Apple silicon only" >&2; exit 2; }
say() { echo "== $*"; }

rm -rf "${WORK}"
mkdir -p "${PAYLOAD}/root/Library/Application Support/Owlette/runtime" \
         "${PAYLOAD}/root/Library/LaunchDaemons" \
         "${PAYLOAD}/root/Library/LaunchAgents" \
         "${PAYLOAD}/app" "${OUT}/cache"
RUNTIME="${PAYLOAD}/root/Library/Application Support/Owlette/runtime"

# --- the interpreter: python-build-standalone, cached by exact build ---------
TAG="${PYTHON_BUILD#*+}"
TARBALL="cpython-${PYTHON_BUILD}-aarch64-apple-darwin-install_only.tar.gz"
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
cp "${PACKAGING}/app.owlette.agent.plist" "${PAYLOAD}/root/Library/LaunchDaemons/"
cp "${PACKAGING}/app.owlette.desktop.plist" "${PAYLOAD}/root/Library/LaunchAgents/"
chmod 644 "${PAYLOAD}/root/Library/LaunchDaemons/"*.plist "${PAYLOAD}/root/Library/LaunchAgents/"*.plist

# --- the app ---------------------------------------------------------------------
APP="${REPO}/desktop/src-tauri/target/release/bundle/macos/owlette.app"
if [ "${SKIP_APP}" = "0" ]; then
  say "building the app"
  ( cd "${REPO}/desktop" && npm ci --no-audit --no-fund --silent && npx tauri build --bundles app --ci )
fi
[ -d "${APP}" ] || { echo "build.sh: no app bundle at ${APP}" >&2; exit 1; }
cp -R "${APP}" "${PAYLOAD}/app/"

# --- the packages ----------------------------------------------------------------
say "building the component packages"
cp -R "${PACKAGING}/scripts" "${WORK}/scripts"
chmod 755 "${WORK}/scripts/"*
pkgbuild --quiet --root "${PAYLOAD}/root" --identifier app.owlette.runtime --version "${VERSION}" \
  --install-location / --scripts "${WORK}/scripts" "${WORK}/owlette-runtime.pkg"
pkgbuild --quiet --root "${PAYLOAD}/app" --identifier app.owlette.app --version "${VERSION}" \
  --install-location /Applications "${WORK}/owlette-app.pkg"

say "building the product"
sed "s/__VERSION__/${VERSION}/g" "${PACKAGING}/distribution.xml" > "${WORK}/distribution.xml"
mkdir -p "${WORK}/resources" && cp "${PACKAGING}/welcome.txt" "${WORK}/resources/"
PRODUCT="${OUT}/Owlette-Installer-v${VERSION}.pkg"
SIGN=()
[ -n "${INSTALLER_IDENTITY}" ] && SIGN=(--sign "${INSTALLER_IDENTITY}")
productbuild --quiet --distribution "${WORK}/distribution.xml" --resources "${WORK}/resources" \
  --package-path "${WORK}" --version "${VERSION}" "${SIGN[@]}" "${PRODUCT}"

if [ -n "${NOTARIZE_PROFILE}" ]; then
  say "notarizing"
  xcrun notarytool submit "${PRODUCT}" --keychain-profile "${NOTARIZE_PROFILE}" --wait
  xcrun stapler staple "${PRODUCT}"
fi

say "done"
ls -la "${PRODUCT}"
shasum -a 256 "${PRODUCT}"
pkgutil --check-signature "${PRODUCT}" 2>&1 | head -2 || true
