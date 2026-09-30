//! Input injection on macOS, through CoreGraphics events.
//!
//! The session hands the injector what it has already resolved (the parent
//! module): set-1 scancodes with the extended flag, `KeyVirtual` for Pause,
//! moves normalised over the captured display, buttons, and the wheel in
//! `WHEEL_DELTA` units. It never sees a browser `code`. A CGEvent wants a
//! virtual keycode instead, so `testdata/keymap-macos.json` maps each `code` to
//! its `kVK_*` and `key_table` joins that with `keymap.json` into one table
//! from (scancode, extended) to keycode. The host's layout decides what a
//! keycode types, the same contract as a scancode on Windows.
//!
//! A synthesised event does less for itself than a device's, and each gap is
//! this module's to close:
//!
//! - its modifier flags are whatever the HID system holds when it is made.
//!   Measured on the rig, that includes a modifier this injector posted, but
//!   it also includes anything else holding one, so every event carries
//!   exactly the modifiers this injector has pressed and not released: what
//!   the viewer is holding;
//! - a move with a button down is a drag only when it is posted as that
//!   button's dragged type;
//! - a double click is a click count, carried by the second press and by its
//!   release, which this module counts: 500 ms and 4 points from the last
//!   press of the same button.
//!
//! **Pixels and points** (decision 13): `PointerSpace.rect` is pixels and a
//! CGEvent's location is global points, so an absolute move goes to a pixel
//! through [`super::PointerSpace::to_desktop`], as on Windows, and on to a
//! point through the display's own point rect. A relative move is kept on
//! that display too, since nothing else keeps it there.
//!
//! **Accessibility.** Without it `CGEventPost` drops every event and says
//! nothing. The grant is read once, when the injector is made: the streamer is
//! a fresh process per session, so that is the session's answer. Without it
//! one line says so, and every event after is dropped and counted.
//!
//! Hardware tests are `#[ignore]`d. With the working directory `agent/swoop`
//! and the macOS feature flags:
//!
//! ```text
//! cargo test --no-default-features --features encode-videotoolbox,audio-opus -- --ignored --nocapture each_corner
//! ```
//!
//! **moves the real pointer** to each corner of the main display (a corner may
//! be a hot corner: on the rig the bottom-right one opens Quick Note's peek),
//! presses and releases shift alone, and puts the pointer back. It needs
//! Accessibility for whatever started it.
//!
//! ```text
//! SWOOP_INPUT_HUMAN=1 cargo test --no-default-features --features encode-videotoolbox,audio-opus -- --ignored --nocapture a_human
//! ```
//!
//! **types into whatever is focused**, then double clicks, presses cmd+a,
//! drags and scrolls, with a printed instruction and a pause before each. Run
//! it only with a text field focused and a human watching: the human confirms
//! what no check here can see. Without the variable it fails before it posts
//! anything, so `--ignored input` alone never types into a window.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use serde::Deserialize;

use super::{keymap, InputEvent};

#[cfg(target_os = "macos")]
pub use cg::CgInjector;

/// `testdata/keymap-macos.json`, compiled in beside `keymap.json`.
const KEYMAP_MACOS_JSON: &str = include_str!("../../testdata/keymap-macos.json");

#[derive(Debug, Deserialize)]
struct MacKeymapFile {
    codes: BTreeMap<String, MacKey>,
}

#[derive(Debug, Deserialize)]
struct MacKey {
    keycode: u16,
}

/// (scancode, extended) to virtual keycode: the two keymaps joined by `code`.
#[derive(Debug)]
struct KeyTable(HashMap<(u16, bool), u16>);

impl KeyTable {
    fn keycode(&self, scancode: u16, extended: bool) -> Option<u16> {
        self.0.get(&(scancode, extended)).copied()
    }
}

/// The one joined copy.
///
/// Joined through [`super::Keymap::press`], the call the session turns a
/// `code` into a scancode with, so the table is keyed on exactly what arrives.
/// Both files are compiled in and the join is covered by a unit test, so a
/// failure here is a build that never shipped, not a machine in the field.
fn key_table() -> &'static KeyTable {
    static TABLE: OnceLock<KeyTable> = OnceLock::new();
    TABLE.get_or_init(|| {
        let file: MacKeymapFile =
            serde_json::from_str(KEYMAP_MACOS_JSON).expect("keymap-macos.json is compiled in");
        let mut table = HashMap::with_capacity(file.codes.len());
        for (code, key) in file.codes {
            let events = keymap().press(&code, true);
            let [InputEvent::Key {
                scancode, extended, ..
            }] = events[..]
            else {
                panic!("{code} has no single scancode in keymap.json");
            };
            let previous = table.insert((scancode, extended), key.keycode);
            assert!(
                previous.is_none(),
                "{code} shares its scancode with another code"
            );
        }
        KeyTable(table)
    })
}

#[cfg(target_os = "macos")]
mod cg {
    use std::time::{Duration, Instant};

