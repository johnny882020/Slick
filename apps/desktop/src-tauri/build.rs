// Build script.
//
// 1. Declares the app's own commands so Tauri generates one permission per command
//    (allow-daemon-call, allow-bridge-run, ...). Capabilities in capabilities/*.json then
//    decide which window may call which command: `main` gets everything but bridge_run,
//    `app-*` windows get only bridge_run.
// 2. Makes sure the daemon sidecar named in tauri.conf.json `bundle.externalBin`
//    (binaries/oneseat-daemon-<target-triple>[.exe]) exists. tauri-build refuses to build
//    without it. In debug builds (cargo build / cargo test / tauri dev) the app runs the
//    daemon with `node` and never uses this file, so we write a small placeholder. A
//    release build with a missing or placeholder sidecar fails here with instructions.

use std::path::PathBuf;

const PLACEHOLDER_MARKER: &str = "ONESEAT_SIDECAR_PLACEHOLDER";

pub const COMMANDS: &[&str] = &[
    "daemon_call",
    "daemon_status",
    "key_save",
    "key_delete",
    "key_status",
    "pin_open",
    "app_export",
    "bridge_run",
];

/// Sidecars in tauri.conf.json `bundle.externalBin`: the daemon and the Deno binary its
/// script sandbox runs (installed side by side; the daemon finds `deno` next to itself).
const SIDECARS: &[&str] = &["oneseat-daemon", "deno"];

fn ensure_sidecars() {
    for name in SIDECARS {
        ensure_sidecar(name);
    }
}

fn ensure_sidecar(name: &str) {
    let target = std::env::var("TARGET").expect("cargo sets TARGET");
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let ext = if target.contains("windows") { ".exe" } else { "" };
    let dir = PathBuf::from("binaries");
    let file = dir.join(format!("{name}-{target}{ext}"));
    println!("cargo:rerun-if-changed={}", file.display());
    let is_placeholder = std::fs::read(&file)
        .map(|b| {
            b.windows(PLACEHOLDER_MARKER.len())
                .any(|w| w == PLACEHOLDER_MARKER.as_bytes())
                && b.len() < 4096
        })
        .ok();
    match (profile.as_str(), is_placeholder) {
        ("release", None) | ("release", Some(true)) => {
            if std::env::var("ONESEAT_ALLOW_PLACEHOLDER_SIDECAR").as_deref() == Ok("1") {
                println!("cargo:warning=release build with a placeholder daemon sidecar (ONESEAT_ALLOW_PLACEHOLDER_SIDECAR=1)");
                if is_placeholder.is_none() {
                    write_placeholder(&dir, &file);
                }
                return;
            }
            panic!(
                "missing sidecar {}.\nBuild it first: pnpm --filter @oneseat/daemon run build:sidecar\n(it writes apps/desktop/src-tauri/binaries/oneseat-daemon-<target-triple>[.exe] and deno-<target-triple>[.exe])",
                file.display()
            );
        }
        (_, None) => write_placeholder(&dir, &file),
        _ => {}
    }
}

fn write_placeholder(dir: &PathBuf, file: &PathBuf) {
    std::fs::create_dir_all(dir).expect("create binaries/");
    let body = format!(
        "#!/bin/sh\n# {PLACEHOLDER_MARKER}: debug builds run the daemon with node (see README).\necho 'oneseat-daemon placeholder: build the real sidecar with pnpm --filter @oneseat/daemon run build:sidecar' >&2\nexit 1\n"
    );
    std::fs::write(file, body).expect("write placeholder sidecar");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755));
    }
}

fn main() {
    ensure_sidecars();
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
