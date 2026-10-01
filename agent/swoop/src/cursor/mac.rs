//! macOS: the pointer for the cursor overlay (decision 7).
//!
//! ScreenCaptureKit leaves the pointer out of the picture, so the viewer draws
//! it from `cpos` / `cshape` as it does for Desktop Duplication, and
//! [`CursorSampler`] is what the capture source asks on every step.
//!
//! **Position.** The location of a `CGEventCreate(NULL)` event is where the
//! pointer is, in global points. On the captured display it becomes a pixel of
//! that display (decision 13: `desktop_rect` is pixels), counted from its
//! top-left pixel as the session's normalisation expects, and it is visible
//! whenever it is there. On any other display the last pixel it had here is
//! reported invisible, so the overlay hides without sliding along an edge.
//!
//! **Not `CGCursorIsVisible()`.** macOS hides the pointer while someone types
//! until the mouse moves, and only a physical mouse clears that: measured on
//! the rig on 2026-09-30 with the pointer hidden by typing, moves posted at the
//! HID and session taps (with and without their deltas),
//! `CGWarpMouseCursorPosition` and `CGPostMouseEvent` all left it hidden. A
//! viewer that typed would lose the pointer for the rest of the session while
//! its moves and clicks still landed, so the viewer draws it as other remote
//! tools do. The person at the Mac sees it again once they touch their mouse. The display's two rects are read again with every shape read,
//! since a mode change moves its pixels under the same id.
//!
//! **Shape.** At most every 33 ms, `NSCursor.currentSystemCursor`'s image is
//! drawn at the display's scale into a 32-bit BGRA bitmap, with the hot spot
//! in the same pixels. CoreGraphics draws only into premultiplied bitmaps, so
//! the alpha is made straight before the bytes leave: that is the `Color`
//! shape [`super::CursorTracker::on_shape`] and [`super::decode`] already take
//! from Desktop Duplication. The call answers a new object every time, so the
//! bytes are hashed and only a changed hash is handed on.
//!
//! **When there is no shape.** Whether the call answers in a child that is not
//! an AppKit app, off the main thread, was the open question;
//! [`CursorSampler::shapes_available`] is the answer for this process, read
//! once at construction. When it is false the capture draws the pointer into
//! the picture and every position here is reported invisible, so the viewer
//! draws nothing of its own. Apple has deprecated the property ("will always
//! be nil in a future version of macOS"); a macOS that makes it so lands in
//! the same fallback.
//!
//! Measured on the rig (macOS 26.6, a 2x panel), from a test thread of a
//! process started over ssh, with the screen locked: the call answers the
//! arrow, 28x40 points with representations at 1x, 2x, 5x and 10x, drawn here
//! at 56x80 pixels with the hot spot at (10, 10). In a release build a shape
//! read costs 0.14 ms at p50 (0.3 ms at p95), 0.12 ms of it the call itself; a
//! sample without one costs 15 µs at p50 even in a debug build.
//!
//! Hardware test, with the working directory `agent/swoop`:
//!
//! ```text
//! CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --locked --no-default-features \
//!     --features encode-videotoolbox,audio-opus -- --ignored --nocapture cursor
//! ```
//!
//! It reads the pointer on the main display for 20 s (`SWOOP_CURSOR_SECS`
//! changes that) while a human moves it, and prints `shapes_available`, each
//! shape change as a size, hot spot and hash, and the counts. Nothing is
//! saved. With `SWOOP_CURSOR_SWEEP=1` it instead **moves the real pointer**
//! over the main display in a serpentine (rows inset from every edge, so no
//! hot corner), which needs Accessibility for whatever started it, and puts
//! the pointer back at the end.

use std::hash::{DefaultHasher, Hash, Hasher};

use super::ShapeInfo;
use crate::capture::Rect;

#[cfg(target_os = "macos")]
pub use appkit::CursorSampler;

/// How often the shape is read, in `platform::clock` ticks, which on macOS are
/// nanoseconds (decision 14): about once a frame at 30 fps. The capture calls
/// the sampler on every step, so this is what keeps a step cheap when nothing
/// changed.
const SHAPE_PERIOD_TICKS: i64 = 33_000_000;

