//! Windows: the main window, pinned app windows, the tray.

use crate::pinned::{self, Navigation};
use crate::state::{AppState, MAIN_LABEL};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// Pages the main window may show: the bundled UI (or the dev server in debug builds).
pub fn is_main_origin(url: &Url, dev_url: Option<&Url>) -> bool {
    let bundled = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    };
    let dev = dev_url.is_some_and(|d| d.origin() == url.origin());
    bundled || dev || url.as_str() == "about:blank"
}

pub fn show_main(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        let _ = w.unminimize();
        w.show()?;
        let _ = w.set_focus();
        return Ok(());
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_LABEL)
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    let dev_url = if cfg!(debug_assertions) {
        app.config().build.dev_url.clone()
    } else {
        None
    };
    WebviewWindowBuilder::from_config(app, &config)?
        .on_navigation(move |url| {
            let ok = is_main_origin(url, dev_url.as_ref());
            if !ok {
                log::warn!(target: "oneseat::nav", "main window navigation blocked: {}", url.scheme());
            }
            ok
        })
        .on_new_window(move |url, _| {
            log::warn!(target: "oneseat::nav", "main window new-window blocked: {}", url.scheme());
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

/// Open (or focus) the window for a pinned app.
pub fn open_pinned(app: &AppHandle, id: &str) -> Result<(), String> {
    if !pinned::is_valid_app_id(id) {
        return Err("invalid app id".into());
    }
    let label = pinned::label_for(id);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let state = app.state::<AppState>();
    let meta = pinned::read_app_json(&state.data_dir, id).map_err(|e| format!("{e}. Pin the app again."))?;
    if !pinned::app_dir(&state.data_dir, id).join("index.html").is_file() {
        return Err(format!("the page for {id} is missing. Pin the app again."));
    }
    let spec = pinned::WindowSpec::from_app(&meta);
    let nav_app = app.clone();
    let nav_label = label.clone();
    let nav_id = id.to_string();
    let new_app = app.clone();
    let new_label = label.clone();
    let new_id = id.to_string();
    WebviewWindowBuilder::new(app, &label, WebviewUrl::CustomProtocol(pinned::pinned_url(id)))
        .title(&spec.title)
        .inner_size(spec.width, spec.height)
        .min_inner_size(spec.min_width, spec.min_height)
        .resizable(spec.resizable)
        .initialization_script(pinned::PINNED_INIT_JS)
        .disable_drag_drop_handler()
        .devtools(cfg!(debug_assertions))
        .on_navigation(move |url| match pinned::decide_navigation(url, &nav_id) {
            Navigation::Allow => true,
            Navigation::External(u) => {
                confirm_external(&nav_app, &nav_label, u);
                false
            }
            Navigation::Deny => {
                log::warn!(target: "oneseat::nav", "{nav_label}: navigation blocked ({})", url.scheme());
                false
            }
        })
        .on_new_window(move |url, _| {
            if let Navigation::External(u) = pinned::decide_navigation(&url, &new_id) {
                confirm_external(&new_app, &new_label, u);
            }
            NewWindowResponse::Deny
        })
        .build()
        .map_err(|e| format!("cannot open the app window: {e}"))?;
    Ok(())
}

/// A pinned page asked to leave (a link click, a script, target=_blank). Nothing opens
/// unless the person confirms; one prompt per window at a time, so a page cannot spam.
fn confirm_external(app: &AppHandle, label: &str, url: Url) {
    let state = app.state::<AppState>();
    {
        let mut open = state.link_prompts.lock().unwrap_or_else(|e| e.into_inner());
        if !open.insert(label.to_string()) {
            return;
        }
    }
    let shown: String = url.as_str().chars().take(300).collect();
    let mut dialog = app
        .dialog()
        .message(format!(
            "This app wants to open a link in your web browser:\n\n{shown}\n\nOpen it?"
        ))
        .title("Open link in browser?")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Open in browser".into(),
            "Cancel".into(),
        ));
    if let Some(w) = app.get_webview_window(label) {
        dialog = dialog.parent(&w);
    }
    let handle = app.clone();
    let label = label.to_string();
    dialog.show(move |ok| {
        handle
            .state::<AppState>()
            .link_prompts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&label);
        if ok {
            if let Err(e) = handle.opener().open_url(url.as_str(), None::<&str>) {
                log::warn!(target: "oneseat::nav", "cannot open link: {e}");
            }
        }
    });
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open OneSeat", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit OneSeat", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &sep, &quit])?;
    let mut builder = TrayIconBuilder::with_id("oneseat")
        .tooltip("OneSeat")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Err(e) = show_main(app) {
                    log::warn!("cannot show main window: {e}");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_window_origins() {
        let dev = Url::parse("http://localhost:1420").unwrap();
        for ok in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/#/run",
            "http://localhost:1420/src/main.ts",
            "about:blank",
        ] {
            assert!(is_main_origin(&Url::parse(ok).unwrap(), Some(&dev)), "{ok}");
        }
        for bad in [
            "https://example.com/",
            "http://localhost:1421/",
            "oneseat-app://localhost/foo/index.html",
            "file:///etc/hosts",
        ] {
            assert!(!is_main_origin(&Url::parse(bad).unwrap(), Some(&dev)), "{bad}");
        }
        assert!(!is_main_origin(&Url::parse("http://localhost:1420/").unwrap(), None));
    }
}