    use anyhow::Context;
    use objc2_core_foundation::{CFRetained, CGPoint};
    use objc2_core_graphics::{
        CGEvent, CGEventField, CGEventFlags, CGEventSource, CGEventSourceStateID,
        CGEventTapLocation, CGEventType, CGMouseButton, CGPreflightPostEventAccess,
        CGScrollEventUnit,
    };

    use super::{key_table, KeyTable};
    use crate::capture::Rect;
    use crate::input::{Accum, Injector, InputEvent, PointerSpace, LINES_PER_NOTCH, WHEEL_DELTA};
    use crate::platform::macos::{display_for_pixel_rect, display_point_rect};

    /// How soon, and how near, a press must follow the last press of the same
    /// button to raise its click count.
    const MULTI_CLICK_TIME: Duration = Duration::from_millis(500);
    const MULTI_CLICK_POINTS: f64 = 4.0;

    /// The modifier keys by `kVK_*`, and the flag each one holds. Left and
    /// right are separate keys holding the same flag, so releasing one leaves
    /// the flag set while the other is still down.
    const MODIFIERS: [(u16, CGEventFlags); 8] = [
        (0x38, CGEventFlags::MaskShift),     // kVK_Shift
        (0x3C, CGEventFlags::MaskShift),     // kVK_RightShift
        (0x3B, CGEventFlags::MaskControl),   // kVK_Control
        (0x3E, CGEventFlags::MaskControl),   // kVK_RightControl
        (0x3A, CGEventFlags::MaskAlternate), // kVK_Option
        (0x3D, CGEventFlags::MaskAlternate), // kVK_RightOption
        (0x37, CGEventFlags::MaskCommand),   // kVK_Command
        (0x36, CGEventFlags::MaskCommand),   // kVK_RightCommand
    ];

    /// The flags [`MODIFIERS`] hold: the only ones this injector decides.
    const HELD_FLAGS: u64 = CGEventFlags::MaskShift.0
        | CGEventFlags::MaskControl.0
        | CGEventFlags::MaskAlternate.0
        | CGEventFlags::MaskCommand.0;

    /// A new event's flags with the held modifiers made the injector's.
    ///
    /// CoreGraphics fills a new event's flags from its source and its key:
    /// measured on the rig, an arrow comes with the numeric-pad and fn bits, a
    /// modifier key with its own flag, caps lock with the lock, and any key
    /// with the modifiers the HID system holds. The first three stay. The four
    /// held modifiers are replaced, because what the injector has pressed is
    /// what the viewer is holding.
    fn carried(created: CGEventFlags, held: CGEventFlags) -> CGEventFlags {
        CGEventFlags((created.0 & !HELD_FLAGS) | held.0)
    }

    /// §5's button (0 left, 1 middle, 2 right, 3 x1, 4 x2) as CoreGraphics
    /// numbers it (0 left, 1 right, 2 centre, then 3 and 4).
    fn cg_button(button: u8) -> Option<CGMouseButton> {
        match button {
            0 => Some(CGMouseButton::Left),
            1 => Some(CGMouseButton::Center),
            2 => Some(CGMouseButton::Right),
            3 | 4 => Some(CGMouseButton(u32::from(button))),
            _ => None,
        }
    }

    /// A CoreGraphics button's down, up and dragged types.
    fn types(button: CGMouseButton) -> [CGEventType; 3] {
        match button {
            CGMouseButton::Left => [
                CGEventType::LeftMouseDown,
                CGEventType::LeftMouseUp,
                CGEventType::LeftMouseDragged,
            ],
            CGMouseButton::Right => [
                CGEventType::RightMouseDown,
                CGEventType::RightMouseUp,
                CGEventType::RightMouseDragged,
            ],
            _ => [
                CGEventType::OtherMouseDown,
                CGEventType::OtherMouseUp,
                CGEventType::OtherMouseDragged,
            ],
        }
    }

    /// A pixel inside `rect` as a global point: the display's point origin
    /// plus the pixel's offset, scaled from the pixel rect to the point rect.
    fn to_point(pixel: (i32, i32), rect: &Rect, points: (f64, f64, f64, f64)) -> CGPoint {
        let (x, y, width, height) = points;
        CGPoint::new(
            x + f64::from(pixel.0 - rect.left) * width / f64::from(rect.width().max(1)),
            y + f64::from(pixel.1 - rect.top) * height / f64::from(rect.height().max(1)),
        )
    }

    /// A point kept between the display's first and last pixel. The window
    /// server does not clamp a posted location (measured: a move posted past
    /// the edge reads back past it), and a pointer left off every display is
    /// lost to the viewer, so a relative move stops at the edge, as it does
    /// on Windows.
    fn clamp_to(at: CGPoint, rect: &Rect, points: (f64, f64, f64, f64)) -> CGPoint {
        let (x, y, _, _) = points;
        let last = to_point((rect.right - 1, rect.bottom - 1), rect, points);
        CGPoint::new(at.x.clamp(x, last.x.max(x)), at.y.clamp(y, last.y.max(y)))
    }

