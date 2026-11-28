//! Redaction for anything that may reach a log: daemon stderr, stray stdout, error text.
//!
//! Three layers:
//! 1. Exact values of the keys this process holds (they are registered when loaded from
//!    the keychain or saved), so even an unusual key shape never reaches a log.
//! 2. Sensitive header and field names (`x-api-key`, `authorization`, `x-goog-api-key`,
//!    `apiKey`, `api_key`) followed by a value, in `name: value`, `name=value` and JSON forms.
//! 3. Well-known key shapes: `sk-...` (Anthropic, OpenAI), `AIza...` (Google), `Bearer ...`.

use regex::Regex;
use std::sync::{OnceLock, RwLock};

pub const REDACTED: &str = "[REDACTED]";

fn header_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)(["']?(?:x-api-key|x-goog-api-key|authorization|proxy-authorization|api[_-]?key|apikey)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|(?:bearer\s+|basic\s+)?[^\s,;"'}\]]+)"#,
        )
        .expect("valid header regex")
    })
}

fn shape_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?:\bsk-[A-Za-z0-9_\-]{8,}|\bAIza[0-9A-Za-z_\-]{20,}|(?i:\bbearer\s+)[A-Za-z0-9._~+/\-]{8,}=*)")
            .expect("valid shape regex")
    })
}

/// Secret values currently held by the process (never logged, only used for matching).
fn known() -> &'static RwLock<Vec<String>> {
    static KNOWN: OnceLock<RwLock<Vec<String>>> = OnceLock::new();
    KNOWN.get_or_init(|| RwLock::new(Vec::new()))
}

/// Remember a secret so `redact` removes it wherever it appears. Short values are ignored
/// (they would redact ordinary words).
pub fn register_secret(secret: &str) {
    let s = secret.trim();
    if s.len() < 6 {
        return;
    }
    let mut k = known().write().unwrap_or_else(|e| e.into_inner());
    if !k.iter().any(|x| x == s) {
        k.push(s.to_string());
        // Longest first, so a key that contains another is removed whole.
        k.sort_by_key(|x| std::cmp::Reverse(x.len()));
    }
}

pub fn forget_secret(secret: &str) {
    let s = secret.trim();
    let mut k = known().write().unwrap_or_else(|e| e.into_inner());
    k.retain(|x| x != s);
}

/// Redact secrets from one line of text.
pub fn redact(input: &str) -> String {
    redact_with(input, &known().read().unwrap_or_else(|e| e.into_inner()))
}

/// Redact with an explicit list of known secrets (pure; used by tests).
pub fn redact_with(input: &str, secrets: &[String]) -> String {
    let mut out = input.to_string();
    for s in secrets {
        if !s.is_empty() && out.contains(s.as_str()) {
            out = out.replace(s.as_str(), REDACTED);
        }
    }
    let out = header_re().replace_all(&out, |c: &regex::Captures| {
        let value = &c[2];
        let quoted = value.starts_with('"') || value.starts_with('\'');
        if quoted {
            let q = &value[..1];
            format!("{}{q}{REDACTED}{q}", &c[1])
        } else {
            format!("{}{REDACTED}", &c[1])
        }
    });
    shape_re().replace_all(&out, REDACTED).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_header_forms() {
        let cases = [
            ("x-api-key: sk-ant-api03-abcdefghijk", "x-api-key: [REDACTED]"),
            (
                "X-Goog-Api-Key=AIzaSyA1234567890abcdefghijklmnop",
                "X-Goog-Api-Key=[REDACTED]",
            ),
            ("authorization: Bearer abc.def.ghi-123456", "authorization: [REDACTED]"),
            ("Authorization: Basic dXNlcjpwYXNz", "Authorization: [REDACTED]"),
            (
                r#"{"apiKey":"hunter2hunter2","provider":"openai"}"#,
                r#"{"apiKey":"[REDACTED]","provider":"openai"}"#,
            ),
            (r#"{"x-api-key": "zzzzzzzz"}"#, r#"{"x-api-key": "[REDACTED]"}"#),
            ("api_key=foo123456 next", "api_key=[REDACTED] next"),
        ];
        for (input, want) in cases {
            assert_eq!(redact_with(input, &[]), want, "input: {input}");
        }
    }

    #[test]
    fn redacts_key_shapes_anywhere() {
        let line = "request failed for sk-proj-ABCDEFGH12345678 and AIzaSyB-abcdefghijklmnopqrstuvwxyz0";
        let out = redact_with(line, &[]);
        assert!(!out.contains("sk-proj"), "{out}");
        assert!(!out.contains("AIza"), "{out}");
        assert_eq!(out.matches(REDACTED).count(), 2);
        let out = redact_with("sent with bearer eyJhbGciOiJIUzI1NiJ9.payload", &[]);
        assert_eq!(out, "sent with [REDACTED]");
    }

    #[test]
    fn redacts_known_secret_values_of_any_shape() {
        let secrets = vec!["local-weird-token-42".to_string()];
        let out = redact_with("connecting with local-weird-token-42 to 127.0.0.1", &secrets);
        assert_eq!(out, "connecting with [REDACTED] to 127.0.0.1");
    }

    #[test]
    fn keeps_ordinary_text() {
        for line in [
            "daemon ready (protocol 1)",
            "skills.install source=owner/repo verdict=pass",
            "the task asked about skills and keys",
            // No separator after the header name, so nothing to redact.
            "authorization required for provider anthropic",
        ] {
            assert_eq!(redact_with(line, &[]), line);
        }
    }

    #[test]
    fn registry_round_trip() {
        register_secret("short"); // ignored: too short
        register_secret("registry-secret-value-1");
        assert_eq!(redact("x registry-secret-value-1 y"), "x [REDACTED] y");
        assert_eq!(redact("x short y"), "x short y");
        forget_secret("registry-secret-value-1");
        assert_eq!(redact("x registry-secret-value-1 y"), "x registry-secret-value-1 y");
    }
}
