//! Annex-B NAL parsing — enough of H.264 and H.265 to answer the structural
//! questions spike 0.9 asks of the bitstream itself, rather than trusting what
//! the encoder was configured to do:
//!
//! * how many VCL NAL units an access unit contains (single-slice check),
//! * whether an access unit is an IDR / IRAP,
//! * whether VPS/SPS/PPS travel in-band with it,
//! * and what the H.264 SPS VUI actually says about `max_num_reorder_frames`
//!   and `max_dec_frame_buffering` — the two values the NVENC API has no field
//!   for and only emits as a consequence of `bitstreamRestrictionFlag = 1`.
//!
//! Every reader is fallible: a truncated or malformed unit returns `None`
//! instead of panicking, because this parser is also run over bitstreams that
//! were deliberately produced with an unusual configuration.

/// Which codec's NAL header layout to apply. H.264 has a 1-byte header with the
/// type in the low 5 bits; H.265 has a 2-byte header with the type in bits 1-6.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    H264,
    Hevc,
}

pub const H264_NAL_IDR: u8 = 5;
pub const H264_NAL_SPS: u8 = 7;
pub const H264_NAL_PPS: u8 = 8;

pub const HEVC_NAL_VPS: u8 = 32;
pub const HEVC_NAL_SPS: u8 = 33;
pub const HEVC_NAL_PPS: u8 = 34;

/// One NAL unit located inside an Annex-B buffer. `start`/`end` bracket the
/// payload *including* the NAL header byte(s) but excluding the start code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Nal {
    pub ty: u8,
    pub start: usize,
    pub end: usize,
}

/// Split an Annex-B buffer into NAL units. Accepts both 3-byte and 4-byte start
/// codes and tolerates trailing zero bytes before the next start code.
pub fn parse_annexb(data: &[u8], codec: Codec) -> Vec<Nal> {
    let mut starts: Vec<usize> = Vec::new();
    let mut i = 0usize;
    while i + 2 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }

    let header_len = match codec {
        Codec::H264 => 1,
        Codec::Hevc => 2,
    };
    let mut out = Vec::with_capacity(starts.len());
    for (n, &start) in starts.iter().enumerate() {
        // The unit runs to the byte before the next start code, minus any zero
        // bytes that belong to that start code (a 4-byte code is a 3-byte code
        // with a leading zero).
        let mut end = starts.get(n + 1).map_or(data.len(), |&next| next - 3);
        while end > start && data[end - 1] == 0 {
            end -= 1;
        }
        if end < start + header_len {
            continue;
        }
        let ty = match codec {
            Codec::H264 => data[start] & 0x1f,
            Codec::Hevc => (data[start] >> 1) & 0x3f,
        };
        out.push(Nal { ty, start, end });
    }
    out
}

/// Is this NAL unit a coded slice? Only VCL units are counted when checking how
/// many slices a picture was split into.
pub fn is_vcl(codec: Codec, ty: u8) -> bool {
    match codec {
        Codec::H264 => (1..=5).contains(&ty),
        Codec::Hevc => ty <= 31,
    }
}

/// Does this NAL unit start a random-access point? H.264: an IDR slice. H.265:
/// any IRAP unit (BLA/IDR/CRA, types 16-23), which is what "VPS/SPS/PPS on
/// every IRAP" is measured against.
pub fn is_irap(codec: Codec, ty: u8) -> bool {
    match codec {
        Codec::H264 => ty == H264_NAL_IDR,
        Codec::Hevc => (16..=23).contains(&ty),
    }
}

/// Strip emulation-prevention bytes (`00 00 03` -> `00 00`) to recover the RBSP.
pub fn rbsp(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len());
    let mut zeros = 0usize;
    for &b in payload {
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        if b == 0 {
            zeros += 1;
        } else {
            zeros = 0;
        }
        out.push(b);
    }
    out
}

