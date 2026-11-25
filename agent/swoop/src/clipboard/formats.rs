//! What the clipboard carries, what it refuses, and the conversions between
//! the windows clipboard's formats and §5's two.
//!
//! Portable on purpose: bytes in, bytes out. The caps, the refusals, the
//! chunking and the DIB layout are unit-tested on any host, and every win32
//! call lives in [`super::listener`] and `super::wic`.

use base64::prelude::{Engine as _, BASE64_STANDARD};
use sha2::{Digest, Sha256};

use crate::cursor::{encode_png, CursorImage};
use crate::ipc::Desktop;
use crate::signal::messages::channel::{
    ClipFormat, CLIPBOARD_CHUNK_MAX_BYTES, CLIPBOARD_IMAGE_MAX_BYTES, CLIPBOARD_TEXT_MAX_BYTES,
};

/// Standard clipboard format ids, spelled here rather than imported so the
/// refusal table below is testable on a host with no win32 at all.
pub const CF_DIB: u32 = 8;
pub const CF_UNICODETEXT: u32 = 13;
pub const CF_HDROP: u32 = 15;
pub const CF_DIBV5: u32 = 17;

/// §5: transfers above this are reported to the audit trail. The content never
/// is — the row says a transfer happened and how big it was, nothing more.
pub const CLIPBOARD_AUDIT_BYTES: u64 = 64 * 1024;

/// §5: file lists are never carried and there is no file transfer in this
/// protocol. A clipboard holding one is left alone **entirely** rather than
/// synced as the text of the paths — a directory listing is exactly the thing
/// a file-list refusal is for.
pub fn is_refused(format: u32) -> bool {
    format == CF_HDROP
}

/// Whether the clipboard may be synced at all with this desktop in front.
///
/// `Winlogon` is the ruling: the credential desktop's clipboard is not the
/// user's and a viewer has no business reading or writing it. The other two
/// refusals are the same caution — the screensaver desktop is not where anyone
/// is working, and `Unknown` is a desktop this process could not name, which is
/// no basis for moving data either way. The cost of being wrong here is a
/// paste that does not happen.
pub fn sync_allowed(desktop: Desktop) -> bool {
    matches!(desktop, Desktop::Default)
}

/// The desktop a `UOI_NAME` string names. Win32 compares these case-insensitively
/// and so does this.
pub fn desktop_from_name(name: &str) -> Desktop {
    match name.to_ascii_lowercase().as_str() {
        "default" => Desktop::Default,
        "winlogon" => Desktop::Winlogon,
        "screen-saver" => Desktop::Screensaver,
        _ => Desktop::Unknown,
    }
}

/// One clipboard payload in §5's terms: the format on the wire and the raw
/// bytes behind it — utf-8 for text, a PNG file for an image.
#[derive(Clone, PartialEq, Eq)]
pub struct Payload {
    pub fmt: ClipFormat,
    pub bytes: Vec<u8>,
}

/// Hand-written so a payload can be logged at all: the derived one would print
/// the clipboard's contents, which nothing in this crate may ever do.
impl std::fmt::Debug for Payload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Payload({:?}, {} bytes)", self.fmt, self.bytes.len())
    }
}

impl Payload {
    pub fn text(text: &str) -> Self {
        Self {
            fmt: ClipFormat::Text,
            bytes: text.as_bytes().to_vec(),
        }
    }

    pub fn png(bytes: Vec<u8>) -> Self {
        Self {
            fmt: ClipFormat::Png,
            bytes,
        }
    }

    /// Content hash, and half of the echo guard: a clipboard update whose
    /// content is what we ourselves last wrote is our own write coming back.
    pub fn digest(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update([u8::from(self.fmt == ClipFormat::Png)]);
        hasher.update(&self.bytes);
        hasher.finalize().into()
    }

    /// §5's cap for this format.
    pub fn cap(&self) -> u64 {
        cap_for(self.fmt)
    }

    pub fn within_cap(&self) -> bool {
        self.bytes.len() as u64 <= self.cap()
    }

    /// How many §5 chunks this payload takes. Never zero: `admit` refuses a
    /// transfer declaring none, and an empty payload is still one chunk.
    pub fn chunks(&self) -> u32 {
        let chunk = CLIPBOARD_CHUNK_MAX_BYTES as usize;
        self.bytes.len().div_ceil(chunk).max(1) as u32
    }

