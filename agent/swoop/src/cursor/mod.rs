//! Cursor shape and position, kept in sync with the viewer.
//!
//! Desktop Duplication never blends the pointer into the desktop image: the
//! adapter draws it, and what `AcquireNextFrame` hands back is the desktop
//! without it. So the encoded frames carry no cursor at all and the viewer has
//! to composite one from the messages this module emits — which is what
//! [`CursorMetadata::pointer_in_frame`] says on the wire, and why it is `false`
//! and stays `false` for this backend.
//!
//! Every number below is a measurement from spike 0.8 (Windows 11 23H2
//! 22631.6199, two attached outputs), over 500 frames / 25 s:
//!
//! - `LastMouseUpdateTime == 0` on **102 frames (20.4%)** — a frame carrying no
//!   pointer news at all. `PointerPosition` on such a frame is not zeroed, it
//!   is *stale*, so reading it unconditionally is how the cursor teleports to
//!   the top-left corner. [`pointer_position`] returns `None` for those frames
//!   and the tracker is not told anything.
//! - Of the 398 updates that did carry news: `Visible` true 325, false 73.
//! - 142 shape updates across **11 distinct shapes** — `COLOR` 120,
//!   `MONOCHROME` 16, `MASKED_COLOR` 6, all 32x32, hotspots (0,0) to (16,16).
//!   Caching by content is what turns those 142 updates into 11 bitmaps on the
//!   wire; the rest are `{"t":"cshape","id":n}` or nothing at all.
//!
//! # The monochrome trap
//!
//! A 32x32 `MONOCHROME` shape reports `Height = 64, Pitch = 4`. The buffer is
//! two stacked 1-bit planes — the AND mask on top of the XOR mask — so the
//! image is `Height / 2` rows tall and the second plane starts at
//! `Pitch * Height / 2`. Reading `Height` as the image height gives a cursor
//! whose bottom half is the mask. See [`ShapeInfo::image_height`].
//!
//! # Hotspot
//!
//! `hotX`/`hotY` are in pixels of the PNG that goes with them, so every scaling
//! step this module applies has to move the hotspot with it or the I-beam
//! selects from its corner. The scaling step is per-monitor DPI: the same
//! pointer is a 64x64 bitmap on a 200% output and a 32x32 one at 100%, and it
//! is 32 css px either way. [`fit_for_css`] is the only place that resizes.
//!
//! Hardware tests are `#[ignore]`d. With the working directory `agent/swoop`:
//!
//! ```text
//! cargo test -- --ignored --nocapture cursor
//! ```
//!
//! Expected on a dev box: a tally of frames with and without a pointer update,
//! at least one shape decoded, and fewer distinct shapes than shape updates.

use base64::prelude::{Engine as _, BASE64_STANDARD};
use serde::Serialize;

use crate::capture::{Rect, Rotation};
use crate::input::PointerSpace;
use crate::signal::messages::channel::Cursor;

/// 96 dpi is 100% scaling — `USER_DEFAULT_SCREEN_DPI`.
pub const DEFAULT_DPI: u32 = 96;

/// §5: a css cursor larger than this is presented as an overlay by the viewer,
/// and browsers ignore one above 128x128 outright. Shapes are downscaled to
/// fit rather than sent at a size that may be silently dropped.
pub const MAX_CSS_SIZE: u32 = 32;

/// Hard ceiling on the emitted bitmap, in image pixels.
///
/// [`MAX_CSS_SIZE`] alone does not bound the bytes: at 400% scaling a 32 css px
/// pointer is a 128x128 bitmap, which is 65 KiB of RGBA and — with the stored
/// deflate blocks [`encode_png`] writes — more than §2's 64 KiB frame cap once
/// base64'd. 64 px keeps the worst case near 22 KiB.
pub const MAX_IMAGE_SIZE: u32 = 64;

/// Anything larger is refused rather than decoded: the largest cursor Windows
/// produces at the largest accessibility size is 256 px, and the shape info
/// comes from a driver.
const MAX_SHAPE_DIM: u32 = 512;

/// Distinct shapes held for id reuse. 11 were measured in 25 s; the cap only
/// bounds an animated cursor that churns. Ids are never reused after an
/// eviction — a viewer's cache is its own, and a duplicate bitmap is cheaper
/// than an id that means two things.
const MAX_CACHED_SHAPES: usize = 64;

/// What the viewer needs to know about how the pointer is delivered, for the
/// `swoop-meta` channel. Neither `cpos` nor `cshape` has anywhere to say it and
/// PROTOCOL.md §5 does not define either field, so it travels as metadata
/// rather than as a new message type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorMetadata {
    /// False for Desktop Duplication: the video carries no pointer and the
    /// viewer must draw the shape itself at the last `cpos`.
    pub pointer_in_frame: bool,
    /// The largest shape the viewer will be sent, in css pixels.
    pub max_css_size: u32,
}

