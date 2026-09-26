#!/bin/zsh
# the owlette installer for macOS (tri-platform 5.1): one .pkg carrying the
# service runtime, the two launchd plists and the app. runs on an Apple silicon
# Mac with the Command Line Tools, node and cargo; nothing here needs root.
#
#   agent/build/macos/build.sh [--skip-app]
#                              [--installer-identity "Developer ID Installer: …"]
#                              [--notarize <notarytool keychain profile> |
#                               --notary-key <path.p8> --notary-key-id <id> --notary-issuer <uuid>]
#
# with APPLE_SIGNING_IDENTITY in the environment the app (Tauri) and every
# mach-o in the runtime are signed with it; unsigned by default, which installs on a box that allows it and is what the
# spike work runs on. with an identity the product is signed; with a keychain
# profile or an App Store Connect api key (the three --notary-* flags together)
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
# the tarball's published sha256 (SHA256SUMS of that release): moves with PYTHON_BUILD
PBS_SHA256="d718e3c5c6f4b225ed25f88bf65e4c5d314e0dea0d716ea50bc9d038630c502b"
SKIP_APP=0
INSTALLER_IDENTITY=""
NOTARIZE_PROFILE=""
NOTARY_KEY=""
NOTARY_KEY_ID=""
NOTARY_ISSUER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-app) SKIP_APP=1; shift ;;
    --installer-identity) INSTALLER_IDENTITY="$2"; shift 2 ;;
    --notarize) NOTARIZE_PROFILE="$2"; shift 2 ;;
    --notary-key) NOTARY_KEY="$2"; shift 2 ;;
    --notary-key-id) NOTARY_KEY_ID="$2"; shift 2 ;;
    --notary-issuer) NOTARY_ISSUER="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ "$(uname -m)" = "arm64" ] || { echo "build.sh: Apple silicon only" >&2; exit 2; }
# notarytool takes a keychain profile or an api key (all three parts), never both
NOTARY=()
if [ -n "${NOTARY_KEY}${NOTARY_KEY_ID}${NOTARY_ISSUER}" ]; then
  [ -n "${NOTARY_KEY}" ] && [ -n "${NOTARY_KEY_ID}" ] && [ -n "${NOTARY_ISSUER}" ] \
    || { echo "build.sh: --notary-key, --notary-key-id and --notary-issuer go together" >&2; exit 2; }
  [ -z "${NOTARIZE_PROFILE}" ] \
    || { echo "build.sh: --notarize and --notary-key are alternatives, give one" >&2; exit 2; }
  NOTARY=(--key "${NOTARY_KEY}" --key-id "${NOTARY_KEY_ID}" --issuer "${NOTARY_ISSUER}")
elif [ -n "${NOTARIZE_PROFILE}" ]; then
  NOTARY=(--keychain-profile "${NOTARIZE_PROFILE}")
fi
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
# checked on every run, cache hit included: a stale or altered cache must not ship
echo "${PBS_SHA256}  ${OUT}/cache/${TARBALL}" | shasum -a 256 -c
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
# --- signing the runtime, inside-out ------------------------------------------
# notarization refuses a payload with any unsigned mach-o (measured: 93 issues
# on the first submission — every dylib, extension module and the interpreter).
# dylibs and modules first, then executables, each with the hardened runtime
# and a secure timestamp; the interpreter gets the entitlements python needs
# under the hardened runtime. the identity is the app's (Tauri reads the same
# variable), so the whole product carries one team.
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  say "signing the runtime's mach-o files as ${APPLE_SIGNING_IDENTITY}"
  ENTITLEMENTS="${PACKAGING}/entitlements.plist"
  find "${RUNTIME}" -type f \( -name '*.dylib' -o -name '*.so' \) -print0     | xargs -0 codesign --force --options runtime --timestamp --sign "${APPLE_SIGNING_IDENTITY}"
  find "${RUNTIME}" -type f -perm -u+x ! -name '*.dylib' ! -name '*.so' -print0     | while IFS= read -r -d '' candidate; do
        if file -b "${candidate}" | grep -q 'Mach-O'; then
          codesign --force --options runtime --timestamp --entitlements "${ENTITLEMENTS}"             --sign "${APPLE_SIGNING_IDENTITY}" "${candidate}"
        fi
      done
  codesign --verify --strict "${PY}" && say "runtime signature verified"
else
  say "no APPLE_SIGNING_IDENTITY: the runtime stays unsigned (not notarizable)"
fi

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

if [ "${#NOTARY[@]}" -gt 0 ]; then
  say "notarizing"
  xcrun notarytool submit "${PRODUCT}" "${NOTARY[@]}" --wait
  xcrun stapler staple "${PRODUCT}"
fi

say "done"
ls -la "${PRODUCT}"
shasum -a 256 "${PRODUCT}"
pkgutil --check-signature "${PRODUCT}" 2>&1 | head -2 || true
