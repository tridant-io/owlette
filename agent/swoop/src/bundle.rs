//! The session bundle: parsed from the first stdin line, never logged, never
//! written to disk, never echoed in an error. Task 2.10 fills it, against
//! agent/swoop/PROTOCOL.md.
//!
//! Everything the bundle authorises with lives here too — the JWT keyset, the
//! time anchor, token verification (PROTOCOL.md §8/§11) and the §11 key
//! derivation. The bundle is what supplies the public keys, the anchor and
//! `K_session`, so splitting them across modules would only mean handing the
//! same secrets around; Task 2.10's file list has no separate security module
//! by design.

use std::collections::HashSet;
use std::fmt;
use std::time::{Duration, Instant};

use base64::prelude::{Engine as _, BASE64_URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, VerifyingKey};
use hkdf::Hkdf;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// The one integer both ends compile in (PROTOCOL.md §1). No minor version, no
/// negotiation: either both ends speak it or they do not talk.
pub const SWOOP_PROTOCOL_VERSION: u32 = 1;

/// PROTOCOL.md §11 literals. A drifted byte here is a silent interop failure
/// between the api, the streamer and the browser, so they are consts and
/// `testdata/protocol/crypto/hkdf-and-host-mac.json` pins them.
pub const HKDF_SESSION_SALT: &[u8] = b"owlette-swoop/session/v1";
/// Salt for `k = HKDF(K_session, viewerId)`.
pub const HKDF_VIEWER_SALT: &[u8] = b"owlette-swoop/viewer/v1";
/// First part of the host fingerprint MAC input.
pub const HOST_FP_MAC_LABEL: &[u8] = b"owlette-swoop/host-fp/v1";
/// `L` in both derivations.
pub const DERIVED_KEY_LEN: usize = 32;

/// `iss` on every swoop token.
pub const TOKEN_ISSUER: &str = "owlette-api";
/// The audience the streamer verifies against; the worker uses `swoop-signal`.
pub const AUDIENCE_HOST: &str = "swoop-host";
/// The audience the signaling worker verifies against.
pub const AUDIENCE_SIGNAL: &str = "swoop-signal";

/// §8: a viewer token lives at most 60 s, a host or doorbell token 300 s.
const VIEWER_MAX_LIFETIME_S: i64 = 60;
const SERVICE_MAX_LIFETIME_S: i64 = 300;

// ---------------------------------------------------------------- secrets ---

/// A bundle string that must never be printed. `Debug` and `Display` render a
/// placeholder, so a `{:?}` anywhere — an error, a struct, a panic message —
/// cannot leak it, and the buffer is wiped on drop.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    /// Hand the value to the one place that needs it. Never to a logger.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

/// 32 bytes of derived key material — `K_session` or a viewer's `k`. Derived on
/// demand, never persisted, wiped on drop (§11).
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct DerivedKey([u8; DERIVED_KEY_LEN]);

impl DerivedKey {
    /// `K_session` as the bundle delivered it, before any expansion.
    pub fn from_bytes(bytes: [u8; DERIVED_KEY_LEN]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; DERIVED_KEY_LEN] {
        &self.0
    }
}

impl fmt::Debug for DerivedKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

// ----------------------------------------------------------------- errors ---

/// Why a bundle line was refused. Carries no detail on purpose: a serde message
/// quotes the value it choked on, and §7 forbids any part of the bundle
/// appearing in an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BundleError {
    /// Malformed, or missing a required field.
    Invalid,
    /// `overrides` without the `testhooks` build.
    OverridesNotPermitted,
    /// `protocolVersion` or `agentVersion` differs from this binary.
    VersionMismatch,
}

impl BundleError {
    /// The manifest's reason code for this refusal.
    pub fn reason(self) -> &'static str {
        match self {
            BundleError::Invalid => "bundle_invalid",
            BundleError::OverridesNotPermitted => "overrides_not_permitted",
            BundleError::VersionMismatch => "version_mismatch",
        }
    }

    /// §6's exit code for this refusal.
    pub fn exit(self) -> crate::ipc::Exit {
        match self {
            BundleError::Invalid | BundleError::OverridesNotPermitted => {
                crate::ipc::Exit::BundleInvalid
            }
            BundleError::VersionMismatch => crate::ipc::Exit::VersionMismatch,
        }
    }
}

