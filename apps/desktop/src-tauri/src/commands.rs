//! Tauri commands. Capabilities decide which window may call which command
//! (capabilities/*.json); each command also checks the calling window's label itself.

use crate::allowlist;
use crate::daemon::DaemonStatus;
use crate::keychain::{self, KeyStoreError, PROVIDERS};
use crate::pinned;
use crate::redact;
use crate::rpc::{codes, RpcError};
use crate::state::{AppState, MAIN_LABEL};
use crate::windows;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, State, Webview};

pub const MAX_BRIDGE_INPUT_BYTES: usize = 1024 * 1024;

fn forbidden(msg: &str) -> RpcError {
    RpcError::new(codes::FORBIDDEN, msg)
}

/// Main-window-only commands.
pub fn require_main(label: &str) -> Result<(), RpcError> {
    if label == MAIN_LABEL {
        Ok(())
    } else {
        Err(forbidden("this command is only available in the OneSeat main window"))
    }
}

/// `daemon_call` gate: the main window, and an allowlisted method.
pub fn check_daemon_call(label: &str, method: &str) -> Result<(), RpcError> {
    require_main(label)?;
    if allowlist::is_ui_allowed(method) {
        Ok(())
    } else {
        let shown: String = method.chars().take(64).collect();
        Err(forbidden(&format!(
            "the method \"{shown}\" cannot be called from the UI"
        )))
    }
}

/// `bridge_run` gate: the app id comes from the window label, never from the page.
pub fn bridge_app_id(label: &str) -> Result<String, RpcError> {
    pinned::app_id_from_label(label)
        .map(str::to_string)
        .ok_or_else(|| forbidden("bridge_run is only available in pinned app windows"))
}

pub fn validate_bridge_input(skill: &str, input: &Value) -> Result<(), String> {
    if !pinned::is_valid_app_id(skill) {
        return Err("skill must be a skill name".into());
    }
    match input {
        Value::String(_) | Value::Object(_) => {}
        _ => return Err("input must be a string or an object".into()),
    }
    if input.to_string().len() > MAX_BRIDGE_INPUT_BYTES {
        return Err("input is too large".into());
    }
    Ok(())
}

pub fn method_timeout(method: &str) -> Duration {
    match method {
        "skills.inspect" | "skills.install" => Duration::from_secs(300),
        "apps.run" => Duration::from_secs(600),
        _ => Duration::from_secs(60),
    }
}

#[tauri::command]
pub async fn daemon_call(
    webview: Webview,
    state: State<'_, AppState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    check_daemon_call(webview.label(), &method)?;
    let params = params.unwrap_or_else(|| json!({}));
    if !params.is_object() {
        return Err(RpcError::new(codes::INVALID_PARAMS, "params must be an object"));
    }
    let daemon = state.daemon()?.clone();
    daemon
        .call(&method, params, method_timeout(&method))
        .await
        .map_err(|mut e| {
            e.message = redact::redact(&e.message);
            e
        })
}

