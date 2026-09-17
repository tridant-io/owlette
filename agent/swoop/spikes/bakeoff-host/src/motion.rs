//! Test content: a small borderless window on the captured monitor that
//! presents a desktop-like pattern once per vblank.
//!
//! It exists because the front half has nothing to measure on a still desktop.
//! Spike 0.8 §7 measured a genuinely static output at 99.54 % `WAIT_TIMEOUT`
//! and 0.28 fps, so an unattended run with no moving content produces a handful
//! of samples and no distribution at all. This window guarantees ~60 desktop
//! presents a second without a human wiggling a mouse, and it keeps every run
//! comparable: the same pattern, the same size, the same cadence.
//!
//! **It is test content, not part of the product pipeline.** Nothing in
//! `capture.rs` knows it exists; it changes the desktop, and Desktop
//! Duplication picks it up exactly as it picks up any other window.
//!
//! The pattern generator is lifted verbatim from spike 0.9's
//! `nvenc-probe/src/d3d.rs`, so an encode-cost number here is comparable with
//! one there.
//!
//! Hardware-dependent tests in this module are `#[ignore]`d. Manual invocation:
//!
//! ```text
//! cd agent/swoop/spikes/bakeoff-host
//! cargo test -- --ignored --nocapture
//! ```

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use windows::core::w;
use windows::Win32::Foundation::{HMODULE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_SDK_VERSION, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIFactory2, IDXGISwapChain1, DXGI_MWA_NO_ALT_ENTER, DXGI_PRESENT,
    DXGI_SCALING_NONE, DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_EFFECT_FLIP_DISCARD,
    DXGI_USAGE_RENDER_TARGET_OUTPUT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW,
    PostQuitMessage, RegisterClassW, TranslateMessage, MSG, PM_REMOVE, WM_DESTROY, WM_QUIT,
    WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
};

/// How many pre-rendered phases the window cycles through. Sixteen at 60 fps is
/// a 3.7 Hz loop: long enough that consecutive frames never repeat, short
/// enough that the textures cost ~32 MB at this size.
const PHASES: usize = 16;

pub const WIDTH: u32 = 960;
pub const HEIGHT: u32 = 540;

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

/// Present the pattern on `monitor_bounds` until `running` goes false.
///
/// Runs on its own thread with its own message pump, because a window's pump
/// must live on the thread that created it.
pub fn run(monitor_bounds: (i32, i32, i32, i32), running: Arc<AtomicBool>) -> Result<(), String> {
    let (left, top, right, bottom) = monitor_bounds;
    let x = left + ((right - left) - WIDTH as i32).max(0) / 2;
    let y = top + ((bottom - top) - HEIGHT as i32).max(0) / 2;

    let hwnd = unsafe {
        let instance = GetModuleHandleW(None).map_err(|e| format!("GetModuleHandleW: {e}"))?;
        let class = w!("swoop_bakeoff_motion");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: instance.into(),
            lpszClassName: class,
            ..Default::default()
        };
        // A second run in the same process re-registers the class and fails
        // harmlessly; CreateWindowExW is the call that must succeed.
        RegisterClassW(&wc);
        CreateWindowExW(
            // NOACTIVATE so the window never steals focus from the browser the
            // operator is watching, and never changes which window is
            // foreground mid-run.
            WS_EX_TOPMOST | WS_EX_NOACTIVATE,
            class,
            w!("swoop bake-off motion"),
            WS_POPUP | WS_VISIBLE,
            x,
            y,
            WIDTH as i32,
            HEIGHT as i32,
            None,
            None,
            Some(instance.into()),
            None,
        )
        .map_err(|e| format!("CreateWindowExW: {e}"))?
    };

    let result = present_loop(hwnd, &running);
    let _ = unsafe { DestroyWindow(hwnd) };
    result
}

fn present_loop(hwnd: HWND, running: &AtomicBool) -> Result<(), String> {
    let (device, context) = create_device().map_err(|e| format!("D3D11CreateDevice: {e}"))?;
    let swapchain =
        create_swapchain(&device, hwnd).map_err(|e| format!("CreateSwapChainForHwnd: {e}"))?;
    let phases: Vec<ID3D11Texture2D> = (0..PHASES)
        .map(|p| create_pattern_texture(&device, p as u32))
        .collect::<windows::core::Result<_>>()
        .map_err(|e| format!("CreateTexture2D: {e}"))?;

    let mut phase = 0usize;
    while running.load(Ordering::Relaxed) {
        let mut msg = MSG::default();
        while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
            if msg.message == WM_QUIT {
                return Ok(());
            }
            let _ = unsafe { TranslateMessage(&msg) };
            unsafe { DispatchMessageW(&msg) };
        }

        let back: ID3D11Texture2D = unsafe { swapchain.GetBuffer(0) }
            .map_err(|e| format!("swapchain GetBuffer: {e}"))?;
        unsafe { context.CopyResource(&back, &phases[phase % PHASES]) };
        // Present(1, ...) blocks until the next vertical blank, so this loop
        // paces itself at the panel's refresh rate with no timer of its own —
        // the same reason capture.rs has no frame timer.
        unsafe { swapchain.Present(1, DXGI_PRESENT(0)) }
            .ok()
            .map_err(|e| format!("Present: {e}"))?;
        phase += 1;
    }
    Ok(())
}

fn create_device() -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext)> {
    let levels: [D3D_FEATURE_LEVEL; 2] = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
    let mut device = None;
    let mut context = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
    }
    Ok((device.unwrap(), context.unwrap()))
}