impl fmt::Display for BundleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.reason())
    }
}

impl std::error::Error for BundleError {}

/// Why a token was refused, one variant per reason code in the golden vectors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenError {
    /// Not three base64url segments, or the payload is not the claim set.
    Malformed,
    /// Header `kid` is not in the bundle keyset. Refuse, log the `kid` only,
    /// re-fetch the bundle — never try every key.
    UnknownKid,
    /// `alg` is pinned to `EdDSA`; anything else, `none` included, is a refusal.
    BadAlg,
    BadSignature,
    IssMismatch,
    AudMismatch,
    RoleNotPermitted,
    /// Absent, or already past the bundle anchor plus monotonic elapsed.
    Expired,
    /// Lifetime longer than §8 allows for the role.
    LifetimeTooLong,
    FpMissing,
    FpMismatch,
    SiteMismatch,
    MachineMismatch,
    SidMismatch,
    JtiReplayed,
}

impl TokenError {
    pub fn reason(self) -> &'static str {
        match self {
            TokenError::Malformed => "malformed",
            TokenError::UnknownKid => "unknown_kid",
            TokenError::BadAlg => "bad_alg",
            TokenError::BadSignature => "bad_signature",
            TokenError::IssMismatch => "iss_mismatch",
            TokenError::AudMismatch => "aud_mismatch",
            TokenError::RoleNotPermitted => "role_not_permitted",
            TokenError::Expired => "expired",
            TokenError::LifetimeTooLong => "lifetime_too_long",
            TokenError::FpMissing => "fp_missing",
            TokenError::FpMismatch => "fp_mismatch",
            TokenError::SiteMismatch => "site_mismatch",
            TokenError::MachineMismatch => "machine_mismatch",
            TokenError::SidMismatch => "sid_mismatch",
            TokenError::JtiReplayed => "jti_replayed",
        }
    }
}

impl fmt::Display for TokenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.reason())
    }
}

impl std::error::Error for TokenError {}

// ----------------------------------------------------------------- bundle ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Indicator {
    Banner,
    Tray,
    None,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Enablement {
    pub members_may_watch: bool,
    pub max_viewers: u32,
    pub lease_seconds: u64,
    pub session_cap_seconds: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JwtKey {
    pub kid: String,
    pub alg: String,
    /// base64url, raw 32-byte ed25519 public key.
    pub key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<Secret>,
}

/// The test-only hook, parsed only under `testhooks`.
#[cfg(feature = "testhooks")]
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Overrides {
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub encoder: Option<String>,
}

/// Line 1 of stdin. Deliberately has no `Serialize` and no field-printing
/// `Debug`: §7 says it is never written out, and the cheapest way to keep that
/// true is to give the type no way to do it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Bundle {
    pub protocol_version: u32,
    pub agent_version: String,
    pub sid: String,
    pub site: String,
    pub machine: String,
    /// The time anchor: unix seconds, the api's own clock at mint. The only
    /// clock the streamer trusts.
    pub now: i64,
    /// Unix microseconds; §4's frame timestamps are relative to this.
    pub streamer_epoch: i64,
    pub signal_url: String,
    pub host_token: Secret,
    /// Current and previous, for the two-key overlap.
    pub jwt_keys: Vec<JwtKey>,
    /// `K_session`, base64url 32 bytes.
    pub session_key: Secret,
    pub ice_servers: Vec<IceServer>,
    pub enablement: Enablement,
    pub indicator: Indicator,
    /// The session floor for control, not a grant — a viewer's own `ctl` comes
    /// from its jwt.
    pub ctl: bool,
    #[cfg(feature = "testhooks")]
    #[serde(default)]
    pub overrides: Option<Overrides>,
    // Without `testhooks` the object is detected but never parsed: `IgnoredAny`
    // reads and discards it, which is what lets the refusal name
    // `overrides_not_permitted` instead of a generic unknown-field error.
    #[cfg(not(feature = "testhooks"))]
    #[serde(default)]
    overrides: Option<serde::de::IgnoredAny>,
}

impl fmt::Debug for Bundle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Bundle { <redacted> }")
    }
}

