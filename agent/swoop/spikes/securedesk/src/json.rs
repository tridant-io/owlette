//! The smallest json this spike needs: emit an object, read a top-level field.
//!
//! Not a parser. The lines it reads are the ones `spawn_spike.py` writes, so it
//! only has to find a named top-level field and read the scalar after it. What
//! it does refuse to do is match a key inside a *value*: `"sid"` appearing in
//! the bundle's `signalUrl` must not answer a lookup for `sid`, so a candidate
//! only counts when the first non-space character before it is `{` or `,`.

use std::fmt::Write as _;

/// One field of an emitted object.
pub enum Val {
    Str(String),
    Num(i64),
    F64(f64),
    Bool(bool),
    /// Already-rendered json: a nested object or an array.
    Raw(String),
}

pub fn s(v: impl Into<String>) -> Val {
    Val::Str(v.into())
}

/// Emit `{"k":v,...}` with no trailing newline.
pub fn obj(fields: &[(&str, Val)]) -> String {
    let mut out = String::from("{");
    for (i, (key, value)) in fields.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let _ = write!(out, "{}:", quote(key));
        match value {
            Val::Str(v) => out.push_str(&quote(v)),
            Val::Num(v) => {
                let _ = write!(out, "{v}");
            }
            // Non-finite has no json spelling; null is the honest answer and
            // never reaches a number field the harness reads.
            Val::F64(v) if !v.is_finite() => out.push_str("null"),
            Val::F64(v) => {
                let _ = write!(out, "{v:.3}");
            }
            Val::Bool(v) => out.push_str(if *v { "true" } else { "false" }),
            Val::Raw(v) => out.push_str(v),
        }
    }
    out.push('}');
    out
}

/// Emit `[a,b,c]` from already-rendered elements.
pub fn arr(items: &[String]) -> String {
    format!("[{}]", items.join(","))
}

pub fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The string value of a top-level `key`, unescaped only for `\"` and `\\`.
pub fn field_str(line: &str, key: &str) -> Option<String> {
    let rest = after_key(line, key)?;
    let mut chars = rest.chars();
    if chars.next()? != '"' {
        return None;
    }
    let mut out = String::new();
    let mut escaped = false;
    for c in chars {
        if escaped {
            out.push(match c {
                'n' => '\n',
                't' => '\t',
                'r' => '\r',
                other => other,
            });
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '"' {
            return Some(out);
        } else {
            out.push(c);
        }
    }
    None
}

/// The unsigned value of a top-level `key`. A handle value can exceed i64 on
/// paper, never in practice, but u64 costs nothing here.
pub fn field_u64(line: &str, key: &str) -> Option<u64> {
    let rest = after_key(line, key)?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// The text just after `"key":`, whitespace skipped, or None.
fn after_key<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\"");
    let mut from = 0usize;
    while let Some(offset) = line[from..].find(&needle) {
        let at = from + offset;
        if at_top_level_key(line, at) {
            let after = &line[at + needle.len()..];
            let after = after.trim_start();
            if let Some(value) = after.strip_prefix(':') {
                return Some(value.trim_start());
            }
        }
        from = at + needle.len();
    }
    None
}

/// True when the token at `at` is a key rather than text inside a value: the
/// first non-space character before it opens the object or ends the last field.
fn at_top_level_key(line: &str, at: usize) -> bool {
    matches!(
        line[..at].chars().rev().find(|c| !c.is_whitespace()),
        Some('{') | Some(',')
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn obj_renders_every_value_kind() {
        let rendered = obj(&[
            ("a", s("x")),
            ("b", Val::Num(7)),
            ("c", Val::Bool(true)),
            ("d", Val::Raw("[1,2]".into())),
            ("e", Val::F64(1.5)),
        ]);
        assert_eq!(rendered, r#"{"a":"x","b":7,"c":true,"d":[1,2],"e":1.500}"#);
    }

    #[test]
    fn non_finite_numbers_become_null_rather_than_invalid_json() {
        assert_eq!(obj(&[("a", Val::F64(f64::NAN))]), r#"{"a":null}"#);
    }

    #[test]
    fn quote_escapes_the_characters_that_would_break_a_line() {
        assert_eq!(quote(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(quote("one\ntwo"), r#""one\ntwo""#);
        // Spelled as a contains/length pair rather than a literal, so the
        // expectation cannot itself be mangled by an editor that resolves
        // escapes.
        let control = quote("\u{1}");
        assert!(control.contains("u0001"), "{control}");
        assert_eq!(control.len(), 8);
    }

    #[test]
    fn field_str_reads_a_top_level_string() {
        let line = r#"{"type":"desk","access":"inject"}"#;
        assert_eq!(field_str(line, "type").as_deref(), Some("desk"));
        assert_eq!(field_str(line, "access").as_deref(), Some("inject"));
        assert_eq!(field_str(line, "missing"), None);
    }

    #[test]
    fn a_key_spelled_inside_a_value_does_not_answer_the_lookup() {
        // The bundle's signalUrl really does contain the text `sid` and the
        // golden vector's `site` value really does start with `site_`.
        let line = r#"{"signalUrl":"wss://x/v1/room/"sid":"no"","sid":"sid_1"}"#;
        assert_eq!(field_str(line, "sid").as_deref(), Some("sid_1"));
    }

    #[test]
    fn field_u64_reads_a_top_level_number() {
        let line = r#"{"spikeCanary": 1234, "seconds":30}"#;
        assert_eq!(field_u64(line, "spikeCanary"), Some(1234));
        assert_eq!(field_u64(line, "seconds"), Some(30));
        assert_eq!(field_u64(line, "absent"), None);
    }

    #[test]
    fn arr_joins_rendered_elements() {
        assert_eq!(arr(&["1".into(), "2".into()]), "[1,2]");
        assert_eq!(arr(&[]), "[]");
    }
}