    /// The point rect of the display whose pixel rect this is. When no
    /// attached display has it, one line says so and absolute moves are
    /// dropped until the space changes.
    fn point_rect(rect: &Rect) -> Option<(f64, f64, f64, f64)> {
        let found = display_for_pixel_rect(rect).map(display_point_rect);
        if found.is_none() {
            ::log::warn!(
                "swoop: no attached display has the pixel rect {rect:?}, so pointer moves are dropped"
            );
        }
        found
    }

    /// Where the system has the pointer, in global points.
    fn system_pointer() -> CGPoint {
        CGEvent::new(None).map_or(CGPoint::ZERO, |event| CGEvent::location(Some(&*event)))
    }

    /// One debug line for a key that has no mac keycode. PrintScreen's two
    /// halves are named, since they are the keys a user presses on purpose.
    fn dropped_key(scancode: u16, extended: bool) {
        match (scancode, extended) {
            (42, true) => ::log::debug!(
                "swoop: dropped the extended-42 half of printscreen's sequence: a mac has no such key"
            ),
            (55, true) => ::log::debug!("swoop: dropped printscreen: a mac has no such key"),
            _ => ::log::debug!(
                "swoop: dropped scancode {scancode} (extended {extended}): it has no mac keycode"
            ),
        }
    }

    /// One press, for the next press of the same button to count from.
    #[derive(Debug, Clone, Copy)]
    struct Press {
        at: Instant,
        point: CGPoint,
        count: i64,
    }

    /// What the injector believes about the devices it drives. It learns only
    /// from the events it is given: the session's `release_all` arrives as
    /// ordinary key-ups and button-ups. Pure, so the tests drive it without
    /// posting anything.
    #[derive(Debug, Default)]
    struct Held {
        /// Bit `i` is `MODIFIERS[i]`.
        modifiers: u8,
        /// Bit `b` is §5's button `b`.
        buttons: u8,
        presses: [Option<Press>; 5],
        wheel_x: Accum,
        wheel_y: Accum,
    }

    impl Held {
        fn key(&mut self, keycode: u16, down: bool) {
            if let Some(i) = MODIFIERS.iter().position(|(key, _)| *key == keycode) {
                if down {
                    self.modifiers |= 1 << i;
                } else {
                    self.modifiers &= !(1 << i);
                }
            }
        }

        fn flags(&self) -> CGEventFlags {
            MODIFIERS
                .iter()
                .enumerate()
                .filter(|(i, _)| self.modifiers & (1 << i) != 0)
                .fold(CGEventFlags::empty(), |flags, (_, (_, flag))| flags | *flag)
        }

        /// A press or release of §5's `button`: its event type, CoreGraphics'
        /// button and the click count it carries. `None` for a button §5 does
        /// not define. A release carries the count of its press, which is what
        /// makes the second click of a pair a double click.
        fn button(
            &mut self,
            button: u8,
            down: bool,
            at: Instant,
            point: CGPoint,
        ) -> Option<(CGEventType, CGMouseButton, i64)> {
            let cg = cg_button(button)?;
            let [press, release, _] = types(cg);
            let last = &mut self.presses[usize::from(button)];
            if !down {
                self.buttons &= !(1 << button);
                return Some((release, cg, last.map_or(1, |p| p.count)));
            }
            let count = match *last {
                Some(p)
                    if at.saturating_duration_since(p.at) <= MULTI_CLICK_TIME
                        && (point.x - p.point.x).hypot(point.y - p.point.y)
                            <= MULTI_CLICK_POINTS =>
                {
                    p.count + 1
                }
                _ => 1,
            };
            *last = Some(Press { at, point, count });
            self.buttons |= 1 << button;
            Some((press, cg, count))
        }

        /// A move's type and button: a held button's dragged type, left before
        /// right before the others, and a plain move when none is held.
        fn move_type(&self) -> (CGEventType, CGMouseButton) {
            [0u8, 2, 1, 3, 4]
                .into_iter()
                .filter(|&button| self.buttons & (1 << button) != 0)
                .find_map(cg_button)
                .map_or((CGEventType::MouseMoved, CGMouseButton::Left), |cg| {
                    (types(cg)[2], cg)
                })
        }

        /// Whole lines for the vertical and the horizontal wheel, carrying the
        /// rest to the next event. Three lines to a notch, the same three a
        /// browser's line is worth on the way in, so a line there is a line
        /// here. Up is positive in both; right is positive in `WHEEL_DELTA`
        /// and left in CoreGraphics, so the horizontal wheel flips.
        fn wheel(&mut self, delta_x: i32, delta_y: i32) -> (i32, i32) {
            let lines = LINES_PER_NOTCH / WHEEL_DELTA;
            (
                self.wheel_y.take(f64::from(delta_y) * lines),
                self.wheel_x.take(-f64::from(delta_x) * lines),
            )
        }
    }