impl Default for CursorMetadata {
    fn default() -> Self {
        Self {
            pointer_in_frame: false,
            max_css_size: MAX_CSS_SIZE,
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CursorError {
    #[error("unknown pointer shape type {0}")]
    UnknownShapeType(u32),
    /// A monochrome shape's two planes cannot be split.
    #[error("monochrome shape height {0} is not two stacked planes")]
    OddMonochromeHeight(u32),
    #[error("pointer shape has a zero dimension")]
    EmptyShape,
    #[error("pointer shape {0}x{1} is larger than any real cursor")]
    ShapeTooLarge(u32, u32),
    #[error("pitch {pitch} is too small for {width} pixels")]
    PitchTooSmall { pitch: u32, width: u32 },
    #[error("pointer shape buffer holds {got} bytes, needs {needed}")]
    ShortBuffer { needed: usize, got: usize },
}

/// The three encodings `DXGI_OUTDUPL_POINTER_SHAPE_INFO.Type` can carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShapeKind {
    /// Two stacked 1-bit planes, AND then XOR.
    Monochrome,
    /// BGRA with a real alpha channel.
    Color,
    /// BGRA where the alpha byte is a mask, not coverage.
    MaskedColor,
}

impl ShapeKind {
    pub fn from_dxgi(value: u32) -> Result<Self, CursorError> {
        match value {
            1 => Ok(ShapeKind::Monochrome),
            2 => Ok(ShapeKind::Color),
            4 => Ok(ShapeKind::MaskedColor),
            other => Err(CursorError::UnknownShapeType(other)),
        }
    }
}

/// `DXGI_OUTDUPL_POINTER_SHAPE_INFO`, as reported.
///
/// `height` is the buffer's row count, which for [`ShapeKind::Monochrome`] is
/// twice the image height. Use [`ShapeInfo::image_height`], never `height`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShapeInfo {
    pub kind: ShapeKind,
    pub width: u32,
    pub height: u32,
    pub pitch: u32,
    pub hot_x: u32,
    pub hot_y: u32,
}

impl ShapeInfo {
    /// Rows of picture, as opposed to rows of buffer.
    pub fn image_height(&self) -> Result<u32, CursorError> {
        match self.kind {
            ShapeKind::Monochrome => {
                if self.height == 0 || !self.height.is_multiple_of(2) {
                    return Err(CursorError::OddMonochromeHeight(self.height));
                }
                Ok(self.height / 2)
            }
            _ => Ok(self.height),
        }
    }
}

/// A decoded pointer, straight (non-premultiplied) RGBA, hotspot in its own
/// pixels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorImage {
    pub width: u32,
    pub height: u32,
    pub hot_x: u32,
    pub hot_y: u32,
    pub rgba: Vec<u8>,
}

/// Where the pointer is, when the frame said anything about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PointerPosition {
    /// Output-local, un-rotated texture coordinates.
    pub x: i32,
    pub y: i32,
    pub visible: bool,
}

/// One output's geometry, as the cursor path needs it.
///
/// The three spaces Desktop Duplication hands out are not interchangeable
/// (see [`crate::capture::Rect`]): pointer positions are output-local and
/// un-rotated, `desktop_rect` is virtual-desktop and rotated, and the virtual
/// desktop's origin is negative in both axes on a normal two-monitor box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputGeometry {
    pub desktop_rect: Rect,
    pub rotation: Rotation,
    /// The acquired texture's size, un-rotated — never the mode's.
    pub texture: (u32, u32),
    /// Effective dpi of this output. 96 is 100%.
    pub dpi: u32,
}

impl OutputGeometry {
    /// Host pixels per css pixel on this output.
    pub fn scale(&self) -> f64 {
        if self.dpi == 0 {
            1.0
        } else {
            f64::from(self.dpi) / f64::from(DEFAULT_DPI)
        }
    }

    /// An output-local pointer position, normalised over the texture the
    /// encoder is fed — the `x`/`y` of a `cpos`.
    ///
    /// Normalised and not absolute so a mode change mid-session does not move
    /// the cursor on the viewer. The divisor is `size - 1`, exactly as
    /// [`crate::input::absolute_from_desktop`] uses it and for the same reason:
    /// this is the inverse of the mapping injection runs on a `m` message, and
    /// a cursor drawn where the viewer's own click does not land is worse than
    /// a half-pixel bias.
    pub fn normalise(&self, at: (i32, i32)) -> (f64, f64) {
        let axis = |v: i32, size: u32| {
            let span = f64::from(size.saturating_sub(1).max(1));
            (f64::from(v) / span).clamp(0.0, 1.0)
        };
        (axis(at.0, self.texture.0), axis(at.1, self.texture.1))
    }

    /// The viewer→desktop transform for this output, which run forwards over
    /// [`OutputGeometry::normalise`]'s output puts a pointer position in
    /// virtual-desktop pixels.
    ///
    /// Task 4.3 owns it: rotation and a virtual-desktop origin that is negative
    /// in both axes are the two things a second implementation would drift on,
    /// and the cursor the viewer draws has to agree with where its click lands.
    pub fn pointer_space(&self) -> PointerSpace {
        PointerSpace {
            rect: self.desktop_rect,
            rotation: self.rotation,
        }
    }
}

