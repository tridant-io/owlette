//! The `probe` verb: what this machine can actually capture and encode.
//!
//! Task 7.3 fills `sources` and `encoders` from the real backends. `probe` is
//! run on demand — never on the agent's heartbeat path, which computes the
//! `capabilities.swoop` flag from the binary's presence alone.

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Report {
    /// Matches the binary's own version, so the agent can refuse a stale
    /// streamer without spawning it twice.
    pub version: &'static str,
    /// The heartbeat's spelling (`windows` / `macos` / `linux`), not Rust's.
    pub os_family: &'static str,
    /// The heartbeat's spelling (`x64` / `arm64`).
    pub arch: &'static str,
    pub sources: Vec<String>,
    pub encoders: Vec<crate::encode::BackendCaps>,
}

fn os_family() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        _ => "linux",
    }
}

fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        _ => "x64",
    }
}

pub fn report() -> Report {
    Report {
        version: env!("CARGO_PKG_VERSION"),
        os_family: os_family(),
        arch: arch(),
        sources: Vec::new(),
        encoders: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_serialises_to_json_with_the_heartbeat_spellings() {
        let json = serde_json::to_value(report()).expect("the report serialises");
        assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
        assert!(["windows", "macos", "linux"].contains(&json["os_family"].as_str().unwrap()));
        assert!(["x64", "arm64"].contains(&json["arch"].as_str().unwrap()));
    }
}