fn create_swapchain(device: &ID3D11Device, hwnd: HWND) -> windows::core::Result<IDXGISwapChain1> {
    let factory: IDXGIFactory2 = unsafe { CreateDXGIFactory1()? };
    let desc = DXGI_SWAP_CHAIN_DESC1 {
        Width: WIDTH,
        Height: HEIGHT,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
        BufferCount: 2,
        Scaling: DXGI_SCALING_NONE,
        SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
        AlphaMode: DXGI_ALPHA_MODE_IGNORE,
        ..Default::default()
    };
    let swapchain = unsafe { factory.CreateSwapChainForHwnd(device, hwnd, &desc, None, None)? };
    let _ = unsafe { factory.MakeWindowAssociation(hwnd, DXGI_MWA_NO_ALT_ENTER) };
    Ok(swapchain)
}

fn create_pattern_texture(
    device: &ID3D11Device,
    phase: u32,
) -> windows::core::Result<ID3D11Texture2D> {
    let pixels = pattern_frame(WIDTH, HEIGHT, phase);
    let desc = D3D11_TEXTURE2D_DESC {
        Width: WIDTH,
        Height: HEIGHT,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let init = D3D11_SUBRESOURCE_DATA {
        pSysMem: pixels.as_ptr().cast(),
        SysMemPitch: WIDTH * 4,
        SysMemSlicePitch: 0,
    };
    let mut texture: Option<ID3D11Texture2D> = None;
    unsafe { device.CreateTexture2D(&desc, Some(&init), Some(&mut texture))? };
    Ok(texture.expect("CreateTexture2D succeeded without producing a texture"))
}

/// A desktop-like BGRA frame: dark background with a grid, three "windows" with
/// text-like rows, one block that slides with `phase`, and a small high-entropy
/// region so the encoder is never given a perfectly static picture. Verbatim
/// from spike 0.9's `nvenc-probe/src/d3d.rs`.
pub fn pattern_frame(width: u32, height: u32, phase: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut px = vec![0u8; w * h * 4];

    let put = |buf: &mut [u8], x: usize, y: usize, b: u8, g: u8, r: u8| {
        let i = (y * w + x) * 4;
        buf[i] = b;
        buf[i + 1] = g;
        buf[i + 2] = r;
        buf[i + 3] = 0xff;
    };

    for y in 0..h {
        for x in 0..w {
            let grid = x % 80 == 0 || y % 80 == 0;
            let v = if grid { 0x2a } else { 0x1e };
            put(&mut px, x, y, v, v, v);
        }
    }

    let windows = [
        (w / 20, h / 12, w / 3, h / 3),
        (w / 2, h / 6, w / 3, h / 2),
        (w / 8, h / 2, w / 2, h / 3),
    ];
    for (wx, wy, ww, wh) in windows {
        for y in wy..(wy + wh).min(h) {
            for x in wx..(wx + ww).min(w) {
                let title = y < wy + 28;
                let (b, g, r) = if title {
                    (0x50, 0x3c, 0x30)
                } else {
                    (0xf2, 0xf2, 0xf0)
                };
                put(&mut px, x, y, b, g, r);
            }
        }
        let mut row = wy + 48;
        while row + 6 < (wy + wh).min(h) {
            let mut col = wx + 16;
            while col + 40 < (wx + ww).min(w) {
                let run = 12 + (col * 7 + row * 3) % 60;
                for y in row..row + 6 {
                    for x in col..(col + run).min(wx + ww).min(w) {
                        put(&mut px, x, y, 0x30, 0x30, 0x30);
                    }
                }
                col += run + 12;
            }
            row += 22;
        }
    }

    let bw = w / 6;
    let bh = h / 6;
    let travel = w.saturating_sub(bw).max(1);
    let bx = (phase as usize * 37) % travel;
    let by = h / 3 + ((phase as usize * 11) % (h / 6));
    for y in by..(by + bh).min(h) {
        for x in bx..(bx + bw).min(w) {
            let g = ((x - bx) * 255 / bw.max(1)) as u8;
            let r = ((y - by) * 255 / bh.max(1)) as u8;
            put(&mut px, x, y, 0x90, g, r);
        }
    }

    let (vx, vy, vw, vh) = (w / 2, h - h / 3, (w / 4).min(w - w / 2), h / 4);
    let mut seed = 0x9e37_79b9u32 ^ phase.wrapping_mul(0x85eb_ca6b);
    for y in vy..(vy + vh).min(h) {
        for x in vx..(vx + vw).min(w) {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let v = (seed >> 24) as u8;
            put(&mut px, x, y, v, v.wrapping_add(40), v.wrapping_add(80));
        }
    }

    px
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pattern_is_bgra_sized_and_opaque() {
        let px = pattern_frame(64, 32, 0);
        assert_eq!(px.len(), 64 * 32 * 4);
        assert!(px.chunks_exact(4).all(|p| p[3] == 0xff));
    }

    #[test]
    fn pattern_changes_between_phases() {
        let a = pattern_frame(256, 128, 0);
        let b = pattern_frame(256, 128, 1);
        assert_ne!(a, b, "a static pool would understate encode cost");
    }

    #[test]
    fn the_window_is_centred_on_the_monitor_it_is_given() {
        // The primary on this box at the time of writing.
        let (left, top, right, bottom) = (0, 0, 1920, 1080);
        let x = left + ((right - left) - WIDTH as i32).max(0) / 2;
        let y = top + ((bottom - top) - HEIGHT as i32).max(0) / 2;
        assert_eq!((x, y), (480, 270));
    }
}