/// A global point as a pixel of the display whose pixel rect is `pixels` and
/// whose point rect (`CGDisplayBounds`: x, y, width, height) is `points`,
/// counted from the display's top-left pixel. `None` off that display.
///
/// The inverse of the injector's pixel-to-point step in `input::mac`, floored
/// rather than rounded: a pixel is the cell a point falls in, so the point
/// half a point inside the far edge, which the injector aims at for the last
/// pixel, comes back as the last pixel and not one past it.
fn local_pixel(at: (f64, f64), pixels: &Rect, points: (f64, f64, f64, f64)) -> Option<(i32, i32)> {
    let (x, y, width, height) = points;
    let on = (x..x + width).contains(&at.0) && (y..y + height).contains(&at.1);
    if !on || pixels.width() <= 0 || pixels.height() <= 0 {
        return None;
    }
    let axis = |v: f64, origin: f64, span: f64, size: i32| {
        (((v - origin) * f64::from(size) / span).floor() as i32).clamp(0, size - 1)
    };
    Some((
        axis(at.0, x, width, pixels.width()),
        axis(at.1, y, height, pixels.height()),
    ))
}

/// Premultiplied BGRA to straight, in place, rounding to nearest. A pixel with
/// no coverage keeps no colour either, so a shape's hash never depends on what
/// a transparent pixel happened to hold.
fn unpremultiply(bgra: &mut [u8]) {
    for pixel in bgra.as_chunks_mut::<4>().0 {
        let alpha = u16::from(pixel[3]);
        match alpha {
            0 => pixel[..3].fill(0),
            255 => {}
            _ => {
                for channel in &mut pixel[..3] {
                    *channel = ((u16::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
                }
            }
        }
    }
}

/// A shape's identity: its geometry and every byte of it.
fn shape_hash(info: &ShapeInfo, bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    (info.width, info.height, info.pitch, info.hot_x, info.hot_y).hash(&mut hasher);
    bytes.hash(&mut hasher);
    hasher.finish()
}

/// When the shape is next read, and which shape was last handed on.
struct ShapeGate {
    next_read: i64,
    last: Option<u64>,
}

impl ShapeGate {
    fn new() -> Self {
        Self {
            next_read: i64::MIN,
            last: None,
        }
    }

    /// True at most once every [`SHAPE_PERIOD_TICKS`], and on the first call.
    fn due(&mut self, now: i64) -> bool {
        if now < self.next_read {
            return false;
        }
        self.next_read = now.saturating_add(SHAPE_PERIOD_TICKS);
        true
    }

    /// True when `hash` is not the shape last handed on, which it becomes. A
    /// return to an earlier shape is news: the tracker answers it with an id.
    fn changed(&mut self, hash: u64) -> bool {
        let changed = self.last != Some(hash);
        self.last = Some(hash);
        changed
    }
}

#[cfg(target_os = "macos")]
mod appkit {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::{NSCursor, NSGraphicsContext};
    use objc2_core_foundation::{CGPoint, CGRect};
    use objc2_core_graphics::{
        kCGColorSpaceSRGB, CGBitmapContextCreate, CGColorSpace, CGContext, CGEvent,
        CGImageAlphaInfo, CGImageByteOrderInfo,
    };

    use super::{local_pixel, shape_hash, unpremultiply, ShapeGate};
    use crate::capture::{OutputInfo, Rect};
    use crate::cursor::{
        PointerPosition, PointerSample, PointerSampler, ShapeInfo, ShapeKind, MAX_SHAPE_DIM,
    };
    use crate::platform::clock;
    use crate::platform::macos::{display_for_pixel_rect, display_pixel_rect, display_point_rect};

    /// The pointer over one captured display.
    pub struct CursorSampler {
        /// `None` when no attached display had the output's pixel rect; every
        /// position is then off the display, so invisible.
        display: Option<u32>,
        pixels: Rect,
        /// `CGDisplayBounds`: x, y, width, height in global points.
        points: (f64, f64, f64, f64),
        shapes: bool,
        gate: ShapeGate,
        /// The pixel the pointer last had on this display, reported invisible
        /// while it is on another.
        last: (i32, i32),
        bitmap: Vec<u8>,
    }

    impl CursorSampler {
        /// A sampler for the display `output` is, which reads the system
        /// cursor once to learn whether shapes are available at all.
        pub fn new(output: &OutputInfo) -> Self {
            let display = display_for_pixel_rect(&output.desktop_rect);
            if display.is_none() {
                ::log::warn!(
                    "swoop: no attached display has the pixel rect {:?}, so the pointer is reported hidden",
                    output.desktop_rect
                );
            }
            let points = display.map_or((0.0, 0.0, 0.0, 0.0), display_point_rect);
            let mut bitmap = Vec::new();
            let shapes = read_shape(scale(&output.desktop_rect, points), &mut bitmap).is_some();
            if shapes {
                ::log::info!("swoop: the pointer is drawn by the viewer from the system cursor");
            } else {
                ::log::warn!(
                    "swoop: the system cursor has no image for this process, so the pointer stays in the picture"
                );
            }
            Self {
                display,
                pixels: output.desktop_rect,
                points,
                shapes,
                gate: ShapeGate::new(),
                last: (0, 0),
                bitmap,
            }
        }

        /// Whether the system cursor's image could be read when this sampler
        /// was made. When false, the capture must draw the pointer into the
        /// picture (`cursor_in_frame`), and every position this sampler
        /// reports is invisible.
        pub fn shapes_available(&self) -> bool {
            self.shapes
        }

        fn position(&mut self) -> Option<PointerPosition> {
            let event = CGEvent::new(None)?;
            let at = CGEvent::location(Some(&*event));
            Some(match local_pixel((at.x, at.y), &self.pixels, self.points) {
                Some((x, y)) => {
                    self.last = (x, y);
                    PointerPosition {
                        x,
                        y,
                        visible: self.shapes,
                    }
                }
                None => PointerPosition {
                    x: self.last.0,
                    y: self.last.1,
                    visible: false,
                },
            })
        }

        fn shape(&mut self) -> Option<(ShapeInfo, &[u8])> {
            let info = read_shape(scale(&self.pixels, self.points), &mut self.bitmap)?;
            let bytes = &self.bitmap[..];
            self.gate
                .changed(shape_hash(&info, bytes))
                .then_some((info, bytes))
        }
    }

    impl PointerSampler for CursorSampler {
        fn sample(&mut self) -> PointerSample<'_> {
            let now = clock::now_ticks();
            let due = self.gate.due(now);
            if due {
                if let Some(id) = self.display {
                    self.pixels = display_pixel_rect(id);
                    self.points = display_point_rect(id);
                }
            }
            let position = self.position();
            let shape = if due && self.shapes {
                self.shape()
            } else {
                None
            };
            PointerSample {
                position,
                ts_ticks: now,
                shape,
            }
        }
    }

    /// Pixels per point, from the display's two rects; 1 for a display that
    /// has gone.
    fn scale(pixels: &Rect, points: (f64, f64, f64, f64)) -> f64 {
        if points.2 > 0.0 && pixels.width() > 0 {
            f64::from(pixels.width()) / points.2
        } else {
            1.0
        }
    }

    /// Draw the system cursor at `scale` into `out` as straight BGRA, and
    /// describe it. `None` when the system answers no cursor, or an image
    /// with no size or larger than any real cursor.
    fn read_shape(scale: f64, out: &mut Vec<u8>) -> Option<ShapeInfo> {
        // AppKit answers autoreleased objects, and the capture thread has no
        // pool of its own that would ever drain them.
        autoreleasepool(|_| {
            // The one call that names another app's cursor; see the module doc.
            #[allow(deprecated)]
            let cursor = NSCursor::currentSystemCursor()?;
            let image = cursor.image();
            let size = image.size();
            let hot = cursor.hotSpot();
            let (width, height) = ((size.width * scale).ceil(), (size.height * scale).ceil());
            let limit = 1.0..=f64::from(MAX_SHAPE_DIM);
            if !limit.contains(&width) || !limit.contains(&height) {
                return None;
            }
            let (width, height) = (width as u32, height as u32);
            let pitch = width * 4;
            out.clear();
            out.resize(pitch as usize * height as usize, 0);
            // SAFETY: a constant the framework exports.
            let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))?;
            // 32-bit little-endian with alpha first is B, G, R, A in memory:
            // Desktop Duplication's order, and a layout CoreGraphics draws into.
            let layout =
                CGImageAlphaInfo::PremultipliedFirst.0 | CGImageByteOrderInfo::Order32Little.0;
            // SAFETY: `out` holds `pitch * height` bytes and is neither moved
            // nor read while the context draws; the pool that may hold the
            // context drains before this function returns.
            let context = unsafe {
                CGBitmapContextCreate(
                    out.as_mut_ptr().cast(),
                    width as usize,
                    height as usize,
                    8,
                    pitch as usize,
                    Some(&*space),
                    layout,
                )
            }?;
            // Drawn in points on a pixel grid, so the image draws the
            // representation it has for this scale.
            CGContext::scale_ctm(Some(&*context), scale, scale);
            let graphics = NSGraphicsContext::graphicsContextWithCGContext_flipped(&context, false);
            NSGraphicsContext::saveGraphicsState_class();
            NSGraphicsContext::setCurrentContext(Some(&*graphics));
            image.drawInRect(CGRect::new(CGPoint::ZERO, size));
            NSGraphicsContext::restoreGraphicsState_class();
            drop(graphics);
            drop(context);
            unpremultiply(out);
            // The hot spot is in the image's points, from its top-left corner.
            let to_pixel = |v: f64, size: u32| ((v * scale).round().max(0.0) as u32).min(size - 1);
            Some(ShapeInfo {
                kind: ShapeKind::Color,
                width,
                height,
                pitch,
                hot_x: to_pixel(hot.x, width),
                hot_y: to_pixel(hot.y, height),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor::{decode, ShapeKind};

    /// The injector's own layout (`input::mac`): 1440x900 points at (-1440,
    /// -200) left of and above the main display, so 2880x1800 pixels from
    /// twice that origin (decision 13).
    const PIXELS: Rect = Rect {
        left: -2880,
        top: -400,
        right: 0,
        bottom: 1400,
    };
    const POINTS: (f64, f64, f64, f64) = (-1440.0, -200.0, 1440.0, 900.0);

    #[test]
    fn a_point_becomes_a_pixel_on_a_2x_display_at_a_negative_origin() {
        let at = |x, y| local_pixel((x, y), &PIXELS, POINTS);
        assert_eq!(at(-1440.0, -200.0), Some((0, 0)));
        // The points the injector aims at for the last pixel and for the
        // middle come back as that pixel.
        assert_eq!(at(-0.5, 699.5), Some((2879, 1799)));
        assert_eq!(at(-720.0, 250.0), Some((1440, 900)));
        // A real pointer sits between points: a pixel is the cell it is in.
        assert_eq!(at(-1439.75, -199.25), Some((0, 1)));
        assert_eq!(at(-0.01, 699.99), Some((2879, 1799)));

        // The main display's origin, and just past each edge, are elsewhere.
        assert_eq!(at(0.0, 0.0), None);
        assert_eq!(at(-1440.01, 0.0), None);
        assert_eq!(at(-100.0, 700.0), None);
        assert_eq!(at(-100.0, -200.5), None);

        // A display that has gone reads back empty rects.
        let gone = Rect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        assert_eq!(local_pixel((0.0, 0.0), &gone, (0.0, 0.0, 0.0, 0.0)), None);
        assert_eq!(local_pixel((-720.0, 250.0), &gone, POINTS), None);
    }

    #[test]
    fn a_premultiplied_bitmap_is_made_straight_and_decodes_as_a_colour_shape() {
        // B, G, R, A, premultiplied, as CoreGraphics draws: half-covered red,
        // opaque blue, quarter-covered white, and a transparent pixel with
        // colour left in it.
        let mut bgra = vec![
            0, 0, 128, 128, //
            255, 0, 0, 255, //
            64, 64, 64, 64, //
            9, 9, 9, 0,
        ];
        unpremultiply(&mut bgra);
        assert_eq!(
            bgra,
            [
                0, 0, 255, 128, //
                255, 0, 0, 255, //
                255, 255, 255, 64, //
                0, 0, 0, 0,
            ]
        );

        let info = ShapeInfo {
            kind: ShapeKind::Color,
            width: 2,
            height: 2,
            pitch: 8,
            hot_x: 1,
            hot_y: 0,
        };
        let image = decode(&info, &bgra).expect("the tracker takes a straight colour shape");
        assert_eq!(
            image.rgba,
            [
                255, 0, 0, 128, //
                0, 0, 255, 255, //
                255, 255, 255, 64, //
                0, 0, 0, 0,
            ]
        );
        assert_eq!((image.hot_x, image.hot_y), (1, 0));

        // A channel above its alpha is not valid premultiplied data; it
        // saturates rather than wrapping.
        let mut bad = vec![200, 0, 0, 100];
        unpremultiply(&mut bad);
        assert_eq!(bad, [255, 0, 0, 100]);
    }

    #[test]
    fn the_shape_is_read_every_33_ms_and_handed_on_only_when_its_bytes_change() {
        let mut gate = ShapeGate::new();
        let t0 = 5_000_000_000;
        assert!(gate.due(t0), "the first sample reads the shape");
        assert!(!gate.due(t0 + 1));
        assert!(!gate.due(t0 + 32_999_999));
        assert!(gate.due(t0 + 33_000_000));
        assert!(!gate.due(t0 + 40_000_000));
        // A late sample restarts the period from itself.
        assert!(gate.due(t0 + 100_000_000));
        assert!(!gate.due(t0 + 132_000_000));

        let arrow = ShapeInfo {
            kind: ShapeKind::Color,
            width: 2,
            height: 1,
            pitch: 8,
            hot_x: 0,
            hot_y: 0,
        };
        // Every read answers new bytes in a new buffer; the same picture is
        // no news.
        let first = vec![1u8, 2, 3, 255, 4, 5, 6, 255];
        let again = first.clone();
        assert!(gate.changed(shape_hash(&arrow, &first)));
        assert!(!gate.changed(shape_hash(&arrow, &again)));

        let mut beam = first.clone();
        beam[4] = 7;
        assert!(gate.changed(shape_hash(&arrow, &beam)));
        assert!(!gate.changed(shape_hash(&arrow, &beam)));
        // Back to the first picture: news, which the tracker makes an id.
        assert!(gate.changed(shape_hash(&arrow, &first)));
        // The same bytes with the hot spot moved are another shape.
        let moved = ShapeInfo { hot_x: 1, ..arrow };
        assert!(gate.changed(shape_hash(&moved, &first)));
    }

    /// See the module doc for the invocation and what it does to the machine.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "reads the system cursor for 20 s; SWOOP_CURSOR_SWEEP=1 MOVES THE REAL POINTER; cargo test -- --ignored --nocapture cursor"]
    fn live_system_cursor_positions_and_shapes() {
        use std::time::{Duration, Instant};

        use objc2_app_kit::NSCursor;
        use objc2_core_foundation::CGPoint;
        use objc2_core_graphics::{
            CGEvent, CGEventTapLocation, CGEventType, CGMainDisplayID, CGMouseButton,
            CGPreflightPostEventAccess,
        };

        use crate::cursor::{CursorTracker, OutputGeometry, PointerSampler};
        use crate::platform::macos::{display_for_pixel_rect, display_point_rect};
        use crate::signal::messages::channel::Cursor;

        fn post_move(at: CGPoint) {
            let event =
                CGEvent::new_mouse_event(None, CGEventType::MouseMoved, at, CGMouseButton::Left)
                    .expect("a move event");
            CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&*event));
        }

        /// Rows across the display, alternating direction, each point inset
        /// from every edge so the sweep never rests in a hot corner.
        fn serpentine((x, y, width, height): (f64, f64, f64, f64)) -> Vec<CGPoint> {
            const ROWS: usize = 16;
            const COLUMNS: usize = 48;
            (0..ROWS)
                .flat_map(|row| {
                    let py = y + height * (row as f64 + 0.5) / ROWS as f64;
                    (0..COLUMNS).map(move |column| {
                        let column = if row % 2 == 0 {
                            column
                        } else {
                            COLUMNS - 1 - column
                        };
                        CGPoint::new(x + width * (column as f64 + 0.5) / COLUMNS as f64, py)
                    })
                })
                .collect()
        }

        let main = CGMainDisplayID();
        let outputs = crate::displays::mac::outputs().expect("the displays");
        let output = outputs
            .iter()
            .find(|o| display_for_pixel_rect(&o.desktop_rect) == Some(main))
            .expect("the main display is active: an asleep one is not listed (caffeinate -u -t 2 wakes it)");
        let mut sampler = CursorSampler::new(output);
        println!("{} pixels {:?}", output.device_name, output.desktop_rect);
        println!("shapes_available={}", sampler.shapes_available());
        #[allow(deprecated)]
        let system = NSCursor::currentSystemCursor();
        if let Some(cursor) = system {
            let image = cursor.image();
            let reps: Vec<String> = image
                .representations()
                .iter()
                .map(|rep| format!("{}x{}", rep.pixelsWide(), rep.pixelsHigh()))
                .collect();
            let (size, hot) = (image.size(), cursor.hotSpot());
            println!(
                "system cursor: {}x{} points, hot spot ({}, {}), representations {reps:?}",
                size.width, size.height, hot.x, hot.y
            );
        }

        let sweep = std::env::var("SWOOP_CURSOR_SWEEP").is_ok_and(|v| v == "1");
        let path = if sweep {
            assert!(
                CGPreflightPostEventAccess(),
                "this process may not post events: grant accessibility to whatever started it"
            );
            serpentine(display_point_rect(main))
        } else {
            Vec::new()
        };
        let watch = Duration::from_secs(
            std::env::var("SWOOP_CURSOR_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(20),
        );
        let before = CGEvent::new(None).map(|event| CGEvent::location(Some(&*event)));

        // What the session does with a sample: a `cpos` for each new
        // position, over the texture the capture opens at the pixel rect.
        let rect = output.desktop_rect;
        let geometry =
            OutputGeometry::for_output(output, (rect.width() as u32, rect.height() as u32));
        let mut tracker = CursorTracker::new();
        let (mut samples, mut shown, mut hidden, mut cpos, mut changes) = (0u32, 0, 0, 0, 0u32);
        let mut costs = Vec::new();
        let mut steps = path.iter();
        let started = Instant::now();
        loop {
            if sweep {
                let Some(&at) = steps.next() else { break };
                post_move(at);
                std::thread::sleep(Duration::from_millis(8));
            } else if started.elapsed() >= watch {
                break;
            } else {
                std::thread::sleep(Duration::from_millis(4));
            }
            let call = Instant::now();
            let sample = sampler.sample();
            costs.push(call.elapsed());
            samples += 1;
            if let Some(at) = sample.position {
                if at.visible {
                    shown += 1;
                } else {
                    hidden += 1;
                }
                cpos += u32::from(tracker.on_position(at, &geometry, 0).is_some());
            }
            let Some((info, bytes)) = sample.shape else {
                continue;
            };
            changes += 1;
            let hash = shape_hash(&info, bytes);
            let alpha = bytes[(info.hot_y * info.pitch + info.hot_x * 4 + 3) as usize];
            let told = match tracker
                .on_shape(&info, bytes)
                .expect("decode takes the shape")
            {
                Some(Cursor::Cshape {
                    id, png: Some(_), ..
                }) => format!("new, id {id}"),
                Some(Cursor::Cshape { id, .. }) => format!("cached, id {id}"),
                _ => "the shape already drawn".to_owned(),
            };
            println!(
                "{:>6} ms: {}x{} hot spot ({}, {}), {} bytes, hash {hash:016x}, alpha at the hot spot {alpha}: {told}",
                started.elapsed().as_millis(),
                info.width,
                info.height,
                info.hot_x,
                info.hot_y,
                bytes.len()
            );
        }
        if let (true, Some(at)) = (sweep, before) {
            post_move(at);
        }
        costs.sort_unstable();
        println!(
            "samples={samples} visible={shown} invisible={hidden} cpos={cpos} shape_changes={changes} distinct={}",
            tracker.cached_shapes()
        );
        println!(
            "sample() took p50 {:?}, p95 {:?}, max {:?}",
            costs[costs.len() / 2],
            costs[costs.len() * 95 / 100],
            costs[costs.len() - 1]
        );

        if !sampler.shapes_available() {
            assert_eq!(shown, 0, "without shapes every position is invisible");
            assert_eq!(changes, 0, "without shapes nothing is read");
            return;
        }
        assert!(changes > 0, "the first read is always news");
        assert!(tracker.cached_shapes() <= changes as usize);
        assert!(
            (tracker.cached_shapes() as u32) < samples,
            "fewer distinct shapes than samples"
        );
    }
}
