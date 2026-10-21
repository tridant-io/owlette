//! launch arguments, `owlette-swoop://` links, the remembered origin and every
//! navigation pass through [`allowed_origin`], so none of them can point a
//! window anywhere but owlette.app, dev.owlette.app or, in a debug build, a
//! local web dev server.

use tauri::Url;

const ALLOWED_HOSTS: [&str; 2] = ["owlette.app", "dev.owlette.app"];

// `npm run dev` in web/, plain http on any port; a debug build only
const DEV_SERVER_HOST: &str = "localhost";

// plugins.deep-link in tauri.conf.json
const DEEP_LINK_SCHEME: &str = "owlette-swoop";

pub fn allowed_origin(url: &str) -> Option<Url> {
  // the url parser strips some control characters silently; refuse them instead
  if url.chars().any(char::is_control) {
    return None;
  }
  let parsed = Url::parse(url).ok()?;
  if !parsed.username().is_empty() || parsed.password().is_some() {
    return None;
  }
  let host = parsed.host_str()?;
  let allowed = match parsed.scheme() {
    "https" => ALLOWED_HOSTS.contains(&host) && parsed.port().is_none(),
    "http" => cfg!(debug_assertions) && host == DEV_SERVER_HOST,
    _ => false,
  };
  allowed.then_some(parsed)
}

// the scheme is received, never opened: a link only ever becomes https on an
// allowed host, or http on the local web dev server in a debug build
pub fn from_deep_link(link: &str) -> Option<Url> {
  allowed_origin(&rebuilt_deep_link(link, cfg!(debug_assertions))?)
}

// `debug` is a parameter so the release rewrite is tested in a debug build too
fn rebuilt_deep_link(link: &str, debug: bool) -> Option<String> {
  if link.chars().any(char::is_control) {
    return None;
  }
  let parsed = Url::parse(link).ok()?;
  if parsed.scheme() != DEEP_LINK_SCHEME
    || !parsed.username().is_empty()
    || parsed.password().is_some()
  {
    return None;
  }
  // an empty host would let the path's first segment become the https host
  let host = parsed.host_str().filter(|host| !host.is_empty())?;
  let dev_server = debug && host.eq_ignore_ascii_case(DEV_SERVER_HOST);
  let mut rebuilt = match (dev_server, parsed.port()) {
    (true, Some(port)) => format!("http://{host}:{port}"),
    (true, None) => format!("http://{host}"),
    (false, None) => format!("https://{host}"),
    // owlette.app is never served on a port
    (false, Some(_)) => return None,
  };
  rebuilt.push_str(parsed.path());
  if let Some(query) = parsed.query() {
    rebuilt.push('?');
    rebuilt.push_str(query);
  }
  if let Some(fragment) = parsed.fragment() {
    rebuilt.push('#');
    rebuilt.push_str(fragment);
  }
  Some(rebuilt)
}