struct BitReader<'a> {
    data: &'a [u8],
    bit: usize,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, bit: 0 }
    }

    fn u1(&mut self) -> Option<u32> {
        let byte = *self.data.get(self.bit / 8)?;
        let shift = 7 - (self.bit % 8);
        self.bit += 1;
        Some(u32::from((byte >> shift) & 1))
    }

    fn u(&mut self, n: u32) -> Option<u32> {
        let mut v = 0u32;
        for _ in 0..n {
            v = (v << 1) | self.u1()?;
        }
        Some(v)
    }

    /// Unsigned Exp-Golomb. Bounded at 32 leading zeros so a corrupt stream
    /// terminates instead of spinning.
    fn ue(&mut self) -> Option<u32> {
        let mut leading = 0u32;
        while self.u1()? == 0 {
            leading += 1;
            if leading > 32 {
                return None;
            }
        }
        if leading == 0 {
            return Some(0);
        }
        Some((1u32 << leading) - 1 + self.u(leading)?)
    }

    fn se(&mut self) -> Option<i32> {
        let k = self.ue()?;
        let magnitude = i64::from(k).div_euclid(2) + i64::from(k % 2);
        Some(if k % 2 == 1 {
            magnitude as i32
        } else {
            -(magnitude as i32)
        })
    }
}

/// The subset of an H.264 SPS this spike reads back.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct H264Sps {
    pub profile_idc: u8,
    /// The `constraint_set*_flags` byte, needed verbatim to build the
    /// `avc1.PPCCLL` codec string WebCodecs is configured with.
    pub constraint_flags: u8,
    pub level_idc: u8,
    pub vui_present: bool,
    pub timing_info_present_flag: bool,
    pub num_units_in_tick: Option<u32>,
    pub time_scale: Option<u32>,
    pub bitstream_restriction_flag: bool,
    pub max_num_reorder_frames: Option<u32>,
    pub max_dec_frame_buffering: Option<u32>,
}

fn skip_scaling_list(r: &mut BitReader, size: usize) -> Option<()> {
    let mut last_scale = 8i32;
    let mut next_scale = 8i32;
    for _ in 0..size {
        if next_scale != 0 {
            let delta = r.se()?;
            next_scale = (last_scale + delta + 256).rem_euclid(256);
        }
        if next_scale != 0 {
            last_scale = next_scale;
        }
    }
    Some(())
}

fn skip_hrd_parameters(r: &mut BitReader) -> Option<()> {
    let cpb_cnt_minus1 = r.ue()?;
    r.u(4)?; // bit_rate_scale
    r.u(4)?; // cpb_size_scale
    for _ in 0..=cpb_cnt_minus1 {
        r.ue()?; // bit_rate_value_minus1
        r.ue()?; // cpb_size_value_minus1
        r.u1()?; // cbr_flag
    }
    r.u(5)?; // initial_cpb_removal_delay_length_minus1
    r.u(5)?; // cpb_removal_delay_length_minus1
    r.u(5)?; // dpb_output_delay_length_minus1
    r.u(5)?; // time_offset_length
    Some(())
}

