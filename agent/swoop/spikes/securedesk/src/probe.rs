//! Who this process is, what desktop it landed on, and exactly what handles it
//! inherited.
//!
//! The handle census is the measurement primitive (2) needs. **An inherited
//! handle carries `HANDLE_FLAG_INHERIT` in the child**, because `CreateProcess`
//! copies the attribute along with the handle, while a handle the child opens
//! for itself does not have it unless it asks. So counting valid handle values
//! whose flags carry `HANDLE_FLAG_INHERIT` counts what the parent handed over,
//! and nothing else. Handle values are multiples of four, so the scan is a
//! walk, not an enumeration API.
//!
//! The canary is the other half: the harness creates one more inheritable
//! object, leaves it *out* of `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, and tells
//! this process its numeric value on stdin. The value is not a secret. If the
//! handle list is in force the value is invalid here; if it is not, the object
//! is right there, signalled, and the census is three rather than two.

use std::ffi::c_void;

use windows::Win32::Foundation::{
    CloseHandle, GetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0,
};
use windows::Win32::Security::{
    GetTokenInformation, TokenElevation, TokenElevationType, TokenIntegrityLevel, TokenUser,
    TOKEN_ELEVATION, TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::Storage::FileSystem::{
    GetFileType, FILE_TYPE_CHAR, FILE_TYPE_DISK, FILE_TYPE_PIPE,
};
use windows::Win32::System::RemoteDesktop::{ProcessIdToSessionId, WTSGetActiveConsoleSessionId};
use windows::Win32::System::StationsAndDesktops::{
    GetProcessWindowStation, GetThreadDesktop, GetUserObjectInformationW, UOI_NAME,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId, OpenProcessToken,
    WaitForSingleObject,
};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};

use crate::json::{self, Val};

/// Declared before any screen metric is read. A dpi-unaware process reads
/// `SM_CXVIRTUALSCREEN` scaled, which on a mixed-dpi box is a silent error on
/// one monitor and none on the other.
pub fn set_dpi_awareness() {
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
}

/// One handle the child holds.
pub struct HandleRow {
    pub value: usize,
    pub inherited: bool,
    pub kind: &'static str,
}

impl HandleRow {
    fn render(&self) -> String {
        json::obj(&[
            ("value", Val::Num(self.value as i64)),
            ("inherited", Val::Bool(self.inherited)),
            ("kind", json::s(self.kind)),
        ])
    }
}

/// Every valid handle this process holds below `limit`, with whether it was
/// inherited. 1024 handles is far above what a freshly spawned child has and
/// the scan costs a few hundred microseconds.
pub fn handle_census(limit: usize) -> Vec<HandleRow> {
    let mut rows = Vec::new();
    for value in (4..=limit * 4).step_by(4) {
        let handle = HANDLE(value as *mut c_void);
        let mut flags = 0u32;
        if unsafe { GetHandleInformation(handle, &mut flags) }.is_err() {
            continue;
        }
        rows.push(HandleRow {
            value,
            inherited: flags & HANDLE_FLAG_INHERIT.0 != 0,
            kind: file_kind(handle),
        });
    }
    rows
}

fn file_kind(handle: HANDLE) -> &'static str {
    match unsafe { GetFileType(handle) } {
        FILE_TYPE_PIPE => "pipe",
        FILE_TYPE_DISK => "file",
        FILE_TYPE_CHAR => "char",
        _ => "other",
    }
}

/// What the canary handle value looks like from in here.
///
/// `"absent"` is the pass: the handle list kept it out. `"inherited"` means the
/// restriction is not in force and an object the parent never meant to share
/// crossed the boundary — the wait proves it is that object and not an
/// unrelated handle that happens to sit at the same value.
fn canary_verdict(value: u64) -> &'static str {
    if value == 0 {
        return "not_tested";
    }
    let handle = HANDLE(value as usize as *mut c_void);
    let mut flags = 0u32;
    if unsafe { GetHandleInformation(handle, &mut flags) }.is_err() {
        return "absent";
    }
    if flags & HANDLE_FLAG_INHERIT.0 == 0 {
        // Valid, but not inheritable: a handle this process opened for itself
        // that happens to sit at the value the parent's canary had. Handle
        // values are per-process, so this is ordinary, not a leak.
        return "absent_value_reused";
    }
    if unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0 {
        "inherited"
    } else {
        // Inheritable and at the right value but not the signalled event the
        // parent created. Reported rather than guessed at.
        "inheritable_but_not_ours"
    }
}

