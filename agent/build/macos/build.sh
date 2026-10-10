#!/bin/zsh
# the owlette installer for macOS (tri-platform 5.1): one .pkg carrying the
# service runtime, the two launchd plists and the two apps, owlette.app and
# owlette swoop.app (the viewer app, desktop/viewer). runs on an Apple silicon
# Mac with the Command Line Tools, node, cargo and cmake (the streamer's opus
# build); nothing here needs root.
#
#   agent/build/macos/build.sh [--skip-app]
#                              [--installer-identity "Developer ID Installer: …"]
#                              [--notarize <notarytool keychain profile> |
#                               --notary-key <path.p8> --notary-key-id <id> --notary-issuer <uuid>]
#
# the swoop streamer rides inside the app as a Tauri sidecar
# (`bundle.externalBin` in tauri.macos.conf.json), so the pass that signs the
# app signs it too. --skip-app reuses the last app bundles, sidecar included:
# neither app nor the streamer is rebuilt.
#
# with APPLE_SIGNING_IDENTITY in the environment both apps (Tauri) and every
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

# --- the swoop streamer, staged as the app's sidecar ---------------------------
# tauri-build will not compile the app without the file under its target
# triple, and the bundler copies it to Contents/MacOS/owlette-swoop. the
# default feature (nvenc) is windows-only; cmake 4 refuses the opus that
# audio-opus vendors without the policy floor.
if [ "${SKIP_APP}" = "0" ]; then
  say "building the swoop streamer"
  ( cd "${REPO}/agent/swoop" && CMAKE_POLICY_VERSION_MINIMUM=3.5 \
      cargo build --release --locked --no-default-features --features encode-videotoolbox,audio-opus )
  cp "${REPO}/agent/swoop/target/release/owlette-swoop" \
    "${REPO}/desktop/src-tauri/binaries/owlette-swoop-aarch64-apple-darwin"
fi

# --- the app ---------------------------------------------------------------------
APP="${REPO}/desktop/src-tauri/target/release/bundle/macos/owlette.app"
if [ "${SKIP_APP}" = "0" ]; then
  say "building the app"
  ( cd "${REPO}/desktop" && npm ci --no-audit --no-fund --silent && npx tauri build --bundles app --ci )
fi
[ -d "${APP}" ] || { echo "build.sh: no app bundle at ${APP}" >&2; exit 1; }
# the sidecar must be in the bundle, be this version (the agent refuses a
# mismatched streamer at spawn) and, when signed, carry the app's signature:
# the hardened runtime and the app's own team.
SIDECAR="${APP}/Contents/MacOS/owlette-swoop"
[ -x "${SIDECAR}" ] || { echo "build.sh: no swoop streamer at ${SIDECAR}" >&2; exit 1; }
SIDECAR_VERSION="$("${SIDECAR}" version)"
[ "${SIDECAR_VERSION}" = "${VERSION}" ] \
  || { echo "build.sh: the bundled streamer is ${SIDECAR_VERSION}, agent/VERSION is ${VERSION}" >&2; exit 1; }
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  codesign --verify --strict "${SIDECAR}"
  SIDECAR_SIG="$(codesign -dv "${SIDECAR}" 2>&1)"
  APP_TEAM="$(codesign -dv "${APP}" 2>&1 | sed -n 's/^TeamIdentifier=//p' || true)"
  grep -q '^CodeDirectory .*flags=0x[0-9a-f]*([^)]*runtime' <<< "${SIDECAR_SIG}" \
    || { echo "build.sh: the bundled streamer is signed without the hardened runtime" >&2; exit 1; }
  [ -n "${APP_TEAM}" ] && [ "${APP_TEAM}" != "not set" ] \
    && grep -qx "TeamIdentifier=${APP_TEAM}" <<< "${SIDECAR_SIG}" \
    || { echo "build.sh: the bundled streamer is not signed by the app's team (${APP_TEAM:-none})" >&2; exit 1; }
  say "streamer signature verified: hardened runtime, team ${APP_TEAM}"
fi
say "bundled streamer ${SIDECAR_VERSION}"
cp -R "${APP}" "${PAYLOAD}/app/"

# --- owlette swoop, the viewer app ------------------------------------------------
# a second Tauri crate with no frontend and no sidecar, run from the app's
# node_modules and signed the same way as the app. tauri-plugin-deep-link writes
# its owlette-swoop URL type into Info.plist; without it the app installs and
# never receives a link, so its absence fails the build.
VIEWER_APP="${REPO}/desktop/viewer/target/release/bundle/macos/owlette swoop.app"
if [ "${SKIP_APP}" = "0" ]; then
  say "building owlette swoop"
  ( cd "${REPO}/desktop/viewer" && ../node_modules/.bin/tauri build --bundles app --ci )
fi
[ -d "${VIEWER_APP}" ] || { echo "build.sh: no owlette swoop bundle at ${VIEWER_APP}" >&2; exit 1; }
VIEWER_URL_TYPES="$(plutil -extract CFBundleURLTypes json -o - "${VIEWER_APP}/Contents/Info.plist" 2>/dev/null || true)"
grep -q '"owlette-swoop"' <<< "${VIEWER_URL_TYPES}" \
  || { echo "build.sh: owlette swoop's Info.plist declares no owlette-swoop URL scheme" >&2; exit 1; }
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  codesign --verify --strict "${VIEWER_APP}"
  VIEWER_SIG="$(codesign -dv "${VIEWER_APP}" 2>&1)"
  grep -q '^CodeDirectory .*flags=0x[0-9a-f]*([^)]*runtime' <<< "${VIEWER_SIG}" \
    && grep -qx "TeamIdentifier=${APP_TEAM}" <<< "${VIEWER_SIG}" \
    || { echo "build.sh: owlette swoop is not signed with the hardened runtime by the app's team (${APP_TEAM})" >&2; exit 1; }
  say "owlette swoop signature verified: hardened runtime, team ${APP_TEAM}"
fi
say "owlette swoop declares the owlette-swoop URL scheme"
cp -R "${VIEWER_APP}" "${PAYLOAD}/app/"

# --- the packages ----------------------------------------------------------------
say "building the component packages"
cp -R "${PACKAGING}/scripts" "${WORK}/scripts"
chmod 755 "${WORK}/scripts/"*
pkgbuild --quiet --root "${PAYLOAD}/root" --identifier app.owlette.runtime --version "${VERSION}" \
  --install-location / --scripts "${WORK}/scripts" "${WORK}/owlette-runtime.pkg"
# both apps must land in /Applications: without this the installer "relocates"
# the payload onto any other copy of a bundle spotlight knows (a build tree, an
# old download) and the LaunchAgent's /Applications path points at nothing (the
# desktop app's tray looks for /Applications/owlette swoop.app the same way).
pkgbuild --analyze --root "${PAYLOAD}/app" "${WORK}/app-components.plist" >/dev/null
BUNDLES=0
while plutil -extract "${BUNDLES}" xml1 -o - "${WORK}/app-components.plist" >/dev/null 2>&1; do
  plutil -replace "${BUNDLES}.BundleIsRelocatable" -bool false "${WORK}/app-components.plist"
  BUNDLES=$((BUNDLES + 1))
done
[ "${BUNDLES}" = "2" ] \
  || { echo "build.sh: the app package should hold owlette.app and owlette swoop.app, found ${BUNDLES} bundles" >&2; exit 1; }
pkgbuild --quiet --root "${PAYLOAD}/app" --identifier app.owlette.app --version "${VERSION}" \
  --install-location /Applications --component-plist "${WORK}/app-components.plist" "${WORK}/owlette-app.pkg"

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