/// Parse an H.264 SPS NAL payload (header byte included) far enough to read the
/// VUI bitstream-restriction block. Returns `None` on a malformed unit.
pub fn parse_h264_sps(payload: &[u8]) -> Option<H264Sps> {
    if payload.is_empty() || payload[0] & 0x1f != H264_NAL_SPS {
        return None;
    }
    let data = rbsp(&payload[1..]);
    let mut r = BitReader::new(&data);
    let mut sps = H264Sps {
        profile_idc: r.u(8)? as u8,
        ..Default::default()
    };
    sps.constraint_flags = r.u(8)? as u8;
    sps.level_idc = r.u(8)? as u8;
    r.ue()?; // seq_parameter_set_id

    const HIGH_PROFILES: [u8; 13] = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];
    if HIGH_PROFILES.contains(&sps.profile_idc) {
        let chroma_format_idc = r.ue()?;
        if chroma_format_idc == 3 {
            r.u1()?; // separate_colour_plane_flag
        }
        r.ue()?; // bit_depth_luma_minus8
        r.ue()?; // bit_depth_chroma_minus8
        r.u1()?; // qpprime_y_zero_transform_bypass_flag
        if r.u1()? == 1 {
            let lists = if chroma_format_idc != 3 { 8 } else { 12 };
            for i in 0..lists {
                if r.u1()? == 1 {
                    skip_scaling_list(&mut r, if i < 6 { 16 } else { 64 })?;
                }
            }
        }
    }

    r.ue()?; // log2_max_frame_num_minus4
    let poc_type = r.ue()?;
    if poc_type == 0 {
        r.ue()?; // log2_max_pic_order_cnt_lsb_minus4
    } else if poc_type == 1 {
        r.u1()?; // delta_pic_order_always_zero_flag
        r.se()?; // offset_for_non_ref_pic
        r.se()?; // offset_for_top_to_bottom_field
        let cycle = r.ue()?;
        for _ in 0..cycle {
            r.se()?; // offset_for_ref_frame[i]
        }
    }
    r.ue()?; // max_num_ref_frames
    r.u1()?; // gaps_in_frame_num_value_allowed_flag
    r.ue()?; // pic_width_in_mbs_minus1
    r.ue()?; // pic_height_in_map_units_minus1
    if r.u1()? == 0 {
        r.u1()?; // mb_adaptive_frame_field_flag
    }
    r.u1()?; // direct_8x8_inference_flag
    if r.u1()? == 1 {
        r.ue()?; // frame_crop_left_offset
        r.ue()?; // frame_crop_right_offset
        r.ue()?; // frame_crop_top_offset
        r.ue()?; // frame_crop_bottom_offset
    }

    sps.vui_present = r.u1()? == 1;
    if !sps.vui_present {
        return Some(sps);
    }

    if r.u1()? == 1 {
        // aspect_ratio_info_present_flag
        let idc = r.u(8)?;
        if idc == 255 {
            r.u(16)?; // sar_width
            r.u(16)?; // sar_height
        }
    }
    if r.u1()? == 1 {
        r.u1()?; // overscan_appropriate_flag
    }
    if r.u1()? == 1 {
        // video_signal_type_present_flag
        r.u(3)?; // video_format
        r.u1()?; // video_full_range_flag
        if r.u1()? == 1 {
            r.u(8)?; // colour_primaries
            r.u(8)?; // transfer_characteristics
            r.u(8)?; // matrix_coefficients
        }
    }
    if r.u1()? == 1 {
        // chroma_loc_info_present_flag
        r.ue()?;
        r.ue()?;
    }
    sps.timing_info_present_flag = r.u1()? == 1;
    if sps.timing_info_present_flag {
        sps.num_units_in_tick = Some(r.u(32)?);
        sps.time_scale = Some(r.u(32)?);
        r.u1()?; // fixed_frame_rate_flag
    }
    let nal_hrd = r.u1()? == 1;
    if nal_hrd {
        skip_hrd_parameters(&mut r)?;
    }
    let vcl_hrd = r.u1()? == 1;
    if vcl_hrd {
        skip_hrd_parameters(&mut r)?;
    }
    if nal_hrd || vcl_hrd {
        r.u1()?; // low_delay_hrd_flag
    }
    r.u1()?; // pic_struct_present_flag

    sps.bitstream_restriction_flag = r.u1()? == 1;
    if sps.bitstream_restriction_flag {
        r.u1()?; // motion_vectors_over_pic_boundaries_flag
        r.ue()?; // max_bytes_per_pic_denom
        r.ue()?; // max_bits_per_mb_denom
        r.ue()?; // log2_max_mv_length_horizontal
        r.ue()?; // log2_max_mv_length_vertical
        sps.max_num_reorder_frames = Some(r.ue()?);
        sps.max_dec_frame_buffering = Some(r.ue()?);
    }
    Some(sps)
}

impl H264Sps {
    /// The WebCodecs / RFC 6381 codec string for this SPS, e.g. `avc1.64002a`.
    /// The browser needs it to configure a `VideoDecoder`, and it has to come
    /// from the bitstream rather than from what we asked the encoder for.
    pub fn codec_string(&self) -> String {
        format!(
            "avc1.{:02x}{:02x}{:02x}",
            self.profile_idc, self.constraint_flags, self.level_idc
        )
    }
}

/// Summary of one encoder output buffer, treated as one access unit.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccessUnit {
    pub vcl_nals: usize,
    pub irap: bool,
    pub has_vps: bool,
    pub has_sps: bool,
    pub has_pps: bool,
}