/// Decode a pointer shape buffer into straight RGBA.
pub fn decode(info: &ShapeInfo, buf: &[u8]) -> Result<CursorImage, CursorError> {
    let height = info.image_height()?;
    if info.width == 0 || height == 0 {
        return Err(CursorError::EmptyShape);
    }
    if info.width > MAX_SHAPE_DIM || height > MAX_SHAPE_DIM {
        return Err(CursorError::ShapeTooLarge(info.width, height));
    }
    let min_pitch = match info.kind {
        ShapeKind::Monochrome => info.width.div_ceil(8),
        _ => info.width * 4,
    };
    if info.pitch < min_pitch {
        return Err(CursorError::PitchTooSmall {
            pitch: info.pitch,
            width: info.width,
        });
    }
    // Monochrome's buffer is both planes; the others are one.
    let rows = if info.kind == ShapeKind::Monochrome {
        height * 2
    } else {
        height
    };
    let needed = info.pitch as usize * rows as usize;
    if buf.len() < needed {
        return Err(CursorError::ShortBuffer {
            needed,
            got: buf.len(),
        });
    }

    let pitch = info.pitch as usize;
    let mut rgba = Vec::with_capacity((info.width * height * 4) as usize);
    for y in 0..height as usize {
        for x in 0..info.width as usize {
            let px = match info.kind {
                ShapeKind::Monochrome => {
                    // The XOR plane sits below the AND plane in the same buffer.
                    let and = mask_bit(&buf[y * pitch..], x);
                    let xor = mask_bit(&buf[(height as usize + y) * pitch..], x);
                    match (and, xor) {
                        (false, false) => [0, 0, 0, 255],
                        (false, true) => [255, 255, 255, 255],
                        (true, false) => [0, 0, 0, 0],
                        // "XOR with the screen" has no css equivalent and the
                        // desktop image is not ours to read here, so an invert
                        // pixel is drawn opaque black. It is the choice that
                        // keeps a caret or a sizing bar visible on the light
                        // chrome these appear over.
                        (true, true) => [0, 0, 0, 255],
                    }
                }
                ShapeKind::Color => {
                    let p = &buf[y * pitch + x * 4..];
                    [p[2], p[1], p[0], p[3]]
                }
                ShapeKind::MaskedColor => {
                    // The alpha byte is a mask: 0 replaces the screen pixel,
                    // 0xFF xors with it. An xor of black changes nothing, which
                    // is the transparent case; any other xor is approximated by
                    // the colour itself.
                    let p = &buf[y * pitch + x * 4..];
                    let (b, g, r, mask) = (p[0], p[1], p[2], p[3]);
                    if mask != 0 && r == 0 && g == 0 && b == 0 {
                        [0, 0, 0, 0]
                    } else {
                        [r, g, b, 255]
                    }
                }
            };
            rgba.extend_from_slice(&px);
        }
    }

    Ok(CursorImage {
        width: info.width,
        height,
        hot_x: info.hot_x,
        hot_y: info.hot_y,
        rgba,
    })
}

/// One pixel of a 1-bit plane, most significant bit first.
fn mask_bit(row: &[u8], x: usize) -> bool {
    (row[x / 8] >> (7 - (x % 8))) & 1 == 1
}

/// Downscale a decoded shape until the browser will take it, moving the hotspot
/// with it.
///
/// Two ceilings: [`MAX_CSS_SIZE`] in css pixels, which depends on the output's
/// dpi because a 200% output delivers a bitmap of twice the pixels for the same
/// cursor, and [`MAX_IMAGE_SIZE`] in image pixels, which bounds the message.
pub fn fit_for_css(image: CursorImage, dpi: u32) -> CursorImage {
    let longest = image.width.max(image.height);
    let dpi = if dpi == 0 { DEFAULT_DPI } else { dpi };
    let css = (u64::from(longest) * u64::from(DEFAULT_DPI)).div_ceil(u64::from(dpi)) as u32;
    let factor = css
        .div_ceil(MAX_CSS_SIZE)
        .max(longest.div_ceil(MAX_IMAGE_SIZE))
        .max(1);
    if factor == 1 {
        return image;
    }
    downscale(&image, factor)
}

/// Box filter by an integer factor, averaging in premultiplied alpha so a
/// transparent pixel's colour does not tint the pixels it is averaged with.
fn downscale(src: &CursorImage, factor: u32) -> CursorImage {
    let width = src.width.div_ceil(factor);
    let height = src.height.div_ceil(factor);
    let mut rgba = vec![0u8; (width * height * 4) as usize];
    for ty in 0..height {
        for tx in 0..width {
            let (mut r, mut g, mut b, mut alpha, mut n) = (0u32, 0u32, 0u32, 0u32, 0u32);
            for sy in ty * factor..((ty + 1) * factor).min(src.height) {
                for sx in tx * factor..((tx + 1) * factor).min(src.width) {
                    let i = ((sy * src.width + sx) * 4) as usize;
                    let a = u32::from(src.rgba[i + 3]);
                    r += u32::from(src.rgba[i]) * a;
                    g += u32::from(src.rgba[i + 1]) * a;
                    b += u32::from(src.rgba[i + 2]) * a;
                    alpha += a;
                    n += 1;
                }
            }
            if alpha == 0 || n == 0 {
                continue;
            }
            let i = ((ty * width + tx) * 4) as usize;
            rgba[i] = (r / alpha) as u8;
            rgba[i + 1] = (g / alpha) as u8;
            rgba[i + 2] = (b / alpha) as u8;
            rgba[i + 3] = (alpha / n) as u8;
        }
    }
    CursorImage {
        width,
        height,
        hot_x: src.hot_x / factor,
        hot_y: src.hot_y / factor,
        rgba,
    }
}

/// Tracks what the viewer has been told, so an unchanged shape costs nothing
/// and a repeat costs an id.
#[derive(Debug)]
pub struct CursorTracker {
    shapes: Vec<CachedShape>,
    current: Option<u32>,
    next_id: u32,
    last: Option<(i32, i32, bool)>,
}

#[derive(Debug)]
struct CachedShape {
    id: u32,
    image: CursorImage,
    png: String,
}

impl CachedShape {
    fn full(&self) -> Cursor {
        Cursor::Cshape {
            id: self.id,
            hot_x: Some(self.image.hot_x as u16),
            hot_y: Some(self.image.hot_y as u16),
            w: Some(self.image.width as u16),
            h: Some(self.image.height as u16),
            png: Some(self.png.clone()),
        }
    }
}

