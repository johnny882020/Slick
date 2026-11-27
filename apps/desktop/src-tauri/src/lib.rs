//! OneSeat desktop shell (Tauri 2).
//!
//! - Spawns the harness daemon (JSON-RPC over stdio) and restarts it if it dies.
//! - Keeps model keys in the OS keychain and hands them to the daemon directly.
//! - Hosts pinned apps in their own windows, reachable only through `oneseat.run`.

pub mod allowlist;
pub mod commands;
pub mod daemon;
pub mod keychain;
pub mod pinned;
pub mod redact;
pub mod rpc;
pub mod state;
pub mod windows;

use daemon::{Backoff, Daemon};
use keychain::{KeyStore, MemoryKeyStore, OsKeychain};
use state::{AppState, BundledApp, ShellEvents};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Manager, RunEvent};

/// Starter skills the daemon installs on first run (each still goes through scan + lint).
/// Release: the `skills` resource folder. Debug: the repo's top-level `skills/`.
fn bundled_skills_dir(debug: bool, resource_dir: Option<PathBuf>, manifest_dir: &Path) -> Option<PathBuf> {
    let dir = if debug {
        manifest_dir.join("..").join("..").join("..").join("skills")
    } else {
        resource_dir?.join("skills")
    };
    dir.is_dir().then_some(dir)
}

/// Single-app export: a pinned app bundled as resources `pinned/index.html` + `pinned/app.json`.
fn bundled_app(resource_dir: Option<PathBuf>) -> Option<BundledApp> {
    let dir = resource_dir?.join("pinned");
    let app_text = std::fs::read_to_string(dir.join("app.json")).ok()?;
    let html = std::fs::read_to_string(dir.join("index.html")).ok()?;
    let app: serde_json::Value = serde_json::from_str(&app_text).ok()?;
    let id = app.get("id")?.as_str()?.to_string();
    pinned::is_valid_app_id(&id).then_some(BundledApp { id, html, app })
}

/// The data dir. A single-app export shares the main OneSeat data dir (skills, apps,
/// schedules), so it uses the "app.oneseat" folder next to its own.
fn data_dir_for(own: PathBuf, single_app: bool) -> PathBuf {
    if single_app {
        if let Some(parent) = own.parent() {
            return parent.join("app.oneseat");
        }
    }
    own
}

fn key_store() -> Arc<dyn KeyStore> {
    if cfg!(debug_assertions) && std::env::var("ONESEAT_DEV_MEMORY_KEYSTORE").as_deref() == Ok("1") {
        log::warn!("ONESEAT_DEV_MEMORY_KEYSTORE=1: keys are kept in memory only (debug builds only)");
        return Arc::new(MemoryKeyStore::new());
    }
    Arc::new(OsKeychain)
}

fn has_any_key(keys: &dyn KeyStore) -> bool {
    keychain::PROVIDERS.iter().any(|p| matches!(keys.get(p), Ok(Some(_))))
}