// for the log: a query may one day carry a one-time sign-in code
pub fn redacted(url: &Url) -> String {
  format!("{}{}", url.origin().ascii_serialization(), url.path())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn owlette_pages_are_accepted() {
    for (given, loaded) in [
      ("https://owlette.app", "https://owlette.app/"),
      ("https://owlette.app/swoop", "https://owlette.app/swoop"),
      (
        "https://dev.owlette.app/swoop/site-1/B4A?x=1#top",
        "https://dev.owlette.app/swoop/site-1/B4A?x=1#top",
      ),
      ("https://OWLETTE.app/swoop", "https://owlette.app/swoop"),
      ("https://owlette.app:443/swoop", "https://owlette.app/swoop"),
    ] {
      let url = allowed_origin(given).unwrap_or_else(|| panic!("{given} should be accepted"));
      assert_eq!(url.as_str(), loaded, "{given}");
    }
  }

  #[test]
  fn everything_else_is_refused() {
    for refused in [
      "",
      "owlette.app",
      "not a url",
      "http://owlette.app/swoop",
      "ftp://owlette.app/",
      "file:///C:/Windows/System32/cmd.exe",
      "javascript:alert(1)",
      "owlette-swoop://owlette.app/swoop",
      "https://evil.com/swoop",
      "https://owlette.app.evil.com/",
      "https://evilowlette.app/",
      "https://owlette.app./",
      "https://swoop.dev.owlette.app/",
      "https://user@owlette.app/",
      "https://user:pass@owlette.app/",
      "https://owlette.app:8443/",
      "https://owlette.app/swoop\r\nx",
      "https://owlette.app/\u{0}",
      "\thttps://owlette.app/",
      "http://127.0.0.1:3000/swoop",
      "https://localhost:3000/swoop",
    ] {
      assert!(
        allowed_origin(refused).is_none(),
        "{refused:?} should be refused"
      );
    }
  }

  #[test]
  fn localhost_is_a_debug_build_only_origin() {
    for local in ["http://localhost:3000/swoop", "http://localhost/swoop"] {
      assert_eq!(
        allowed_origin(local).is_some(),
        cfg!(debug_assertions),
        "{local}"
      );
    }
  }

  #[test]
  fn a_deep_link_becomes_the_same_page_over_https() {
    for (link, loaded) in [
      (
        "owlette-swoop://owlette.app/swoop/site-1/B4A",
        "https://owlette.app/swoop/site-1/B4A",
      ),
      (
        "owlette-swoop://dev.owlette.app/swoop?site=site-1",
        "https://dev.owlette.app/swoop?site=site-1",
      ),
      (
        "owlette-swoop://dev.owlette.app/swoop/s/m.local#stats",
        "https://dev.owlette.app/swoop/s/m.local#stats",
      ),
      (
        "OWLETTE-SWOOP://Owlette.App/swoop",
        "https://owlette.app/swoop",
      ),
      ("owlette-swoop://owlette.app", "https://owlette.app/"),
    ] {
      let url = from_deep_link(link).unwrap_or_else(|| panic!("{link} should be accepted"));
      assert_eq!(url.as_str(), loaded, "{link}");
    }
  }

  #[test]
  fn a_deep_link_is_held_to_the_same_hosts() {
    for refused in [
      "owlette-swoop://evil.com/swoop",
      "owlette-swoop://owlette.app.evil.com/swoop",
      "owlette-swoop://user@owlette.app/swoop",
      "owlette-swoop://user:pass@owlette.app/swoop",
      "owlette-swoop://owlette.app:8443/swoop",
      "owlette-swoop://127.0.0.1:3000/swoop",
      "owlette-swoop://localhost.evil.com:3000/swoop",
      "owlette-swoop:swoop",
      "owlette-swoop:///swoop",
      "owlette-swoop:///owlette.app/swoop",
      "owlette-swoop://owlette.app/swoop\r\nx",
      "https://owlette.app/swoop",
      "other-scheme://owlette.app/swoop",
      "",
    ] {
      assert!(
        from_deep_link(refused).is_none(),
        "{refused:?} should be refused"
      );
    }
  }

  #[test]
  fn a_path_cannot_move_the_host() {
    let url = from_deep_link("owlette-swoop://owlette.app//evil.com/x").expect("same host");
    assert_eq!(url.host_str(), Some("owlette.app"));
    let url = from_deep_link("owlette-swoop://owlette.app/\\evil.com/x").expect("same host");
    assert_eq!(url.host_str(), Some("owlette.app"));
  }

  #[test]
  fn only_a_debug_build_rewrites_a_dev_server_link_to_http() {
    for (link, debug, rebuilt) in [
      (
        "owlette-swoop://localhost:3000/swoop",
        true,
        Some("http://localhost:3000/swoop"),
      ),
      (
        "owlette-swoop://localhost/swoop",
        true,
        Some("http://localhost/swoop"),
      ),
      (
        "owlette-swoop://dev.owlette.app/swoop",
        true,
        Some("https://dev.owlette.app/swoop"),
      ),
      ("owlette-swoop://dev.owlette.app:3000/swoop", true, None),
      ("owlette-swoop://127.0.0.1:3000/swoop", true, None),
      ("owlette-swoop://localhost:3000/swoop", false, None),
      // which allowed_origin then refuses
      (
        "owlette-swoop://localhost/swoop",
        false,
        Some("https://localhost/swoop"),
      ),
      (
        "owlette-swoop://dev.owlette.app/swoop",
        false,
        Some("https://dev.owlette.app/swoop"),
      ),
    ] {
      assert_eq!(
        rebuilt_deep_link(link, debug).as_deref(),
        rebuilt,
        "{link} (debug {debug})"
      );
    }
  }

  #[test]
  fn a_dev_server_link_opens_in_a_debug_build_only() {
    for (link, loaded) in [
      (
        "owlette-swoop://localhost:3000/swoop",
        "http://localhost:3000/swoop",
      ),
      (
        "owlette-swoop://LOCALHOST:3000/app-link?code=x&next=%2Fswoop#y",
        "http://localhost:3000/app-link?code=x&next=%2Fswoop#y",
      ),
    ] {
      assert_eq!(
        from_deep_link(link).as_ref().map(Url::as_str),
        cfg!(debug_assertions).then_some(loaded),
        "{link}"
      );
    }
  }

  #[test]
  fn the_log_never_sees_a_query() {
    let url = allowed_origin("https://owlette.app/app-link?code=secret#x").expect("allowed");
    assert_eq!(redacted(&url), "https://owlette.app/app-link");
  }
}