impl Default for CursorTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl CursorTracker {
    pub fn new() -> Self {
        Self {
            shapes: Vec::new(),
            current: None,
            // Ids start at 1 so a viewer can treat 0 as "no shape yet".
            next_id: 1,
            last: None,
        }
    }

    /// A new shape buffer from `GetFramePointerShape`.
    ///
    /// `Ok(None)` when the decoded shape is the one the viewer is already
    /// drawing — the common case, 142 updates for 11 shapes.
    pub fn on_shape(
        &mut self,
        info: &ShapeInfo,
        buf: &[u8],
        dpi: u32,
    ) -> Result<Option<Cursor>, CursorError> {
        let image = fit_for_css(decode(info, buf)?, dpi);
        if let Some(current) = self.current {
            if self
                .shapes
                .iter()
                .any(|s| s.id == current && s.image == image)
            {
                return Ok(None);
            }
        }
        if let Some(cached) = self.shapes.iter().find(|s| s.image == image) {
            let id = cached.id;
            self.current = Some(id);
            return Ok(Some(Cursor::Cshape {
                id,
                hot_x: None,
                hot_y: None,
                w: None,
                h: None,
                png: None,
            }));
        }

        let id = self.next_id;
        self.next_id += 1;
        let png = BASE64_STANDARD.encode(encode_png(&image));
        self.shapes.push(CachedShape { id, image, png });
        if self.shapes.len() > MAX_CACHED_SHAPES {
            self.shapes.remove(0);
        }
        self.current = Some(id);
        Ok(self.shapes.last().map(CachedShape::full))
    }

    /// A pointer position from a frame that carried one.
    ///
    /// `Ok(None)` for a repeat: the pointer is reported on most frames and it
    /// has usually not moved.
    pub fn on_position(
        &mut self,
        position: PointerPosition,
        geometry: &OutputGeometry,
        ts_us: i64,
    ) -> Option<Cursor> {
        let sample = (position.x, position.y, position.visible);
        if self.last == Some(sample) {
            return None;
        }
        self.last = Some(sample);
        let (x, y) = geometry.normalise((position.x, position.y));
        Some(Cursor::Cpos {
            x,
            y,
            visible: position.visible,
            ts_us,
        })
    }

    /// The full current shape, for a viewer that has just joined and whose
    /// shape cache is empty.
    pub fn current_shape(&self) -> Option<Cursor> {
        let current = self.current?;
        self.shapes
            .iter()
            .find(|s| s.id == current)
            .map(CachedShape::full)
    }

    /// Distinct shapes cached so far.
    pub fn cached_shapes(&self) -> usize {
        self.shapes.len()
    }
}

// ------------------------------------------------------------------- png

/// An RGBA PNG with stored (uncompressed) deflate blocks.
///
/// No compressor: this crate has no deflate dependency and a cursor is at most
/// [`MAX_IMAGE_SIZE`] square, so the worst case is ~16 KiB of IDAT against a
/// 64 KiB frame cap, sent once per distinct shape. The cost of the missing
/// compression is bytes, not correctness — every PNG decoder reads a stored
/// block.
pub fn encode_png(image: &CursorImage) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&image.width.to_be_bytes());
    ihdr.extend_from_slice(&image.height.to_be_bytes());
    // 8 bits per sample, colour type 6 (truecolour + alpha), deflate, adaptive
    // filtering, no interlace.
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    png_chunk(&mut out, b"IHDR", &ihdr);

    let mut raw = Vec::with_capacity(image.rgba.len() + image.height as usize);
    for row in image.rgba.chunks((image.width * 4) as usize) {
        raw.push(0); // filter type 0: none
        raw.extend_from_slice(row);
    }
    png_chunk(&mut out, b"IDAT", &zlib_stored(&raw));
    png_chunk(&mut out, b"IEND", &[]);
    out
}

fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc = crc32(0xffff_ffff, kind);
    crc = crc32(crc, data);
    out.extend_from_slice(&(crc ^ 0xffff_ffff).to_be_bytes());
}

fn zlib_stored(raw: &[u8]) -> Vec<u8> {
    // 0x78 0x01: deflate, 32 KiB window, no preset dictionary, and
    // 0x7801 % 31 == 0 as the header check requires.
    let mut out = vec![0x78, 0x01];
    let mut offset = 0usize;
    loop {
        let end = (offset + 0xffff).min(raw.len());
        let block = &raw[offset..end];
        let last = end == raw.len();
        out.push(u8::from(last));
        let len = block.len() as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(block);
        offset = end;
        if last {
            break;
        }
    }
    out.extend_from_slice(&adler32(raw).to_be_bytes());
    out
}