/// This build's identity, compared against the bundle's. A parameter rather
/// than a constant read inside `parse` so the golden vectors — authored against
/// the version swoop ships in, not the version in this working tree — can be
/// exercised without the test lying about what it checks.
#[derive(Debug, Clone, Copy)]
pub struct BuildVersions<'a> {
    pub protocol_version: u32,
    pub agent_version: &'a str,
}

impl BuildVersions<'static> {
    /// What `owlette-swoop.exe` actually is.
    pub const THIS_BUILD: Self = Self {
        protocol_version: SWOOP_PROTOCOL_VERSION,
        agent_version: env!("CARGO_PKG_VERSION"),
    };
}

/// Read only when the strict parse failed, to tell "a bundle for a different
/// build" from "a broken bundle" — a v2 bundle need not have a v1 shape.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionProbe {
    #[serde(default)]
    protocol_version: Option<u32>,
    #[serde(default)]
    agent_version: Option<String>,
}

impl Bundle {
    /// Parse and validate line 1 of stdin.
    pub fn parse(line: &str, build: BuildVersions<'_>) -> Result<Self, BundleError> {
        let bundle = match serde_json::from_str::<Bundle>(line) {
            Ok(bundle) => bundle,
            Err(_) => return Err(probe_version_mismatch(line, build)),
        };
        bundle.check_versions(build)?;
        bundle.reject_overrides()?;
        bundle.check_shape()?;
        Ok(bundle)
    }

    fn check_versions(&self, build: BuildVersions<'_>) -> Result<(), BundleError> {
        if self.protocol_version != build.protocol_version || self.agent_version != build.agent_version
        {
            return Err(BundleError::VersionMismatch);
        }
        Ok(())
    }

    fn reject_overrides(&self) -> Result<(), BundleError> {
        #[cfg(not(feature = "testhooks"))]
        if self.overrides.is_some() {
            return Err(BundleError::OverridesNotPermitted);
        }
        Ok(())
    }

    /// Everything serde cannot express: identifier shapes, a usable keyset, and
    /// key material that is the right length before anything tries to use it.
    fn check_shape(&self) -> Result<(), BundleError> {
        if !is_identifier(&self.sid) || !is_identifier(&self.site) || !is_identifier(&self.machine) {
            return Err(BundleError::Invalid);
        }
        if self.now <= 0 || self.streamer_epoch <= 0 || self.signal_url.is_empty() {
            return Err(BundleError::Invalid);
        }
        if self.jwt_keys.is_empty() {
            return Err(BundleError::Invalid);
        }
        self.session_key()?;
        Keyset::from_bundle(self)?;
        Ok(())
    }

    /// The anchor this bundle establishes. Taken once, when the bundle is read;
    /// every later "now" is this plus monotonic elapsed.
    pub fn time_anchor(&self) -> TimeAnchor {
        TimeAnchor::new(self.now)
    }

    /// `K_session` for this sid.
    pub fn session_key(&self) -> Result<DerivedKey, BundleError> {
        let mut bytes = [0u8; DERIVED_KEY_LEN];
        let decoded = BASE64_URL_SAFE_NO_PAD
            .decode(self.session_key.expose())
            .map_err(|_| BundleError::Invalid)?;
        if decoded.len() != DERIVED_KEY_LEN {
            return Err(BundleError::Invalid);
        }
        bytes.copy_from_slice(&decoded);
        Ok(DerivedKey(bytes))
    }

    /// `k` for one viewer. Derived on demand from `K_session`, never stored.
    pub fn viewer_key(&self, viewer_id: &str) -> Result<DerivedKey, BundleError> {
        Ok(derive_viewer_key(&self.session_key()?, viewer_id))
    }
}

fn probe_version_mismatch(line: &str, build: BuildVersions<'_>) -> BundleError {
    match serde_json::from_str::<VersionProbe>(line) {
        Ok(probe) => {
            let protocol_differs = probe.protocol_version.is_some_and(|v| v != build.protocol_version);
            let agent_differs = probe
                .agent_version
                .as_deref()
                .is_some_and(|v| v != build.agent_version);
            if protocol_differs || agent_differs {
                BundleError::VersionMismatch
            } else {
                BundleError::Invalid
            }
        }
        Err(_) => BundleError::Invalid,
    }
}

/// §8's `^[A-Za-z0-9_-]{1,64}$`, hand-rolled because one pattern does not earn
/// a regex dependency.
fn is_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

