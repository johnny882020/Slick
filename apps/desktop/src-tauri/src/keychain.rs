//! Model keys live in the OS keychain (macOS Keychain, Windows Credential Manager,
//! Linux Secret Service) under service "app.oneseat", one entry per provider.
//! Keys are read only by the Rust core, sent to the daemon with `auth.set`, and never
//! returned to a webview or written to a log.

use serde::{Deserialize, Serialize};

pub const SERVICE: &str = "app.oneseat";
pub const PROVIDERS: &[&str] = &["anthropic", "openai", "google", "local"];

/// Shown when the platform has no usable keychain (most often Linux without a Secret
/// Service provider). OneSeat never falls back to storing keys in a file.
pub const NO_KEYCHAIN_MESSAGE: &str = "No system keychain is available, so OneSeat cannot store your key. \
OneSeat keeps keys only in the operating system keychain, never in a file. \
On Linux, install and unlock a Secret Service provider (for example GNOME Keyring or KWallet), then restart OneSeat.";

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credential {
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "baseUrl", default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credential")
            .field("api_key", &"[REDACTED]")
            .field("base_url", &self.base_url)
            .finish()
    }
}

impl Credential {
    /// Keychain secret format: JSON, so a base URL can travel with the key.
    pub fn to_secret(&self) -> String {
        serde_json::to_string(self).expect("credential serialises")
    }

    /// Accepts the JSON form, or a bare key (written by older builds or by hand).
    pub fn from_secret(secret: &str) -> Self {
        serde_json::from_str(secret).unwrap_or_else(|_| Credential {
            api_key: secret.trim().to_string(),
            base_url: None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyStoreError {
    /// No keychain on this system, or it is locked / refused access.
    Unavailable(String),
    Other(String),
}

impl std::fmt::Display for KeyStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyStoreError::Unavailable(detail) => write!(f, "{NO_KEYCHAIN_MESSAGE} ({detail})"),
            KeyStoreError::Other(m) => write!(f, "keychain error: {m}"),
        }
    }
}

pub trait KeyStore: Send + Sync {
    fn get(&self, provider: &str) -> Result<Option<Credential>, KeyStoreError>;
    fn set(&self, provider: &str, cred: &Credential) -> Result<(), KeyStoreError>;
    /// Returns whether an entry existed.
    fn delete(&self, provider: &str) -> Result<bool, KeyStoreError>;
    /// Check the keychain is reachable without reading any real key.
    fn probe(&self) -> Result<(), KeyStoreError>;
}

/// The real OS keychain via the `keyring` crate.
pub struct OsKeychain;

impl OsKeychain {
    fn entry(user: &str) -> Result<keyring::Entry, KeyStoreError> {
        keyring::Entry::new(SERVICE, user).map_err(map_err)
    }
}

fn map_err(e: keyring::Error) -> KeyStoreError {
    use keyring::Error as E;
    // Error text from platform layers never contains the secret; still, keep it short.
    match e {
        E::NoStorageAccess(inner) => KeyStoreError::Unavailable(short(&inner.to_string())),
        E::PlatformFailure(inner) => KeyStoreError::Unavailable(short(&inner.to_string())),
        other => KeyStoreError::Other(short(&other.to_string())),
    }
}

fn short(s: &str) -> String {
    let s = crate::redact::redact(s);
    if s.chars().count() > 200 {
        s.chars().take(200).collect::<String>() + "..."
    } else {
        s
    }
}

impl KeyStore for OsKeychain {
    fn get(&self, provider: &str) -> Result<Option<Credential>, KeyStoreError> {
        match Self::entry(provider)?.get_password() {
            Ok(secret) => Ok(Some(Credential::from_secret(&secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map_err(e)),
        }
    }

    fn set(&self, provider: &str, cred: &Credential) -> Result<(), KeyStoreError> {
        Self::entry(provider)?.set_password(&cred.to_secret()).map_err(map_err)
    }

    fn delete(&self, provider: &str) -> Result<bool, KeyStoreError> {
        match Self::entry(provider)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(e) => Err(map_err(e)),
        }
    }

    fn probe(&self) -> Result<(), KeyStoreError> {
        match Self::entry("__oneseat_probe__")?.get_password() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map_err(e)),
        }
    }
}

/// In-memory store for tests and for debug builds started with
/// ONESEAT_DEV_MEMORY_KEYSTORE=1 (containers without a keychain). Never used in release.
#[derive(Default)]
pub struct MemoryKeyStore {
    map: std::sync::Mutex<std::collections::HashMap<String, Credential>>,
    unavailable: bool,
}

impl MemoryKeyStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// A store that behaves like a missing keychain.
    pub fn unavailable() -> Self {
        Self {
            unavailable: true,
            ..Self::default()
        }
    }

    fn check(&self) -> Result<(), KeyStoreError> {
        if self.unavailable {
            Err(KeyStoreError::Unavailable("no secret service".into()))
        } else {
            Ok(())
        }
    }
}

