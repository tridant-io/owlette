//! A ~60-line JSON writer, so the spike's results file needs no serialisation
//! crate. The spike only ever writes JSON; the browser's report is stored as
//! the raw bytes it posted, never parsed here.

use std::fmt::Write as _;

pub enum J {
    Bool(bool),
    Num(f64),
    Uint(u64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(&'static str, J)>),
}

impl J {
    pub fn s(value: impl Into<String>) -> J {
        J::Str(value.into())
    }

    /// Serialise with two-space indentation, so the results file stays readable
    /// next to the memo that quotes it.
    pub fn render(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, 0);
        out
    }

    fn write(&self, out: &mut String, indent: usize) {
        let pad = "  ".repeat(indent);
        let pad_inner = "  ".repeat(indent + 1);
        match self {
            J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Uint(u) => {
                let _ = write!(out, "{u}");
            }
            J::Num(n) => {
                if n.is_finite() {
                    let _ = write!(out, "{n:.3}");
                } else {
                    out.push_str("null");
                }
            }
            J::Str(s) => {
                out.push('"');
                for c in s.chars() {
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
            }
            J::Arr(items) => {
                if items.is_empty() {
                    out.push_str("[]");
                    return;
                }
                out.push_str("[\n");
                for (i, item) in items.iter().enumerate() {
                    out.push_str(&pad_inner);
                    item.write(out, indent + 1);
                    out.push_str(if i + 1 == items.len() { "\n" } else { ",\n" });
                }
                out.push_str(&pad);
                out.push(']');
            }
            J::Obj(fields) => {
                if fields.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push_str("{\n");
                for (i, (key, value)) in fields.iter().enumerate() {
                    let _ = write!(out, "{pad_inner}\"{key}\": ");
                    value.write(out, indent + 1);
                    out.push_str(if i + 1 == fields.len() { "\n" } else { ",\n" });
                }
                out.push_str(&pad);
                out.push('}');
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::J;

    #[test]
    fn escapes_control_characters_and_quotes() {
        let rendered = J::s("a\"b\\c\nd\u{1}").render();
        // Built from a char rather than written out, so an editor that
        // helpfully interprets escape sequences cannot rewrite the expectation
        // into the very control character this is checking gets escaped.
        let bs = '\\';
        assert_eq!(rendered, format!("\"a{bs}\"b{bs}{bs}c{bs}nd{bs}u0001\""));
    }

    #[test]
    fn renders_nested_structures() {
        let v = J::Obj(vec![
            ("n", J::Uint(3)),
            ("ms", J::Num(1.5)),
            ("ok", J::Bool(true)),
            ("list", J::Arr(vec![J::Uint(1), J::Uint(2)])),
        ]);
        assert_eq!(
            v.render(),
            "{\n  \"n\": 3,\n  \"ms\": 1.500,\n  \"ok\": true,\n  \"list\": [\n    1,\n    2\n  ]\n}"
        );
    }

    #[test]
    fn empty_containers_stay_on_one_line() {
        assert_eq!(J::Arr(vec![]).render(), "[]");
        assert_eq!(J::Obj(vec![]).render(), "{}");
    }
}