// ------------------------------------------------------------ time anchor ---

/// The api's clock at bundle mint, advanced by the monotonic clock only.
///
/// §11: these are signage and kiosk boxes whose wall clocks drift, so
/// `SystemTime::now()` is never consulted for expiry. A streamer checking a
/// 60-second `exp` against a drifted wall clock either refuses every session or
/// acquires a leeway in a hotfix — and that leeway *is* the replay window.
#[derive(Debug, Clone, Copy)]
pub struct TimeAnchor {
    anchor_unix: i64,
    read_at: Instant,
}

impl TimeAnchor {
    pub fn new(anchor_unix: i64) -> Self {
        Self { anchor_unix, read_at: Instant::now() }
    }

    /// An anchor that was read `elapsed` ago. Used by the golden-vector tests,
    /// and by anything that has to reason about a lease without waiting for it.
    pub fn with_elapsed(anchor_unix: i64, elapsed: Duration) -> Self {
        let read_at = Instant::now().checked_sub(elapsed).unwrap_or_else(Instant::now);
        Self { anchor_unix, read_at }
    }

    /// The streamer's idea of now, in unix seconds.
    pub fn now_unix(&self) -> i64 {
        self.anchor_unix
            .saturating_add(self.read_at.elapsed().as_secs() as i64)
    }
}

// -------------------------------------------------------------------- jwt ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Viewer,
    Host,
    Doorbell,
}

#[derive(Deserialize)]
struct JwtHeader {
    alg: String,
    #[serde(default)]
    kid: Option<String>,
}

/// The claim set of §8. Every optional claim is optional because a role that
/// does not carry it must still verify: a doorbell names no session, and only a
/// viewer carries `viewer`, `uid`, `ctl` and `fp`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Claims {
    pub iss: String,
    pub aud: String,
    pub role: Role,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid: Option<String>,
    pub site: String,
    pub machine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctl: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fp: Option<String>,
    pub iat: i64,
    /// §11 step 4 refuses on absence, so it is checked rather than required by
    /// the parser — the refusal is `expired`, not `malformed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exp: Option<i64>,
    pub jti: String,
}

impl Claims {
    /// Control or watch-only. Absent means watch-only — never a default of
    /// true.
    pub fn has_control(&self) -> bool {
        self.ctl.unwrap_or(false)
    }
}

/// What this verifier is, and what it is verifying against.
#[derive(Debug, Clone, Copy)]
pub struct VerifyContext<'a> {
    /// `swoop-host` in the streamer, `swoop-signal` in the worker.
    pub audience: &'a str,
    pub site: &'a str,
    pub machine: &'a str,
    /// The live session, or `None` where there is none to name.
    pub sid: Option<&'a str>,
    /// The `a=fingerprint:` line of the offer this token arrived with, already
    /// canonicalised. Only a viewer token is bound to one.
    pub offer_fingerprint: Option<&'a str>,
}

/// `jti` single use, for the lifetime of this process.
///
/// §11: the streamer has no store across spawns, so this is belt-and-braces
/// behind `fp` + `exp` — the absence of a record after a restart is not a
/// vulnerability, and is not a reason to relax either of those.
#[derive(Debug, Default)]
pub struct JtiSet(HashSet<String>);

impl JtiSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// True the first time a `jti` is seen, false on every replay.
    pub fn admit(&mut self, jti: &str) -> bool {
        self.0.insert(jti.to_owned())
    }
}

/// The bundle's public keys, selected by `kid`.
#[derive(Debug, Clone, Default)]
pub struct Keyset {
    keys: Vec<(String, VerifyingKey)>,
}

impl Keyset {
    /// `(kid, base64url raw 32-byte public key)` pairs.
    pub fn from_entries<'a, I>(entries: I) -> Result<Self, BundleError>
    where
        I: IntoIterator<Item = (&'a str, &'a str)>,
    {
        let mut keys = Vec::new();
        for (kid, encoded) in entries {
            let decoded = BASE64_URL_SAFE_NO_PAD
                .decode(encoded)
                .map_err(|_| BundleError::Invalid)?;
            let bytes: [u8; 32] = decoded.try_into().map_err(|_| BundleError::Invalid)?;
            let key = VerifyingKey::from_bytes(&bytes).map_err(|_| BundleError::Invalid)?;
            keys.push((kid.to_owned(), key));
        }
        Ok(Self { keys })
    }

