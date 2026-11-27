//! Pinned apps: one self-contained HTML page per app, in its own window.
//!
//! - Window label: `app-<id>`. The app id for `bridge_run` comes from this label only.
//! - Content: served by the `oneseat-app` URI scheme from `<dataDir>/apps/<id>/index.html`,
//!   with the `PINNED_APP_CSP` header. A window can load only its own app's page.
//! - Script surface: `pinned_init.js` defines only `window.oneseat.run(skill, input)`.
//! - Navigation: the page cannot navigate away. http(s)/mailto links open in the system
//!   browser after the person confirms (see lib.rs).

use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::http::{header, Response, StatusCode};
use url::Url;

/// Copied from `PINNED_APP_CSP` in packages/contracts/src/artifact.ts.
/// A unit test reads artifact.ts and fails if the two ever differ.
pub const PINNED_APP_CSP: &str = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src ipc: http://ipc.localhost; frame-src 'none'; object-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

pub const SCHEME: &str = "oneseat-app";
pub const LABEL_PREFIX: &str = "app-";
pub const PINNED_INIT_JS: &str = include_str!("pinned_init.js");
const MAX_ID_LEN: usize = 64;

/// Same rule as `APP_ID_PATTERN` in artifact.ts: lowercase slug.
pub fn is_valid_app_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .split('-')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

pub fn label_for(id: &str) -> String {
    format!("{LABEL_PREFIX}{id}")
}

/// The app id a window may act for, from its label. `None` for the main window and
/// anything that is not exactly `app-<valid id>`.
pub fn app_id_from_label(label: &str) -> Option<&str> {
    label.strip_prefix(LABEL_PREFIX).filter(|id| is_valid_app_id(id))
}

/// URL a pinned window loads. Tauri serves custom schemes as `<scheme>://localhost/...`
/// on macOS and Linux, and as `http://<scheme>.localhost/...` on Windows.
pub fn pinned_url(id: &str) -> Url {
    let s = if cfg!(windows) {
        format!("http://{SCHEME}.localhost/{id}/index.html")
    } else {
        format!("{SCHEME}://localhost/{id}/index.html")
    };
    Url::parse(&s).expect("valid pinned URL")
}

/// True if `url` is this app's own page (any fragment or query is fine).
pub fn is_own_page(url: &Url, id: &str) -> bool {
    let origin_ok = if cfg!(windows) {
        url.scheme() == "http" && url.host_str() == Some(&format!("{SCHEME}.localhost"))
    } else {
        url.scheme() == SCHEME && url.host_str() == Some("localhost")
    };
    origin_ok && page_id(url.path()) == Some(id)
}