/// Open a pinned app window once the daemon is running (or after 20 s, whichever is first).
fn open_when_ready(handle: tauri::AppHandle, id: String) {
    std::thread::spawn(move || {
        let state = handle.state::<AppState>();
        for _ in 0..200 {
            if state
                .daemon
                .get()
                .is_some_and(|d| d.status().state == daemon::DaemonState::Running)
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if let Err(e) = windows::open_pinned(&handle, &id) {
            log::error!("cannot open app {id}: {e}");
        }
    });
}

pub fn run() {
    let log_plugin = tauri_plugin_log::Builder::new()
        .targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("oneseat".into()),
            }),
        ])
        .level(log::LevelFilter::Info)
        .level_for("oneseat::daemon", log::LevelFilter::Info)
        // Belt and braces: everything that reaches the log file goes through redaction.
        .format(|out, message, record| {
            out.finish(format_args!(
                "[{}][{}] {}",
                record.level(),
                record.target(),
                redact::redact(&message.to_string())
            ))
        })
        .build();

    let daemon_slot: Arc<OnceLock<Daemon>> = Arc::new(OnceLock::new());
    let exit_slot = daemon_slot.clone();

    let app = tauri::Builder::default()
        .plugin(log_plugin)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .register_uri_scheme_protocol(pinned::SCHEME, |ctx, request| {
            match ctx.app_handle().try_state::<AppState>() {
                Some(state) => pinned::serve(
                    &state.data_dir,
                    ctx.webview_label(),
                    request.method().as_str(),
                    request.uri().path(),
                ),
                None => pinned::serve(Path::new(""), "", "GET", "/"),
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::daemon_call,
            commands::daemon_status,
            commands::key_save,
            commands::key_delete,
            commands::key_status,
            commands::pin_open,
            commands::app_export,
            commands::bridge_run,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let single = bundled_app(app.path().resource_dir().ok());
            let own_dir = app.path().app_data_dir()?;
            let mut data_dir = data_dir_for(own_dir, single.is_some());
            // Debug builds only: a throwaway data dir (native smoke test, parallel dev copies).
            if cfg!(debug_assertions) {
                if let Some(dir) = std::env::var_os("ONESEAT_DEV_DATA_DIR").filter(|d| !d.is_empty()) {
                    data_dir = PathBuf::from(dir);
                }
            }
            std::fs::create_dir_all(data_dir.join("apps"))?;
            let keys = key_store();
            app.manage(AppState {
                daemon: OnceLock::new(),
                keys: keys.clone(),
                data_dir: data_dir.clone(),
                single_app: single.clone(),
                link_prompts: Mutex::new(Default::default()),
            });

            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(Path::to_path_buf));
            let spec = daemon::resolve_spec(
                cfg!(debug_assertions),
                std::env::var("ONESEAT_DAEMON").ok().as_deref(),
                std::env::var("ONESEAT_NODE").ok().as_deref(),
                Path::new(env!("CARGO_MANIFEST_DIR")),
                exe_dir.as_deref(),
                &data_dir,
            );
            match spec {
                Ok(mut spec) => {
                    let resource_dir = app.path().resource_dir().ok();
                    match bundled_skills_dir(
                        cfg!(debug_assertions),
                        resource_dir.clone(),
                        Path::new(env!("CARGO_MANIFEST_DIR")),
                    ) {
                        Some(dir) => {
                            log::info!("starter skills: {}", dir.display());
                            spec.env.push(("ONESEAT_BUNDLED_SKILLS".to_string(), dir.into_os_string()));
                        }
                        None => log::warn!(
                            "no starter skills folder (resource dir: {})",
                            resource_dir.map(|d| d.display().to_string()).unwrap_or_else(|| "unknown".into())
                        ),
                    }
                    log::info!("starting daemon: {}", spec.description);
                    let events = Arc::new(ShellEvents {
                        app: handle.clone(),
                        keys: keys.clone(),
                        single_app: single.clone(),
                    });
                    let d = Daemon::start(spec, events, Backoff::default());
                    let _ = daemon_slot.set(d.clone());
                    let _ = app.state::<AppState>().daemon.set(d);
                }
                Err(e) => log::error!("{e}"),
            }

            match &single {
                Some(bundled) => {
                    // Single-app build: open the app; the main window only if a key is missing.
                    if !has_any_key(keys.as_ref()) {
                        windows::show_main(&handle)?;
                    }
                    // Wait for the daemon to pin the bundled app, then open it.
                    open_when_ready(handle.clone(), bundled.id.clone());
                }
                None => {
                    windows::show_main(&handle)?;
                    if let Err(e) = windows::build_tray(&handle) {
                        log::warn!("no tray icon: {e}");
                    }
                    // Debug builds only: open a pinned app at startup (native smoke tests).
                    if cfg!(debug_assertions) {
                        if let Ok(id) = std::env::var("ONESEAT_DEV_OPEN_APP") {
                            open_when_ready(handle.clone(), id);
                        }
                    }
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building OneSeat");

    app.run(move |_app, event| {
        if let RunEvent::Exit = event {
            if let Some(d) = exit_slot.get() {
                d.shutdown();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_app_uses_main_data_dir() {
        let own = PathBuf::from("/home/u/.local/share/app.oneseat.pinned.invoice-tracker");
        assert_eq!(
            data_dir_for(own.clone(), true),
            PathBuf::from("/home/u/.local/share/app.oneseat")
        );
        assert_eq!(data_dir_for(own.clone(), false), own);
    }

    #[test]
    fn finds_bundled_skills() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let debug = bundled_skills_dir(true, None, manifest).expect("repo skills/ in debug");
        assert!(debug.join("customers").join("SKILL.md").is_file());
        let tmp = std::env::temp_dir().join(format!("oneseat-res-{}", std::process::id()));
        std::fs::create_dir_all(tmp.join("skills")).unwrap();
        assert_eq!(bundled_skills_dir(false, Some(tmp.clone()), manifest), Some(tmp.join("skills")));
        assert_eq!(bundled_skills_dir(false, None, manifest), None);
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn reads_bundled_app_resources() {
        let dir = std::env::temp_dir().join(format!("oneseat-bundled-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(bundled_app(Some(dir.clone())).is_none());
        std::fs::create_dir_all(dir.join("pinned")).unwrap();
        std::fs::write(dir.join("pinned/index.html"), "<p>hi</p>").unwrap();
        std::fs::write(dir.join("pinned/app.json"), r#"{"id":"Bad Id"}"#).unwrap();
        assert!(bundled_app(Some(dir.clone())).is_none());
        std::fs::write(dir.join("pinned/app.json"), r#"{"id":"good-id","name":"Good"}"#).unwrap();
        let b = bundled_app(Some(dir.clone())).unwrap();
        assert_eq!(b.id, "good-id");
        assert_eq!(b.html, "<p>hi</p>");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