    pub fn from_bundle(bundle: &Bundle) -> Result<Self, BundleError> {
        for entry in &bundle.jwt_keys {
            if entry.alg != "EdDSA" {
                return Err(BundleError::Invalid);
            }
        }
        Self::from_entries(
            bundle
                .jwt_keys
                .iter()
                .map(|entry| (entry.kid.as_str(), entry.key.as_str())),
        )
    }

    fn select(&self, kid: &str) -> Option<&VerifyingKey> {
        self.keys
            .iter()
            .find(|(candidate, _)| candidate == kid)
            .map(|(_, key)| key)
    }

    /// §11's verification order, stopping at the first failure:
    /// `kid` → signature → `iss`/`aud`/`role` → `exp` → `fp` →
    /// site/machine/sid → `jti`.
    ///
    /// `kid` necessarily precedes the signature, because the key cannot be
    /// selected otherwise.
    pub fn verify(
        &self,
        token: &str,
        ctx: &VerifyContext<'_>,
        anchor: &TimeAnchor,
        jti: &mut JtiSet,
    ) -> Result<Claims, TokenError> {
        let mut parts = token.split('.');
        let (header_b64, payload_b64, signature_b64) =
            match (parts.next(), parts.next(), parts.next(), parts.next()) {
                (Some(h), Some(p), Some(s), None) => (h, p, s),
                _ => return Err(TokenError::Malformed),
            };

        // 1. kid, and the key it selects.
        let header: JwtHeader = decode_segment(header_b64)?;
        let kid = header.kid.as_deref().ok_or(TokenError::UnknownKid)?;
        let key = self.select(kid).ok_or(TokenError::UnknownKid)?;

        // 2. signature, with alg pinned to EdDSA.
        if header.alg != "EdDSA" {
            return Err(TokenError::BadAlg);
        }
        let signature_bytes: [u8; 64] = BASE64_URL_SAFE_NO_PAD
            .decode(signature_b64)
            .map_err(|_| TokenError::Malformed)?
            .try_into()
            .map_err(|_| TokenError::Malformed)?;
        let signed = &token[..header_b64.len() + 1 + payload_b64.len()];
        key.verify_strict(signed.as_bytes(), &Signature::from_bytes(&signature_bytes))
            .map_err(|_| TokenError::BadSignature)?;

        let claims: Claims = decode_segment(payload_b64)?;

        // 3. iss / aud / role.
        if claims.iss != TOKEN_ISSUER {
            return Err(TokenError::IssMismatch);
        }
        if claims.aud != ctx.audience {
            return Err(TokenError::AudMismatch);
        }
        if !role_permitted(claims.role, &claims.aud) {
            return Err(TokenError::RoleNotPermitted);
        }

        // 4. exp, against the anchor plus monotonic elapsed. Never the wall
        // clock.
        let exp = claims.exp.ok_or(TokenError::Expired)?;
        if exp <= anchor.now_unix() {
            return Err(TokenError::Expired);
        }
        let max_lifetime = match claims.role {
            Role::Viewer => VIEWER_MAX_LIFETIME_S,
            Role::Host | Role::Doorbell => SERVICE_MAX_LIFETIME_S,
        };
        if exp.saturating_sub(claims.iat) > max_lifetime {
            return Err(TokenError::LifetimeTooLong);
        }

        // 5. fp. Mandatory on a viewer token, and never degraded to "no binding
        // required".
        if claims.role == Role::Viewer {
            let claimed = claims.fp.as_deref().ok_or(TokenError::FpMissing)?;
            let claimed = canonical_fingerprint(claimed).ok_or(TokenError::FpMissing)?;
            let offered = ctx.offer_fingerprint.ok_or(TokenError::FpMismatch)?;
            let offered = canonical_fingerprint(offered).ok_or(TokenError::FpMismatch)?;
            if !constant_time_eq(claimed.as_bytes(), offered.as_bytes()) {
                return Err(TokenError::FpMismatch);
            }
        }

        // 6. site / machine / sid.
        if !is_identifier(&claims.site) || claims.site != ctx.site {
            return Err(TokenError::SiteMismatch);
        }
        if !is_identifier(&claims.machine) || claims.machine != ctx.machine {
            return Err(TokenError::MachineMismatch);
        }
        let sid_ok = match (ctx.sid, claims.sid.as_deref()) {
            // only a doorbell may name no session.
            (_, None) => claims.role == Role::Doorbell,
            (None, Some(_)) => false,
            (Some(want), Some(got)) => want == got,
        };
        if !sid_ok {
            return Err(TokenError::SidMismatch);
        }

        // 7. jti.
        if !jti.admit(&claims.jti) {
            return Err(TokenError::JtiReplayed);
        }

        Ok(claims)
    }
}

