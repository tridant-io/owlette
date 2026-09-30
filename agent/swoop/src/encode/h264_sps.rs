//! The H.264 sequence parameter set, read through its VUI, and the one rewrite
//! swoop needs of it.
//!
//! Without `bitstream_restriction_flag` a decoder must assume the level's whole
//! DPB may be spent on reordering, so it holds pictures back before output:
//! Chrome's D3D11 decoder measured 208 ms against 8 ms once
//! `max_num_reorder_frames = 0` was declared (the swoop plan's D5), and spike
//! 0.9 measured 67 ms at level 4.2 and 267 ms at level 5.1 on NVENC's stream.
//! NVENC has a field for the flag; VideoToolbox has none, so its backend reads
//! the first SPS it emits and, when the restriction is missing, rewrites every
//! SPS with [`with_restriction`].
//!
//! The parser is the spike's (`spikes/bakeoff-host/src/nal.rs`) plus the bit
//! positions a rewrite needs. Every reader is fallible: a truncated or
//! malformed unit is `None`, never a panic, because the input is whatever an
//! encoder emitted.

/// `nal_unit_type` of a sequence parameter set.
pub const NAL_SPS: u8 = 7;

/// The values of `bitstream_restriction` that come before the two this module
/// rewrites, as the spec infers them when the block is absent (H.264 E.2.1):
/// motion vectors may cross picture boundaries, `max_bytes_per_pic_denom` 2,
/// `max_bits_per_mb_denom` 1, and 16 for both motion vector lengths. Writing
/// these claims nothing an SPS without the block did not already imply.
const INFERRED_RESTRICTION: [u32; 5] = [1, 2, 1, 16, 16];

/// `profile_idc` values whose SPS carries the chroma, bit depth and scaling
/// list fields.
const HIGH_PROFILES: [u8; 13] = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

/// What swoop reads back from an SPS.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Sps {
    pub profile_idc: u8,
    /// The `constraint_set*_flags` byte, verbatim.
    pub constraint_flags: u8,
    pub level_idc: u8,
    /// `max_num_ref_frames`: the reference count a rewrite declares as
    /// `max_dec_frame_buffering`.
    pub max_num_ref_frames: u32,
    pub vui_present: bool,
    pub bitstream_restriction_flag: bool,
    pub max_num_reorder_frames: Option<u32>,
    pub max_dec_frame_buffering: Option<u32>,
}

impl Sps {
    /// Whether a decoder may output each picture as soon as it is decoded,
    /// which is the whole point of the restriction.
    pub fn declares_no_reordering(&self) -> bool {
        self.bitstream_restriction_flag && self.max_num_reorder_frames == Some(0)
    }
}

/// Where a rewrite cuts the RBSP.
struct Layout {
    /// Bit offset of `vui_parameters_present_flag`.
    vui_flag: usize,
    /// Bit offset of `bitstream_restriction_flag`, when the VUI is present.
    restriction_flag: Option<usize>,
    /// The five restriction fields before `max_num_reorder_frames`, when the
    /// block is present, so a rewrite keeps what the encoder declared.
    restriction: Option<[u32; 5]>,
}

/// Parse an SPS NAL unit, header byte included and emulation prevention in
/// place, as it travels in the stream.
pub fn parse(nal: &[u8]) -> Option<Sps> {
    if nal.first()? & 0x1f != NAL_SPS {
        return None;
    }
    parse_rbsp(&unescape(&nal[1..])).map(|(sps, _)| sps)
}

