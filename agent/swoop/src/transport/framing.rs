//! The binary frame header and fragmentation. Task 2.10 fills it, against
//! agent/swoop/PROTOCOL.md and its golden vectors.
//!
//! A fixed 48-byte record, little-endian, all fields naturally aligned. Under
//! the G1 winner (arm B) it travels on `swoop-meta` as a header-only record and
//! exists so the browser can join a presented frame back to the host's
//! per-stage timestamps — that is the instrumentation contract behind the stats
//! overlay. The fragment fields and the payload are defined because the same
//! record prefixes an access unit on the deferred second video path.

use std::fmt;

/// The record is fixed length; the payload, where there is one, follows it.
pub const FRAME_HEADER_BYTES: usize = 48;
/// `kind` — any other value means drop the message.
pub const FRAME_RECORD_KIND: u8 = 0x01;
/// `headerVersion` — an unknown version is dropped, not guessed at.
pub const FRAME_HEADER_VERSION: u8 = 0x01;

/// `flags` bits. Bits 3–7 are reserved and sent zero.
pub mod flags {
    pub const IRAP: u8 = 1 << 0;
    pub const RESOLUTION_CHANGED: u8 = 1 << 1;
    pub const PARAMETER_SETS_IN_BAND: u8 = 1 << 2;
    pub const RESERVED: u8 = !(IRAP | RESOLUTION_CHANGED | PARAMETER_SETS_IN_BAND);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameCodec {
    H264,
    Hevc,
    Av1,
}

impl FrameCodec {
    const fn wire(self) -> u8 {
        match self {
            FrameCodec::H264 => 0,
            FrameCodec::Hevc => 1,
            FrameCodec::Av1 => 2,
        }
    }

    const fn from_wire(value: u8) -> Option<Self> {
        match value {
            0 => Some(FrameCodec::H264),
            1 => Some(FrameCodec::Hevc),
            2 => Some(FrameCodec::Av1),
            _ => None,
        }
    }
}

/// The three per-stage timestamps, microseconds since `streamerEpoch` — never
/// raw performance-counter ticks and never wall clock. The browser converts to
/// its own clock with the offset it measures on `swoop-feedback`, so no end has
/// to trust the other's.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FrameStamps {
    /// The compositor's present time for this desktop content.
    pub capture_us: u64,
    /// The encoder signalled completion and the bitstream was locked.
    pub encode_us: u64,
    /// Immediately before the frame was handed to the transport.
    pub send_us: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    pub codec: FrameCodec,
    pub flags: u8,
    pub fragment_index: u16,
    pub fragment_count: u16,
    /// Monotonic from 0 for the life of one track, no gaps, wraps at 2³².
    pub frame_id: u32,
    /// The rtp timestamp of the same picture on the video track — the join key.
    pub rtp_timestamp_90k: u32,
    pub width: u16,
    pub height: u16,
    /// Access-unit size; 0 for a header-only record.
    pub payload_bytes: u32,
    pub stamps: FrameStamps,
}

/// Why a record was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    Truncated,
    UnknownKind,
    UnknownHeaderVersion,
    UnknownCodec,
    /// A reserved flag bit was set — a later version's meaning we cannot guess.
    ReservedFlags,
    /// `fragmentCount` below 1, or an index outside it.
    BadFragmentation,
    /// A gap without IRAP, or anything before the first IRAP. Chrome hard-fails
    /// h.265 on a missing prior slice, and the failure is a black stream.
    DanglingReference,
}

impl FrameError {
    pub fn reason(self) -> &'static str {
        match self {
            FrameError::Truncated => "truncated",
            FrameError::UnknownKind => "unknown_kind",
            FrameError::UnknownHeaderVersion => "unknown_header_version",
            FrameError::UnknownCodec => "unknown_codec",
            FrameError::ReservedFlags => "reserved_flags",
            FrameError::BadFragmentation => "bad_fragmentation",
            FrameError::DanglingReference => "dangling_reference",
        }
    }
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.reason())
    }
}

impl std::error::Error for FrameError {}

impl FrameHeader {
    /// The G1 winner's record: header only on `swoop-meta`, joined to the RTP
    /// track by `rtpTimestamp90k`. Never fragmented, never carries a payload —
    /// the fragment fields exist for the deferred second video path.
    pub fn meta_record(
        codec: FrameCodec,
        frame_id: u32,
        rtp_timestamp_90k: u32,
        size: (u16, u16),
        stamps: FrameStamps,
    ) -> Self {
        Self {
            codec,
            flags: 0,
            fragment_index: 0,
            fragment_count: 1,
            frame_id,
            rtp_timestamp_90k,
            width: size.0,
            height: size.1,
            payload_bytes: 0,
            stamps,
        }
    }