/// The audience decides the role: only a viewer talks to the streamer, only a
/// host or a doorbell holds a signaling socket.
fn role_permitted(role: Role, audience: &str) -> bool {
    match audience {
        AUDIENCE_HOST => role == Role::Viewer,
        AUDIENCE_SIGNAL => matches!(role, Role::Host | Role::Doorbell),
        _ => false,
    }
}

fn decode_segment<T: serde::de::DeserializeOwned>(segment: &str) -> Result<T, TokenError> {
    let bytes = BASE64_URL_SAFE_NO_PAD
        .decode(segment)
        .map_err(|_| TokenError::Malformed)?;
    serde_json::from_slice(&bytes).map_err(|_| TokenError::Malformed)
}

// ---------------------------------------------------------- fingerprints ---

/// `<hash-func> <HEX:WITH:COLONS>` — hash token lowercase, hex uppercase, colon
/// separated, exactly as an sdp `a=fingerprint:` attribute value. Returns
/// `None` when the input is not a fingerprint at all.
pub fn canonical_fingerprint(raw: &str) -> Option<String> {
    let mut parts = raw.split_whitespace();
    let func = parts.next()?;
    let hex = parts.next()?;
    if parts.next().is_some() || func.is_empty() {
        return None;
    }
    let mut octets = Vec::new();
    for group in hex.split(':') {
        if group.len() != 2 || !group.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        octets.push(group.to_ascii_uppercase());
    }
    if octets.is_empty() {
        return None;
    }
    Some(format!("{} {}", func.to_ascii_lowercase(), octets.join(":")))
}

/// Pull the fingerprint out of an offer or answer. Session-level and
/// media-level `a=fingerprint:` lines are the same value in every offer a
/// browser produces, so the first one wins.
pub fn fingerprint_from_sdp(sdp: &str) -> Option<String> {
    sdp.lines()
        .filter_map(|line| line.trim().strip_prefix("a=fingerprint:"))
        .find_map(canonical_fingerprint)
}

/// Length-independent only for equal lengths, which is all this compares: two
/// canonical fingerprints, or a MAC against a MAC.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    std::hint::black_box(diff) == 0
}

// ------------------------------------------------------------- derivation ---

/// `k = HKDF-SHA256(IKM = K_session, salt = "owlette-swoop/viewer/v1",
/// info = viewerId, L = 32)`.
pub fn derive_viewer_key(session_key: &DerivedKey, viewer_id: &str) -> DerivedKey {
    let mut okm = [0u8; DERIVED_KEY_LEN];
    Hkdf::<Sha256>::new(Some(HKDF_VIEWER_SALT), session_key.as_bytes())
        .expand(viewer_id.as_bytes(), &mut okm)
        .expect("32 bytes is one hkdf block");
    DerivedKey(okm)
}

/// The MAC input, laid out byte for byte. Exposed so a test can pin the layout
/// rather than only the digest: the `0x00` separators are what stop
/// `sid="ab", viewerId="c"` colliding with `sid="a", viewerId="bc"`.
pub fn host_fp_mac_input(sid: &str, viewer_id: &str, host_fingerprint_canonical: &str) -> Vec<u8> {
    let mut input = Vec::new();
    input.extend_from_slice(HOST_FP_MAC_LABEL);
    input.push(0x00);
    input.extend_from_slice(sid.as_bytes());
    input.push(0x00);
    input.extend_from_slice(viewer_id.as_bytes());
    input.push(0x00);
    input.extend_from_slice(host_fingerprint_canonical.as_bytes());
    input
}