/// The same SPS declaring `bitstream_restriction_flag = 1`,
/// `max_num_reorder_frames = 0` and `max_dec_frame_buffering` equal to its
/// reference count, ready to send. Every bit before the restriction block is
/// copied unchanged; an SPS without a VUI gains one that carries only the
/// block. `None` when `nal` is not an SPS this parser can read.
///
/// Zero reordering is true of every stream swoop sends: each backend turns
/// frame reordering off, so no picture waits on a later one.
pub fn with_restriction(nal: &[u8]) -> Option<Vec<u8>> {
    let header = *nal.first()?;
    if header & 0x1f != NAL_SPS {
        return None;
    }
    let rbsp = unescape(&nal[1..]);
    let (sps, layout) = parse_rbsp(&rbsp)?;

    let mut w = BitWriter::default();
    match layout.restriction_flag {
        Some(flag) => w.copy_bits(&rbsp, flag),
        None => {
            w.copy_bits(&rbsp, layout.vui_flag);
            w.u1(1); // vui_parameters_present_flag
                     // aspect ratio, overscan, video signal, chroma location, timing,
                     // nal hrd, vcl hrd and pic struct: all absent
            for _ in 0..8 {
                w.u1(0);
            }
        }
    }
    let [mv_over_boundaries, bytes_per_pic, bits_per_mb, mv_h, mv_v] =
        layout.restriction.unwrap_or(INFERRED_RESTRICTION);
    w.u1(1); // bitstream_restriction_flag
    w.u1(mv_over_boundaries);
    w.ue(bytes_per_pic);
    w.ue(bits_per_mb);
    w.ue(mv_h);
    w.ue(mv_v);
    w.ue(0); // max_num_reorder_frames
    w.ue(sps.max_num_ref_frames); // max_dec_frame_buffering
    w.trailing_bits();

    let mut out = Vec::with_capacity(nal.len() + 8);
    out.push(header);
    escape(&w.bytes, &mut out);
    Some(out)
}