    pub fn is_irap(&self) -> bool {
        self.flags & flags::IRAP != 0
    }

    pub fn resolution_changed(&self) -> bool {
        self.flags & flags::RESOLUTION_CHANGED != 0
    }

    pub fn parameter_sets_in_band(&self) -> bool {
        self.flags & flags::PARAMETER_SETS_IN_BAND != 0
    }

    pub fn encode(&self) -> [u8; FRAME_HEADER_BYTES] {
        let mut out = [0u8; FRAME_HEADER_BYTES];
        out[0] = FRAME_RECORD_KIND;
        out[1] = FRAME_HEADER_VERSION;
        out[2] = self.codec.wire();
        out[3] = self.flags;
        out[4..6].copy_from_slice(&self.fragment_index.to_le_bytes());
        out[6..8].copy_from_slice(&self.fragment_count.to_le_bytes());
        out[8..12].copy_from_slice(&self.frame_id.to_le_bytes());
        out[12..16].copy_from_slice(&self.rtp_timestamp_90k.to_le_bytes());
        out[16..18].copy_from_slice(&self.width.to_le_bytes());
        out[18..20].copy_from_slice(&self.height.to_le_bytes());
        out[20..24].copy_from_slice(&self.payload_bytes.to_le_bytes());
        out[24..32].copy_from_slice(&self.stamps.capture_us.to_le_bytes());
        out[32..40].copy_from_slice(&self.stamps.encode_us.to_le_bytes());
        out[40..48].copy_from_slice(&self.stamps.send_us.to_le_bytes());
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, FrameError> {
        let head: &[u8; FRAME_HEADER_BYTES] = bytes
            .get(..FRAME_HEADER_BYTES)
            .and_then(|slice| slice.try_into().ok())
            .ok_or(FrameError::Truncated)?;
        if head[0] != FRAME_RECORD_KIND {
            return Err(FrameError::UnknownKind);
        }
        if head[1] != FRAME_HEADER_VERSION {
            return Err(FrameError::UnknownHeaderVersion);
        }
        let codec = FrameCodec::from_wire(head[2]).ok_or(FrameError::UnknownCodec)?;
        if head[3] & flags::RESERVED != 0 {
            return Err(FrameError::ReservedFlags);
        }
        let fragment_index = u16::from_le_bytes([head[4], head[5]]);
        let fragment_count = u16::from_le_bytes([head[6], head[7]]);
        if fragment_count == 0 || fragment_index >= fragment_count {
            return Err(FrameError::BadFragmentation);
        }
        Ok(Self {
            codec,
            flags: head[3],
            fragment_index,
            fragment_count,
            frame_id: u32::from_le_bytes(head[8..12].try_into().expect("4 bytes")),
            rtp_timestamp_90k: u32::from_le_bytes(head[12..16].try_into().expect("4 bytes")),
            width: u16::from_le_bytes([head[16], head[17]]),
            height: u16::from_le_bytes([head[18], head[19]]),
            payload_bytes: u32::from_le_bytes(head[20..24].try_into().expect("4 bytes")),
            stamps: FrameStamps {
                capture_us: u64::from_le_bytes(head[24..32].try_into().expect("8 bytes")),
                encode_us: u64::from_le_bytes(head[32..40].try_into().expect("8 bytes")),
                send_us: u64::from_le_bytes(head[40..48].try_into().expect("8 bytes")),
            },
        })
    }
}

/// Sender side of "never a chunk with a dangling reference": a record whose
/// `frameId` is not `previousFrameId + 1` gets IRAP set, because a gap without
/// it *is* the dangling reference.
#[derive(Debug, Default, Clone, Copy)]
pub struct FrameSequencer {
    last: Option<u32>,
}

impl FrameSequencer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Stamp one record before it goes out. Under arm B the header-only record
    /// is all that is sent, so this is the only place the invariant can be
    /// enforced.
    pub fn prepare(&mut self, header: &mut FrameHeader) {
        let continuous = self
            .last
            .is_some_and(|last| header.frame_id == last.wrapping_add(1));
        if !continuous || header.resolution_changed() {
            header.flags |= flags::IRAP;
        }
        // vps/sps/pps go in band with every irap, so the flag is not optional.
        if header.is_irap() {
            header.flags |= flags::PARAMETER_SETS_IN_BAND;
        }
        self.last = Some(header.frame_id);
    }
}