fn crc32(seed: u32, data: &[u8]) -> u32 {
    let mut crc = seed;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    crc
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for byte in data {
        a = (a + u32::from(*byte)) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

// ----------------------------------------------------------------- win32

#[cfg(windows)]
mod win32 {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Dxgi::{
        IDXGIOutputDuplication, DXGI_OUTDUPL_FRAME_INFO, DXGI_OUTDUPL_POINTER_SHAPE_INFO,
    };
    use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

    use super::{
        OutputGeometry, PointerPosition, Rect, ShapeInfo, ShapeKind, DEFAULT_DPI,
    };
    use crate::capture::OutputInfo;

    /// The pointer position a frame carries, or `None` when it carries none.
    ///
    /// `LastMouseUpdateTime == 0` was 20.4% of frames in spike 0.8 and the
    /// `PointerPosition` on those frames is the previous one, not a fresh
    /// reading — treating it as fresh is how a hidden cursor "reappears" or
    /// jumps to the corner.
    pub fn pointer_position(info: &DXGI_OUTDUPL_FRAME_INFO) -> Option<PointerPosition> {
        if info.LastMouseUpdateTime == 0 {
            return None;
        }
        Some(PointerPosition {
            x: info.PointerPosition.Position.x,
            y: info.PointerPosition.Position.y,
            visible: info.PointerPosition.Visible.as_bool(),
        })
    }

    /// Effective dpi of the monitor a desktop rect sits on. 96 when it cannot
    /// be read, which is 100% and the right guess to be wrong with.
    pub fn dpi_for_rect(rect: &Rect) -> u32 {
        let centre = POINT {
            x: rect.left + rect.width() / 2,
            y: rect.top + rect.height() / 2,
        };
        let monitor = unsafe { MonitorFromPoint(centre, MONITOR_DEFAULTTONEAREST) };
        let (mut x, mut y) = (0u32, 0u32);
        match unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut x, &mut y) } {
            Ok(()) if x > 0 => x,
            _ => DEFAULT_DPI,
        }
    }

    impl OutputGeometry {
        /// `texture` is the acquired texture's size, which on a rotated output
        /// is not the mode's — see [`crate::capture::Rotation::swap_axes`].
        pub fn for_output(output: &OutputInfo, texture: (u32, u32)) -> Self {
            Self {
                desktop_rect: output.desktop_rect,
                rotation: output.rotation,
                texture,
                dpi: dpi_for_rect(&output.desktop_rect),
            }
        }
    }

    /// Reads pointer shapes off a duplication, reusing one buffer.
    ///
    /// The duplication is passed in rather than held: there is one per output
    /// and it belongs to [`crate::capture::Duplication`], which acquires the
    /// frame this shape came with.
    #[derive(Debug, Default)]
    pub struct PointerReader {
        buffer: Vec<u8>,
    }

    impl PointerReader {
        pub fn new() -> Self {
            Self::default()
        }

        /// The new shape a frame carries, or `None` when the shape has not
        /// changed. `PointerShapeBufferSize` is zero on every frame that
        /// carries only a move.
        pub fn shape(
            &mut self,
            dup: &IDXGIOutputDuplication,
            info: &DXGI_OUTDUPL_FRAME_INFO,
        ) -> anyhow::Result<Option<(ShapeInfo, &[u8])>> {
            let needed = info.PointerShapeBufferSize as usize;
            if needed == 0 {
                return Ok(None);
            }
            if self.buffer.len() < needed {
                self.buffer.resize(needed, 0);
            }
            let mut required = 0u32;
            let mut raw = DXGI_OUTDUPL_POINTER_SHAPE_INFO::default();
            unsafe {
                dup.GetFramePointerShape(
                    needed as u32,
                    self.buffer.as_mut_ptr().cast(),
                    &mut required,
                    &mut raw,
                )
            }?;
            let info = ShapeInfo {
                kind: ShapeKind::from_dxgi(raw.Type)?,
                width: raw.Width,
                height: raw.Height,
                pitch: raw.Pitch,
                hot_x: raw.HotSpot.x.max(0) as u32,
                hot_y: raw.HotSpot.y.max(0) as u32,
            };
            // The frame's own size, not `required`: the decoder validates the
            // slice against pitch and height anyway, and a driver that reports
            // less than it wrote would truncate a valid shape.
            Ok(Some((info, &self.buffer[..needed])))
        }
    }
}

#[cfg(windows)]
pub use win32::{dpi_for_rect, pointer_position, PointerReader};

#[cfg(test)]
mod tests {
    use super::*;

    /// Expand a picture written as characters into the RGBA the decoders should
    /// produce: `k` black, `w` white, `.` transparent, `r` red, `b` blue.
    fn expect(rows: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for row in rows {
            for c in row.chars() {
                out.extend_from_slice(&match c {
                    'k' => [0, 0, 0, 255],
                    'w' => [255, 255, 255, 255],
                    '.' => [0, 0, 0, 0],
                    'r' => [255, 0, 0, 255],
                    'b' => [0, 0, 255, 255],
                    other => panic!("no such pixel {other}"),
                });
            }
        }
        out
    }

    #[test]
    fn a_monochrome_shape_is_two_stacked_planes_not_one_tall_image() {
        // 8x2 picture in a buffer that reports four rows: the AND mask on top
        // of the XOR mask. This is the 32x32/Height=64/Pitch=4 case from spike
        // 0.8, shrunk.
        let info = ShapeInfo {
            kind: ShapeKind::Monochrome,
            width: 8,
            height: 4,
            pitch: 1,
            hot_x: 3,
            hot_y: 1,
        };
        assert_eq!(info.image_height(), Ok(2));

        // and: 1111_0000 / 0000_0000   xor: 1100_1100 / 1010_0000
        let buf = [0xf0u8, 0x00, 0xcc, 0xa0];
        let image = decode(&info, &buf).expect("decode");

        assert_eq!((image.width, image.height), (8, 2));
        assert_eq!(
            image.rgba,
            expect(&[
                // and=1,xor=1 invert -> black; and=1,xor=0 -> transparent;
                // and=0,xor=1 -> white; and=0,xor=0 -> black.
                "kk..wwkk", "wkwkkkkk",
            ])
        );
        assert_eq!((image.hot_x, image.hot_y), (3, 1));
    }

