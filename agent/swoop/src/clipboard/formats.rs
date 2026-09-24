//! What the clipboard carries, what it refuses, and the conversions between
//! the windows clipboard's formats and §5's two.
//!
//! Portable on purpose: bytes in, bytes out. The caps, the refusals, the
//! chunking and the DIB decode are unit-tested on any host, and every win32
//! call lives in [`super::listener`].

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

/// A `CF_DIB`/`CF_DIBV5` buffer as a PNG, or `None` when it is a shape this
/// module does not carry (a palettised or compressed DIB, or one whose header
/// does not describe the bytes behind it).
///
/// Only 24- and 32-bit uncompressed DIBs are decoded, which is what every
/// screenshot and every image editor puts on the clipboard. The registered
/// `"PNG"` format is preferred over this path whenever it is offered, so the
/// DIB fallback is for the applications that offer nothing else.
pub fn dib_to_png(dib: &[u8]) -> Option<Vec<u8>> {
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
    // The pixels start after the header and, for BI_BITFIELDS on a v1 header,
    // after the three channel masks that follow it. A v4/v5 header carries its
    // masks inside itself, so nothing extra follows those.
    let mut offset = header_bytes;
    if compression == BI_BITFIELDS && header_bytes == HEADER_V1_BYTES {
        offset += 12;
    }
    let width = width as u32;
    // A negative height is a top-down DIB: the first row in the buffer is the
    // top row. The usual bottom-up case is the other way round.
    let top_down = height_signed < 0;
    let height = height_signed.unsigned_abs();
    let bytes_per_pixel = (bit_count / 8) as usize;
    // Rows are padded out to a 4-byte boundary, always.
    let stride = ((width as usize * bit_count as usize).div_ceil(32)) * 4;
    let needed = stride.checked_mul(height as usize)?;
    if dib.len() < offset + needed {
        return None;
    }
    let pixels = &dib[offset..offset + needed];

    // A 32-bit BI_RGB DIB's fourth byte is reserved, not alpha, and most
    // producers leave it zero — honouring it would turn every such image
    // invisible. So alpha is used only when some pixel actually sets it.
    let has_alpha = bytes_per_pixel == 4
        && pixels
            .as_chunks::<4>()
            .0
            .iter()
            .take(width as usize * height as usize)
            .any(|px| px[3] != 0);

    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for row in 0..height {
        let source_row = if top_down { row } else { height - 1 - row };
        let start = source_row as usize * stride;
        let line = &pixels[start..start + stride];
        for x in 0..width as usize {
            let px = &line[x * bytes_per_pixel..x * bytes_per_pixel + bytes_per_pixel];
            // BGR(A) on the wire, RGBA in the png.
            rgba.extend_from_slice(&[px[2], px[1], px[0]]);
            rgba.push(if has_alpha { px[3] } else { 0xff });
        }
    }
    // The crate's only png encoder, which lives with the cursor because that is
    // what first needed one. It writes stored deflate blocks — there is no
    // compressor in this crate's dependency graph — so a large DIB encodes to
    // roughly its raw size and a big one lands over §5's 2 MiB image cap and is
    // refused. That is the honest outcome of the cap being derived from the
    // transport's buffering limit rather than picked, and it is why the
    // registered "PNG" format is tried first: it is already compressed.
    Some(encode_png(&CursorImage {
        width,
        height,
        hot_x: 0,
        hot_y: 0,
        scale: 1,
        rgba,
    }))
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

    #[test]
    fn a_bottom_up_dib_is_flipped_and_bgr_becomes_rgb() {
        // bottom row first in the buffer: blue, then the top row: red.
        let blue = [0xffu8, 0x00, 0x00, 0x00, 0x00, 0x00];
        let red = [0x00u8, 0x00, 0xff, 0x00, 0x00, 0x00];
        let png = dib_to_png(&dib_24(1, 2, &[&blue, &red])).expect("a 1x2 dib");
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        assert_eq!(&png[16..24], &[0, 0, 0, 1, 0, 0, 0, 2], "1x2");
    }

    #[test]
    fn a_dib_whose_header_outruns_its_pixels_is_refused() {
        let mut truncated = dib_24(4, 4, &[]);
        truncated.extend_from_slice(&[0u8; 8]);
        assert!(dib_to_png(&truncated).is_none());
        assert!(dib_to_png(&[]).is_none());
        // 8 bits per pixel is palettised, which this module does not carry.
        let mut palettised = dib_24(1, 1, &[&[0u8; 4]]);
        palettised[14..16].copy_from_slice(&8u16.to_le_bytes());
        assert!(dib_to_png(&palettised).is_none());
    }
}