/// Receiver side. A receiver that sees a gap, a decoder error or a resolution
/// change drops everything until the next IRAP and asks for an idr — it never
/// reorders, interpolates, or submits the gap-crossing chunk to see if it
/// decodes.
#[derive(Debug, Default, Clone, Copy)]
pub struct ReceiverState {
    pub last_frame_id: Option<u32>,
    /// Whether a recovery point has been seen on this track at all.
    pub have_irap: bool,
}

impl ReceiverState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Admit one record, or say why the decoder must not see it.
    pub fn admit(&mut self, header: &FrameHeader) -> Result<(), FrameError> {
        if !header.is_irap() {
            // `== last` is a later fragment of the frame already in flight; the
            // frame id only advances between frames, not between fragments.
            let continuous = self.last_frame_id.is_some_and(|last| {
                header.frame_id == last.wrapping_add(1) || header.frame_id == last
            });
            // a resolution change is always a new idr plus a decoder
            // reconfigure; chromium rejects a non-irap h.265 config change
            // outright, so one without IRAP is as unusable as a gap.
            if !self.have_irap || !continuous || header.resolution_changed() {
                return Err(FrameError::DanglingReference);
            }
        }
        self.last_frame_id = Some(header.frame_id);
        self.have_irap = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> FrameHeader {
        FrameHeader::meta_record(
            FrameCodec::Hevc,
            41,
            123_456_789,
            (1920, 1080),
            FrameStamps { capture_us: 1_000_000, encode_us: 1_004_120, send_us: 1_004_480 },
        )
    }

    #[test]
    fn a_record_round_trips_through_its_48_bytes() {
        let original = header();
        let decoded = FrameHeader::decode(&original.encode()).expect("it decodes");
        assert_eq!(decoded, original);
    }

    #[test]
    fn an_unknown_kind_or_version_is_dropped_not_guessed_at() {
        let mut bytes = header().encode();
        bytes[0] = 0x02;
        assert_eq!(FrameHeader::decode(&bytes), Err(FrameError::UnknownKind));
        let mut bytes = header().encode();
        bytes[1] = 0x02;
        assert_eq!(
            FrameHeader::decode(&bytes),
            Err(FrameError::UnknownHeaderVersion)
        );
        assert_eq!(FrameHeader::decode(&[0u8; 12]), Err(FrameError::Truncated));
    }

    #[test]
    fn reserved_flag_bits_and_impossible_fragmentation_are_refused() {
        let mut bytes = header().encode();
        bytes[3] = flags::RESERVED;
        assert_eq!(FrameHeader::decode(&bytes), Err(FrameError::ReservedFlags));
        let mut bytes = header().encode();
        bytes[6..8].copy_from_slice(&0u16.to_le_bytes());
        assert_eq!(
            FrameHeader::decode(&bytes),
            Err(FrameError::BadFragmentation)
        );
    }

    #[test]
    fn the_sequencer_never_produces_a_gap_without_irap() {
        let mut sequencer = FrameSequencer::new();
        let mut first = header();
        sequencer.prepare(&mut first);
        assert!(first.is_irap(), "the first record on a track is a recovery point");
        assert!(first.parameter_sets_in_band());

        let mut next = FrameHeader { frame_id: 42, ..header() };
        sequencer.prepare(&mut next);
        assert!(!next.is_irap(), "a continuous record needs no recovery point");

        let mut gapped = FrameHeader { frame_id: 45, ..header() };
        sequencer.prepare(&mut gapped);
        assert!(gapped.is_irap(), "a gap is always closed by an irap");
    }

    #[test]
    fn the_receiver_drops_everything_before_its_first_irap() {
        let mut state = ReceiverState::new();
        let delta = FrameHeader { frame_id: 1, ..header() };
        assert_eq!(state.admit(&delta), Err(FrameError::DanglingReference));

        let irap = FrameHeader { flags: flags::IRAP, ..header() };
        assert_eq!(state.admit(&irap), Ok(()));
    }

    #[test]
    fn a_later_fragment_of_the_frame_in_flight_is_not_a_gap() {
        let mut state = ReceiverState { last_frame_id: Some(41), have_irap: true };
        let fragment = FrameHeader { frame_id: 41, fragment_index: 1, fragment_count: 3, ..header() };
        assert_eq!(state.admit(&fragment), Ok(()));
    }
}
