//! swoop spike 0.3 child: the process `spawn-py` launches as SYSTEM in the
//! active console session, over inherited anonymous pipes.
//!
//! It is not the streamer and it is not `agent/swoop/src`. It exists to be
//! *spawned*, so it answers the questions only a real child can: what handles
//! did it inherit, what token did it get, what desktop did it land on, and what
//! happens to capture and to `SendInput` when the input desktop moves under it.
//!
//! The wire is `agent/swoop/PROTOCOL.md` section 6's shape, kept deliberately:
//! **stdin line 1 is the bundle**, one json object on one line, then control
//! lines; **stdout is json lines**. Nothing sensitive is ever on a command line
//! and nothing here ever echoes, logs or hashes the bundle — the spike's bundle
//! carries fake values and is still treated as if it did not.
//!
//! ```text
//! cd agent/swoop/spikes/securedesk
//! cargo clippy -- -D warnings
//! cargo test                            # pure logic
//! cargo test -- --ignored --nocapture   # touches this machine's input
//! ```
//!
//! It is driven by `../spawn-py/spawn_spike.py`, never by hand: run on its own
//! it reads a bundle line from a terminal and waits.
//!
//! stdin, harness -> child:
//!
//! ```text
//! {bundle, plus "spikeCanary": <handle value>}   line 1
//! {"type":"inject","arm":"none"|"capture"|"inject"}
//! {"type":"desk","seconds":N,"access":"capture"|"inject","output":N}
//! {"type":"sas"}
//! {"type":"kill"}
//! ```
//!
//! stdout, child -> harness: `ready`, `inject_result`, `desk_*`, `sas_result`,
//! `error`, `exiting`.

mod desk;
mod inject;
mod json;
mod probe;
mod rights;

use std::io::{BufRead, Write};

use json::Val;

/// Matches the streamer's own `EXIT_BUNDLE_INVALID`, so the harness reads the
/// same code the product would report.
const EXIT_BUNDLE_INVALID: i32 = 10;

/// How long a `desk` run is allowed to last, whatever it asks for. A spike that
/// can be told to hold the capture thread for an hour is a spike that gets left
/// running on somebody's console.
const DESK_MAX_SECONDS: u64 = 600;

fn main() -> std::process::ExitCode {
    probe::set_dpi_awareness();

    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();

    // Line 1 is the bundle. Only two fields are read out of it and neither is
    // secret; the rest is never touched.
    let Some(Ok(bundle)) = lines.next() else {
        emit(&json::obj(&[
            ("type", json::s("exiting")),
            ("code", Val::Num(EXIT_BUNDLE_INVALID as i64)),
            ("reason", json::s("no_bundle")),
        ]));
        return std::process::ExitCode::from(EXIT_BUNDLE_INVALID as u8);
    };
    if !bundle.trim_start().starts_with('{') {
        emit(&json::obj(&[
            ("type", json::s("exiting")),
            ("code", Val::Num(EXIT_BUNDLE_INVALID as i64)),
            ("reason", json::s("bundle_not_json")),
        ]));
        return std::process::ExitCode::from(EXIT_BUNDLE_INVALID as u8);
    }
    let sid = json::field_str(&bundle, "sid").unwrap_or_default();
    let canary = json::field_u64(&bundle, "spikeCanary").unwrap_or(0);
    let bundle_bytes = bundle.len();
    drop(bundle);

    emit(&json::obj(&[
        ("type", json::s("ready")),
        ("sid", json::s(&sid)),
        ("version", json::s(env!("CARGO_PKG_VERSION"))),
        ("protocolVersion", Val::Num(1)),
        // The length, never the content: it is what says the whole line
        // arrived, and it is all the harness needs to say so.
        ("bundleBytes", Val::Num(bundle_bytes as i64)),
        ("probe", Val::Raw(probe::report(canary))),
    ]));

    for line in lines {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match json::field_str(line, "type").as_deref() {
            Some("kill") => {
                emit(&exiting("kill"));
                return std::process::ExitCode::SUCCESS;
            }
            Some("probe") => emit(&json::obj(&[
                ("type", json::s("probe_result")),
                ("probe", Val::Raw(probe::report(canary))),
            ])),
            Some("inject") => {
                let arm = json::field_str(line, "arm").unwrap_or_else(|| "none".into());
                emit(&inject::arm(&arm));
            }
            Some("sas") => emit(&inject::send_sas()),
            Some("desk") => run_desk(line),
            other => emit(&json::obj(&[
                ("type", json::s("error")),
                ("reason", json::s("unknown_type")),
                ("got", json::s(other.unwrap_or("-"))),
            ])),
        }
    }

    // Eof on stdin means the harness is gone. Same contract as the streamer's.
    emit(&exiting("eof"));
    std::process::ExitCode::SUCCESS
}

/// A `desk` run owns a thread of its own for the length of the run, because
/// `SetThreadDesktop` cannot be undone for the thread that called it and the
/// thread reading stdin must stay where it is.
fn run_desk(line: &str) {
    let seconds = json::field_u64(line, "seconds")
        .unwrap_or(30)
        .clamp(1, DESK_MAX_SECONDS);
    let access = json::field_str(line, "access").unwrap_or_else(|| "capture".into());
    let output = json::field_u64(line, "output").unwrap_or(0) as usize;
    let joined = std::thread::spawn(move || {
        desk::Run::new(&access, output).run(seconds, &|line| emit(&line));
    })
    .join();
    if joined.is_err() {
        emit(&json::obj(&[
            ("type", json::s("error")),
            ("reason", json::s("desk_thread_panicked")),
        ]));
    }
}

fn exiting(reason: &str) -> String {
    json::obj(&[
        ("type", json::s("exiting")),
        ("code", Val::Num(0)),
        ("reason", json::s(reason)),
    ])
}

/// One json line, flushed. Stdout is an anonymous pipe with no buffer of its
/// own worth relying on, and the harness is timing the round trip.
fn emit(line: &str) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exiting_carries_the_reason_and_a_zero_code() {
        assert_eq!(
            exiting("kill"),
            r#"{"type":"exiting","code":0,"reason":"kill"}"#
        );
    }

    #[test]
    fn a_desk_run_is_clamped_to_something_a_human_will_wait_for() {
        let seconds = json::field_u64(r#"{"type":"desk","seconds":99999}"#, "seconds")
            .unwrap_or(30)
            .clamp(1, DESK_MAX_SECONDS);
        assert_eq!(seconds, DESK_MAX_SECONDS);
        let defaulted = json::field_u64(r#"{"type":"desk"}"#, "seconds")
            .unwrap_or(30)
            .clamp(1, DESK_MAX_SECONDS);
        assert_eq!(defaulted, 30);
    }

    #[test]
    fn the_bundle_line_yields_only_the_two_fields_the_child_reads() {
        let bundle = r#"{"protocolVersion":1,"sid":"sid_0001","hostToken":"FAKE","spikeCanary":880}"#;
        assert_eq!(json::field_str(bundle, "sid").as_deref(), Some("sid_0001"));
        assert_eq!(json::field_u64(bundle, "spikeCanary"), Some(880));
    }
}