    /// One chunk's `data` field, base64 as §5 spells it.
    pub fn chunk(&self, index: u32) -> String {
        let chunk = CLIPBOARD_CHUNK_MAX_BYTES as usize;
        let start = (index as usize) * chunk;
        let end = (start + chunk).min(self.bytes.len());
        if start >= end {
            return String::new();
        }
        BASE64_STANDARD.encode(&self.bytes[start..end])
    }
}

pub fn cap_for(fmt: ClipFormat) -> u64 {
    match fmt {
        ClipFormat::Text => CLIPBOARD_TEXT_MAX_BYTES,
        ClipFormat::Png => CLIPBOARD_IMAGE_MAX_BYTES,
    }
}

/// Decode one chunk's `data`. `None` is a malformed transfer, which is dropped
/// whole — a half-decoded paste is worse than none.
pub fn decode_chunk(data: &str) -> Option<Vec<u8>> {
    let bytes = BASE64_STANDARD.decode(data).ok()?;
    (bytes.len() as u64 <= CLIPBOARD_CHUNK_MAX_BYTES).then_some(bytes)
}

// ------------------------------------------------------------------- text

/// A `CF_UNICODETEXT` buffer as a string. The win32 buffer is NUL-terminated
/// and `GlobalSize` rounds up, so everything from the first NUL is padding.
pub fn text_from_utf16(units: &[u16]) -> String {
    let end = units.iter().position(|u| *u == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

/// The buffer `SetClipboardData(CF_UNICODETEXT, …)` wants, NUL included.
pub fn text_to_utf16(text: &str) -> Vec<u16> {
    let mut units: Vec<u16> = text.encode_utf16().collect();
    units.push(0);
    units
}

// -------------------------------------------------------------------- dib

const BI_RGB: u32 = 0;
const BI_BITFIELDS: u32 = 3;
const HEADER_V1_BYTES: usize = 40;

/// A `BITMAPV5HEADER`, the header [`finish_dibv5`] writes.
pub const HEADER_V5_BYTES: usize = 124;
/// `LCS_sRGB` and `LCS_GM_IMAGES`: a png's pixels are sRGB.
const LCS_SRGB: u32 = 0x7352_4742;
const LCS_GM_IMAGES: u32 = 4;

/// The most pixels a bitmap may have, in either direction: 8192 × 8192, a
/// 256 MiB buffer at 32 bits. A 4K screenshot is an eighth of it and a
/// three-monitor one well inside it; past it is a clipboard built to make this
/// process allocate, and it is refused from the header, before a byte behind
/// the header is copied or a pixel decoded.
pub const DIB_MAX_PIXELS: u64 = 8192 * 8192;

/// What a DIB's header says about the bytes behind it.
struct Layout {
    width: u32,
    height: u32,
    bytes_per_pixel: usize,
    top_down: bool,
    stride: usize,
    /// Where the pixels start.
    offset: usize,
    /// The whole DIB, header to last row.
    len: usize,
}

impl Layout {
    /// From the header alone: `None` for a shape this module does not carry
    /// (palettised, compressed, or a header that does not describe a bitmap)
    /// and for one over [`DIB_MAX_PIXELS`].
    fn read(dib: &[u8]) -> Option<Self> {
        if dib.len() < HEADER_V1_BYTES {
            return None;
        }
        let word = |offset: usize| -> [u8; 4] {
            dib[offset..offset + 4]
                .try_into()
                .expect("four bytes inside a buffer already long enough")
        };

        let header_bytes = u32::from_le_bytes(word(0)) as usize;
        if header_bytes < HEADER_V1_BYTES || header_bytes > dib.len() {
            return None;
        }
        let width = i32::from_le_bytes(word(4));
        let height_signed = i32::from_le_bytes(word(8));
        let bit_count = u16::from_le_bytes([dib[14], dib[15]]);
        let compression = u32::from_le_bytes(word(16));
        if width <= 0 || height_signed == 0 || !matches!(bit_count, 24 | 32) {
            return None;
        }
        if compression != BI_RGB && compression != BI_BITFIELDS {
            return None;
        }
        let width = width.unsigned_abs();
        let height = height_signed.unsigned_abs();
        if u64::from(width) * u64::from(height) > DIB_MAX_PIXELS {
            return None;
        }
        // The pixels start after the header and, for BI_BITFIELDS on a v1
        // header, after the three channel masks that follow it. A v4/v5 header
        // carries its masks inside itself, so nothing extra follows those.
        let mut offset = header_bytes;
        if compression == BI_BITFIELDS && header_bytes == HEADER_V1_BYTES {
            offset += 12;
        }
        // Rows are padded out to a 4-byte boundary, always.
        let stride = (width as usize * usize::from(bit_count)).div_ceil(32) * 4;
        Some(Self {
            width,
            height,
            bytes_per_pixel: usize::from(bit_count / 8),
            // A negative height is a top-down DIB: the first row in the buffer
            // is the top row. The usual bottom-up case is the other way round.
            top_down: height_signed < 0,
            stride,
            offset,
            len: offset + stride * height as usize,
        })
    }
}

/// How many bytes the DIB at the front of `buffer` occupies, read from its
/// header, when `buffer` holds that many. It is what a clipboard handle is
/// copied out as: one over [`DIB_MAX_PIXELS`] is refused without a byte of it
/// being copied, and the slack `GlobalSize` rounds up to is never copied along.
pub fn dib_len(buffer: &[u8]) -> Option<usize> {
    Layout::read(buffer)
        .map(|layout| layout.len)
        .filter(|len| *len <= buffer.len())
}

/// A `CF_DIB`/`CF_DIBV5` this module carries, read in place: 24 or 32 bits a
/// pixel, uncompressed, within [`DIB_MAX_PIXELS`] and with every row present.
/// That is what every screenshot and every image editor puts on the clipboard.
pub struct Dib<'a> {
    pub width: u32,
    pub height: u32,
    /// 3 or 4: each row is BGR or BGRA, in that byte order.
    pub bytes_per_pixel: usize,
    /// Whether the fourth byte is alpha. A 32-bit BI_RGB DIB's fourth byte is
    /// reserved, not alpha, and most producers leave it zero — honouring it
    /// would turn every such image invisible — so it counts as alpha only when
    /// some pixel actually sets it.
    pub alpha: bool,
    top_down: bool,
    stride: usize,
    pixels: &'a [u8],
}

impl<'a> Dib<'a> {
    pub fn parse(dib: &'a [u8]) -> Option<Self> {
        let layout = Layout::read(dib)?;
        let pixels = dib.get(layout.offset..layout.len)?;
        let alpha =
            layout.bytes_per_pixel == 4 && pixels.as_chunks::<4>().0.iter().any(|px| px[3] != 0);
        Some(Self {
            width: layout.width,
            height: layout.height,
            bytes_per_pixel: layout.bytes_per_pixel,
            alpha,
            top_down: layout.top_down,
            stride: layout.stride,
            pixels,
        })
    }

    /// Row `y`, counted from the top, without its padding.
    pub fn row(&self, y: u32) -> &'a [u8] {
        let source = if self.top_down {
            y
        } else {
            self.height - 1 - y
        };
        let start = source as usize * self.stride;
        &self.pixels[start..start + self.width as usize * self.bytes_per_pixel]
    }
}

