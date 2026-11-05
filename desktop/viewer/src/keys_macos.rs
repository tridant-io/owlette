//! cmd+q, cmd+w, cmd+h and cmd+m go to the machine while a session is
//! captured (mac.rs): a local event monitor sees each key's down before the
//! menu and the page do, hands it to the page as
//! `window.__owletteNativeKey(code, true)` and drops it, so the app neither
//! quits, closes, hides nor minimizes. the up needs nothing: a cmd combo's up
//! never passes a local monitor, and webkit gives it to the page as a keyup of
//! its own (measured 2026-10-09). cmd+tab is not among them: with switching off
//! macos swallows it, so it switches nothing and reaches no app. cmd+space and
//! the other system hotkeys never reach an app either, so they stay with
//! macos, and so does ctrl+cmd+q, which locks the screen.

use std::ptr::{self, NonNull};

use block2::RcBlock;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
use objc2_foundation::NSString;
use objc2_web_kit::WKWebView;

use crate::mac;

// what the menu matches a key equivalent on: the key's character, so cmd+q
// is the key labelled q on azerty and dvorak too, wherever it sits
const FORWARDED: [&str; 4] = ["q", "w", "h", "m"];

// the dom `code` the page's own keydown would give each key, by its virtual
// key code (carbon's kVK_*). codes name the physical key, so this is the
// typing block, where a forwarded character can sit in any layout
const DOM_CODES: [(u16, &str); 48] = [
  (0x00, "KeyA"),
  (0x01, "KeyS"),
  (0x02, "KeyD"),
  (0x03, "KeyF"),
  (0x04, "KeyH"),
  (0x05, "KeyG"),
  (0x06, "KeyZ"),
  (0x07, "KeyX"),
  (0x08, "KeyC"),
  (0x09, "KeyV"),
  (0x0A, "IntlBackslash"),
  (0x0B, "KeyB"),
  (0x0C, "KeyQ"),
  (0x0D, "KeyW"),
  (0x0E, "KeyE"),
  (0x0F, "KeyR"),
  (0x10, "KeyY"),
  (0x11, "KeyT"),
  (0x12, "Digit1"),
  (0x13, "Digit2"),
  (0x14, "Digit3"),
  (0x15, "Digit4"),
  (0x16, "Digit6"),
  (0x17, "Digit5"),
  (0x18, "Equal"),
  (0x19, "Digit9"),
  (0x1A, "Digit7"),
  (0x1B, "Minus"),
  (0x1C, "Digit8"),
  (0x1D, "Digit0"),
  (0x1E, "BracketRight"),
  (0x1F, "KeyO"),
  (0x20, "KeyU"),
  (0x21, "BracketLeft"),
  (0x22, "KeyI"),
  (0x23, "KeyP"),
  (0x25, "KeyL"),
  (0x26, "KeyJ"),
  (0x27, "Quote"),
  (0x28, "KeyK"),
  (0x29, "Semicolon"),
  (0x2A, "Backslash"),
  (0x2B, "Comma"),
  (0x2C, "Slash"),
  (0x2D, "KeyN"),
  (0x2E, "KeyM"),
  (0x2F, "Period"),
  (0x32, "Backquote"),
];

#[derive(Debug, PartialEq, Eq)]
enum Verdict {
  // to the menu and the page as usual
  Pass,
  // swallowed and not sent: a repeat, or a key with no dom code
  Drop,
  // to the page instead of the menu
  Forward(&'static str),
}

pub fn monitor() {
  let block = RcBlock::new(|event: NonNull<NSEvent>| -> *mut NSEvent {
    // SAFETY: appkit hands the monitor a live event for the call
    if forwarded(unsafe { event.as_ref() }) {
      ptr::null_mut()
    } else {
      event.as_ptr()
    }
  });
  // SAFETY: the block returns the event it was given, or nil to drop it
  let monitor =
    unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block) };
  match monitor {
    // monitors for the app's whole life
    Some(monitor) => std::mem::forget(monitor),
    None => log::warn!("no key monitor; cmd+q, w, h and m stay with the app in fullscreen"),
  }
}

// true when the key went to the page instead of the app
fn forwarded(event: &NSEvent) -> bool {
  let Some(webview) = mac::captured_webview() else {
    return false;
  };
  let characters = event
    .charactersIgnoringModifiers()
    .map(|characters| characters.to_string())
    .unwrap_or_default();
  match verdict(
    event.keyCode(),
    &characters,
    event.modifierFlags(),
    event.isARepeat(),
  ) {
    Verdict::Pass => false,
    Verdict::Drop => true,
    Verdict::Forward(code) => {
      deliver(&webview, code);
      true
    }
  }
}