/// The name of a window station or desktop handle. The handle is borrowed.
fn user_object_name(handle: HANDLE) -> String {
    let mut buffer = [0u16; 128];
    let mut needed = 0u32;
    let ok = unsafe {
        GetUserObjectInformationW(
            handle,
            UOI_NAME,
            Some(buffer.as_mut_ptr().cast()),
            std::mem::size_of_val(&buffer) as u32,
            Some(&mut needed),
        )
    };
    if ok.is_err() {
        return "unknown".to_string();
    }
    let len = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..len])
}

pub fn thread_desktop_name() -> String {
    match unsafe { GetThreadDesktop(GetCurrentThreadId()) } {
        Ok(desktop) => user_object_name(HANDLE(desktop.0)),
        Err(_) => "unknown".to_string(),
    }
}

pub fn window_station_name() -> String {
    match unsafe { GetProcessWindowStation() } {
        Ok(station) => user_object_name(HANDLE(station.0)),
        Err(_) => "unknown".to_string(),
    }
}

pub fn session_id() -> u32 {
    let mut session = 0u32;
    let _ = unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) };
    session
}

pub fn console_session_id() -> u32 {
    unsafe { WTSGetActiveConsoleSessionId() }
}

/// The token's user sid, elevation and integrity level.
///
/// Reported so the memo can say what the child actually got without anyone
/// having to trust that it got it: `S-1-5-18` at integrity `S-1-16-16384` is
/// SYSTEM, and `elevationType` distinguishes a token that was *given* full
/// rights from one that was split and filtered.
pub struct Identity {
    pub user_sid: String,
    pub integrity_sid: String,
    pub elevation_type: u32,
    pub elevated: bool,
}

impl Identity {
    pub fn read() -> Self {
        let mut identity = Self {
            user_sid: "unknown".to_string(),
            integrity_sid: "unknown".to_string(),
            elevation_type: 0,
            elevated: false,
        };
        let mut token = HANDLE::default();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }.is_err() {
            return identity;
        }
        if let Some(buffer) = token_info(token, TokenUser.0 as u32) {
            let user = buffer.as_ptr() as *const TOKEN_USER;
            identity.user_sid = unsafe { sid_string((*user).User.Sid.0 as *const u8) };
        }
        if let Some(buffer) = token_info(token, TokenIntegrityLevel.0 as u32) {
            let label = buffer.as_ptr() as *const TOKEN_MANDATORY_LABEL;
            identity.integrity_sid = unsafe { sid_string((*label).Label.Sid.0 as *const u8) };
        }
        if let Some(buffer) = token_info(token, TokenElevationType.0 as u32) {
            identity.elevation_type = u32::from_le_bytes(buffer[..4].try_into().unwrap_or_default());
        }
        if let Some(buffer) = token_info(token, TokenElevation.0 as u32) {
            let elevation = buffer.as_ptr() as *const TOKEN_ELEVATION;
            identity.elevated = unsafe { (*elevation).TokenIsElevated != 0 };
        }
        let _ = unsafe { CloseHandle(token) };
        identity
    }
}

fn token_info(token: HANDLE, class: u32) -> Option<Vec<u8>> {
    let class = windows::Win32::Security::TOKEN_INFORMATION_CLASS(class as i32);
    let mut needed = 0u32;
    // The sizing call always "fails"; only the length it writes matters.
    let _ = unsafe { GetTokenInformation(token, class, None, 0, &mut needed) };
    if needed == 0 {
        return None;
    }
    let mut buffer = vec![0u8; needed as usize];
    unsafe {
        GetTokenInformation(
            token,
            class,
            Some(buffer.as_mut_ptr().cast()),
            needed,
            &mut needed,
        )
    }
    .ok()?;
    Some(buffer)
}

