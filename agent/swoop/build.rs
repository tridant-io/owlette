//! Embed a Windows VERSIONINFO resource (and the product icon) in owlette-swoop.exe.
//!
//! Copied from agent/host/build.rs with the names changed. Until 2026-09-08 the
//! service host shipped with NO version resource at all: no CompanyName,
//! ProductName, FileDescription, FileVersion, no icon, and no signature.
//! Combined with a statically linked CRT and a size-optimised, stripped, LTO'd
//! image, that is the exact static profile Defender's ML classifier associates
//! with dropper stubs — and on signature set 1.459.111.0 it began quarantining
//! the installed service host as `Trojan:Win32/Bearfoos.B!ml`, deregistering
//! OwletteService on the way out.
//!
//! The streamer is a far more suspicious-looking binary than the host: it runs
//! as SYSTEM, captures the screen and injects input. Every legitimate Windows
//! binary that does those things carries this metadata; adding it is the single
//! cheapest change to the classifier's inputs. It is NOT a guarantee (only a
//! signature gives reputation that persists across builds), so a rebuilt
//! candidate must still be scanned with
//! `MpCmdRun -Scan -ScanType 3 -File <copy> -DisableRemediation` before it goes
//! anywhere near an installer.
//!
//! FileVersion/ProductVersion come from `CARGO_PKG_VERSION`, which is why this
//! crate's version is kept in step by scripts/sync-versions.js — a stale
//! version stamped into the metadata would defeat the purpose, and the agent
//! refuses to spawn a streamer whose version differs from its own.

use std::env;
use std::path::Path;

fn main() {
    // Only meaningful for the Windows target; a cross-check build elsewhere
    // must not fail for want of rc.exe.
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let mut res = winresource::WindowsResource::new();
    res.set("CompanyName", "Tridant Inc.");
    res.set("ProductName", "owlette");
    res.set("FileDescription", "owlette swoop streamer");
    res.set("InternalName", "owlette-swoop");
    res.set("OriginalFilename", "owlette-swoop.exe");
    res.set("LegalCopyright", "Copyright (c) Tridant Inc. Licensed under FSL-1.1-Apache-2.0.");

    // The product icon lives with the desktop app. Optional: a checkout that
    // lacks it (or a future move) must not break the streamer build.
    let icon = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("desktop")
        .join("src-tauri")
        .join("icons")
        .join("icon.ico");
    if icon.is_file() {
        res.set_icon(icon.to_str().expect("icon path is valid UTF-8"));
        println!("cargo:rerun-if-changed={}", icon.display());
    }

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=Cargo.toml");

    if let Err(e) = res.compile() {
        panic!("failed to embed the Windows version resource: {e}");
    }
}