    #[test]
    fn a_monochrome_height_that_is_not_two_planes_is_refused() {
        let info = ShapeInfo {
            kind: ShapeKind::Monochrome,
            width: 8,
            height: 3,
            pitch: 1,
            hot_x: 0,
            hot_y: 0,
        };
        assert_eq!(info.image_height(), Err(CursorError::OddMonochromeHeight(3)));
        assert!(decode(&info, &[0; 8]).is_err());
    }

    #[test]
    fn a_colour_shape_is_bgra_with_padding_between_rows() {
        // Pitch deliberately wider than the row: a decoder that walks the
        // buffer linearly reads the padding as pixels.
        let info = ShapeInfo {
            kind: ShapeKind::Color,
            width: 2,
            height: 2,
            pitch: 12,
            hot_x: 1,
            hot_y: 1,
        };
        let mut buf = vec![0u8; 24];
        // row 0: red, transparent black
        buf[0..4].copy_from_slice(&[0, 0, 255, 255]);
        buf[4..8].copy_from_slice(&[0, 0, 0, 0]);
        buf[8..12].copy_from_slice(&[0xde, 0xad, 0xbe, 0xef]); // padding
        // row 1: blue, white
        buf[12..16].copy_from_slice(&[255, 0, 0, 255]);
        buf[16..20].copy_from_slice(&[255, 255, 255, 255]);

        let image = decode(&info, &buf).expect("decode");
        assert_eq!(image.rgba, expect(&["r.", "bw"]));
    }

    #[test]
    fn a_masked_colour_shape_reads_alpha_as_a_mask_not_as_coverage() {
        let info = ShapeInfo {
            kind: ShapeKind::MaskedColor,
            width: 2,
            height: 2,
            pitch: 8,
            hot_x: 0,
            hot_y: 0,
        };
        let buf = [
            // mask 0 -> the colour replaces the screen pixel, opaque.
            0, 0, 255, 0, // red
            255, 255, 255, 0, // white
            // mask 0xff -> xor with the screen. Black xors to nothing, so it is
            // the transparent case; anything else is drawn.
            0, 0, 0, 0xff, //
            255, 0, 0, 0xff, // blue
        ];
        let image = decode(&info, &buf).expect("decode");
        assert_eq!(image.rgba, expect(&["rw", ".b"]));
    }

    #[test]
    fn a_short_buffer_is_refused_rather_than_read_past() {
        let info = ShapeInfo {
            kind: ShapeKind::Color,
            width: 32,
            height: 32,
            pitch: 128,
            hot_x: 0,
            hot_y: 0,
        };
        assert_eq!(
            decode(&info, &[0; 100]),
            Err(CursorError::ShortBuffer {
                needed: 4096,
                got: 100
            })
        );
    }

    fn solid(width: u32, height: u32, hot: (u32, u32)) -> CursorImage {
        CursorImage {
            width,
            height,
            hot_x: hot.0,
            hot_y: hot.1,
            rgba: vec![255; (width * height * 4) as usize],
        }
    }

    /// The 0.8 box's layout, with the 4K panel's dpi raised to 200% so the two
    /// outputs disagree: origin negative in both axes, mixed scaling.
    fn mixed_dpi_layout() -> (OutputGeometry, OutputGeometry) {
        let hidpi = OutputGeometry {
            // Desktop coordinates are physical pixels whatever the scaling, so
            // a 200% 4K panel is 3840x2160 of desktop rect, not 1920x1080.
            desktop_rect: Rect {
                left: -3840,
                top: -1138,
                right: 0,
                bottom: 1022,
            },
            rotation: Rotation::Identity,
            texture: (3840, 2160),
            dpi: 192,
        };
        let standard = OutputGeometry {
            desktop_rect: Rect {
                left: 0,
                top: 0,
                right: 1920,
                bottom: 1080,
            },
            rotation: Rotation::Identity,
            texture: (1920, 1080),
            dpi: 96,
        };
        (hidpi, standard)
    }

    #[test]
    fn the_hotspot_follows_the_bitmap_through_the_per_monitor_dpi_fit() {
        let (hidpi, standard) = mixed_dpi_layout();
        assert_eq!(hidpi.scale(), 2.0);
        assert_eq!(standard.scale(), 1.0);

        // The same pointer: 64x64 of bitmap either way, but 32 css px on the
        // 200% output and 64 on the 100% one.
        let fitted = fit_for_css(solid(64, 64, (32, 32)), hidpi.dpi);
        assert_eq!((fitted.width, fitted.height), (64, 64));
        assert_eq!(
            (fitted.hot_x, fitted.hot_y),
            (32, 32),
            "32 css px already fits, so nothing moves"
        );

        let fitted = fit_for_css(solid(64, 64, (32, 32)), standard.dpi);
        assert_eq!((fitted.width, fitted.height), (32, 32));
        assert_eq!(
            (fitted.hot_x, fitted.hot_y),
            (16, 16),
            "halving the bitmap without halving the hotspot is the i-beam bug"
        );
    }

    /// A pointer position all the way through: texture pixels to a normalised
    /// `cpos` and back out to the virtual desktop through the transform
    /// injection runs.
    fn round_trip(geometry: &OutputGeometry, at: (i32, i32)) -> (i32, i32) {
        let (x, y) = geometry.normalise(at);
        geometry.pointer_space().to_desktop(x as f32, y as f32)
    }