/// `S-1-5-18` from a raw SID. Hand-rolled rather than `ConvertSidToStringSidW`
/// so the formatting has a unit test that needs no Windows and no `LocalFree`.
unsafe fn sid_string(sid: *const u8) -> String {
    if sid.is_null() {
        return "unknown".to_string();
    }
    let count = unsafe { *sid.add(1) } as usize;
    let bytes = unsafe { std::slice::from_raw_parts(sid, 8 + count * 4) };
    format_sid(bytes)
}

/// The SID wire layout: revision, sub-authority count, a six-byte big-endian
/// identifier authority, then that many little-endian sub-authorities.
fn format_sid(bytes: &[u8]) -> String {
    if bytes.len() < 8 {
        return "unknown".to_string();
    }
    let revision = bytes[0];
    let count = bytes[1] as usize;
    let authority = bytes[2..8].iter().fold(0u64, |acc, b| (acc << 8) | *b as u64);
    let mut out = format!("S-{revision}-{authority}");
    for i in 0..count {
        let at = 8 + i * 4;
        if at + 4 > bytes.len() {
            break;
        }
        let sub = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap_or_default());
        out.push_str(&format!("-{sub}"));
    }
    out
}

/// Everything primitives (1), (2) and (6) need, as one json object.
pub fn report(canary: u64) -> String {
    let census = handle_census(1024);
    let inherited: Vec<&HandleRow> = census.iter().filter(|row| row.inherited).collect();
    let identity = Identity::read();
    let rendered: Vec<String> = inherited.iter().map(|row| row.render()).collect();

    json::obj(&[
        ("pid", Val::Num(unsafe { GetCurrentProcessId() } as i64)),
        ("sessionId", Val::Num(session_id() as i64)),
        ("consoleSessionId", Val::Num(console_session_id() as i64)),
        ("userSid", json::s(identity.user_sid)),
        ("integritySid", json::s(identity.integrity_sid)),
        ("elevationType", Val::Num(identity.elevation_type as i64)),
        ("elevated", Val::Bool(identity.elevated)),
        ("windowStation", json::s(window_station_name())),
        ("threadDesktop", json::s(thread_desktop_name())),
        ("handlesTotal", Val::Num(census.len() as i64)),
        ("handlesInherited", Val::Num(inherited.len() as i64)),
        ("inherited", Val::Raw(json::arr(&rendered))),
        ("canary", json::s(canary_verdict(canary))),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_sid_renders_the_well_known_system_sid() {
        // S-1-5-18: revision 1, one sub-authority, authority 5, sub 18.
        let bytes = [1u8, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0];
        assert_eq!(format_sid(&bytes), "S-1-5-18");
    }

    #[test]
    fn format_sid_renders_the_system_integrity_level() {
        // S-1-16-16384, the label a SYSTEM process carries.
        let bytes = [1u8, 1, 0, 0, 0, 0, 0, 16, 0, 64, 0, 0];
        assert_eq!(format_sid(&bytes), "S-1-16-16384");
    }

    #[test]
    fn format_sid_renders_a_multi_sub_authority_sid() {
        // S-1-5-32-544, the local Administrators group.
        let bytes = [1u8, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 32, 2, 0, 0];
        assert_eq!(format_sid(&bytes), "S-1-5-32-544");
    }

    #[test]
    fn format_sid_refuses_a_truncated_buffer_rather_than_indexing_past_it() {
        assert_eq!(format_sid(&[1, 1, 0]), "unknown");
        // A count that claims more sub-authorities than the buffer holds stops
        // at what is there.
        assert_eq!(format_sid(&[1, 4, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0]), "S-1-5-18");
    }

    #[test]
    fn a_zero_canary_is_reported_as_untested_rather_than_as_a_pass() {
        assert_eq!(canary_verdict(0), "not_tested");
    }

    #[test]
    #[ignore = "reads this process's real handle table; cargo test -- --ignored"]
    fn the_census_finds_this_process_s_own_handles() {
        let census = handle_census(1024);
        assert!(!census.is_empty(), "no handles found at all");
        // Run from cargo the test harness owns stdio, so nothing is asserted
        // about the inherited count here - that is what the spawn run measures.
        println!(
            "{} handles, {} inherited",
            census.len(),
            census.iter().filter(|row| row.inherited).count()
        );
    }
}