/// A `CF_DIB`/`CF_DIBV5` buffer as a PNG: compressed by `compress` — WIC, on
/// Windows — or, when that fails, written by the crate's own stored encoder,
/// so a clip is never lost to the compressor alone. `None` for a DIB this
/// module does not carry, or one the stored encoder cannot fit under §5's
/// image cap either.
///
/// The registered `"PNG"` format is preferred over this path whenever it is
/// offered, so the DIB is for the applications that offer nothing else.
pub fn dib_to_png(dib: &[u8], compress: impl FnOnce(&Dib) -> Option<Vec<u8>>) -> Option<Vec<u8>> {
    let dib = Dib::parse(dib)?;
    compress(&dib).or_else(|| stored_png(&dib))
}

/// The crate's other png encoder, which lives with the cursor because that is
/// what first needed one. It writes stored deflate blocks, so the png is the
/// bitmap at its raw size and only a small one fits the cap — which is known
/// from the size alone, so one that cannot fit is never built.
fn stored_png(dib: &Dib) -> Option<Vec<u8>> {
    let raw = u64::from(dib.height) * (1 + u64::from(dib.width) * 4);
    if raw > CLIPBOARD_IMAGE_MAX_BYTES {
        return None;
    }
    let mut rgba = Vec::with_capacity(dib.width as usize * dib.height as usize * 4);
    for y in 0..dib.height {
        for px in dib.row(y).chunks_exact(dib.bytes_per_pixel) {
            // BGR(A) on the wire, RGBA in the png.
            rgba.extend_from_slice(&[px[2], px[1], px[0], if dib.alpha { px[3] } else { 0xff }]);
        }
    }
    Some(encode_png(&CursorImage {
        width: dib.width,
        height: dib.height,
        hot_x: 0,
        hot_y: 0,
        scale: 1,
        rgba,
    }))
}