impl KeyStore for MemoryKeyStore {
    fn get(&self, provider: &str) -> Result<Option<Credential>, KeyStoreError> {
        self.check()?;
        Ok(self.map.lock().unwrap().get(provider).cloned())
    }
    fn set(&self, provider: &str, cred: &Credential) -> Result<(), KeyStoreError> {
        self.check()?;
        self.map.lock().unwrap().insert(provider.to_string(), cred.clone());
        Ok(())
    }
    fn delete(&self, provider: &str) -> Result<bool, KeyStoreError> {
        self.check()?;
        Ok(self.map.lock().unwrap().remove(provider).is_some())
    }
    fn probe(&self) -> Result<(), KeyStoreError> {
        self.check()
    }
}

pub fn validate_provider(provider: &str) -> Result<(), String> {
    if PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(format!(
            "unknown provider \"{}\"",
            provider.chars().take(32).collect::<String>()
        ))
    }
}

/// Check what the user typed. Error messages never include the key.
pub fn validate_credential(provider: &str, api_key: &str, base_url: Option<&str>) -> Result<Credential, String> {
    validate_provider(provider)?;
    let key = api_key.trim();
    let base_url = base_url.map(str::trim).filter(|s| !s.is_empty());
    if provider == "local" {
        if base_url.is_none() {
            return Err("a local model needs a base URL, for example http://localhost:11434/v1".into());
        }
    } else if key.is_empty() {
        return Err("paste your API key".into());
    }
    if !key.is_empty() {
        if key.len() < 8 {
            return Err("that key is too short; check you copied all of it".into());
        }
        if key.len() > 1024 {
            return Err("that key is too long; check you copied only the key".into());
        }
        if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err("the key contains spaces or line breaks; copy only the key".into());
        }
    }
    if let Some(u) = base_url {
        let parsed = url::Url::parse(u).map_err(|_| "the base URL is not a valid URL".to_string())?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("the base URL must start with http:// or https://".into());
        }
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err("put credentials in the key field, not in the base URL".into());
        }
    }
    Ok(Credential {
        api_key: key.to_string(),
        base_url: base_url.map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_input_without_echoing_keys() {
        let key = "sk-ant-api03-0123456789abcdef";
        let c = validate_credential("anthropic", &format!("  {key}\n"), None).unwrap();
        assert_eq!(c.api_key, key);
        assert_eq!(c.base_url, None);
        for (provider, k, url) in [
            ("anthropic", "", None),
            ("openai", "k3y9x", None),
            ("openai", "sk-abc def-ghijkl", None),
            ("google", "sk-abc\u{7}defghijkl", None),
            ("local", "", None),
            ("local", "", Some("ftp://x")),
            ("local", "", Some("not a url")),
            ("local", "", Some("http://user:pw@localhost:1234")),
            ("mystery", "sk-0123456789", None),
        ] {
            let err = validate_credential(provider, k, url).unwrap_err();
            if !k.is_empty() {
                assert!(!err.contains(k), "error echoes key: {err}");
            }
        }
        let local = validate_credential("local", "", Some("http://localhost:11434/v1")).unwrap();
        assert_eq!(local.base_url.as_deref(), Some("http://localhost:11434/v1"));
    }

    #[test]
    fn secret_round_trip_and_debug_redaction() {
        let c = Credential {
            api_key: "sk-secret-123456".into(),
            base_url: Some("https://proxy.example".into()),
        };
        assert_eq!(Credential::from_secret(&c.to_secret()), c);
        assert_eq!(Credential::from_secret(" bare-key-123456 ").api_key, "bare-key-123456");
        let dbg = format!("{c:?}");
        assert!(!dbg.contains("sk-secret"), "{dbg}");
    }

    #[test]
    fn memory_store_behaves_like_a_keychain() {
        let s = MemoryKeyStore::new();
        assert!(s.probe().is_ok());
        assert_eq!(s.get("openai").unwrap(), None);
        let c = Credential {
            api_key: "sk-0123456789".into(),
            base_url: None,
        };
        s.set("openai", &c).unwrap();
        assert_eq!(s.get("openai").unwrap(), Some(c));
        assert!(s.delete("openai").unwrap());
        assert!(!s.delete("openai").unwrap());

        let missing = MemoryKeyStore::unavailable();
        let err = missing.probe().unwrap_err();
        assert!(matches!(err, KeyStoreError::Unavailable(_)));
        assert!(err.to_string().contains("Secret Service"));
    }

    #[test]
    fn provider_ids_match_contract() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packages/contracts/src/model.ts");
        let src = std::fs::read_to_string(path).expect("read model.ts");
        let line = src
            .lines()
            .find(|l| l.starts_with("export type ProviderId"))
            .expect("ProviderId");
        let ids: Vec<&str> = line.split('"').skip(1).step_by(2).collect();
        assert_eq!(ids, PROVIDERS);
    }
}