/// Classify one encoder output buffer.
pub fn summarize_access_unit(data: &[u8], codec: Codec) -> AccessUnit {
    let mut au = AccessUnit::default();
    for nal in parse_annexb(data, codec) {
        if is_vcl(codec, nal.ty) {
            au.vcl_nals += 1;
            au.irap |= is_irap(codec, nal.ty);
        }
        match codec {
            Codec::H264 => {
                au.has_sps |= nal.ty == H264_NAL_SPS;
                au.has_pps |= nal.ty == H264_NAL_PPS;
                au.has_vps = true; // H.264 has no VPS; treat it as satisfied.
            }
            Codec::Hevc => {
                au.has_vps |= nal.ty == HEVC_NAL_VPS;
                au.has_sps |= nal.ty == HEVC_NAL_SPS;
                au.has_pps |= nal.ty == HEVC_NAL_PPS;
            }
        }
    }
    au
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_three_and_four_byte_start_codes() {
        // 4-byte code, a 2-byte SPS-typed unit, then a 3-byte code and an IDR.
        let data = [0, 0, 0, 1, 0x67, 0x42, 0, 0, 1, 0x65, 0xAA, 0xBB];
        let nals = parse_annexb(&data, Codec::H264);
        assert_eq!(nals.len(), 2);
        assert_eq!(nals[0].ty, H264_NAL_SPS);
        assert_eq!(&data[nals[0].start..nals[0].end], &[0x67, 0x42]);
        assert_eq!(nals[1].ty, H264_NAL_IDR);
        assert_eq!(&data[nals[1].start..nals[1].end], &[0x65, 0xAA, 0xBB]);
    }

    #[test]
    fn trailing_zeros_belong_to_the_next_start_code_not_the_unit() {
        let data = [0, 0, 1, 0x61, 0x01, 0, 0, 0, 1, 0x61, 0x02];
        let nals = parse_annexb(&data, Codec::H264);
        assert_eq!(nals.len(), 2);
        assert_eq!(&data[nals[0].start..nals[0].end], &[0x61, 0x01]);
    }

    #[test]
    fn hevc_nal_type_comes_from_the_two_byte_header() {
        // 0x40 0x01 -> type 32 (VPS); 0x26 0x01 -> type 19 (IDR_W_RADL).
        let data = [0, 0, 0, 1, 0x40, 0x01, 0xAA, 0, 0, 0, 1, 0x26, 0x01, 0xBB];
        let nals = parse_annexb(&data, Codec::Hevc);
        assert_eq!(nals.len(), 2);
        assert_eq!(nals[0].ty, HEVC_NAL_VPS);
        assert_eq!(nals[1].ty, 19);
        assert!(is_irap(Codec::Hevc, nals[1].ty));
        assert!(is_vcl(Codec::Hevc, nals[1].ty));
        assert!(!is_vcl(Codec::Hevc, nals[0].ty));
    }

    #[test]
    fn rbsp_drops_only_the_emulation_prevention_byte() {
        assert_eq!(rbsp(&[0x00, 0x00, 0x03, 0x01]), vec![0x00, 0x00, 0x01]);
        assert_eq!(rbsp(&[0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x02]), vec![0, 0, 0, 0, 2]);
        // A lone 0x03 that is not preceded by two zeros is real payload.
        assert_eq!(rbsp(&[0x01, 0x03, 0x00, 0x03]), vec![0x01, 0x03, 0x00, 0x03]);
    }

    #[test]
    fn exp_golomb_matches_the_spec_table() {
        // ue codes 1 / 010 / 011 / 00100 / 00101 packed MSB-first.
        let data = [0b1010_0110, 0b0100_0010, 0b1000_0000];
        let mut r = BitReader::new(&data);
        assert_eq!(r.ue(), Some(0));
        assert_eq!(r.ue(), Some(1));
        assert_eq!(r.ue(), Some(2));
        assert_eq!(r.ue(), Some(3));
        assert_eq!(r.ue(), Some(4));
    }

    #[test]
    fn signed_exp_golomb_alternates_sign() {
        // codeNum 0,1,2,3,4 -> 0, 1, -1, 2, -2.
        // ue codes 1 / 010 / 011 / 00100 / 00101 packed MSB-first.
        let data = [0b1010_0110, 0b0100_0010, 0b1000_0000];
        let mut r = BitReader::new(&data);
        assert_eq!(r.se(), Some(0));
        assert_eq!(r.se(), Some(1));
        assert_eq!(r.se(), Some(-1));
        assert_eq!(r.se(), Some(2));
        assert_eq!(r.se(), Some(-2));
    }

    #[test]
    fn bit_reader_runs_out_instead_of_panicking() {
        let data = [0x00];
        let mut r = BitReader::new(&data);
        assert_eq!(r.u(8), Some(0));
        assert_eq!(r.u1(), None);
        assert_eq!(r.ue(), None);
    }

    #[test]
    fn truncated_sps_returns_none() {
        assert_eq!(parse_h264_sps(&[0x67, 0x42]), None);
        assert_eq!(parse_h264_sps(&[]), None);
        // Not an SPS NAL at all.
        assert_eq!(parse_h264_sps(&[0x65, 0x42, 0x00, 0x1f]), None);
    }

    // Real SPS units captured from this box's NVENC on 2026-09-17 (driver
    // 591.86, RTX 2080 Ti), 1920x1080 High profile, the exact two configs
    // measurement 1 compares. They are the fixture because the whole point of
    // the parser is reading back what NVENC emitted, not what we believe it
    // emits.
    const SPS_VUI_OFF: &[u8] = &[
        0x67, 0x64, 0x00, 0x2a, 0xac, 0x2b, 0x28, 0x0f, 0x00, 0x44, 0xfc, 0xb8, 0x08, 0x80, 0x00,
        0x01, 0xf4, 0x00, 0x00, 0xea, 0x60, 0x42,
    ];
    const SPS_VUI_ON: &[u8] = &[
        0x67, 0x64, 0x00, 0x2a, 0xac, 0x2b, 0x28, 0x0f, 0x00, 0x44, 0xfc, 0xb8, 0x08, 0x80, 0x00,
        0x01, 0xf4, 0x00, 0x00, 0xea, 0x60, 0x47, 0x8e, 0x15, 0x2c,
    ];

    #[test]
    fn nvenc_sps_without_bitstream_restriction() {
        let sps = parse_h264_sps(SPS_VUI_OFF).expect("captured SPS parses");
        assert_eq!(sps.profile_idc, 100);
        assert!(sps.vui_present);
        assert!(sps.timing_info_present_flag);
        assert!(!sps.bitstream_restriction_flag);
        assert_eq!(sps.max_num_reorder_frames, None);
        assert_eq!(sps.max_dec_frame_buffering, None);
    }

    #[test]
    fn nvenc_sps_with_bitstream_restriction_declares_zero_reordering() {
        let sps = parse_h264_sps(SPS_VUI_ON).expect("captured SPS parses");
        assert_eq!(sps.profile_idc, 100);
        assert!(sps.vui_present);
        assert!(sps.bitstream_restriction_flag);
        assert_eq!(sps.max_num_reorder_frames, Some(0));
        // NVENC has no field for max_dec_frame_buffering: it emits
        // maxNumRefFrames (4 here), not 0. Only max_num_reorder_frames is
        // what removes the decoder's output delay.
        assert_eq!(sps.max_dec_frame_buffering, Some(4));
    }

    #[test]
    fn access_unit_summary_counts_slices_and_parameter_sets() {
        let mut data = vec![0, 0, 0, 1, 0x40, 0x01, 0xAA]; // VPS
        data.extend_from_slice(&[0, 0, 0, 1, 0x42, 0x01, 0xBB]); // SPS (33)
        data.extend_from_slice(&[0, 0, 0, 1, 0x44, 0x01, 0xCC]); // PPS (34)
        data.extend_from_slice(&[0, 0, 0, 1, 0x26, 0x01, 0xDD]); // IDR_W_RADL
        let au = summarize_access_unit(&data, Codec::Hevc);
        assert_eq!(au.vcl_nals, 1);
        assert!(au.irap && au.has_vps && au.has_sps && au.has_pps);
    }
}