/// Make `buffer` a `CF_DIBV5`. It arrives as [`HEADER_V5_BYTES`] of room and
/// then `width × height` top-down rows of 32-bit BGRA, which is how WIC hands a
/// bitmap over, and leaves with the header written and the rows flipped in
/// place: bottom-up is the order every reader of the clipboard takes.
pub fn finish_dibv5(buffer: &mut [u8], width: u32, height: u32) {
    let stride = width as usize * 4;
    let rows = height as usize;
    let (header, pixels) = buffer.split_at_mut(HEADER_V5_BYTES);
    for top in 0..rows / 2 {
        let bottom = rows - 1 - top;
        let (upper, lower) = pixels.split_at_mut(bottom * stride);
        upper[top * stride..(top + 1) * stride].swap_with_slice(&mut lower[..stride]);
    }
    header.fill(0);
    let mut put = |offset: usize, value: u32| {
        header[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    };
    put(0, HEADER_V5_BYTES as u32);
    put(4, width);
    // positive: bottom-up.
    put(8, height);
    // one plane and 32 bits a pixel, the two u16s at 12 and 14.
    put(12, 1 | (32 << 16));
    put(16, BI_BITFIELDS);
    put(20, (stride * rows) as u32);
    // the red, green, blue and alpha masks of bgra in memory.
    put(40, 0x00ff_0000);
    put(44, 0x0000_ff00);
    put(48, 0x0000_00ff);
    put(52, 0xff00_0000);
    put(56, LCS_SRGB);
    put(108, LCS_GM_IMAGES);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_list_is_the_one_format_refused_outright() {
        assert!(is_refused(CF_HDROP));
        for carried in [CF_UNICODETEXT, CF_DIB, CF_DIBV5] {
            assert!(!is_refused(carried));
        }
    }

    #[test]
    fn the_clipboard_is_synced_on_the_default_desktop_and_nowhere_else() {
        assert!(sync_allowed(Desktop::Default));
        assert!(!sync_allowed(Desktop::Winlogon));
        assert!(!sync_allowed(Desktop::Screensaver));
        assert!(!sync_allowed(Desktop::Unknown));
    }

    #[test]
    fn the_desktop_name_is_matched_the_way_win32_matches_it() {
        assert_eq!(desktop_from_name("Default"), Desktop::Default);
        assert_eq!(desktop_from_name("default"), Desktop::Default);
        assert_eq!(desktop_from_name("Winlogon"), Desktop::Winlogon);
        assert_eq!(desktop_from_name("WINLOGON"), Desktop::Winlogon);
        assert_eq!(desktop_from_name("Screen-saver"), Desktop::Screensaver);
        assert_eq!(desktop_from_name(""), Desktop::Unknown);
    }

    #[test]
    fn a_payload_never_prints_its_contents() {
        let shown = format!("{:?}", Payload::text("the secret"));
        assert!(!shown.contains("secret"), "{shown}");
        assert_eq!(shown, "Payload(Text, 10 bytes)");
    }

    #[test]
    fn the_two_caps_are_section_fives_caps() {
        let text = Payload {
            fmt: ClipFormat::Text,
            bytes: vec![b'x'; CLIPBOARD_TEXT_MAX_BYTES as usize],
        };
        assert!(text.within_cap());
        let over = Payload {
            fmt: ClipFormat::Text,
            bytes: vec![b'x'; CLIPBOARD_TEXT_MAX_BYTES as usize + 1],
        };
        assert!(!over.within_cap());
        let image = Payload::png(vec![0u8; CLIPBOARD_IMAGE_MAX_BYTES as usize]);
        assert!(image.within_cap());
        assert!(!Payload::png(vec![0u8; CLIPBOARD_IMAGE_MAX_BYTES as usize + 1]).within_cap());
    }

    #[test]
    fn chunks_cover_the_payload_exactly() {
        let payload = Payload::png(vec![7u8; 40 * 1024]);
        assert_eq!(payload.chunks(), 3);
        let mut rebuilt = Vec::new();
        for index in 0..payload.chunks() {
            let chunk = decode_chunk(&payload.chunk(index)).expect("a chunk we produced");
            assert!(chunk.len() as u64 <= CLIPBOARD_CHUNK_MAX_BYTES);
            rebuilt.extend_from_slice(&chunk);
        }
        assert_eq!(rebuilt, payload.bytes);
    }

    #[test]
    fn an_empty_payload_is_still_one_chunk() {
        assert_eq!(Payload::text("").chunks(), 1);
        assert_eq!(Payload::text("").chunk(0), "");
    }

    #[test]
    fn a_chunk_above_the_chunk_cap_is_refused_on_decode() {
        let oversize = BASE64_STANDARD.encode(vec![0u8; CLIPBOARD_CHUNK_MAX_BYTES as usize + 1]);
        assert!(decode_chunk(&oversize).is_none());
        assert!(decode_chunk("not base64!!").is_none());
    }

    #[test]
    fn the_same_bytes_in_two_formats_are_not_the_same_content() {
        let text = Payload::text("hello");
        assert_eq!(text.digest(), Payload::text("hello").digest());
        assert_ne!(text.digest(), Payload::text("hell0").digest());
        assert_ne!(text.digest(), Payload::png(b"hello".to_vec()).digest());
    }

    #[test]
    fn a_unicode_text_buffer_stops_at_its_nul() {
        let units: Vec<u16> = "hi\0\0\0".encode_utf16().collect();
        assert_eq!(text_from_utf16(&units), "hi");
        assert_eq!(text_to_utf16("hi"), vec![b'h' as u16, b'i' as u16, 0]);
    }

    /// One row of one 24-bit bottom-up DIB: two pixels, red then blue, plus the
    /// two padding bytes the 4-byte stride rule adds.
    fn dib_24(width: i32, height: i32, rows: &[&[u8]]) -> Vec<u8> {
        let mut dib = vec![0u8; HEADER_V1_BYTES];
        dib[0..4].copy_from_slice(&(HEADER_V1_BYTES as u32).to_le_bytes());
        dib[4..8].copy_from_slice(&width.to_le_bytes());
        dib[8..12].copy_from_slice(&height.to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&24u16.to_le_bytes());
        dib[16..20].copy_from_slice(&BI_RGB.to_le_bytes());
        for row in rows {
            dib.extend_from_slice(row);
        }
        dib
    }

    /// A 32-bit top-down DIB with a v1 header, from its BGRA pixels in order.
    fn dib_32(width: i32, height: i32, pixels: &[[u8; 4]]) -> Vec<u8> {
        let mut dib = dib_24(width, -height, &[]);
        dib[14..16].copy_from_slice(&32u16.to_le_bytes());
        dib.extend(pixels.iter().flatten());
        dib
    }

    const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

    #[test]
    fn a_bottom_up_dib_is_flipped_and_bgr_becomes_rgb() {
        // bottom row first in the buffer: blue, then the top row: red.
        let blue = [0xffu8, 0x00, 0x00, 0x00, 0x00, 0x00];
        let red = [0x00u8, 0x00, 0xff, 0x00, 0x00, 0x00];
        let png = dib_to_png(&dib_24(1, 2, &[&blue, &red]), |_| None).expect("a 1x2 dib");
        assert_eq!(png[..8], PNG_SIGNATURE);
        assert_eq!(&png[16..24], &[0, 0, 0, 1, 0, 0, 0, 2], "1x2");
    }

    #[test]
    fn a_dib_whose_header_outruns_its_pixels_is_refused() {
        let mut truncated = dib_24(4, 4, &[]);
        truncated.extend_from_slice(&[0u8; 8]);
        assert!(dib_to_png(&truncated, |_| None).is_none());
        assert!(dib_to_png(&[], |_| None).is_none());
        // 8 bits per pixel is palettised, which this module does not carry.
        let mut palettised = dib_24(1, 1, &[&[0u8; 4]]);
        palettised[14..16].copy_from_slice(&8u16.to_le_bytes());
        assert!(dib_to_png(&palettised, |_| None).is_none());
    }

    /// The bound is decided on the header: nothing behind it is needed, so
    /// nothing behind it is copied or allocated for a clipboard over it.
    #[test]
    fn a_dib_over_the_pixel_bound_is_refused_from_its_header_alone() {
        let header = |width: i32, height: i32| dib_32(width, height, &[]);
        let at_bound = header(8192, 8192);
        assert_eq!(
            Layout::read(&at_bound).map(|layout| layout.len),
            Some(HEADER_V1_BYTES + 8192 * 8192 * 4),
            "the bound itself is sized from 40 bytes"
        );
        assert_eq!(dib_len(&at_bound), None, "and its pixels are not there");
        assert!(Layout::read(&header(8192, 8193)).is_none(), "one row over");
        assert!(
            Layout::read(&header(11_520, 2160)).is_some(),
            "three 4K screens"
        );
    }

    #[test]
    fn a_dib_is_copied_as_long_as_its_header_says_and_no_longer() {
        let mut dib = dib_24(1, 1, &[&[1, 2, 3, 0]]);
        let exact = dib.len();
        // what GlobalSize rounds a handle up to.
        dib.extend_from_slice(&[0u8; 12]);
        assert_eq!(dib_len(&dib), Some(exact));
        assert_eq!(dib_len(&dib[..exact - 1]), None, "a short one is refused");
    }

    /// The compressor is preferred, the stored encoder answers when it fails,
    /// and a bitmap too big to store under the cap is dropped, not built.
    #[test]
    fn a_failed_compressor_falls_back_to_the_stored_encoder() {
        let dib = dib_32(2, 2, &[[1, 2, 3, 0]; 4]);
        let compressed = dib_to_png(&dib, |_| Some(b"compressed".to_vec()));
        assert_eq!(compressed.as_deref(), Some(&b"compressed"[..]));
        let stored = dib_to_png(&dib, |_| None).expect("the stored fallback");
        assert_eq!(stored[..8], PNG_SIGNATURE);

        // 2048 square is 16 MiB stored, over the cap.
        let big = dib_32(2048, 2048, &vec![[9, 9, 9, 0]; 2048 * 2048]);
        assert_eq!(dib_to_png(&big, |_| None), None);
        assert!(
            dib_to_png(&big, |_| Some(vec![1])).is_some(),
            "compressed, it goes"
        );
    }

    /// WIC hands over top-down BGRA; the clipboard gets a bottom-up v5 DIB with
    /// an alpha mask, which the reader here takes back row for row.
    #[test]
    fn a_finished_dibv5_reads_back_row_for_row() {
        let (width, height) = (3u32, 3u32);
        let pixels: Vec<u8> = (0..width * height * 4).map(|i| i as u8).collect();
        let mut buffer = vec![0u8; HEADER_V5_BYTES];
        buffer.extend_from_slice(&pixels);
        finish_dibv5(&mut buffer, width, height);

        let field = |at: usize| u32::from_le_bytes(buffer[at..at + 4].try_into().unwrap());
        assert_eq!(field(0), HEADER_V5_BYTES as u32);
        assert_eq!(field(8), height, "positive: bottom-up");
        assert_eq!(field(12), 1 | (32 << 16), "one plane, 32 bits");
        assert_eq!(field(16), BI_BITFIELDS);
        assert_eq!(field(52), 0xff00_0000, "alpha is a channel, not padding");

        let dib = Dib::parse(&buffer).expect("our own dibv5");
        assert_eq!(
            (dib.width, dib.height, dib.bytes_per_pixel),
            (width, height, 4)
        );
        let row_bytes = (width * 4) as usize;
        for y in 0..height {
            let start = y as usize * row_bytes;
            assert_eq!(dib.row(y), &pixels[start..start + row_bytes], "row {y}");
        }
    }
}