fn parse_rbsp(data: &[u8]) -> Option<(Sps, Layout)> {
    let mut r = BitReader::new(data);
    let mut sps = Sps {
        profile_idc: r.u(8)? as u8,
        constraint_flags: r.u(8)? as u8,
        level_idc: r.u(8)? as u8,
        ..Default::default()
    };
    r.ue()?; // seq_parameter_set_id

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
    sps.max_num_ref_frames = r.ue()?;
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

    let mut layout = Layout {
        vui_flag: r.pos(),
        restriction_flag: None,
        restriction: None,
    };
    sps.vui_present = r.u1()? == 1;
    if !sps.vui_present {
        return Some((sps, layout));
    }

    if r.u1()? == 1 {
        // aspect_ratio_info_present_flag
        if r.u(8)? == 255 {
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
    if r.u1()? == 1 {
        // timing_info_present_flag
        r.u(32)?; // num_units_in_tick
        r.u(32)?; // time_scale
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

    layout.restriction_flag = Some(r.pos());
    sps.bitstream_restriction_flag = r.u1()? == 1;
    if sps.bitstream_restriction_flag {
        layout.restriction = Some([r.u1()?, r.ue()?, r.ue()?, r.ue()?, r.ue()?]);
        sps.max_num_reorder_frames = Some(r.ue()?);
        sps.max_dec_frame_buffering = Some(r.ue()?);
    }
    Some((sps, layout))
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

/// Strip emulation prevention (`00 00 03` -> `00 00`) to recover the RBSP.
fn unescape(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len());
    let mut zeros = 0usize;
    for &b in payload {
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        zeros = if b == 0 { zeros + 1 } else { 0 };
        out.push(b);
    }
    out
}

/// Put emulation prevention back: a `03` after any two zero bytes that are
/// followed by a byte of 3 or less, so no start code can appear inside a unit.
fn escape(rbsp: &[u8], out: &mut Vec<u8>) {
    let mut zeros = 0usize;
    for &b in rbsp {
        if zeros >= 2 && b <= 3 {
            out.push(3);
            zeros = 0;
        }
        zeros = if b == 0 { zeros + 1 } else { 0 };
        out.push(b);
    }
}

struct BitReader<'a> {
    data: &'a [u8],
    bit: usize,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, bit: 0 }
    }

    fn pos(&self) -> usize {
        self.bit
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

    /// Unsigned Exp-Golomb, bounded so a corrupt stream terminates.
    fn ue(&mut self) -> Option<u32> {
        let mut leading = 0u32;
        while self.u1()? == 0 {
            leading += 1;
            if leading > 31 {
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

#[derive(Default)]
struct BitWriter {
    bytes: Vec<u8>,
    bits: usize,
}

impl BitWriter {
    fn u1(&mut self, bit: u32) {
        if self.bits.is_multiple_of(8) {
            self.bytes.push(0);
        }
        if bit & 1 == 1 {
            if let Some(last) = self.bytes.last_mut() {
                *last |= 1 << (7 - self.bits % 8);
            }
        }
        self.bits += 1;
    }

    fn ue(&mut self, value: u32) {
        let coded = u64::from(value) + 1;
        let len = 64 - coded.leading_zeros();
        for _ in 1..len {
            self.u1(0);
        }
        for i in (0..len).rev() {
            self.u1(((coded >> i) & 1) as u32);
        }
    }

    /// The first `count` bits of `data`, as they are.
    fn copy_bits(&mut self, data: &[u8], count: usize) {
        for i in 0..count {
            self.u1(u32::from((data[i / 8] >> (7 - i % 8)) & 1));
        }
    }

    /// `rbsp_trailing_bits`: a one, then zeros to the byte boundary.
    fn trailing_bits(&mut self) {
        self.u1(1);
        while !self.bits.is_multiple_of(8) {
            self.u1(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Vectors {
        vectors: Vec<Vector>,
    }

    #[derive(Deserialize)]
    struct Vector {
        name: String,
        sps: String,
    }

    /// NVENC's own SPS units, High profile at levels 4.2 and 5.1, with and
    /// without the restriction: the fixture the nvenc parser is held to.
    fn nvenc_vectors() -> Vec<(String, Vec<u8>)> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("testdata/encode/nvenc-h264-sps.json");
        let raw = std::fs::read_to_string(&path).expect("the sps golden vectors are readable");
        serde_json::from_str::<Vectors>(&raw)
            .expect("the sps golden vectors parse")
            .vectors
            .into_iter()
            .map(|v| (v.name, hex::decode(v.sps).expect("the vector is hex")))
            .collect()
    }

    /// A 1920x1080 Main profile SPS with no VUI at all, the shape an encoder
    /// that writes no VUI would send: one reference frame, cropped to 1080.
    fn main_without_vui() -> Vec<u8> {
        let mut w = BitWriter::default();
        for byte in [77, 0x40, 40] {
            for i in (0..8).rev() {
                w.u1((byte >> i) & 1);
            }
        }
        w.ue(0); // seq_parameter_set_id
        w.ue(0); // log2_max_frame_num_minus4
        w.ue(0); // pic_order_cnt_type
        w.ue(2); // log2_max_pic_order_cnt_lsb_minus4
        w.ue(1); // max_num_ref_frames
        w.u1(0); // gaps_in_frame_num_value_allowed_flag
        w.ue(119); // pic_width_in_mbs_minus1
        w.ue(67); // pic_height_in_map_units_minus1
        w.u1(1); // frame_mbs_only_flag
        w.u1(1); // direct_8x8_inference_flag
        w.u1(1); // frame_cropping_flag
        for offset in [0, 0, 0, 4] {
            w.ue(offset);
        }
        w.u1(0); // vui_parameters_present_flag
        w.trailing_bits();
        let mut nal = vec![0x67];
        escape(&w.bytes, &mut nal);
        nal
    }

    #[test]
    fn nvencs_vectors_parse_as_nvenc_emitted_them() {
        let vectors = nvenc_vectors();
        assert_eq!(vectors.len(), 4, "every vector in the file is read");
        for (name, nal) in vectors {
            let sps = parse(&nal).unwrap_or_else(|| panic!("{name} parses"));
            assert_eq!(sps.profile_idc, 100, "{name}");
            assert!(sps.vui_present, "{name}");
            assert_eq!(sps.max_num_ref_frames, 4, "{name}");
            if name.ends_with("vui-on") {
                assert!(sps.declares_no_reordering(), "{name}");
                assert_eq!(sps.max_dec_frame_buffering, Some(4), "{name}");
            } else {
                assert!(!sps.bitstream_restriction_flag, "{name}");
                assert_eq!(sps.max_num_reorder_frames, None, "{name}");
            }
        }
    }

    #[test]
    fn the_rewrite_adds_the_restriction_and_keeps_every_bit_before_it() {
        for (name, nal) in nvenc_vectors()
            .into_iter()
            .filter(|(n, _)| n.ends_with("vui-off"))
        {
            let before = parse(&nal).expect("parses");
            let fixed = with_restriction(&nal).expect("rewrites");
            let after = parse(&fixed).expect("the rewrite parses");
            assert!(after.declares_no_reordering(), "{name}");
            assert_eq!(
                after.max_dec_frame_buffering,
                Some(before.max_num_ref_frames),
                "{name}"
            );
            assert_eq!(
                (
                    after.profile_idc,
                    after.constraint_flags,
                    after.level_idc,
                    after.max_num_ref_frames
                ),
                (
                    before.profile_idc,
                    before.constraint_flags,
                    before.level_idc,
                    before.max_num_ref_frames
                ),
                "{name}"
            );

            let (_, layout) = parse_rbsp(&unescape(&nal[1..])).expect("parses");
            let cut = layout.restriction_flag.expect("nvenc writes a vui");
            let mut kept = BitWriter::default();
            kept.copy_bits(&unescape(&fixed[1..]), cut);
            let mut original = BitWriter::default();
            original.copy_bits(&unescape(&nal[1..]), cut);
            assert_eq!(
                kept.bytes, original.bytes,
                "{name}: the bits before the cut"
            );
        }
    }

    #[test]
    fn an_sps_without_a_vui_gains_one_carrying_only_the_restriction() {
        let nal = main_without_vui();
        let before = parse(&nal).expect("the synthetic sps parses");
        assert_eq!((before.profile_idc, before.level_idc), (77, 40));
        assert!(!before.vui_present);
        assert!(!before.declares_no_reordering());

        let fixed = with_restriction(&nal).expect("rewrites");
        let after = parse(&fixed).expect("the rewrite parses");
        assert!(after.vui_present);
        assert!(after.declares_no_reordering());
        assert_eq!(after.max_dec_frame_buffering, Some(1));
        assert_eq!(after.max_num_ref_frames, 1);
        let (_, layout) = parse_rbsp(&unescape(&fixed[1..])).expect("parses");
        assert_eq!(layout.restriction, Some(INFERRED_RESTRICTION));
    }

    #[test]
    fn an_sps_that_already_declares_the_restriction_keeps_its_own_fields() {
        let (_, nal) = nvenc_vectors()
            .into_iter()
            .find(|(n, _)| n.ends_with("vui-on"))
            .expect("a vui-on vector");
        let (_, before) = parse_rbsp(&unescape(&nal[1..])).expect("parses");
        let fixed = with_restriction(&nal).expect("rewrites");
        let (sps, after) = parse_rbsp(&unescape(&fixed[1..])).expect("the rewrite parses");
        assert_eq!(
            after.restriction, before.restriction,
            "nvenc's mv lengths survive"
        );
        assert!(sps.declares_no_reordering());
        assert_eq!(sps.max_dec_frame_buffering, Some(4));
    }

    #[test]
    fn emulation_prevention_round_trips_and_leaves_no_start_code() {
        let rbsp = [0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0];
        let mut escaped = Vec::new();
        escape(&rbsp, &mut escaped);
        assert_eq!(unescape(&escaped), rbsp);
        for window in escaped.windows(3) {
            assert!(
                !(window[0] == 0 && window[1] == 0 && window[2] <= 2),
                "{escaped:?}"
            );
        }
        // a 03 not after two zeros is payload, not a prevention byte
        assert_eq!(
            unescape(&[0x01, 0x03, 0x00, 0x03]),
            vec![0x01, 0x03, 0x00, 0x03]
        );
    }

    #[test]
    fn exp_golomb_writes_the_spec_table() {
        // codes 1 / 010 / 011 / 00100 / 00101, the reader's table read back
        let mut w = BitWriter::default();
        for v in 0..5 {
            w.ue(v);
        }
        assert_eq!(w.bytes, vec![0b1010_0110, 0b0100_0010, 0b1000_0000]);
        let mut r = BitReader::new(&w.bytes);
        assert_eq!(
            (r.ue(), r.ue(), r.ue(), r.ue(), r.ue()),
            (Some(0), Some(1), Some(2), Some(3), Some(4))
        );
    }

    #[test]
    fn a_truncated_or_foreign_unit_is_none_not_a_panic() {
        assert_eq!(parse(&[]), None);
        assert_eq!(parse(&[0x67, 0x42]), None);
        assert_eq!(parse(&[0x65, 0x42, 0x00, 0x1f]), None);
        assert_eq!(with_restriction(&[0x67, 0x42]), None);
        assert_eq!(with_restriction(&[0x68, 0xce, 0x3c, 0x80]), None);
        let nal = main_without_vui();
        assert_eq!(parse(&nal[..nal.len() - 3]), None);
    }
}