/// `/<id>/` or `/<id>/index.html` -> id. Nothing else is served.
pub fn page_id(path: &str) -> Option<&str> {
    let rest = path.strip_prefix('/')?;
    let (id, file) = rest.split_once('/')?;
    if !is_valid_app_id(id) {
        return None;
    }
    matches!(file, "" | "index.html").then_some(id)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Navigation {
    Allow,
    /// Ask the person, then open in the system browser.
    External(Url),
    Deny,
}

pub fn decide_navigation(url: &Url, id: &str) -> Navigation {
    if is_own_page(url, id) || url.as_str() == "about:blank" {
        return Navigation::Allow;
    }
    match url.scheme() {
        "http" | "https" if url.host_str().is_some() && !is_local_host(url) => Navigation::External(url.clone()),
        "mailto" => Navigation::External(url.clone()),
        _ => Navigation::Deny,
    }
}

/// Loopback and Tauri-internal hosts are never opened externally.
fn is_local_host(url: &Url) -> bool {
    match url.host_str() {
        Some(h) => h == "localhost" || h.ends_with(".localhost") || h == "127.0.0.1" || h == "[::1]" || h == "::1",
        None => true,
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AppWindowJson {
    pub width: f64,
    pub height: f64,
    #[serde(rename = "minWidth")]
    pub min_width: Option<f64>,
    #[serde(rename = "minHeight")]
    pub min_height: Option<f64>,
    pub resizable: Option<bool>,
}

/// The part of app.json (AppJson in artifact.ts) the shell needs.
#[derive(Debug, Clone, Deserialize)]
pub struct AppJsonLite {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    pub window: AppWindowJson,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowSpec {
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
    pub resizable: bool,
}

fn clamp(v: f64) -> f64 {
    if v.is_finite() {
        v.clamp(200.0, 4000.0)
    } else {
        800.0
    }
}

impl WindowSpec {
    pub fn from_app(app: &AppJsonLite) -> Self {
        let width = clamp(app.window.width);
        let height = clamp(app.window.height);
        let title: String = app.name.trim().chars().filter(|c| !c.is_control()).take(80).collect();
        WindowSpec {
            title: if title.is_empty() { app.id.clone() } else { title },
            width,
            height,
            min_width: clamp(app.window.min_width.unwrap_or(200.0)).min(width),
            min_height: clamp(app.window.min_height.unwrap_or(200.0)).min(height),
            resizable: app.window.resizable.unwrap_or(true),
        }
    }
}

pub fn app_dir(data_dir: &Path, id: &str) -> PathBuf {
    data_dir.join("apps").join(id)
}

pub fn read_app_json(data_dir: &Path, id: &str) -> Result<AppJsonLite, String> {
    if !is_valid_app_id(id) {
        return Err("invalid app id".into());
    }
    let path = app_dir(data_dir, id).join("app.json");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("cannot read app.json for {id}: {e}"))?;
    let app: AppJsonLite = serde_json::from_str(&text).map_err(|e| format!("app.json for {id} is invalid: {e}"))?;
    if app.id != id {
        return Err(format!("app.json id \"{}\" does not match folder \"{id}\"", app.id));
    }
    Ok(app)
}

const NOT_FOUND_BODY: &[u8] = b"Not found";

fn plain(status: StatusCode, body: &'static [u8]) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, PINNED_APP_CSP)
        .body(body.to_vec())
        .expect("valid response")
}

/// Serve a request on the `oneseat-app` scheme. Only the requesting window's own
/// app page is served, always with the pinned-app CSP.
pub fn serve(data_dir: &Path, webview_label: &str, method: &str, path: &str) -> Response<Vec<u8>> {
    let Some(window_app) = app_id_from_label(webview_label) else {
        return plain(StatusCode::FORBIDDEN, b"Forbidden");
    };
    if method != "GET" && method != "HEAD" {
        return plain(StatusCode::METHOD_NOT_ALLOWED, b"Method not allowed");
    }
    match page_id(path) {
        Some(id) if id == window_app => {}
        Some(_) => return plain(StatusCode::FORBIDDEN, b"Forbidden"),
        None => return plain(StatusCode::NOT_FOUND, NOT_FOUND_BODY),
    }
    let file = app_dir(data_dir, window_app).join("index.html");
    match std::fs::read(&file) {
        Ok(html) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CONTENT_SECURITY_POLICY, PINNED_APP_CSP)
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .header(header::REFERRER_POLICY, "no-referrer")
            .header(header::CACHE_CONTROL, "no-store")
            .header("Cross-Origin-Opener-Policy", "same-origin")
            .body(if method == "HEAD" { Vec::new() } else { html })
            .expect("valid response"),
        Err(_) => plain(StatusCode::NOT_FOUND, NOT_FOUND_BODY),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Evaluate the `PINNED_APP_CSP = [ ... ].join("; ")` expression in artifact.ts.
    fn csp_from_contracts() -> String {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/contracts/src/artifact.ts"
        );
        let src = std::fs::read_to_string(path).expect("read packages/contracts/src/artifact.ts");
        let start = src
            .find("export const PINNED_APP_CSP = [")
            .expect("PINNED_APP_CSP in artifact.ts");
        let rest = &src[start..];
        let end = rest.find("].join(").expect("join(...) after the CSP list");
        let joiner_start = end + "].join(".len();
        let joiner_end = rest[joiner_start..].find(')').expect("join close") + joiner_start;
        let joiner = rest[joiner_start..joiner_end].trim().trim_matches('"').to_string();
        let list = &rest[rest.find('[').unwrap() + 1..end];
        let parts: Vec<String> = regex::Regex::new(r#""([^"]*)""#)
            .unwrap()
            .captures_iter(list)
            .map(|c| c[1].to_string())
            .collect();
        assert!(parts.len() >= 10, "parsed {parts:?}");
        parts.join(&joiner)
    }

    #[test]
    fn csp_matches_contracts() {
        assert_eq!(PINNED_APP_CSP, csp_from_contracts());
    }

    #[test]
    fn app_ids_and_labels() {
        for ok in ["invoice-tracker", "a", "app2", "x-1-y"] {
            assert!(is_valid_app_id(ok), "{ok}");
            assert_eq!(app_id_from_label(&label_for(ok)), Some(ok));
        }
        for bad in [
            "",
            "-a",
            "a-",
            "a--b",
            "A",
            "a_b",
            "a/b",
            "../x",
            "a b",
            "ä",
            &"a".repeat(65),
        ] {
            assert!(!is_valid_app_id(bad), "{bad}");
            assert_eq!(app_id_from_label(&format!("app-{bad}")), None, "{bad}");
        }
        assert_eq!(app_id_from_label("main"), None);
        assert_eq!(app_id_from_label("app-"), None);
        assert_eq!(app_id_from_label("xapp-foo"), None);
        assert_eq!(app_id_from_label("App-foo"), None);
        // The page cannot choose another app: the label is set by the shell when it
        // creates the window, and only the label is consulted.
        assert_eq!(app_id_from_label("app-invoice-tracker"), Some("invoice-tracker"));
    }

    #[test]
    fn page_paths() {
        assert_eq!(page_id("/foo/"), Some("foo"));
        assert_eq!(page_id("/foo/index.html"), Some("foo"));
        for bad in [
            "/",
            "/foo",
            "/foo/app.json",
            "/foo/../bar/index.html",
            "/Foo/",
            "/foo/x/index.html",
            "foo/",
            "//",
        ] {
            assert_eq!(page_id(bad), None, "{bad}");
        }
    }

    #[test]
    fn navigation_rules() {
        let own = pinned_url("foo");
        assert!(is_own_page(&own, "foo"));
        assert!(!is_own_page(&own, "bar"));
        assert_eq!(decide_navigation(&own, "foo"), Navigation::Allow);
        let mut with_hash = own.clone();
        with_hash.set_fragment(Some("tab2"));
        assert_eq!(decide_navigation(&with_hash, "foo"), Navigation::Allow);
        assert_eq!(decide_navigation(&pinned_url("bar"), "foo"), Navigation::Deny);
        let ext = Url::parse("https://example.com/help").unwrap();
        assert_eq!(decide_navigation(&ext, "foo"), Navigation::External(ext.clone()));
        let mail = Url::parse("mailto:hi@example.com").unwrap();
        assert_eq!(decide_navigation(&mail, "foo"), Navigation::External(mail.clone()));
        for denied in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "http://localhost:1420/",
            "http://ipc.localhost/bridge_run",
            "http://127.0.0.1:8080/",
            "tauri://localhost/index.html",
            "ftp://example.com/",
        ] {
            let u = Url::parse(denied).unwrap();
            assert_eq!(decide_navigation(&u, "foo"), Navigation::Deny, "{denied}");
        }
    }

    #[test]
    fn window_spec_from_app_json() {
        let app: AppJsonLite = serde_json::from_str(
            r#"{"id":"foo","name":"  Invoice tracker\u0007 ","version":"1.0.0","window":{"width":640,"height":99999,"minWidth":900,"resizable":false},"allowedSkills":[]}"#,
        )
        .unwrap();
        let spec = WindowSpec::from_app(&app);
        assert_eq!(spec.title, "Invoice tracker");
        assert_eq!(spec.width, 640.0);
        assert_eq!(spec.height, 4000.0);
        assert_eq!(spec.min_width, 640.0); // never larger than the window
        assert_eq!(spec.min_height, 200.0);
        assert!(!spec.resizable);
    }

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oneseat-pinned-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("apps/foo")).unwrap();
        std::fs::create_dir_all(dir.join("apps/bar")).unwrap();
        std::fs::write(dir.join("apps/foo/index.html"), "<h1>foo</h1>").unwrap();
        std::fs::write(dir.join("apps/bar/index.html"), "<h1>bar</h1>").unwrap();
        std::fs::write(
            dir.join("apps/foo/app.json"),
            r#"{"id":"foo","name":"Foo","version":"1.0.0","window":{"width":500,"height":400},"allowedSkills":["a"]}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("apps/bar/app.json"),
            r#"{"id":"other","name":"Bar","version":"1.0.0","window":{"width":500,"height":400},"allowedSkills":[]}"#,
        )
        .unwrap();
        dir
    }

    #[test]
    fn serves_only_the_windows_own_page_with_csp() {
        let home = temp_home("serve");
        let ok = serve(&home, "app-foo", "GET", "/foo/index.html");
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.body(), b"<h1>foo</h1>");
        assert_eq!(ok.headers()[header::CONTENT_SECURITY_POLICY], PINNED_APP_CSP);
        assert_eq!(serve(&home, "app-foo", "GET", "/foo/").status(), StatusCode::OK);
        assert!(serve(&home, "app-foo", "HEAD", "/foo/").body().is_empty());
        // Another app's page, the main window, odd paths and methods are refused.
        assert_eq!(
            serve(&home, "app-foo", "GET", "/bar/index.html").status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            serve(&home, "main", "GET", "/foo/index.html").status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            serve(&home, "app-foo", "GET", "/foo/app.json").status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            serve(&home, "app-foo", "GET", "/foo/../bar/index.html").status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            serve(&home, "app-foo", "POST", "/foo/").status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            serve(&home, "app-gone", "GET", "/gone/").status(),
            StatusCode::NOT_FOUND
        );
        // Error responses carry the CSP too.
        assert_eq!(
            serve(&home, "app-foo", "GET", "/bar/").headers()[header::CONTENT_SECURITY_POLICY],
            PINNED_APP_CSP
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn reads_app_json_and_checks_id() {
        let home = temp_home("json");
        assert_eq!(read_app_json(&home, "foo").unwrap().name, "Foo");
        assert!(read_app_json(&home, "bar").unwrap_err().contains("does not match"));
        assert!(read_app_json(&home, "missing").is_err());
        assert!(read_app_json(&home, "../foo").is_err());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn init_script_exposes_only_oneseat_run() {
        let js = PINNED_INIT_JS;
        // The only command it can invoke is bridge_run.
        let invoked: Vec<String> = regex::Regex::new(r#"invoke\(\s*"([a-zA-Z_:|/\-]+)""#)
            .unwrap()
            .captures_iter(js)
            .map(|c| c[1].to_string())
            .collect();
        assert_eq!(invoked, vec!["bridge_run".to_string()]);
        // The only global it defines is window.oneseat.
        let defined: Vec<String> = regex::Regex::new(r#"defineProperty\(\s*window\s*,\s*"([^"]+)""#)
            .unwrap()
            .captures_iter(js)
            .map(|c| c[1].to_string())
            .collect();
        assert_eq!(defined, vec!["oneseat".to_string()]);
        assert!(
            !regex::Regex::new(r"window\.[A-Za-z_$][\w$]*\s*=[^=]")
                .unwrap()
                .is_match(js),
            "assigns a global"
        );
        assert!(!js.contains("globalThis."), "touches globalThis");
        assert!(js.contains("Object.freeze"));
        assert!(js.contains("writable: false") && js.contains("configurable: false"));
    }
}