/// `HMAC-SHA256(k, …)`, base64url without padding — the `mac` field of the
/// host's `answer`. The browser recomputes it and compares in constant time
/// before accepting, so a relay that substitutes its own fingerprint is caught.
pub fn host_fp_mac(
    viewer_key: &DerivedKey,
    sid: &str,
    viewer_id: &str,
    host_fingerprint_canonical: &str,
) -> String {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(viewer_key.as_bytes())
        .expect("hmac takes a key of any length");
    mac.update(&host_fp_mac_input(sid, viewer_id, host_fingerprint_canonical));
    BASE64_URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_never_prints_itself() {
        let secret = Secret("the-actual-value".to_owned());
        assert_eq!(format!("{secret}"), "<redacted>");
        assert_eq!(format!("{secret:?}"), "<redacted>");
        assert_eq!(secret.expose(), "the-actual-value");
    }

    #[test]
    fn fingerprints_canonicalise_to_lowercase_token_and_uppercase_hex() {
        assert_eq!(
            canonical_fingerprint("SHA-256 aa:bb:cc").as_deref(),
            Some("sha-256 AA:BB:CC")
        );
        assert_eq!(canonical_fingerprint("sha-256"), None);
        assert_eq!(canonical_fingerprint("sha-256 aa:bbb"), None);
        assert_eq!(canonical_fingerprint("sha-256 aa:zz"), None);
    }

    #[test]
    fn the_sdp_fingerprint_is_read_from_the_attribute_line() {
        let sdp = "v=0\r\ns=-\r\na=fingerprint:sha-256 aa:bb\r\na=setup:actpass\r\n";
        assert_eq!(fingerprint_from_sdp(sdp).as_deref(), Some("sha-256 AA:BB"));
        assert_eq!(fingerprint_from_sdp("v=0\r\n"), None);
    }

    #[test]
    fn the_anchor_advances_on_the_monotonic_clock_only() {
        let anchor = TimeAnchor::with_elapsed(1_000, Duration::from_secs(5));
        assert!(anchor.now_unix() >= 1_005);
        assert!(anchor.now_unix() < 1_010);
    }

    #[test]
    fn a_jti_is_admitted_once() {
        let mut seen = JtiSet::new();
        assert!(seen.admit("jti_1"));
        assert!(!seen.admit("jti_1"));
        assert!(seen.admit("jti_2"));
    }

    /// The golden-vector manifest describes a release build, so the oracle in
    /// `tests/protocol_vectors.rs` does not run under `testhooks`. These two
    /// pin the verdict that the feature flips, from both sides.
    fn overrides_vector() -> (String, String) {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("testdata/protocol/bundle/bundle-overrides-no-testhooks.json");
        let line = std::fs::read_to_string(path).expect("the vector reads");
        let agent_version = serde_json::from_str::<serde_json::Value>(&line)
            .expect("the vector is json")["agentVersion"]
            .as_str()
            .expect("agentVersion")
            .to_owned();
        (line, agent_version)
    }

    #[cfg(not(feature = "testhooks"))]
    #[test]
    fn a_release_build_refuses_a_bundle_carrying_overrides() {
        let (line, agent_version) = overrides_vector();
        let build = BuildVersions {
            protocol_version: SWOOP_PROTOCOL_VERSION,
            agent_version: &agent_version,
        };
        let error = Bundle::parse(line.trim(), build).expect_err("overrides is test only");
        assert_eq!(error, BundleError::OverridesNotPermitted);
        assert_eq!(error.exit().code(), 10);
    }

    #[cfg(feature = "testhooks")]
    #[test]
    fn a_testhooks_build_parses_the_overrides_object() {
        let (line, agent_version) = overrides_vector();
        let build = BuildVersions {
            protocol_version: SWOOP_PROTOCOL_VERSION,
            agent_version: &agent_version,
        };
        let bundle = Bundle::parse(line.trim(), build).expect("testhooks accepts overrides");
        let overrides = bundle.overrides.expect("the object is parsed, not just tolerated");
        assert_eq!(overrides.source.as_deref(), Some("testpattern"));
        assert_eq!(overrides.encoder.as_deref(), Some("soft"));
    }

    #[test]
    fn identifiers_follow_the_claim_pattern() {
        assert!(is_identifier("site_goldenvector"));
        assert!(is_identifier("a-b_C9"));
        assert!(!is_identifier(""));
        assert!(!is_identifier("has space"));
        assert!(!is_identifier(&"x".repeat(65)));
    }
}
