//! The rust half of the golden-vector oracle.
//!
//! `testdata/protocol/index.json` is the manifest, and the web protocol library
//! (Task 2.9) walks the same list, so both ends are proven against one oracle
//! rather than against each other's reading of PROTOCOL.md. An unknown `kind`
//! fails this test rather than being skipped: a vector nobody runs is worse
//! than no vector.
//!
//! What "round-trip" means per format, because JSON does not have one answer:
//!
//! - **binary** — re-encoding the decoded header reproduces the file byte for
//!   byte.
//! - **ndjson** — re-serialising each parsed line reproduces the line byte for
//!   byte, field order included.
//! - **json** — the parsed value re-serialises to the *same JSON*, compared as
//!   values with numbers compared numerically. JSON has one number type: a
//!   field typed `f64` here comes back as `2.0` where the fixture spells it
//!   `2`, and `JSON.stringify` in the TypeScript half spells it `2` again.
//!   Byte-identity across the two languages is not achievable for those fields,
//!   so the assertion is that nothing was dropped, added or altered.
//!
//! The manifest describes the release build. `testhooks` deliberately changes
//! one verdict — `bundle-overrides-no-testhooks.json` becomes a valid bundle —
//! so the oracle does not run under that feature; `bundle.rs` carries the pair
//! of unit tests that pin both sides of it instead.
#![cfg(not(feature = "testhooks"))]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::prelude::{Engine as _, BASE64_URL_SAFE_NO_PAD};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use owlette_swoop::bundle::{
    canonical_fingerprint, derive_viewer_key, fingerprint_from_sdp, host_fp_mac, host_fp_mac_input,
    Bundle, BuildVersions, DerivedKey, JtiSet, Keyset, TimeAnchor, TokenError,
    VerifyContext, DERIVED_KEY_LEN, HKDF_SESSION_SALT, HKDF_VIEWER_SALT, HOST_FP_MAC_LABEL,
};
use owlette_swoop::ipc::{Control, Event};
use owlette_swoop::signal::messages::{
    channel, check_hello_version, check_send_right_for_type, Message, Role,
};
use owlette_swoop::transport::framing::{FrameCodec, FrameHeader, ReceiverState};

/// The agent version the bundle vectors were authored against — swoop's own
/// release, not whatever `agent/swoop/Cargo.toml` says in this working tree.
/// `index.json` carries the protocol version but not this one, so it is read
/// out of the accept vector: `bundle-version-mismatch.json` is only a mismatch
/// relative to it, and comparing against `CARGO_PKG_VERSION` instead inverts
/// both bundle verdicts while 3.3.5 is still the crate version. Task 2.9's half
/// reads it from the same place, so the two stay in step.
fn vector_agent_version(dir: &Path) -> String {
    let valid: Value = read_json(&dir.join("bundle/bundle-valid.json"));
    valid["agentVersion"]
        .as_str()
        .expect("bundle-valid.json names an agentVersion")
        .to_owned()
}

