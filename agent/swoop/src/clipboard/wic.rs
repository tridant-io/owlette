//! Windows Imaging Component: the png compressor and decompressor the
//! clipboard's images need, which this crate has nowhere else.
//!
//! Bytes in, bytes out, like [`super::formats`]: nothing here opens the
//! clipboard, so none of it holds another application's paste up. WIC is COM,
//! and COM is per thread — whatever calls in here holds a [`Com`] first, which
//! the listener thread does for its whole life.

use windows::core::{Error, Result};
use windows::Win32::Foundation::{
    E_POINTER, HGLOBAL, WINCODEC_ERR_IMAGESIZEOUTOFRANGE, WINCODEC_ERR_UNSUPPORTEDPIXELFORMAT,
};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatPng, GUID_WICPixelFormat24bppBGR,
    GUID_WICPixelFormat32bppBGRA, IWICImagingFactory, WICBitmapDitherTypeNone,
    WICBitmapEncoderNoCache, WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnDemand,
};
use windows::Win32::System::Com::StructuredStorage::{CreateStreamOnHGlobal, GetHGlobalFromStream};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IStream, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED, STATFLAG_NONAME, STATSTG,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};

use super::formats::{finish_dibv5, Dib, DIB_MAX_PIXELS, HEADER_V5_BYTES};
use crate::signal::messages::channel::CLIPBOARD_IMAGE_MAX_BYTES;

/// COM on the calling thread for as long as the value lives.
pub struct Com;

impl Com {
    /// Apartment-threaded: the listener pumps messages for its window, which is
    /// what an STA asks of its thread, and every WIC object here is made, used
    /// and dropped inside one call on that thread.
    pub fn enter() -> Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.ok()?;
        Ok(Self)
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn factory() -> Result<IWICImagingFactory> {
    unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
}

/// A bitmap as a compressed png, or the error the caller answers with the
/// stored encoder.
///
/// The encoder writes into a region §5's image cap long, so a png that would
/// outgrow the cap fails the moment it does: a clipboard built to be enormous
/// costs the cap and not its own size.
pub fn encode_png(dib: &Dib) -> Result<Vec<u8>> {
    let factory = factory()?;
    let memory = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true) }?;
    let region = unsafe { factory.CreateStream() }?;
    unsafe { region.InitializeFromIStreamRegion(&memory, 0, CLIPBOARD_IMAGE_MAX_BYTES) }?;
    let encoder = unsafe { factory.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null()) }?;
    unsafe { encoder.Initialize(&region, WICBitmapEncoderNoCache) }?;
    let mut frame = None;
    let mut options = None;
    unsafe { encoder.CreateNewFrame(&mut frame, &mut options) }?;
    let frame = frame.ok_or_else(|| Error::from(E_POINTER))?;
    unsafe { frame.Initialize(options.as_ref()) }?;
    unsafe { frame.SetSize(dib.width, dib.height) }?;
    // a bitmap without alpha goes in as three bytes a pixel and comes out an
    // rgb png: a screenshot has no use for a fourth channel of 255s.
    let wanted = if dib.alpha {
        GUID_WICPixelFormat32bppBGRA
    } else {
        GUID_WICPixelFormat24bppBGR
    };
    let mut format = wanted;
    unsafe { frame.SetPixelFormat(&mut format) }?;
    if format != wanted {
        // the encoder offered another layout, and the rows below are in this one.
        return Err(WINCODEC_ERR_UNSUPPORTEDPIXELFORMAT.into());
    }
    // a row at a time: a bottom-up DIB's rows are the wrong way round for one
    // call, and turning the whole bitmap over first would double it.
    let mut line = Vec::new();
    for y in 0..dib.height {
        let mut row = dib.row(y);
        if dib.bytes_per_pixel == 4 && !dib.alpha {
            line.clear();
            line.extend(row.as_chunks::<4>().0.iter().flat_map(|px| &px[..3]));
            row = line.as_slice();
        }
        unsafe { frame.WritePixels(1, row.len() as u32, row) }?;
    }
    unsafe { frame.Commit() }?;
    unsafe { encoder.Commit() }?;
    written(&memory)
}