#[tauri::command]
pub fn daemon_status(webview: Webview, state: State<'_, AppState>) -> Result<DaemonStatus, RpcError> {
    require_main(webview.label())?;
    Ok(state.daemon()?.status())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeychainStatus {
    pub available: bool,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKeyStatus {
    pub provider: String,
    /// A key for this provider is in the OS keychain.
    pub stored: bool,
    /// The daemon has a key for this provider (null if the daemon did not answer).
    pub active: Option<bool>,
    pub base_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub keychain: KeychainStatus,
    pub providers: Vec<ProviderKeyStatus>,
    pub daemon: Option<DaemonStatus>,
}

fn keychain_error(e: KeyStoreError) -> RpcError {
    match e {
        KeyStoreError::Unavailable(_) => RpcError::new(codes::KEYCHAIN, keychain::NO_KEYCHAIN_MESSAGE),
        KeyStoreError::Other(m) => RpcError::new(codes::KEYCHAIN, format!("The keychain refused the request: {m}")),
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, RpcError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| RpcError::new(codes::INTERNAL, format!("task failed: {e}")))
}

async fn collect_status(state: &AppState) -> KeyStatus {
    let keys = state.keys.clone();
    let local = blocking(move || {
        let probe = keys.probe();
        let entries: Vec<_> = PROVIDERS
            .iter()
            .map(|p| (p.to_string(), keys.get(p).ok().flatten().map(|c| c.base_url)))
            .collect();
        (probe, entries)
    })
    .await;
    let (probe, entries) = match local {
        Ok(v) => v,
        Err(e) => (Err(KeyStoreError::Other(e.message)), Vec::new()),
    };
    let daemon = state.daemon.get().cloned();
    let active = match &daemon {
        Some(d) => d.call("auth.status", json!({}), Duration::from_secs(5)).await.ok(),
        None => None,
    };
    let providers = PROVIDERS
        .iter()
        .map(|p| {
            let entry = entries.iter().find(|(name, _)| name == p);
            ProviderKeyStatus {
                provider: p.to_string(),
                stored: entry.is_some_and(|(_, v)| v.is_some()),
                active: active.as_ref().and_then(|a| a.get(*p)).and_then(Value::as_bool),
                base_url: entry.and_then(|(_, v)| v.clone().flatten()),
            }
        })
        .collect();
    KeyStatus {
        keychain: match probe {
            Ok(()) => KeychainStatus {
                available: true,
                message: None,
            },
            Err(e) => KeychainStatus {
                available: false,
                message: Some(keychain_error(e).message),
            },
        },
        providers,
        daemon: daemon.map(|d| d.status()),
    }
}

#[tauri::command]
pub async fn key_status(webview: Webview, state: State<'_, AppState>) -> Result<KeyStatus, RpcError> {
    require_main(webview.label())?;
    Ok(collect_status(&state).await)
}

/// Store a key in the OS keychain, then hand it to the daemon. The key is never echoed
/// back, logged, or included in an error.
#[tauri::command]
pub async fn key_save(
    webview: Webview,
    state: State<'_, AppState>,
    provider: String,
    api_key: String,
    base_url: Option<String>,
) -> Result<KeyStatus, RpcError> {
    require_main(webview.label())?;
    let cred = keychain::validate_credential(&provider, &api_key, base_url.as_deref())
        .map_err(|m| RpcError::new(codes::INVALID_PARAMS, m))?;
    drop(api_key);
    let keys = state.keys.clone();
    let (p, c) = (provider.clone(), cred.clone());
    blocking(move || keys.set(&p, &c)).await?.map_err(keychain_error)?;
    redact::register_secret(&cred.api_key);
    // Read back from the keychain, so the daemon gets exactly what is stored.
    let keys = state.keys.clone();
    let p = provider.clone();
    let stored = blocking(move || keys.get(&p)).await?.map_err(keychain_error)?;
    let stored =
        stored.ok_or_else(|| RpcError::new(codes::KEYCHAIN, "the keychain did not keep the key; try again"))?;
    let mut params = json!({ "provider": provider, "apiKey": stored.api_key });
    if let Some(u) = &stored.base_url {
        params["baseUrl"] = json!(u);
    }
    if let Some(d) = state.daemon.get() {
        if let Err(e) = d.call("auth.set", params, Duration::from_secs(15)).await {
            // The key is safe in the keychain; the handshake sends it on the next start.
            log::warn!(target: "oneseat::keychain", "saved the {provider} key, but the daemon did not take it: {}", redact::redact(&e.message));
        }
    }
    Ok(collect_status(&state).await)
}

#[tauri::command]
pub async fn key_delete(webview: Webview, state: State<'_, AppState>, provider: String) -> Result<KeyStatus, RpcError> {
    require_main(webview.label())?;
    keychain::validate_provider(&provider).map_err(|m| RpcError::new(codes::INVALID_PARAMS, m))?;
    let keys = state.keys.clone();
    let p = provider.clone();
    let old = blocking(move || keys.get(&p)).await?.ok().flatten();
    let keys = state.keys.clone();
    let p = provider.clone();
    blocking(move || keys.delete(&p)).await?.map_err(keychain_error)?;
    if let Some(d) = state.daemon.get() {
        let _ = d
            .call("auth.clear", json!({ "provider": provider }), Duration::from_secs(10))
            .await;
    }
    if let Some(c) = old {
        redact::forget_secret(&c.api_key);
    }
    Ok(collect_status(&state).await)
}

#[tauri::command]
pub async fn pin_open(webview: Webview, app: AppHandle, app_id: String) -> Result<(), RpcError> {
    require_main(webview.label())?;
    // Window creation must not block the main thread on Windows: run it off-thread.
    let handle = app.clone();
    blocking(move || windows::open_pinned(&handle, &app_id))
        .await?
        .map_err(|m| RpcError::new(codes::NOT_FOUND, m))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub dir: String,
    pub command: String,
}

/// Copy a pinned app's files to <dataDir>/exports/<id>/ for scripts/export-app.mjs.
pub fn export_app_files(data_dir: &std::path::Path, id: &str) -> Result<ExportResult, String> {
    let app = pinned::read_app_json(data_dir, id)?;
    let src = pinned::app_dir(data_dir, id);
    let out = data_dir.join("exports").join(&app.id);
    std::fs::create_dir_all(&out).map_err(|e| format!("cannot create {}: {e}", out.display()))?;
    for f in ["index.html", "app.json"] {
        std::fs::copy(src.join(f), out.join(f)).map_err(|e| format!("cannot copy {f}: {e}"))?;
    }
    let dir = out.display().to_string();
    Ok(ExportResult {
        command: format!("pnpm --filter @oneseat/desktop export-app -- --app \"{dir}\""),
        dir,
    })
}

#[tauri::command]
pub async fn app_export(
    webview: Webview,
    state: State<'_, AppState>,
    app_id: String,
) -> Result<ExportResult, RpcError> {
    require_main(webview.label())?;
    let data_dir = state.data_dir.clone();
    blocking(move || export_app_files(&data_dir, &app_id))
        .await?
        .map_err(|m| RpcError::new(codes::NOT_FOUND, m))
}

/// The only command a pinned window can call. Runs `apps.run` for the window's own app.
/// Always resolves with a BridgeResult (`{ ok, text, data?, error? }`), except when called
/// from a window that is not a pinned app.
#[tauri::command]
pub async fn bridge_run(
    webview: Webview,
    state: State<'_, AppState>,
    skill: String,
    input: Value,
) -> Result<Value, RpcError> {
    let app_id = bridge_app_id(webview.label())?;
    if let Err(m) = validate_bridge_input(&skill, &input) {
        return Ok(json!({ "ok": false, "text": "", "error": m }));
    }
    let daemon = match state.daemon() {
        Ok(d) => d.clone(),
        Err(e) => return Ok(json!({ "ok": false, "text": "", "error": e.message })),
    };
    let params = json!({ "appId": app_id, "skill": skill, "input": input });
    match daemon.call("apps.run", params, method_timeout("apps.run")).await {
        Ok(v) => Ok(v),
        Err(e) => Ok(json!({ "ok": false, "text": "", "error": redact::redact(&e.message) })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daemon_call_gate() {
        assert!(check_daemon_call("main", "harness.run").is_ok());
        assert!(check_daemon_call("main", "skills.install").is_ok());
        assert_eq!(
            check_daemon_call("main", "apps.run").unwrap_err().code,
            codes::FORBIDDEN
        );
        assert_eq!(
            check_daemon_call("main", "auth.set").unwrap_err().code,
            codes::FORBIDDEN
        );
        assert_eq!(
            check_daemon_call("main", "fake.crash").unwrap_err().code,
            codes::FORBIDDEN
        );
        // A pinned window can call nothing through daemon_call, even allowlisted methods.
        assert_eq!(
            check_daemon_call("app-foo", "harness.run").unwrap_err().code,
            codes::FORBIDDEN
        );
        assert_eq!(
            check_daemon_call("app-foo", "apps.run").unwrap_err().code,
            codes::FORBIDDEN
        );
        assert!(require_main("main").is_ok());
        assert!(require_main("app-main").is_err());
        assert!(require_main("Main").is_err());
    }

    #[test]
    fn bridge_gate_uses_only_the_label() {
        assert_eq!(bridge_app_id("app-invoice-tracker").unwrap(), "invoice-tracker");
        assert_eq!(bridge_app_id("main").unwrap_err().code, codes::FORBIDDEN);
        assert_eq!(bridge_app_id("app-../x").unwrap_err().code, codes::FORBIDDEN);
        assert_eq!(bridge_app_id("app-").unwrap_err().code, codes::FORBIDDEN);
    }

    #[test]
    fn bridge_input_rules() {
        assert!(validate_bridge_input("invoice-chaser", &json!("hi")).is_ok());
        assert!(validate_bridge_input("invoice-chaser", &json!({ "a": 1 })).is_ok());
        assert!(validate_bridge_input("Invoice", &json!("hi")).is_err());
        assert!(validate_bridge_input("invoice-chaser", &json!([1])).is_err());
        assert!(validate_bridge_input("invoice-chaser", &json!(null)).is_err());
        assert!(validate_bridge_input("invoice-chaser", &json!(3)).is_err());
        let big = "x".repeat(MAX_BRIDGE_INPUT_BYTES + 1);
        assert!(validate_bridge_input("invoice-chaser", &json!(big)).is_err());
    }

    #[test]
    fn timeouts() {
        assert_eq!(method_timeout("skills.install"), Duration::from_secs(300));
        assert_eq!(method_timeout("apps.list"), Duration::from_secs(60));
    }

    #[test]
    fn export_copies_bundle() {
        let home = std::env::temp_dir().join(format!("oneseat-export-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("apps/foo")).unwrap();
        std::fs::write(home.join("apps/foo/index.html"), "<p>x</p>").unwrap();
        std::fs::write(
            home.join("apps/foo/app.json"),
            r#"{"id":"foo","name":"Foo","version":"1.2.3","window":{"width":500,"height":400},"allowedSkills":[]}"#,
        )
        .unwrap();
        let r = export_app_files(&home, "foo").unwrap();
        assert!(std::path::Path::new(&r.dir).join("index.html").is_file());
        assert!(std::path::Path::new(&r.dir).join("app.json").is_file());
        assert!(r.command.contains("export-app"));
        assert!(export_app_files(&home, "nope").is_err());
        let _ = std::fs::remove_dir_all(&home);
    }
}
