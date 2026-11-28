//! Shared app state and the bridge between the daemon supervisor and Tauri.

use crate::daemon::{Daemon, DaemonEvents, DaemonStatus};
use crate::keychain::{KeyStore, PROVIDERS};
use crate::redact;
use crate::rpc::{codes, RpcError};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, EventTarget};

pub const MAIN_LABEL: &str = "main";
pub const EVENT_NOTIFICATION: &str = "daemon://notification";
pub const EVENT_STATUS: &str = "daemon://status";

/// A pinned app bundled into a single-app export (see scripts/export-app.mjs).
#[derive(Clone)]
pub struct BundledApp {
    pub id: String,
    pub html: String,
    pub app: Value,
}

pub struct AppState {
    pub daemon: OnceLock<Daemon>,
    pub keys: Arc<dyn KeyStore>,
    pub data_dir: PathBuf,
    pub single_app: Option<BundledApp>,
    /// Pinned windows with an "open this link?" prompt showing (one at a time).
    pub link_prompts: Mutex<HashSet<String>>,
}

impl AppState {
    pub fn daemon(&self) -> Result<&Daemon, RpcError> {
        self.daemon
            .get()
            .ok_or_else(|| RpcError::new(codes::DAEMON_UNAVAILABLE, "the OneSeat daemon is not started yet"))
    }
}

/// Send every stored key to the daemon. Keys go keychain -> here -> daemon stdin only.
pub fn send_keys(daemon: &Daemon, keys: &dyn KeyStore) -> Result<usize, RpcError> {
    let mut sent = 0;
    for provider in PROVIDERS {
        match keys.get(provider) {
            Ok(Some(cred)) => {
                redact::register_secret(&cred.api_key);
                let mut params = json!({ "provider": provider, "apiKey": cred.api_key });
                if let Some(u) = &cred.base_url {
                    params["baseUrl"] = json!(u);
                }
                daemon.call_blocking("auth.set", params, Duration::from_secs(10))?;
                sent += 1;
            }
            Ok(None) => {}
            Err(e) => {
                // Report once per provider without any key material.
                log::warn!(target: "oneseat::keychain", "cannot read the {provider} key: {e}");
            }
        }
    }
    Ok(sent)
}

pub struct ShellEvents {
    pub app: AppHandle,
    pub keys: Arc<dyn KeyStore>,
    pub single_app: Option<BundledApp>,
}

impl DaemonEvents for ShellEvents {
    fn notification(&self, method: &str, params: &Value) {
        // Only the main window listens; pinned windows have no event permission anyway.
        let payload = json!({ "method": method, "params": params });
        if let Err(e) = self
            .app
            .emit_to(EventTarget::webview_window(MAIN_LABEL), EVENT_NOTIFICATION, payload)
        {
            log::debug!(target: "oneseat::daemon", "cannot forward {method}: {e}");
        }
    }

    fn status(&self, status: &DaemonStatus) {
        let _ = self
            .app
            .emit_to(EventTarget::webview_window(MAIN_LABEL), EVENT_STATUS, status);
        log::info!(target: "oneseat::daemon", "daemon {:?} (restarts: {})", status.state, status.restarts);
    }

    fn log(&self, level: log::Level, line: &str) {
        // `line` is already redacted by the supervisor.
        log::log!(target: "oneseat::daemon", level, "{line}");
    }

    fn handshake(&self, daemon: &Daemon) -> Result<Option<String>, RpcError> {
        let hello = daemon.call_blocking(
            "daemon.hello",
            json!({ "client": format!("oneseat-desktop/{}", env!("CARGO_PKG_VERSION")) }),
            Duration::from_secs(15),
        )?;
        if hello.get("protocol").and_then(Value::as_u64) != Some(1) {
            log::error!(target: "oneseat::daemon", "daemon speaks protocol {:?}; this shell speaks 1", hello.get("protocol"));
        }
        let sent = send_keys(daemon, self.keys.as_ref())?;
        log::info!(target: "oneseat::daemon", "sent {sent} key(s) to the daemon");
        if let Some(bundled) = &self.single_app {
            daemon.call_blocking(
                "apps.pin",
                json!({ "html": bundled.html, "app": bundled.app }),
                Duration::from_secs(30),
            )?;
        }
        Ok(hello.get("version").and_then(Value::as_str).map(str::to_string))
    }
}