// for a key's down
fn verdict(
  key_code: u16,
  characters: &str,
  modifiers: NSEventModifierFlags,
  repeat: bool,
) -> Verdict {
  // ctrl+cmd+q locks the screen, which stays with the person at the mac
  let shortcut = modifiers.contains(NSEventModifierFlags::Command)
    && !modifiers.contains(NSEventModifierFlags::Control);
  let wanted = FORWARDED.contains(&characters.to_lowercase().as_str());
  if !shortcut || !wanted {
    return Verdict::Pass;
  }
  match dom_code(key_code) {
    Some(code) if !repeat => Verdict::Forward(code),
    _ => Verdict::Drop,
  }
}

fn dom_code(key_code: u16) -> Option<&'static str> {
  DOM_CODES
    .iter()
    .find(|(key, _)| *key == key_code)
    .map(|(_, code)| *code)
}

// the code comes from the table above, never from the page, so it is safe to
// put in the script as it is
fn deliver(webview: &WKWebView, code: &str) {
  let script = NSString::from_str(&format!("window.__owletteNativeKey?.('{code}', true)"));
  // SAFETY: on the main thread, with no completion handler to keep alive
  unsafe { webview.evaluateJavaScript_completionHandler(&script, None) };
}

#[cfg(test)]
mod tests {
  use super::*;

  const KVK_Q: u16 = 0x0C;
  const KVK_A: u16 = 0x00;
  const KVK_TAB: u16 = 0x30;
  const KVK_SPACE: u16 = 0x31;

  #[test]
  fn each_forwarded_key_has_its_dom_code() {
    for (key_code, code) in [
      (KVK_Q, "KeyQ"),
      (0x0D, "KeyW"),
      (0x04, "KeyH"),
      (0x2E, "KeyM"),
    ] {
      assert_eq!(dom_code(key_code), Some(code), "{key_code:#x}");
    }
  }

  #[test]
  fn the_table_names_each_key_once() {
    for (index, (key_code, code)) in DOM_CODES.iter().enumerate() {
      for (other_key, other) in &DOM_CODES[index + 1..] {
        assert_ne!(key_code, other_key, "{code} and {other}");
        assert_ne!(code, other, "{key_code:#x} and {other_key:#x}");
      }
    }
  }

  #[test]
  fn keys_outside_the_typing_block_have_no_code() {
    // return, tab, space, escape, delete, f1, the arrows
    for key_code in [0x24, KVK_TAB, KVK_SPACE, 0x35, 0x33, 0x7A, 0x7B, 0x7E] {
      assert_eq!(dom_code(key_code), None, "{key_code:#x}");
    }
  }

  const CMD: NSEventModifierFlags = NSEventModifierFlags::Command;
  const NONE: NSEventModifierFlags = NSEventModifierFlags::empty();

  #[test]
  fn cmd_with_a_forwarded_key_goes_to_the_page() {
    for (key_code, characters, modifiers, code) in [
      (KVK_Q, "q", CMD, "KeyQ"),
      (0x0D, "w", CMD, "KeyW"),
      (0x04, "h", CMD, "KeyH"),
      (0x2E, "m", CMD, "KeyM"),
      // log out, hide others and close all are the same keys with more held
      (KVK_Q, "Q", CMD.union(NSEventModifierFlags::Shift), "KeyQ"),
      (0x04, "h", CMD.union(NSEventModifierFlags::Option), "KeyH"),
    ] {
      assert_eq!(
        verdict(key_code, characters, modifiers, false),
        Verdict::Forward(code),
        "{characters:?} {modifiers:?}"
      );
    }
  }

  #[test]
  fn the_character_decides_and_the_position_names_it() {
    // azerty's q sits where qwerty has a
    assert_eq!(verdict(KVK_A, "q", CMD, false), Verdict::Forward("KeyA"));
    // and its a where qwerty has q: cmd+a is select all, not quit
    assert_eq!(verdict(KVK_Q, "a", CMD, false), Verdict::Pass);
  }

  #[test]
  fn everything_else_stays_as_it_is() {
    for (key_code, characters, modifiers) in [
      // no cmd
      (KVK_Q, "q", NONE),
      // ctrl+cmd+q locks the screen here, not on the machine
      (KVK_Q, "q", CMD.union(NSEventModifierFlags::Control)),
      // macos swallows cmd+tab while switching is off; one that got through
      // would find nothing in the menu
      (KVK_TAB, "\t", CMD),
      // the edit menu's own keys
      (0x09, "v", CMD),
      (0x08, "c", CMD),
      (KVK_A, "a", CMD),
      // spotlight's, which never reaches an app anyway
      (KVK_SPACE, " ", CMD),
    ] {
      assert_eq!(
        verdict(key_code, characters, modifiers, false),
        Verdict::Pass,
        "{characters:?} {modifiers:?}"
      );
    }
  }

  #[test]
  fn a_repeat_is_dropped_not_sent_again() {
    assert_eq!(verdict(KVK_Q, "q", CMD, true), Verdict::Drop);
  }
}