/// What the encoder wrote, copied out of the stream's memory.
fn written(memory: &IStream) -> Result<Vec<u8>> {
    let mut stat = STATSTG::default();
    unsafe { memory.Stat(&mut stat, STATFLAG_NONAME) }?;
    let global = unsafe { GetHGlobalFromStream(memory) }?;
    let pointer = unsafe { GlobalLock(global) };
    if pointer.is_null() {
        return Err(Error::from_thread());
    }
    // the region kept the stream under the cap, so its size is a usize.
    let bytes =
        unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), stat.cbSize as usize) }.to_vec();
    let _ = unsafe { GlobalUnlock(global) };
    Ok(bytes)
}

/// A png as a `CF_DIBV5`: 32-bit BGRA with its alpha, bottom-up.
///
/// The bytes are a viewer's and this process runs as the machine, so only
/// WIC's own png decoder reads them — never whichever codec their first bytes
/// claim — and the size is read from the header and checked against
/// [`DIB_MAX_PIXELS`] before a pixel buffer exists.
pub fn png_to_dibv5(png: &[u8]) -> Result<Vec<u8>> {
    let factory = factory()?;
    let stream = unsafe { factory.CreateStream() }?;
    unsafe { stream.InitializeFromMemory(png) }?;
    let decoder = unsafe { factory.CreateDecoder(&GUID_ContainerFormatPng, std::ptr::null()) }?;
    unsafe { decoder.Initialize(&stream, WICDecodeMetadataCacheOnDemand) }?;
    let frame = unsafe { decoder.GetFrame(0) }?;
    let (mut width, mut height) = (0u32, 0u32);
    unsafe { frame.GetSize(&mut width, &mut height) }?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > DIB_MAX_PIXELS {
        return Err(WINCODEC_ERR_IMAGESIZEOUTOFRANGE.into());
    }
    let converter = unsafe { factory.CreateFormatConverter() }?;
    unsafe {
        converter.Initialize(
            &frame,
            &GUID_WICPixelFormat32bppBGRA,
            WICBitmapDitherTypeNone,
            None,
            0.0,
            WICBitmapPaletteTypeCustom,
        )
    }?;
    let stride = width as usize * 4;
    let mut dib = vec![0u8; HEADER_V5_BYTES + stride * height as usize];
    unsafe { converter.CopyPixels(std::ptr::null(), stride as u32, &mut dib[HEADER_V5_BYTES..]) }?;
    finish_dibv5(&mut dib, width, height);
    Ok(dib)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipboard::formats::dib_to_png;
    use crate::cursor::{encode_png as stored_png, CursorImage};
    use windows::Win32::Foundation::WINCODEC_ERR_STREAMWRITE;

    /// A 32-bit top-down DIB with a v1 header, from its BGRA pixels in order.
    fn dib_32(width: u32, height: u32, pixels: &[[u8; 4]]) -> Vec<u8> {
        let mut dib = vec![0u8; 40];
        dib[0..4].copy_from_slice(&40u32.to_le_bytes());
        dib[4..8].copy_from_slice(&(width as i32).to_le_bytes());
        dib[8..12].copy_from_slice(&(-(height as i32)).to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&32u16.to_le_bytes());
        dib.extend(pixels.iter().flatten());
        dib
    }

    /// Every pixel of `dib`, top row first, as BGRA.
    fn bgra(dib: &Dib) -> Vec<[u8; 4]> {
        (0..dib.height)
            .flat_map(|y| {
                dib.row(y)
                    .chunks_exact(dib.bytes_per_pixel)
                    .map(|px| [px[0], px[1], px[2], if dib.alpha { px[3] } else { 0xff }])
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    fn gradient(width: u32, height: u32, alpha: impl Fn(u32, u32) -> u8) -> Vec<[u8; 4]> {
        (0..height)
            .flat_map(|y| (0..width).map(move |x| (x, y)))
            .map(|(x, y)| [(x * 7) as u8, (y * 5) as u8, (x ^ y) as u8, alpha(x, y)])
            .collect()
    }

    #[test]
    fn a_bitmap_round_trips_through_wic_pixel_for_pixel() {
        let _com = Com::enter().expect("com on the test thread");
        // with alpha, and a 32-bit bitmap whose fourth byte is unused.
        let alphas: [fn(u32, u32) -> u8; 2] = [|x, _| (x * 30) as u8, |_, _| 0];
        for alpha in alphas {
            let pixels = gradient(37, 23, alpha);
            let dib = dib_32(37, 23, &pixels);
            let source = Dib::parse(&dib).expect("a 32-bit dib");
            let png = encode_png(&source).expect("wic compresses it");
            let back = png_to_dibv5(&png).expect("wic reads it back");
            let back = Dib::parse(&back).expect("a dibv5 the reader takes");
            assert_eq!((back.width, back.height), (37, 23));
            assert_eq!(bgra(&back), bgra(&source));
        }
    }

    #[test]
    fn a_flat_screenshot_compresses_far_below_the_stored_encoding() {
        let _com = Com::enter().expect("com on the test thread");
        let dib = dib_32(1920, 1080, &vec![[0x30, 0x60, 0x90, 0]; 1920 * 1080]);
        let stored = dib_to_png(&dib, |_| None).expect("1080p fits the cap stored");
        let compressed = encode_png(&Dib::parse(&dib).expect("a dib")).expect("compressed");
        assert!(
            compressed.len() * 100 < stored.len(),
            "{} bytes compressed against {} stored",
            compressed.len(),
            stored.len()
        );
    }

    /// Noise does not compress, so its png outgrows the cap and the region the
    /// encoder writes into refuses it, rather than growing past it.
    #[test]
    fn a_png_that_would_outgrow_the_cap_is_refused_while_it_is_written() {
        let _com = Com::enter().expect("com on the test thread");
        let mut state = 0x2545_f491u32;
        let noise: Vec<[u8; 4]> = (0..2048 * 2048)
            .map(|_| {
                // xorshift: incompressible enough, and the same every run. four
                // bytes a pixel with alpha, so 16 MiB of it against a 15 MiB cap.
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state.to_le_bytes()
            })
            .collect();
        let dib = dib_32(2048, 2048, &noise);
        let refused = encode_png(&Dib::parse(&dib).expect("a dib")).expect_err("over the cap");
        assert_eq!(
            refused.code(),
            WINCODEC_ERR_STREAMWRITE,
            "the region refused it"
        );
    }

    #[test]
    fn a_png_becomes_a_dibv5_the_dib_reader_reads_back() {
        let _com = Com::enter().expect("com on the test thread");
        let rgba = [0x10, 0x20, 0x30, 0x80, 0xff, 0x00, 0x00, 0xff];
        // the crate's own stored png of a 2x1 image, half transparent then red.
        let png = stored_png(&CursorImage {
            width: 2,
            height: 1,
            hot_x: 0,
            hot_y: 0,
            scale: 1,
            rgba: rgba.to_vec(),
        });
        let dib = png_to_dibv5(&png).expect("wic decodes it");
        assert_eq!(dib.len(), HEADER_V5_BYTES + 2 * 4);
        let read = Dib::parse(&dib).expect("a dibv5 the reader takes");
        assert!(read.alpha);
        // straight alpha, BGRA.
        assert_eq!(
            read.row(0),
            &[0x30, 0x20, 0x10, 0x80, 0x00, 0x00, 0xff, 0xff]
        );
        assert!(
            dib_to_png(&dib, |_| None).is_some(),
            "and the stored path takes it too"
        );
    }

    /// A png header can claim any size in a few bytes. The claim is checked
    /// before the decode allocates for it — one row over the bound here, well
    /// inside anything WIC would refuse on its own.
    #[test]
    fn a_png_claiming_more_than_the_bound_is_refused_before_it_is_decoded() {
        let _com = Com::enter().expect("com on the test thread");
        let bomb = stored_png(&CursorImage {
            width: 8192,
            height: 8193,
            hot_x: 0,
            hot_y: 0,
            scale: 1,
            rgba: Vec::new(),
        });
        let refused = png_to_dibv5(&bomb).expect_err("refused");
        assert_eq!(refused.code(), WINCODEC_ERR_IMAGESIZEOUTOFRANGE);
    }

    /// The png decoder and no other: a valid bmp is refused, where a decoder
    /// picked from the bytes would have taken it. The listener then puts the
    /// paste on as png alone.
    #[test]
    fn only_a_png_is_decoded() {
        let _com = Com::enter().expect("com on the test thread");
        let dib = dib_32(1, 1, &[[1, 2, 3, 0xff]]);
        let mut bmp = b"BM".to_vec();
        bmp.extend_from_slice(&(14 + dib.len() as u32).to_le_bytes());
        bmp.extend_from_slice(&[0; 4]);
        bmp.extend_from_slice(&(14u32 + 40).to_le_bytes());
        bmp.extend_from_slice(&dib);
        assert!(png_to_dibv5(&bmp).is_err());
        assert!(png_to_dibv5(b"not an image at all").is_err());
    }
}