    #[test]
    fn a_position_on_the_negative_origin_output_maps_to_the_desktop_and_to_0_1() {
        let (hidpi, standard) = mixed_dpi_layout();

        assert_eq!(hidpi.normalise((0, 0)), (0.0, 0.0));
        assert_eq!(hidpi.normalise((3839, 2159)), (1.0, 1.0));
        // Off the edge of the texture clamps: a viewer never gets a position
        // outside the picture it is looking at.
        assert_eq!(hidpi.normalise((-10, 99_999)), (0.0, 1.0));

        // Both origins are negative, and the round trip is exact at the corners
        // because both halves divide by size - 1.
        assert_eq!(round_trip(&hidpi, (0, 0)), (-3840, -1138));
        assert_eq!(round_trip(&hidpi, (3839, 2159)), (-1, 1021));
        assert_eq!(round_trip(&standard, (10, 20)), (10, 20));
        assert_eq!(round_trip(&standard, (1919, 1079)), (1919, 1079));
    }

    #[test]
    fn a_rotated_output_normalises_in_texture_space_and_lands_rotated() {
        // The 0.8 box's rotate270 4K panel: a 3840x2160 texture behind a
        // 2160x3840 desktop rect, whose top-left texel is displayed at the
        // bottom-left of the desktop.
        let geometry = OutputGeometry {
            desktop_rect: Rect {
                left: -2160,
                top: -1138,
                right: 0,
                bottom: 2702,
            },
            rotation: Rotation::Rotate270,
            texture: (3840, 2160),
            dpi: 96,
        };
        assert_eq!(round_trip(&geometry, (0, 0)), (-2160, 2701));
        assert_eq!(round_trip(&geometry, (3839, 0)), (-2160, -1138));
        assert_eq!(round_trip(&geometry, (0, 2159)), (-1, 2701));
    }

    #[test]
    fn a_shape_larger_than_the_message_cap_is_downscaled_and_averaged() {
        let mut image = solid(128, 128, (64, 64));
        // A transparent left half: premultiplied averaging must not smear its
        // colour into the opaque side.
        for y in 0..128usize {
            for x in 0..64usize {
                let i = (y * 128 + x) * 4;
                image.rgba[i] = 0;
                image.rgba[i + 1] = 0;
                image.rgba[i + 2] = 0;
                image.rgba[i + 3] = 0;
            }
        }
        let fitted = fit_for_css(image, 384);
        assert_eq!(
            (fitted.width, fitted.height),
            (64, 64),
            "128 px is 32 css px at 400%, so only the image cap applies"
        );
        assert_eq!((fitted.hot_x, fitted.hot_y), (32, 32));
        // The first column is fully transparent, the last fully white.
        assert_eq!(&fitted.rgba[0..4], &[0, 0, 0, 0]);
        let last = ((63 * 64 + 63) * 4) as usize;
        assert_eq!(&fitted.rgba[last..last + 4], &[255, 255, 255, 255]);
    }

    fn mono(bits: [u8; 4]) -> (ShapeInfo, [u8; 4]) {
        (
            ShapeInfo {
                kind: ShapeKind::Monochrome,
                width: 8,
                height: 4,
                pitch: 1,
                hot_x: 0,
                hot_y: 0,
            },
            bits,
        )
    }

    #[test]
    fn an_unchanged_shape_produces_no_message_and_a_return_to_a_cached_one_is_an_id() {
        let mut tracker = CursorTracker::new();
        let (arrow, arrow_bits) = mono([0xf0, 0x00, 0xcc, 0xa0]);
        let (beam, beam_bits) = mono([0x00, 0xff, 0x18, 0x18]);

        let first = tracker.on_shape(&arrow, &arrow_bits, 96).expect("decode");
        let Some(Cursor::Cshape { id, png, w, h, .. }) = first else {
            panic!("the first shape must carry its bitmap");
        };
        assert_eq!(id, 1);
        assert_eq!((w, h), (Some(8), Some(2)));
        assert!(png.is_some_and(|p| !p.is_empty()));

        // 141 of spike 0.8's 142 shape updates were this case.
        assert_eq!(tracker.on_shape(&arrow, &arrow_bits, 96), Ok(None));
        assert_eq!(tracker.on_shape(&arrow, &arrow_bits, 96), Ok(None));

        let second = tracker.on_shape(&beam, &beam_bits, 96).expect("decode");
        assert!(matches!(
            second,
            Some(Cursor::Cshape { id: 2, png: Some(_), .. })
        ));
        assert_eq!(tracker.on_shape(&beam, &beam_bits, 96), Ok(None));

        // Back to the arrow: cached, so an id and nothing else.
        assert_eq!(
            tracker.on_shape(&arrow, &arrow_bits, 96),
            Ok(Some(Cursor::Cshape {
                id: 1,
                hot_x: None,
                hot_y: None,
                w: None,
                h: None,
                png: None,
            }))
        );
        assert_eq!(tracker.cached_shapes(), 2);

        // A viewer that joins now has an empty cache and needs the bitmap.
        let Some(Cursor::Cshape { id, png, .. }) = tracker.current_shape() else {
            panic!("a tracked shape must be resendable in full");
        };
        assert_eq!(id, 1);
        assert!(png.is_some());
    }

    #[test]
    fn a_repeated_position_is_not_resent_and_a_hidden_pointer_still_is() {
        let (_, geometry) = mixed_dpi_layout();
        let mut tracker = CursorTracker::new();
        let at = |x, y, visible| PointerPosition { x, y, visible };

        let (x, y) = geometry.normalise((960, 540));
        assert_eq!(
            tracker.on_position(at(960, 540, true), &geometry, 5_000_200),
            Some(Cursor::Cpos {
                x,
                y,
                visible: true,
                ts_us: 5_000_200
            })
        );
        assert_eq!(
            tracker.on_position(at(960, 540, true), &geometry, 5_016_800),
            None
        );
        // 73 of 398 updates in spike 0.8 were a hide, at an unchanged position.
        assert!(tracker
            .on_position(at(960, 540, false), &geometry, 5_033_400)
            .is_some());
    }

