//! D3D11 device plus a pool of `B8G8R8A8_UNORM` textures carrying a synthetic
//! desktop-like test pattern.
//!
//! The pattern stands in for Desktop Duplication output (spike 0.8 owns real
//! capture) so the encoder numbers are reproducible and do not depend on what
//! happens to be on screen. The textures are `D3D11_USAGE_DEFAULT` with render
//! target + shader resource bind flags, which is what Desktop Duplication hands
//! back and what NVENC requires of a registered DirectX input resource — and
//! they are fed to NVENC unchanged, with no shader and no VideoProcessor
//! (research/03-windows-host-stack.md §2.2).

use windows::core::Result;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11_SUBRESOURCE_DATA,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

/// Create a hardware D3D11 device. `BGRA_SUPPORT` is set because every texture
/// here is BGRA, the format Desktop Duplication produces.
pub fn create_device() -> Result<ID3D11Device> {
    let levels = [D3D_FEATURE_LEVEL_11_0];
    let mut device: Option<ID3D11Device> = None;
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
            None,
        )?;
    }
    Ok(device.expect("D3D11CreateDevice succeeded without producing a device"))
}

/// Create a BGRA texture pre-filled with `pixels` (tightly packed, 4 bytes per
/// pixel). Filling at creation time keeps every per-frame copy off the
/// measurement: the encode loop only cycles through already-resident textures.
pub fn create_bgra_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    pixels: &[u8],
) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
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
        SysMemPitch: width * 4,
        SysMemSlicePitch: 0,
    };
    let mut texture: Option<ID3D11Texture2D> = None;
    unsafe {
        device.CreateTexture2D(&desc, Some(&init), Some(&mut texture))?;
    }
    Ok(texture.expect("CreateTexture2D succeeded without producing a texture"))
}

/// Build a desktop-like BGRA frame: a dark background with a grid, three static
/// "windows" with text-like rows, one window-sized block that slides with
/// `phase`, and a small high-entropy region so the encoder is never given a
/// perfectly static picture. This is deliberately cheaper than real content to
/// compress and deliberately not static — a flat frame would make every encode
/// latency number meaninglessly optimistic.
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

    // Three static "windows" with a title bar and text-like rows.
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

    // A sliding block: real motion for the motion estimator to find.
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

    // A small "video" region of changing high-entropy pixels: without it the
    // encoder can coast on a mostly-static frame and understate its own cost.
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
    use super::pattern_frame;

    #[test]
    fn pattern_is_bgra_sized_and_opaque() {
        let px = pattern_frame(64, 32, 0);
        assert_eq!(px.len(), 64 * 32 * 4);
        assert!(px.as_chunks::<4>().0.iter().all(|p| p[3] == 0xff));
    }

    #[test]
    fn pattern_changes_between_phases() {
        let a = pattern_frame(256, 128, 0);
        let b = pattern_frame(256, 128, 1);
        assert_ne!(a, b, "a static pool would understate encode cost");
    }
}
