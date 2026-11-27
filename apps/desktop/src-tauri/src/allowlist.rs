//! Which daemon methods the main window may call through `daemon_call`.
//!
//! Everything in `DaemonMethods` except:
//! - `apps.run`: only the shell calls it, on behalf of a pinned window, with the appId taken
//!   from the window label (see `bridge_run`).
//! - `auth.set`: keys go webview -> `key_save` -> keychain -> Rust -> daemon. The webview never
//!   hands a raw key to the daemon and never gets one back.
//!
//! Unknown methods are refused, so a daemon method added later stays closed until it is
//! reviewed and listed here (a test checks this list against harness.ts).

/// Methods the main window may call.
pub const UI_METHODS: &[&str] = &[
    "daemon.hello",
    "auth.clear",
    "auth.status",
    "models.list",
    "harness.run",
    "harness.cancel",
    "harness.approve",
    "skills.list",
    "skills.inspect",
    "skills.install",
    "skills.remove",
    "apps.pin",
    "apps.list",
    "apps.unpin",
    "schedules.list",
    "schedules.upsert",
    "schedules.remove",
    "actions.log",
    "apps.draft",
    "apps.drafts",
    "mcp.status",
];

/// Methods only the Rust core may call.
pub const SHELL_ONLY_METHODS: &[&str] = &["auth.set", "apps.run"];

pub fn is_ui_allowed(method: &str) -> bool {
    UI_METHODS.contains(&method)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn blocks_shell_only_and_unknown_methods() {
        assert!(is_ui_allowed("harness.run"));
        assert!(is_ui_allowed("skills.inspect"));
        assert!(is_ui_allowed("harness.approve"));
        assert!(!is_ui_allowed("apps.run"));
        assert!(!is_ui_allowed("auth.set"));
        assert!(!is_ui_allowed("fake.crash"));
        assert!(!is_ui_allowed(""));
        assert!(!is_ui_allowed("HARNESS.RUN"));
        assert!(!is_ui_allowed("harness.run "));
        for m in SHELL_ONLY_METHODS {
            assert!(!is_ui_allowed(m));
        }
    }

    /// Method names declared in `interface DaemonMethods { ... }` in harness.ts.
    fn contract_methods() -> BTreeSet<String> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/contracts/src/harness.ts"
        );
        let src = std::fs::read_to_string(path).expect("read packages/contracts/src/harness.ts");
        let start = src
            .find("export interface DaemonMethods {")
            .expect("DaemonMethods in harness.ts");
        let body = &src[start..];
        let end = body.find("\n}").expect("end of DaemonMethods");
        let re = regex::Regex::new(r#"(?m)^\s*"([a-z]+\.[a-zA-Z]+)"\s*:"#).unwrap();
        re.captures_iter(&body[..end]).map(|c| c[1].to_string()).collect()
    }

    #[test]
    fn allowlist_covers_the_contract_exactly() {
        let contract = contract_methods();
        assert!(contract.len() >= 20, "parsed {contract:?}");
        let mut ours: BTreeSet<String> = UI_METHODS.iter().map(|s| s.to_string()).collect();
        for m in SHELL_ONLY_METHODS {
            assert!(ours.insert(m.to_string()), "{m} listed twice");
        }
        assert_eq!(
            ours, contract,
            "UI_METHODS + SHELL_ONLY_METHODS must equal DaemonMethods in harness.ts"
        );
    }
}