    /// Stored deflate blocks are the one thing here a PNG decoder would catch
    /// and no test otherwise reads back, so unwrap the container by hand.
    fn inflate_stored(zlib: &[u8]) -> Vec<u8> {
        assert_eq!(&zlib[..2], &[0x78, 0x01], "zlib header");
        let mut out = Vec::new();
        let mut i = 2usize;
        loop {
            let last = zlib[i] & 1 == 1;
            assert_eq!(zlib[i] >> 1, 0, "stored block");
            let len = u16::from_le_bytes([zlib[i + 1], zlib[i + 2]]) as usize;
            let nlen = u16::from_le_bytes([zlib[i + 3], zlib[i + 4]]);
            assert_eq!(nlen, !(len as u16), "len complement");
            out.extend_from_slice(&zlib[i + 5..i + 5 + len]);
            i += 5 + len;
            if last {
                break;
            }
        }
        assert_eq!(i + 4, zlib.len(), "adler32 then nothing");
        out
    }

    #[test]
    fn the_png_is_a_real_png_whose_idat_holds_the_filtered_scanlines() {
        let image = CursorImage {
            width: 2,
            height: 2,
            hot_x: 0,
            hot_y: 0,
            rgba: expect(&["rw", ".b"]),
        };
        let png = encode_png(&image);

        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(&png[16..24], &[0, 0, 0, 2, 0, 0, 0, 2], "2x2");
        assert_eq!(&png[24..29], &[8, 6, 0, 0, 0], "8-bit rgba, no interlace");
        assert_eq!(&png[png.len() - 8..png.len() - 4], b"IEND");

        // IHDR is 13 bytes of payload: 8 signature + 12 framing + 13.
        let idat_len = u32::from_be_bytes(png[33..37].try_into().unwrap()) as usize;
        assert_eq!(&png[37..41], b"IDAT");
        let raw = inflate_stored(&png[41..41 + idat_len]);
        let mut expected = vec![0u8];
        expected.extend_from_slice(&image.rgba[..8]);
        expected.push(0);
        expected.extend_from_slice(&image.rgba[8..]);
        assert_eq!(raw, expected, "one filter-type byte per scanline");
    }

    #[test]
    fn crc32_and_adler32_match_their_published_check_values() {
        assert_eq!(crc32(0xffff_ffff, b"123456789") ^ 0xffff_ffff, 0xcbf4_3926);
        assert_eq!(adler32(b"Wikipedia"), 0x11e6_0398);
    }

    /// Live capture. With the working directory `agent/swoop`:
    ///
    /// ```text
    /// cargo test -- --ignored --nocapture cursor::tests::live
    /// ```
    ///
    /// Move the mouse and hover a text field while it runs, so the pointer
    /// changes shape at least once.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs a real desktop with a mouse on it"]
    fn live_pointer_updates_decode_and_cache() {
        use crate::capture::{Duplication, RebuildSignal, Source, ACQUIRE_TIMEOUT_MS};

        // Through the capture module's own duplication, never a second one:
        // DXGI refuses two duplications of one output in a process, so a test
        // that opened its own could not share a `cargo test -- --ignored` run
        // with the capture tests, and which of the two failed would come down
        // to ordering.
        let outputs = crate::capture::enumerate_outputs().expect("enumerate outputs");
        let output = outputs.first().expect("an attached output");
        let mut source = Duplication::open(output, RebuildSignal::new()).expect("duplicate output");

        let mut reader = PointerReader::new();
        let mut tracker = CursorTracker::new();
        let (mut acquired, mut no_update, mut positions) = (0u32, 0u32, 0u32);
        let (mut shape_updates, mut shape_messages) = (0u32, 0u32);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            // Recomputed each turn: the texture size is only known once a frame
            // has been emitted, and the pointer arrives before that.
            let geometry = OutputGeometry::for_output(source.output(), source.size());
            source
                .next_frame_with(ACQUIRE_TIMEOUT_MS, &mut |dup, info| {
                    acquired += 1;
                    match pointer_position(info) {
                        None => no_update += 1,
                        Some(at) => {
                            if tracker.on_position(at, &geometry, 0).is_some() {
                                positions += 1;
                            }
                        }
                    }
                    if let Some((shape, bytes)) = reader.shape(dup, info).expect("read shape") {
                        shape_updates += 1;
                        if tracker
                            .on_shape(&shape, bytes, geometry.dpi)
                            .expect("decode shape")
                            .is_some()
                        {
                            shape_messages += 1;
                        }
                    }
                })
                .expect("acquire");
        }

        let geometry = OutputGeometry::for_output(source.output(), source.size());
        println!(
            "{} texture={:?} dpi={} rect={:?}",
            source.output().device_name,
            source.size(),
            geometry.dpi,
            geometry.desktop_rect
        );
        println!(
            "acquired={acquired} no_pointer_update={no_update} cpos={positions} \
             shape_updates={shape_updates} cshape={shape_messages} distinct={}",
            tracker.cached_shapes()
        );

        assert!(acquired > 0, "no frames acquired");
        assert!(
            no_update < acquired,
            "every frame claimed to carry no pointer news"
        );
        assert!(positions > 0, "no pointer position seen - move the mouse");
        assert!(shape_updates > 0, "no pointer shape seen - move the mouse");
        assert!(
            shape_messages <= shape_updates,
            "the cache must never emit more than it is given"
        );
    }
}