    /// Posts CoreGraphics events at the HID tap, made from a HID-state source.
    pub struct CgInjector {
        space: PointerSpace,
        /// The point rect (x, y, width, height) of the display `space` is, or
        /// `None` when no attached display has its pixel rect.
        display: Option<(f64, f64, f64, f64)>,
        source: Option<CFRetained<CGEventSource>>,
        keys: &'static KeyTable,
        held: Held,
        /// Where this injector last put the pointer, in global points. Clicks
        /// and the wheel land here rather than where the system says the
        /// pointer is: a press is made right behind the move that placed it,
        /// and asking the system would race that move.
        pointer: CGPoint,
        granted: bool,
        dropped: u64,
    }

    impl CgInjector {
        pub fn new(space: PointerSpace) -> Self {
            let granted = CGPreflightPostEventAccess();
            if !granted {
                ::log::warn!(
                    "swoop: accessibility is not granted to the owlette app, so viewer input is dropped"
                );
            }
            Self {
                space,
                display: point_rect(&space.rect),
                source: CGEventSource::new(CGEventSourceStateID::HIDSystemState),
                keys: key_table(),
                held: Held::default(),
                pointer: system_pointer(),
                granted,
                dropped: 0,
            }
        }

        /// The viewer picked a different display.
        pub fn set_space(&mut self, space: PointerSpace) {
            self.space = space;
            self.display = point_rect(&space.rect);
        }

        /// A mode change can move a display's points under the same pixels.
        pub fn refresh_bounds(&mut self) {
            self.display = point_rect(&self.space.rect);
        }

        fn mouse(
            &self,
            kind: CGEventType,
            at: CGPoint,
            button: CGMouseButton,
        ) -> anyhow::Result<CFRetained<CGEvent>> {
            CGEvent::new_mouse_event(self.source.as_deref(), kind, at, button)
                .context("CGEventCreateMouseEvent made no event")
        }

        fn move_to(&mut self, at: CGPoint, delta: Option<(i32, i32)>) -> anyhow::Result<()> {
            let (kind, button) = self.held.move_type();
            let event = self.mouse(kind, at, button)?;
            if let Some((dx, dy)) = delta {
                let event = Some(&*event);
                CGEvent::set_integer_value_field(event, CGEventField::MouseEventDeltaX, dx.into());
                CGEvent::set_integer_value_field(event, CGEventField::MouseEventDeltaY, dy.into());
            }
            self.post(&event);
            self.pointer = at;
            Ok(())
        }

        fn post(&self, event: &CGEvent) {
            let flags = carried(CGEvent::flags(Some(event)), self.held.flags());
            CGEvent::set_flags(Some(event), flags);
            CGEvent::post(CGEventTapLocation::HIDEventTap, Some(event));
        }
    }

    impl Drop for CgInjector {
        fn drop(&mut self) {
            if self.dropped > 0 {
                ::log::warn!(
                    "swoop: dropped {} input events: accessibility is not granted to the owlette app",
                    self.dropped
                );
            }
        }
    }