// ------------------------------------------------------------- the manifest ---

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Manifest {
    version: u32,
    protocol_version: u32,
    #[allow(dead_code)]
    note: String,
    keys: String,
    time_anchor: i64,
    streamer_epoch: i64,
    vectors: Vec<Vector>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Vector {
    file: String,
    kind: String,
    format: String,

    expect: String,
    reason: String,
    #[allow(dead_code)]
    description: String,
    #[serde(default)]
    expected: Option<Value>,
    #[serde(default)]
    state: Option<Value>,
    #[serde(default)]
    exit_code: Option<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestKeys {
    keys: Vec<TestKey>,
    #[allow(dead_code)]
    unknown_kid: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestKey {
    kid: String,
    public_key: String,
}

struct Oracle {
    dir: PathBuf,
    manifest: Manifest,
    keys: BTreeMap<String, String>,
    agent_version: String,
}

impl Oracle {
    fn load() -> Self {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/protocol");
        let manifest: Manifest = read_json(&dir.join("index.json"));
        let test_keys: TestKeys = read_json(&dir.join(&manifest.keys));
        let keys = test_keys
            .keys
            .into_iter()
            .map(|key| (key.kid, key.public_key))
            .collect();
        let agent_version = vector_agent_version(&dir);
        Self { dir, manifest, keys, agent_version }
    }

    fn keyset(&self, kids: &[String]) -> Keyset {
        Keyset::from_entries(kids.iter().map(|kid| {
            let key = self
                .keys
                .get(kid)
                .unwrap_or_else(|| panic!("keys.test-only.json has no kid {kid}"));
            (kid.as_str(), key.as_str())
        }))
        .expect("the test keyset is well formed")
    }
}

// ----------------------------------------------------------------- the test ---

#[test]
fn every_golden_vector_is_exercised_and_reaches_the_manifest_verdict() {
    let oracle = Oracle::load();
    assert_eq!(oracle.manifest.version, 1, "manifest shape version");
    assert_eq!(
        oracle.manifest.protocol_version,
        owlette_swoop::bundle::SWOOP_PROTOCOL_VERSION
    );

    let mut accepted = 0;
    let mut rejected = 0;
    for vector in &oracle.manifest.vectors {
        let outcome = run_vector(&oracle, vector);
        match (vector.expect.as_str(), outcome) {
            ("accept", Ok(())) => {
                assert_eq!(vector.reason, "ok", "{}: an accept vector reads ok", vector.file);
                accepted += 1;
            }
            ("accept", Err(reason)) => {
                panic!("{}: expected accept, was refused with {reason}", vector.file)
            }
            ("reject", Err(reason)) => {
                assert_eq!(reason, vector.reason, "{}: reason code", vector.file);
                rejected += 1;
            }
            ("reject", Ok(())) => panic!(
                "{}: expected reject/{}, but it was accepted",
                vector.file, vector.reason
            ),
            (other, _) => panic!("{}: unknown expect {other:?}", vector.file),
        }
    }

    assert_eq!(
        accepted + rejected,
        oracle.manifest.vectors.len(),
        "every entry in the manifest is exercised"
    );
    assert_eq!(accepted, 26, "accept vectors");
    assert_eq!(rejected, 13, "reject vectors");
}

/// Run one vector. `Err` is the implementation refusing it, and carries the
/// reason code; anything the harness itself cannot do panics.
fn run_vector(oracle: &Oracle, vector: &Vector) -> Result<(), String> {
    let path = oracle.dir.join(&vector.file);
    // the manifest declares how each vector is encoded; reading it any other
    // way would be reading a different file than the other half of the oracle.
    let format = match vector.kind.as_str() {
        "frame-header" => "binary",
        "pipe-stdout" | "pipe-stdin" => "ndjson",
        _ => "json",
    };
    assert_eq!(vector.format, format, "{}: declared format", vector.file);
    match vector.kind.as_str() {
        "handshake" => handshake(&read_json::<Value>(&path)),
        "jwt" => jwt(oracle, &read_json::<Value>(&path)),
        "signaling" => signaling(&read_json::<Value>(&path)),
        "frame-header" => frame_header(vector, &fs::read(&path).expect("the vector reads")),
        "bundle" => bundle(oracle, vector, &fs::read_to_string(&path).expect("the vector reads")),
        "pipe-stdout" => pipe_stdout(&read_lines(&path)),
        "pipe-stdin" => pipe_stdin(&read_lines(&path)),
        "message-input" => message_input(&read_json::<Value>(&path)),
        "message-cursor" => message_cursor(&read_json::<Value>(&path)),
        "message-clipboard" => message_clipboard(&read_json::<Value>(&path)),
        "message-control" => message_control(&read_json::<Value>(&path)),
        "message-feedback" => message_feedback(&read_json::<Value>(&path)),
        "crypto" => crypto(&read_json::<Value>(&path)),
        unknown => panic!(
            "{}: unknown kind {unknown:?}. PROTOCOL.md: an implementation iterating the manifest \
             MUST fail on an unknown kind rather than skipping it",
            vector.file
        ),
    }
}

// ------------------------------------------------------------------- kinds ---

fn handshake(vector: &Value) -> Result<(), String> {
    let supported = vector["supported"].as_u64().expect("supported") as u32;
    let message: Message = round_trip(&vector["message"], "hello");
    check_hello_version(&message, supported).map_err(|refusal| refusal.reason().to_owned())
}

fn jwt(oracle: &Oracle, vector: &Value) -> Result<(), String> {
    let token = vector["token"].as_str().expect("token");
    let verifier = &vector["verifier"];
    let kids: Vec<String> = serde_json::from_value(verifier["keys"].clone()).expect("keys");
    let keyset = oracle.keyset(&kids);

    let anchor = TimeAnchor::with_elapsed(
        verifier["anchorNow"].as_i64().expect("anchorNow"),
        Duration::from_secs(verifier["elapsedSeconds"].as_u64().expect("elapsedSeconds")),
    );
    let offer_fingerprint = verifier["offerFingerprint"].as_str();
    let sid = verifier["sid"].as_str();
    let ctx = VerifyContext {
        audience: verifier["aud"].as_str().expect("aud"),
        site: verifier["site"].as_str().expect("site"),
        machine: verifier["machine"].as_str().expect("machine"),
        sid,
        offer_fingerprint,
    };

    match keyset.verify(token, &ctx, &anchor, &mut JtiSet::new()) {
        Ok(claims) => {
            assert_values_equal(
                &serde_json::to_value(&claims).expect("claims serialise"),
                &vector["claims"],
                "verified claims",
            );
            Ok(())
        }
        Err(error) => Err(error.reason().to_owned()),
    }
}

fn signaling(vector: &Value) -> Result<(), String> {
    let sender: Role = serde_json::from_value(vector["sender"]["role"].clone()).expect("role");
    // send rights are decided from the type, before the body is parsed: the
    // reject vectors are frames the sender may not send at all, and one of them
    // is deliberately missing a required field.
    let type_name = vector["message"]["type"].as_str().expect("type");
    check_send_right_for_type(sender, type_name).map_err(|refusal| refusal.reason().to_owned())?;
    let message: Message = round_trip(&vector["message"], "signaling message");
    assert_eq!(message.type_name(), type_name);
    Ok(())
}

fn frame_header(vector: &Vector, bytes: &[u8]) -> Result<(), String> {
    let header = match FrameHeader::decode(bytes) {
        Ok(header) => header,
        Err(error) => return Err(error.reason().to_owned()),
    };
    assert_eq!(
        header.encode().as_slice(),
        bytes,
        "{}: the record re-encodes byte for byte",
        vector.file
    );

    let codec = match header.codec {
        FrameCodec::H264 => "h264",
        FrameCodec::Hevc => "hevc",
        FrameCodec::Av1 => "av1",
    };
    let decoded = json!({
        "codec": codec,
        "irap": header.is_irap(),
        "resolutionChanged": header.resolution_changed(),
        "parameterSets": header.parameter_sets_in_band(),
        "fragmentIndex": header.fragment_index,
        "fragmentCount": header.fragment_count,
        "frameId": header.frame_id,
        "rtpTimestamp90k": header.rtp_timestamp_90k,
        "width": header.width,
        "height": header.height,
        "payloadBytes": header.payload_bytes,
        "tCaptureUs": header.stamps.capture_us,
        "tEncodeUs": header.stamps.encode_us,
        "tSendUs": header.stamps.send_us,
        "headerVersion": 1,
        "kind": 1,
    });
    assert_values_equal(
        &decoded,
        vector.expected.as_ref().expect("a frame vector carries expected"),
        &vector.file,
    );

    let state = vector.state.as_ref().expect("a frame vector carries state");
    let mut receiver = ReceiverState {
        last_frame_id: state["lastFrameId"].as_u64().map(|id| id as u32),
        have_irap: state["haveIrap"].as_bool().expect("haveIrap"),
    };
    receiver
        .admit(&header)
        .map_err(|error| error.reason().to_owned())
}

fn bundle(oracle: &Oracle, vector: &Vector, line: &str) -> Result<(), String> {
    let build = BuildVersions {
        protocol_version: oracle.manifest.protocol_version,
        agent_version: &oracle.agent_version,
    };
    let parsed = match Bundle::parse(line.trim(), build) {
        Ok(parsed) => parsed,
        Err(error) => {
            if let Some(expected) = vector.exit_code {
                assert_eq!(
                    error.exit().code(),
                    expected,
                    "{}: exit code",
                    vector.file
                );
            }
            return Err(error.reason().to_owned());
        }
    };

    // The bundle has no `Serialize` on purpose — §7 says it is never written
    // out — so the round-trip is asserted field by field against the source.
    let source: Value = serde_json::from_str(line).expect("the vector is json");
    assert_eq!(parsed.protocol_version, source["protocolVersion"].as_u64().unwrap() as u32);
    assert_eq!(parsed.agent_version, source["agentVersion"]);
    assert_eq!(parsed.sid, source["sid"]);
    assert_eq!(parsed.site, source["site"]);
    assert_eq!(parsed.machine, source["machine"]);
    assert_eq!(parsed.now, source["now"].as_i64().unwrap());
    assert_eq!(parsed.streamer_epoch, source["streamerEpoch"].as_i64().unwrap());
    assert_eq!(parsed.signal_url, source["signalUrl"]);
    assert_eq!(parsed.host_token.expose(), source["hostToken"]);
    assert_eq!(parsed.session_key.expose(), source["sessionKey"]);
    assert_eq!(parsed.ctl, source["ctl"]);
    assert_eq!(
        serde_json::to_value(parsed.indicator).unwrap(),
        source["indicator"]
    );
    assert_eq!(parsed.jwt_keys.len(), source["jwtKeys"].as_array().unwrap().len());
    for (key, expected) in parsed.jwt_keys.iter().zip(source["jwtKeys"].as_array().unwrap()) {
        assert_eq!(key.kid, expected["kid"]);
        assert_eq!(key.alg, expected["alg"]);
        assert_eq!(key.key, expected["key"]);
    }
    assert_eq!(parsed.ice_servers.len(), source["iceServers"].as_array().unwrap().len());
    for (server, expected) in parsed.ice_servers.iter().zip(source["iceServers"].as_array().unwrap())
    {
        assert_eq!(serde_json::to_value(&server.urls).unwrap(), expected["urls"]);
        assert_eq!(
            server.username.as_deref(),
            expected.get("username").and_then(Value::as_str)
        );
        assert_eq!(
            server.credential.as_ref().map(|c| c.expose()),
            expected.get("credential").and_then(Value::as_str)
        );
    }
    let enablement = &source["enablement"];
    assert_eq!(parsed.enablement.members_may_watch, enablement["membersMayWatch"]);
    assert_eq!(parsed.enablement.max_viewers as u64, enablement["maxViewers"].as_u64().unwrap());
    assert_eq!(parsed.enablement.lease_seconds, enablement["leaseSeconds"].as_u64().unwrap());
    assert_eq!(
        parsed.enablement.session_cap_seconds,
        enablement["sessionCapSeconds"].as_u64().unwrap()
    );

    // The bundle's epoch is what §4's timestamps are relative to, and the
    // manifest states it once for both halves of the oracle.
    assert_eq!(parsed.streamer_epoch, oracle.manifest.streamer_epoch);
    assert_eq!(parsed.now, oracle.manifest.time_anchor);
    Ok(())
}

fn pipe_stdout(lines: &[String]) -> Result<(), String> {
    for line in lines {
        let event: Event = serde_json::from_str(line)
            .unwrap_or_else(|error| panic!("stdout line {line}: {error}"));
        assert_eq!(
            serde_json::to_string(&event).expect("it serialises"),
            *line,
            "a stdout event re-serialises byte for byte"
        );
    }
    assert_eq!(lines.len(), 6, "the six stdout events of a clean session");
    Ok(())
}

fn pipe_stdin(lines: &[String]) -> Result<(), String> {
    for line in lines {
        let control: Control = serde_json::from_str(line)
            .unwrap_or_else(|error| panic!("stdin line {line}: {error}"));
        assert_eq!(
            serde_json::to_string(&control).expect("it serialises"),
            *line,
            "a stdin control line re-serialises byte for byte"
        );
    }
    Ok(())
}

fn message_input(vector: &Value) -> Result<(), String> {
    assert_eq!(vector["channel"], "swoop-input");
    for message in vector["messages"].as_array().expect("messages") {
        let _: channel::Input = round_trip(message, "input");
    }
    let viewer_ctl = vector["viewer"]["ctl"].as_bool().expect("viewer.ctl");
    channel::admit_gated(true, viewer_ctl).map_err(|refusal| refusal.reason().to_owned())
}

fn message_cursor(vector: &Value) -> Result<(), String> {
    assert_eq!(vector["channel"], "swoop-cursor");
    for message in vector["messages"].as_array().expect("messages") {
        let _: channel::Cursor = round_trip(message, "cursor");
    }
    Ok(())
}

fn message_clipboard(vector: &Value) -> Result<(), String> {
    assert_eq!(vector["channel"], "swoop-control");
    for message in vector["messages"].as_array().expect("messages") {
        let clip: channel::Clipboard = round_trip(message, "clipboard");
        clip.admit().map_err(|refusal| refusal.reason().to_owned())?;
    }
    Ok(())
}

fn message_control(vector: &Value) -> Result<(), String> {
    assert_eq!(vector["channel"], "swoop-control");
    for message in vector["messages"].as_array().expect("messages") {
        let _: channel::Control = round_trip(&without_fixture_direction(message), "control");
    }
    Ok(())
}

fn message_feedback(vector: &Value) -> Result<(), String> {
    assert_eq!(vector["channel"], "swoop-feedback");
    for message in vector["messages"].as_array().expect("messages") {
        let _: channel::Feedback = round_trip(&without_fixture_direction(message), "feedback");
    }
    Ok(())
}

fn crypto(vector: &Value) -> Result<(), String> {
    let viewer = &vector["hkdf"]["viewerKey"];
    assert_eq!(viewer["salt"], std::str::from_utf8(HKDF_VIEWER_SALT).unwrap());
    assert_eq!(viewer["length"].as_u64().unwrap() as usize, DERIVED_KEY_LEN);
    assert_eq!(vector["hkdf"]["hash"], "SHA-256");
    // the session salt has no vector of its own — the master key lives only in
    // the api — so the note is where its literal is pinned.
    let note = vector["hkdf"]["sessionKeyNote"].as_str().expect("sessionKeyNote");
    assert!(
        note.contains(std::str::from_utf8(HKDF_SESSION_SALT).unwrap()),
        "the session salt literal has drifted from the note that documents it"
    );

    let session_key = derived_key(viewer["ikm"].as_str().expect("ikm"));
    let viewer_key = derive_viewer_key(&session_key, viewer["info"].as_str().expect("info"));
    assert_eq!(
        BASE64_URL_SAFE_NO_PAD.encode(viewer_key.as_bytes()),
        viewer["expected"].as_str().unwrap(),
        "k = HKDF(K_session, viewerId)"
    );

    let host_mac = &vector["hostMac"];
    assert_eq!(host_mac["algorithm"], "HMAC-SHA256");
    let parts: Vec<&str> = host_mac["parts"]
        .as_array()
        .expect("parts")
        .iter()
        .map(|part| part.as_str().expect("part"))
        .collect();
    assert_eq!(parts.len(), 7, "label, sid, viewerId and the fingerprint, zero separated");
    assert_eq!(parts[0], std::str::from_utf8(HOST_FP_MAC_LABEL).unwrap());
    assert!(parts[1] == "0x00" && parts[3] == "0x00" && parts[5] == "0x00");
    let (sid, viewer_id, fingerprint) = (parts[2], parts[4], parts[6]);
    assert_eq!(
        canonical_fingerprint(fingerprint).as_deref(),
        Some(fingerprint),
        "the vector's fingerprint is already canonical"
    );

    let input = host_fp_mac_input(sid, viewer_id, fingerprint);
    assert_eq!(
        BASE64_URL_SAFE_NO_PAD.encode(&input),
        host_mac["input"].as_str().unwrap(),
        "the mac input, byte for byte"
    );
    let key = derived_key(host_mac["key"].as_str().expect("key"));
    assert_eq!(
        host_fp_mac(&key, sid, viewer_id, fingerprint),
        host_mac["expected"].as_str().unwrap(),
    );
    Ok(())
}

// ------------------------------------------------------ the named unit tests ---

/// §11: `exp` is decided by the bundle's anchor plus monotonic elapsed, and by
/// nothing else. The same token flips verdict on the anchor alone, which is
/// what stops a drifted kiosk clock either refusing every session or acquiring
/// a leeway that *is* the replay window.
#[test]
fn exp_is_decided_by_the_bundle_anchor_and_never_by_the_machine_clock() {
    let oracle = Oracle::load();
    let vector: Value = read_json(&oracle.dir.join("jwt/jwt-viewer-expired.json"));
    let token = vector["token"].as_str().unwrap();
    let verifier = &vector["verifier"];
    let keyset = oracle.keyset(&["test-kid-1".to_owned(), "test-kid-2".to_owned()]);
    let ctx = VerifyContext {
        audience: verifier["aud"].as_str().unwrap(),
        site: verifier["site"].as_str().unwrap(),
        machine: verifier["machine"].as_str().unwrap(),
        sid: verifier["sid"].as_str(),
        offer_fingerprint: verifier["offerFingerprint"].as_str(),
    };
    let exp = vector["claims"]["exp"].as_i64().unwrap();

    let past_it = TimeAnchor::with_elapsed(oracle.manifest.time_anchor, Duration::from_secs(2));
    assert_eq!(
        keyset.verify(token, &ctx, &past_it, &mut JtiSet::new()),
        Err(TokenError::Expired)
    );

    // the identical token against a bundle minted before it lapsed.
    let within = TimeAnchor::with_elapsed(exp - 30, Duration::from_secs(2));
    let claims = keyset
        .verify(token, &ctx, &within, &mut JtiSet::new())
        .expect("the same token verifies against an anchor that precedes its exp");
    assert_eq!(claims.exp, Some(exp));

    // and the other direction, on the token the manifest accepts: a later
    // anchor is what expires it, so the verdict tracks the anchor in both
    // directions and the machine clock in neither.
    let live: Value = read_json(&oracle.dir.join("jwt/jwt-viewer-valid.json"));
    let live_token = live["token"].as_str().unwrap();
    let live_exp = live["claims"]["exp"].as_i64().unwrap();
    assert!(keyset
        .verify(
            live_token,
            &ctx,
            &TimeAnchor::with_elapsed(oracle.manifest.time_anchor, Duration::from_secs(2)),
            &mut JtiSet::new()
        )
        .is_ok());
    assert_eq!(
        keyset.verify(
            live_token,
            &ctx,
            &TimeAnchor::with_elapsed(live_exp + 1, Duration::from_secs(0)),
            &mut JtiSet::new()
        ),
        Err(TokenError::Expired)
    );
}

/// §11's `fp_mismatch`, which cannot be a static vector: it is a comparison
/// against a live offer's `a=fingerprint:` line.
#[test]
fn a_viewer_token_bound_to_another_browser_is_refused_against_the_live_offer() {
    let oracle = Oracle::load();
    let vector: Value = read_json(&oracle.dir.join("jwt/jwt-viewer-valid.json"));
    let token = vector["token"].as_str().unwrap();
    let verifier = &vector["verifier"];
    let keyset = oracle.keyset(&["test-kid-1".to_owned()]);
    let anchor = TimeAnchor::with_elapsed(oracle.manifest.time_anchor, Duration::from_secs(2));

    // a real offer, and the fingerprint the host actually sees on it. this one
    // is the host's own certificate, which is exactly what a relay swapping
    // identities would leave in a viewer's offer.
    let answer: Value = read_json(&oracle.dir.join("signaling/signal-answer.json"));
    let someone_else = fingerprint_from_sdp(answer["message"]["sdp"].as_str().unwrap())
        .expect("the vector sdp carries a fingerprint");

    let mut ctx = VerifyContext {
        audience: verifier["aud"].as_str().unwrap(),
        site: verifier["site"].as_str().unwrap(),
        machine: verifier["machine"].as_str().unwrap(),
        sid: verifier["sid"].as_str(),
        offer_fingerprint: Some(&someone_else),
    };
    assert_eq!(
        keyset.verify(token, &ctx, &anchor, &mut JtiSet::new()),
        Err(TokenError::FpMismatch)
    );

    // the offer the token was actually minted for still verifies, so the
    // refusal above is the binding and not a broken fixture.
    let offer: Value = read_json(&oracle.dir.join("signaling/signal-offer.json"));
    let its_own = fingerprint_from_sdp(offer["message"]["sdp"].as_str().unwrap()).unwrap();
    ctx.offer_fingerprint = Some(&its_own);
    assert!(keyset.verify(token, &ctx, &anchor, &mut JtiSet::new()).is_ok());
}

/// §7: the bundle is never echoed in an error message — not at debug, not
/// partially. Every distinctive value in the vector is checked against the
/// `Display` and `Debug` output of every refusal the parser can produce,
/// including the one a malformed line produces, where a serde message would
/// otherwise quote the value it choked on.
#[test]
fn no_bundle_value_reaches_the_display_or_debug_of_an_error() {
    let oracle = Oracle::load();
    let line = fs::read_to_string(oracle.dir.join("bundle/bundle-valid.json")).unwrap();
    let source: Value = serde_json::from_str(&line).unwrap();
    let mut values = Vec::new();
    collect_strings(&source, &mut values);
    assert!(values.len() > 10, "the vector has values worth protecting");

    let build = BuildVersions { protocol_version: 1, agent_version: &oracle.agent_version };
    let mut renderings = Vec::new();

    // every refusal the parser produces, over the real vectors.
    for vector in ["bundle-overrides-no-testhooks", "bundle-missing-anchor", "bundle-version-mismatch"]
    {
        let text = fs::read_to_string(oracle.dir.join(format!("bundle/{vector}.json"))).unwrap();
        let error = Bundle::parse(text.trim(), build).expect_err("the vector is a reject");
        renderings.push(format!("{error} {error:?}"));
    }
    // and a line mangled so that serde itself is what fails, on a real value.
    let mangled = line.replace("\"now\": 1789689600", "\"now\": \"FAKE-TURN-CREDENTIAL\"");
    let error = Bundle::parse(mangled.trim(), build).expect_err("a string now is not a bundle");
    renderings.push(format!("{error} {error:?}"));

    // and the bundle type itself, which is the other way a value escapes.
    let parsed = Bundle::parse(line.trim(), build).expect("the valid vector parses");
    renderings.push(format!("{parsed:?}"));
    renderings.push(format!("{:?} {}", parsed.host_token, parsed.session_key));

    for rendering in &renderings {
        for value in &values {
            assert!(
                !rendering.contains(value.as_str()),
                "{value:?} appears in {rendering:?}"
            );
        }
    }
}

/// §11: `jti` is single use for the lifetime of this process — belt-and-braces
/// behind `fp` and `exp`, and the last step of the order, so a token that fails
/// anything earlier never consumes its `jti`.
#[test]
fn a_replayed_jti_is_refused_and_a_failed_token_does_not_consume_one() {
    let oracle = Oracle::load();
    let vector: Value = read_json(&oracle.dir.join("jwt/jwt-viewer-valid.json"));
    let token = vector["token"].as_str().unwrap();
    let verifier = &vector["verifier"];
    let keyset = oracle.keyset(&["test-kid-1".to_owned()]);
    let anchor = TimeAnchor::with_elapsed(oracle.manifest.time_anchor, Duration::from_secs(2));
    let ctx = VerifyContext {
        audience: verifier["aud"].as_str().unwrap(),
        site: verifier["site"].as_str().unwrap(),
        machine: verifier["machine"].as_str().unwrap(),
        sid: verifier["sid"].as_str(),
        offer_fingerprint: verifier["offerFingerprint"].as_str(),
    };

    let mut seen = JtiSet::new();
    let wrong_offer = VerifyContext { offer_fingerprint: Some("sha-256 00:11"), ..ctx };
    assert_eq!(
        keyset.verify(token, &wrong_offer, &anchor, &mut seen),
        Err(TokenError::FpMismatch)
    );
    assert!(keyset.verify(token, &ctx, &anchor, &mut seen).is_ok());
    assert_eq!(
        keyset.verify(token, &ctx, &anchor, &mut seen),
        Err(TokenError::JtiReplayed)
    );
}

// ----------------------------------------------------------------- helpers ---

fn read_json<T: DeserializeOwned>(path: &Path) -> T {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn read_lines(path: &Path) -> Vec<String> {
    fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

fn derived_key(base64url: &str) -> DerivedKey {
    let bytes: [u8; DERIVED_KEY_LEN] = BASE64_URL_SAFE_NO_PAD
        .decode(base64url)
        .expect("base64url")
        .try_into()
        .expect("32 bytes");
    DerivedKey::from_bytes(bytes)
}

/// The fixtures annotate §5 messages with a `dir` key that says which way the
/// message travels. It is not on the wire — PROTOCOL.md §5 has no such field —
/// so both halves of the oracle strip it before parsing.
fn without_fixture_direction(message: &Value) -> Value {
    let mut message = message.clone();
    if let Some(object) = message.as_object_mut() {
        object.remove("dir");
    }
    message
}

fn round_trip<T: DeserializeOwned + Serialize>(value: &Value, what: &str) -> T {
    let parsed: T = serde_json::from_value(value.clone())
        .unwrap_or_else(|error| panic!("{what}: {error}\n  {value}"));
    let back = serde_json::to_value(&parsed).expect("it serialises");
    assert_values_equal(&back, value, what);
    parsed
}

fn assert_values_equal(actual: &Value, expected: &Value, what: &str) {
    assert!(
        values_equal(actual, expected),
        "{what}: round trip differs\n  expected: {expected}\n  actual:   {actual}"
    );
}

/// JSON has one number type, so `2` and `2.0` are the same value even though
/// serde_json spells them differently. Everything else compares exactly.
fn values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => match (x.as_f64(), y.as_f64()) {
            (Some(x), Some(y)) => x == y,
            _ => x == y,
        },
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| values_equal(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(key, value)| y.get(key).is_some_and(|other| values_equal(value, other)))
        }
        _ => a == b,
    }
}

fn collect_strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) if text.len() >= 4 => out.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|item| collect_strings(item, out)),
        Value::Object(fields) => fields.values().for_each(|field| collect_strings(field, out)),
        _ => {}
    }
}