    impl Injector for CgInjector {
        fn inject(&mut self, event: &InputEvent) -> anyhow::Result<()> {
            if !self.granted {
                self.dropped += 1;
                return Ok(());
            }
            match *event {
                InputEvent::MouseMove { x, y } => {
                    let Some(points) = self.display else {
                        return Ok(());
                    };
                    let at = to_point(self.space.to_desktop(x, y), &self.space.rect, points);
                    self.move_to(at, None)
                }
                InputEvent::MouseMoveRelative { dx, dy } => {
                    let here = system_pointer();
                    let mut at = CGPoint::new(here.x + f64::from(dx), here.y + f64::from(dy));
                    if let Some(points) = self.display {
                        at = clamp_to(at, &self.space.rect, points);
                    }
                    self.move_to(at, Some((dx, dy)))
                }
                InputEvent::MouseButton { button, down } => {
                    let Some((kind, cg, clicks)) =
                        self.held.button(button, down, Instant::now(), self.pointer)
                    else {
                        return Ok(());
                    };
                    let event = self.mouse(kind, self.pointer, cg)?;
                    CGEvent::set_integer_value_field(
                        Some(&*event),
                        CGEventField::MouseEventClickState,
                        clicks,
                    );
                    self.post(&event);
                    Ok(())
                }
                InputEvent::MouseWheel { delta_x, delta_y } => {
                    let (vertical, horizontal) = self.held.wheel(delta_x, delta_y);
                    if vertical == 0 && horizontal == 0 {
                        return Ok(());
                    }
                    let event = CGEvent::new_scroll_wheel_event2(
                        self.source.as_deref(),
                        CGScrollEventUnit::Line,
                        2,
                        vertical,
                        horizontal,
                        0,
                    )
                    .context("CGEventCreateScrollWheelEvent2 made no event")?;
                    CGEvent::set_location(Some(&*event), self.pointer);
                    self.post(&event);
                    Ok(())
                }
                InputEvent::Key {
                    scancode,
                    extended,
                    down,
                } => {
                    let Some(keycode) = self.keys.keycode(scancode, extended) else {
                        dropped_key(scancode, extended);
                        return Ok(());
                    };
                    let event = CGEvent::new_keyboard_event(self.source.as_deref(), keycode, down)
                        .context("CGEventCreateKeyboardEvent made no event")?;
                    // Before the flags are set: a modifier's own event carries
                    // the state it leaves behind, as a keyboard's does.
                    self.held.key(keycode, down);
                    self.post(&event);
                    Ok(())
                }
                InputEvent::KeyVirtual { vk, .. } => {
                    ::log::debug!("swoop: dropped pause (virtual key {vk}): a mac has no such key");
                    Ok(())
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::capture::Rotation;
        use crate::input::ViewerInput;
        use crate::signal::messages::channel::{Input, WheelMode};
        use objc2_core_graphics::CGMainDisplayID;

        fn key(code: &str, down: bool) -> Input {
            Input::K {
                code: code.to_string(),
                down,
                seq: 1,
                ts_us: 0,
            }
        }

        /// The keycode of every key event, into `held`.
        fn press(held: &mut Held, events: Vec<InputEvent>) {
            for event in events {
                if let InputEvent::Key {
                    scancode,
                    extended,
                    down,
                } = event
                {
                    let keycode = key_table()
                        .keycode(scancode, extended)
                        .expect("a mac keycode");
                    held.key(keycode, down);
                }
            }
        }

        #[test]
        fn modifier_flags_follow_press_release_and_release_all() {
            let now = Instant::now();
            let mut viewer = ViewerInput::new(now);
            let mut held = Held::default();
            for code in ["ShiftLeft", "MetaLeft", "ShiftRight", "KeyA"] {
                press(&mut held, viewer.accept(&key(code, true), now));
            }
            assert_eq!(
                held.flags(),
                CGEventFlags::MaskShift | CGEventFlags::MaskCommand
            );

            // One shift up and the other still down: the flag stays.
            press(&mut held, viewer.accept(&key("ShiftLeft", false), now));
            assert_eq!(
                held.flags(),
                CGEventFlags::MaskShift | CGEventFlags::MaskCommand
            );
            press(&mut held, viewer.accept(&key("ShiftRight", false), now));
            assert_eq!(held.flags(), CGEventFlags::MaskCommand);

            // Option and control, from their right-hand keys.
            for code in ["AltRight", "ControlRight"] {
                press(&mut held, viewer.accept(&key(code, true), now));
            }
            assert_eq!(
                held.flags(),
                CGEventFlags::MaskCommand | CGEventFlags::MaskAlternate | CGEventFlags::MaskControl
            );

            // A disconnect: the session's release_all is ordinary key-ups.
            press(&mut held, viewer.release_all());
            assert_eq!(held.flags(), CGEventFlags::empty());
        }

        #[test]
        fn an_event_keeps_what_the_system_gave_it_and_carries_the_held_modifiers() {
            // An up arrow as the rig creates it: an unnamed high bit, the
            // numeric pad and fn. All three stay, and command joins them.
            let arrow = CGEventFlags(0x20a0_0000);
            assert_eq!(
                carried(arrow, CGEventFlags::MaskCommand),
                CGEventFlags(0x20b0_0000)
            );
            // Caps lock is a lock, not a held modifier: it stays too.
            let caps = CGEventFlags(0x2001_0000);
            assert_eq!(
                carried(caps, CGEventFlags::MaskShift),
                CGEventFlags(0x2003_0000)
            );
            // A modifier the source reports that the injector has released is
            // cleared: the viewer is not holding it.
            let stale = CGEventFlags(0x2000_0000) | CGEventFlags::MaskControl;
            assert_eq!(
                carried(stale, CGEventFlags::empty()),
                CGEventFlags(0x2000_0000)
            );
        }

        #[test]
        fn the_click_count_climbs_within_500_ms_and_4_points() {
            let start = Instant::now();
            let at = |ms: u64| start + Duration::from_millis(ms);
            let here = CGPoint::new(100.0, 100.0);
            let mut held = Held::default();
            let mut count = |button: u8, down: bool, ms: u64, point: CGPoint| {
                held.button(button, down, at(ms), point)
                    .expect("a §5 button")
                    .2
            };
            assert_eq!(count(0, true, 0, here), 1);
            assert_eq!(count(0, false, 80, here), 1);
            // Within the time and a jitter of 3.6 points: the second click.
            assert_eq!(count(0, true, 300, CGPoint::new(103.0, 102.0)), 2);
            // The release carries its press's count.
            assert_eq!(count(0, false, 380, here), 2);
            assert_eq!(count(0, true, 700, here), 3);
            // 501 ms after the last press: a new first click.
            assert_eq!(count(0, true, 1201, here), 1);
            // 4.1 points away: a new first click.
            assert_eq!(count(0, true, 1300, CGPoint::new(104.0, 101.0)), 1);
            // On both limits exactly: still the next click.
            assert_eq!(count(0, true, 1800, CGPoint::new(104.0, 101.0)), 2);
            // Each button counts its own presses.
            assert_eq!(count(2, true, 1850, CGPoint::new(104.0, 101.0)), 1);
            assert_eq!(count(0, true, 1900, CGPoint::new(104.0, 101.0)), 3);
            // §5 defines five buttons.
            assert!(held.button(5, true, at(2000), here).is_none());
        }

        #[test]
        fn each_button_has_its_own_types_and_a_held_one_drags() {
            let now = Instant::now();
            let here = CGPoint::ZERO;
            let mut held = Held::default();
            let pressed = |held: &mut Held, button: u8| {
                let (kind, cg, _) = held.button(button, true, now, here).expect("a §5 button");
                (kind, cg)
            };
            assert_eq!(
                held.move_type(),
                (CGEventType::MouseMoved, CGMouseButton::Left)
            );

            assert_eq!(
                pressed(&mut held, 2),
                (CGEventType::RightMouseDown, CGMouseButton::Right)
            );
            assert_eq!(
                held.move_type(),
                (CGEventType::RightMouseDragged, CGMouseButton::Right)
            );
            // Left and right both down: the left drag.
            assert_eq!(
                pressed(&mut held, 0),
                (CGEventType::LeftMouseDown, CGMouseButton::Left)
            );
            assert_eq!(
                held.move_type(),
                (CGEventType::LeftMouseDragged, CGMouseButton::Left)
            );
            held.button(0, false, now, here);
            held.button(2, false, now, here);
            assert_eq!(
                held.move_type(),
                (CGEventType::MouseMoved, CGMouseButton::Left)
            );

            // The middle button is CoreGraphics' centre, an "other" button.
            assert_eq!(
                pressed(&mut held, 1),
                (CGEventType::OtherMouseDown, CGMouseButton::Center)
            );
            assert_eq!(
                held.move_type(),
                (CGEventType::OtherMouseDragged, CGMouseButton::Center)
            );
            held.button(1, false, now, here);
            assert_eq!(
                pressed(&mut held, 4),
                (CGEventType::OtherMouseDown, CGMouseButton(4))
            );
            assert_eq!(
                held.move_type(),
                (CGEventType::OtherMouseDragged, CGMouseButton(4))
            );
        }

        #[test]
        fn the_wheel_posts_three_lines_a_notch_and_carries_the_rest() {
            let mut held = Held::default();
            // A notch up and a notch right: up is positive in both, right flips.
            assert_eq!(held.wheel(0, 120), (3, 0));
            assert_eq!(held.wheel(120, 0), (0, -3));
            // A browser's line is 40 units on the way in: one line here.
            assert_eq!(held.wheel(0, -40), (-1, 0));
            // A trackpad's 5-unit deltas are an eighth of a line each: none
            // makes a line alone, and none is lost.
            let lines: Vec<i32> = (0..16).map(|_| held.wheel(0, 5).0).collect();
            assert_eq!(lines[..3], [0, 0, 0]);
            assert_eq!(lines.iter().sum::<i32>(), 2);
        }

        #[test]
        fn a_pixel_becomes_a_point_on_a_2x_display_left_of_the_main_one() {
            // 1440x900 points at (-1440, -200), so 2880x1800 pixels from twice
            // that origin (decision 13).
            let rect = Rect {
                left: -2880,
                top: -400,
                right: 0,
                bottom: 1400,
            };
            let points = (-1440.0, -200.0, 1440.0, 900.0);
            assert_eq!(
                to_point((-2880, -400), &rect, points),
                CGPoint::new(-1440.0, -200.0)
            );
            // The last pixel is half a point inside the edge, not on the
            // neighbouring display.
            assert_eq!(
                to_point((-1, 1399), &rect, points),
                CGPoint::new(-0.5, 699.5)
            );

            let space = PointerSpace {
                rect,
                rotation: Rotation::Identity,
            };
            assert_eq!(
                to_point(space.to_desktop(1.0, 1.0), &rect, points),
                CGPoint::new(-0.5, 699.5)
            );
            assert_eq!(
                to_point(space.to_desktop(0.5, 0.5), &rect, points),
                CGPoint::new(-720.0, 250.0)
            );

            // A relative move past two edges stops at the display's corner.
            assert_eq!(
                clamp_to(CGPoint::new(15.0, -900.0), &rect, points),
                CGPoint::new(-0.5, -200.0)
            );
            let inside = CGPoint::new(-700.25, 10.5);
            assert_eq!(clamp_to(inside, &rect, points), inside);
        }

        /// A posted event is applied after the call returns, so a read-back
        /// polls, for up to half a second.
        fn settles(done: impl Fn() -> bool) -> bool {
            for _ in 0..100 {
                if done() {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            done()
        }

        fn near(a: CGPoint, b: CGPoint) -> bool {
            (a.x - b.x).abs() <= 1.0 && (a.y - b.y).abs() <= 1.0
        }

        fn shift_is_down() -> bool {
            CGEventSource::flags_state(CGEventSourceStateID::HIDSystemState)
                .contains(CGEventFlags::MaskShift)
        }

        fn main_display_injector() -> CgInjector {
            let rect = crate::platform::macos::display_pixel_rect(CGMainDisplayID());
            CgInjector::new(PointerSpace {
                rect,
                rotation: Rotation::Identity,
            })
        }

        #[test]
        #[ignore = "MOVES THE REAL POINTER to each corner of the main display and presses shift; cargo test -- --ignored --nocapture each_corner"]
        fn the_pointer_reaches_each_corner_of_the_main_display() {
            assert!(
                CGPreflightPostEventAccess(),
                "this process may not post events: grant accessibility to whatever started it"
            );
            let before = system_pointer();
            let mut injector = main_display_injector();
            let rect = injector.space.rect;
            let points = injector
                .display
                .expect("the main display is found by its own pixel rect");
            println!("main display: pixels {rect:?}, points {points:?}");

            let mut landed = Vec::new();
            for (x, y) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
                let want = to_point(injector.space.to_desktop(x, y), &rect, points);
                injector
                    .inject(&InputEvent::MouseMove { x, y })
                    .expect("move");
                settles(|| near(system_pointer(), want));
                let at = system_pointer();
                println!(
                    "({x}, {y}): asked for ({:.1}, {:.1}), the pointer is at ({:.1}, {:.1})",
                    want.x, want.y, at.x, at.y
                );
                landed.push((want, at));
            }
            // From the last corner, a relative move out past it stays in it.
            let corner = landed[3].0;
            injector
                .inject(&InputEvent::MouseMoveRelative { dx: 50, dy: 50 })
                .expect("relative move");
            settles(|| near(system_pointer(), corner));
            let at = system_pointer();
            println!(
                "50 points past it, relative: the pointer is at ({:.1}, {:.1})",
                at.x, at.y
            );
            landed.push((corner, at));

            // Shift alone types nothing, so this is safe whatever has focus. The
            // release goes in before anything is asserted: a panic between the
            // two would leave a real key held down on the machine.
            let mut viewer = ViewerInput::new(Instant::now());
            injector
                .inject_all(&viewer.accept(&key("ShiftLeft", true), Instant::now()))
                .expect("shift down");
            let went_down = settles(shift_is_down);
            // Made, never posted: whether a new event picks up the held shift
            // from the HID system by itself. On the rig it does (0x20020002).
            let made = CGEvent::new_keyboard_event(injector.source.as_deref(), 0, true)
                .map(|event| CGEvent::flags(Some(&*event)).0);
            injector
                .inject_all(&viewer.release_all())
                .expect("shift up");
            let came_up = settles(|| !shift_is_down());
            println!(
                "shift: the system saw it down {went_down}, up again {came_up}; an event made while it was down had flags {made:#x?}"
            );

            injector.move_to(before, None).expect("restore the pointer");
            println!("put the pointer back at ({:.1}, {:.1})", before.x, before.y);

            for (want, at) in landed {
                assert!(
                    near(at, want),
                    "asked for {want:?}, the pointer is at {at:?}"
                );
            }
            assert!(went_down, "shift did not go down");
            assert!(came_up, "shift stayed down");
        }

        /// The half of Task 4.3's done-when only a human can see. It types a
        /// line, double clicks, selects all, drags and scrolls, each after a
        /// printed instruction and a pause; the human confirms each result.
        #[test]
        #[ignore = "TYPES INTO THE FOCUSED WINDOW, clicks, drags and scrolls; needs a human and SWOOP_INPUT_HUMAN=1"]
        fn a_human_confirms_typing_a_double_click_select_all_a_drag_and_the_wheel() {
            assert!(
                std::env::var_os("SWOOP_INPUT_HUMAN").is_some(),
                "this types into whatever is focused: focus a text field, then run it with SWOOP_INPUT_HUMAN=1"
            );
            assert!(
                CGPreflightPostEventAccess(),
                "this process may not post events: grant accessibility to whatever started it"
            );
            let mut injector = main_display_injector();
            let mut viewer = ViewerInput::new(Instant::now());
            let mut send = |injector: &mut CgInjector, message: Input| {
                let events = viewer.accept(&message, Instant::now());
                injector.inject_all(&events).expect("inject");
                std::thread::sleep(Duration::from_millis(15));
            };
            let step = |text: &str, seconds: u64| {
                println!("{text}");
                std::thread::sleep(Duration::from_secs(seconds));
            };
            let tap = |code: &str| [key(code, true), key(code, false)];
            let button = |down: bool| Input::B {
                button: 0,
                down,
                seq: 1,
                ts_us: 0,
            };
            let nudge = |dx: f64| Input::Mr {
                dx,
                dy: 0.0,
                seq: 1,
                ts_us: 0,
            };
            let wheel = |dy: f64| Input::W {
                dx: 0.0,
                dy,
                mode: WheelMode::Pixel,
                seq: 1,
                ts_us: 0,
            };

            step("typing a line into the focused field in 3 s", 3);
            for ch in "Swoop typed this. Double click a word".chars() {
                let code = match ch {
                    ' ' => "Space".to_string(),
                    '.' => "Period".to_string(),
                    _ => format!("Key{}", ch.to_ascii_uppercase()),
                };
                if ch.is_ascii_uppercase() {
                    send(&mut injector, key("ShiftLeft", true));
                }
                for message in tap(&code) {
                    send(&mut injector, message);
                }
                if ch.is_ascii_uppercase() {
                    send(&mut injector, key("ShiftLeft", false));
                }
            }

            step(
                "put the pointer over a word of that line: a double click in 5 s",
                5,
            );
            // A zero nudge takes the pointer from wherever the human left it.
            send(&mut injector, nudge(0.0));
            for _ in 0..2 {
                send(&mut injector, button(true));
                send(&mut injector, button(false));
                std::thread::sleep(Duration::from_millis(60));
            }

            step("one word should be selected. cmd+a in 3 s", 3);
            send(&mut injector, key("MetaLeft", true));
            for message in tap("KeyA") {
                send(&mut injector, message);
            }
            send(&mut injector, key("MetaLeft", false));

            step("all of it should be selected. put the pointer at the start of the line: a drag to the right in 5 s", 5);
            send(&mut injector, nudge(0.0));
            send(&mut injector, button(true));
            for _ in 0..20 {
                send(&mut injector, nudge(10.0));
            }
            send(&mut injector, button(false));

            step("the drag should have selected text. put the pointer over a long page: the wheel in 5 s", 5);
            for _ in 0..5 {
                send(&mut injector, wheel(100.0));
                std::thread::sleep(Duration::from_millis(150));
            }
            std::thread::sleep(Duration::from_secs(1));
            for _ in 0..5 {
                send(&mut injector, wheel(-100.0));
                std::thread::sleep(Duration::from_millis(150));
            }
            injector
                .inject_all(&viewer.release_all())
                .expect("release everything");

            println!(
                "confirm each: the line was typed as shown, capitals included; the double click selected one word; \
                 cmd+a selected everything; the drag selected text; the page scrolled toward its end and then back \
                 toward its start, as a browser scrolls for a wheel turned toward you and then away"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use super::*;

    #[test]
    fn every_code_with_a_scancode_has_a_mac_keycode_or_a_reason() {
        let raw: serde_json::Value =
            serde_json::from_str(super::super::KEYMAP_JSON).expect("parse");
        let mac: serde_json::Value = serde_json::from_str(KEYMAP_MACOS_JSON).expect("parse");
        let codes = mac["codes"].as_object().expect("codes");
        let exceptions: BTreeMap<&str, &str> = mac["exceptions"]
            .as_array()
            .expect("exceptions")
            .iter()
            .map(|entry| {
                (
                    entry["code"].as_str().expect("an exception's code"),
                    entry["reason"].as_str().expect("an exception's reason"),
                )
            })
            .collect();
        let table = key_table();

        for (code, entry) in raw["codes"].as_object().expect("codes") {
            let Some(scancode) = entry["scancode"].as_u64() else {
                continue;
            };
            let scancode = u16::try_from(scancode).expect("a scancode");
            let extended = entry["extended"].as_bool().unwrap_or(false);
            match (codes.get(code), exceptions.get(code.as_str())) {
                (Some(mapped), None) => assert_eq!(
                    table.keycode(scancode, extended),
                    mapped["keycode"].as_u64().map(|k| k as u16),
                    "{code}"
                ),
                (None, Some(reason)) => {
                    assert!(
                        !reason.trim().is_empty(),
                        "{code} is an exception with no reason"
                    );
                    assert_eq!(table.keycode(scancode, extended), None, "{code}");
                }
                (Some(_), Some(_)) => panic!("{code} is both mapped and an exception"),
                (None, None) => panic!("{code} has a scancode but no mac keycode and no reason"),
            }
        }
        // Nothing either list names that keymap.json cannot send as one scancode.
        for code in codes
            .keys()
            .map(String::as_str)
            .chain(exceptions.keys().copied())
        {
            assert!(
                raw["codes"][code]["scancode"].is_u64(),
                "{code} is not a scancode in keymap.json"
            );
        }
        // One key, one keycode, inside the kVK range: a repeat is a typo.
        let keycodes: BTreeSet<u64> = codes
            .values()
            .filter_map(|k| k["keycode"].as_u64())
            .collect();
        assert_eq!(keycodes.len(), codes.len(), "two codes share a keycode");
        assert!(
            keycodes.iter().all(|&k| k <= 0x7F),
            "a keycode past kVK's range"
        );
    }
}
