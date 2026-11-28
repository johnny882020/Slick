//! JSON-RPC 2.0 over newline-delimited JSON (the daemon protocol in
//! packages/contracts/src/harness.ts). Pure framing and id routing, no I/O, so it is
//! unit-tested without a process.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::oneshot;

/// Error codes from `RPC_ERRORS` in harness.ts, plus shell-side codes (-3201x) for
/// failures that never reached the daemon.
pub mod codes {
    pub const PARSE: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL: i64 = -32603;
    pub const NOT_AUTHORISED: i64 = -32001;
    pub const BLOCKED: i64 = -32002;
    pub const NOT_FOUND: i64 = -32004;
    /// The daemon is not running (starting, restarting, or failed).
    pub const DAEMON_UNAVAILABLE: i64 = -32010;
    /// The daemon did not answer in time.
    pub const TIMEOUT: i64 = -32011;
    /// The shell refused the call (method not allowed from this window).
    pub const FORBIDDEN: i64 = -32012;
    /// No usable OS keychain.
    pub const KEYCHAIN: i64 = -32013;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

impl std::error::Error for RpcError {}

pub type RpcResult = Result<Value, RpcError>;

/// One line read from the daemon's stdout.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Response {
        id: Value,
        result: RpcResult,
    },
    Notification {
        method: String,
        params: Value,
    },
    /// Not valid JSON-RPC (or a request from the daemon, which the protocol does not have).
    Invalid(String),
}

/// Encode a request as one line (no trailing newline). serde_json's compact form never
/// contains a raw newline: newlines inside strings are escaped, so framing is safe.
pub fn encode_request(id: u64, method: &str, params: &Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
}

pub fn parse_line(line: &str) -> Incoming {
    let line = line.trim_end_matches(['\r', '\n']);
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return Incoming::Invalid(format!("not JSON: {e}")),
    };
    let Some(obj) = v.as_object() else {
        return Incoming::Invalid("not an object".into());
    };
    if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Incoming::Invalid("missing jsonrpc 2.0".into());
    }
    let id = obj.get("id").cloned();
    let method = obj.get("method").and_then(Value::as_str);
    match (id, method) {
        (None, Some(m)) => Incoming::Notification {
            method: m.to_string(),
            params: obj.get("params").cloned().unwrap_or(Value::Null),
        },
        (Some(_), Some(m)) => Incoming::Invalid(format!("unexpected request from daemon: {m}")),
        (Some(id), None) => {
            if let Some(err) = obj.get("error") {
                let parsed: RpcError = serde_json::from_value(err.clone())
                    .unwrap_or_else(|_| RpcError::new(codes::INTERNAL, "malformed error object"));
                Incoming::Response {
                    id,
                    result: Err(parsed),
                }
            } else if let Some(r) = obj.get("result") {
                Incoming::Response {
                    id,
                    result: Ok(r.clone()),
                }
            } else {
                Incoming::Invalid("response has neither result nor error".into())
            }
        }
        (None, None) => Incoming::Invalid("neither id nor method".into()),
    }
}

/// Our ids are u64. The daemon must echo them; accept a number or a numeric string.
pub fn id_as_u64(id: &Value) -> Option<u64> {
    match id {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// Requests waiting for a response, keyed by id.
#[derive(Default)]
pub struct PendingRequests {
    map: Mutex<HashMap<u64, oneshot::Sender<RpcResult>>>,
}

impl PendingRequests {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, id: u64) -> oneshot::Receiver<RpcResult> {
        let (tx, rx) = oneshot::channel();
        self.lock().insert(id, tx);
        rx
    }

    pub fn remove(&self, id: u64) {
        self.lock().remove(&id);
    }

    /// Deliver a response to its waiter. Returns false for an unknown id (late or bogus).
    pub fn resolve(&self, id: &Value, result: RpcResult) -> bool {
        let Some(n) = id_as_u64(id) else { return false };
        match self.lock().remove(&n) {
            Some(tx) => {
                // The waiter may have timed out and dropped the receiver; that is fine.
                let _ = tx.send(result);
                true
            }
            None => false,
        }
    }

    /// Fail every waiter (the daemon exited).
    pub fn fail_all(&self, err: RpcError) -> usize {
        let drained: Vec<_> = self.lock().drain().collect();
        let n = drained.len();
        for (_, tx) in drained {
            let _ = tx.send(Err(err.clone()));
        }
        n
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<RpcResult>>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Splits a byte stream into lines. Handles partial reads, CRLF, and invalid UTF-8
/// (replaced, never panics). Used by tests and by the daemon reader.
#[derive(Default)]
pub struct LineBuffer {
    buf: Vec<u8>,
}

impl LineBuffer {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let s = String::from_utf8_lossy(&line[..line.len() - 1]);
            let s = s.strip_suffix('\r').unwrap_or(&s).to_string();
            if !s.trim().is_empty() {
                out.push(s);
            }
        }
        out
    }

    /// Bytes held without a newline yet.
    pub fn pending(&self) -> usize {
        self.buf.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_one_line() {
        let line = encode_request(7, "harness.run", &json!({ "input": "line one\nline two" }));
        assert!(!line.contains('\n'));
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 7);
        assert_eq!(v["method"], "harness.run");
        assert_eq!(v["params"]["input"], "line one\nline two");
    }

    #[test]
    fn parses_responses_notifications_and_junk() {
        assert_eq!(
            parse_line(r#"{"jsonrpc":"2.0","id":3,"result":{"ok":true}}"#),
            Incoming::Response {
                id: json!(3),
                result: Ok(json!({ "ok": true }))
            }
        );
        assert_eq!(
            parse_line("{\"jsonrpc\":\"2.0\",\"id\":4,\"error\":{\"code\":-32601,\"message\":\"nope\"}}\r\n"),
            Incoming::Response {
                id: json!(4),
                result: Err(RpcError::new(-32601, "nope"))
            }
        );
        assert_eq!(
            parse_line(
                r#"{"jsonrpc":"2.0","method":"harness.event","params":{"runId":"r1","event":{"type":"text_delta","text":"hi"}}}"#
            ),
            Incoming::Notification {
                method: "harness.event".into(),
                params: json!({ "runId": "r1", "event": { "type": "text_delta", "text": "hi" } })
            }
        );
        // A result of null is still a result.
        assert_eq!(
            parse_line(r#"{"jsonrpc":"2.0","id":5,"result":null}"#),
            Incoming::Response {
                id: json!(5),
                result: Ok(Value::Null)
            }
        );
        for junk in [
            "hello",
            "[]",
            r#"{"id":1,"result":1}"#,
            r#"{"jsonrpc":"2.0","id":1}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"x"}"#,
            r#"{"jsonrpc":"2.0"}"#,
        ] {
            assert!(matches!(parse_line(junk), Incoming::Invalid(_)), "{junk}");
        }
        // A malformed error object still fails the request instead of hanging it.
        match parse_line(r#"{"jsonrpc":"2.0","id":9,"error":"bad"}"#) {
            Incoming::Response { result: Err(e), .. } => assert_eq!(e.code, codes::INTERNAL),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn routes_by_id_out_of_order() {
        let p = PendingRequests::new();
        let r1 = p.insert(1);
        let r2 = p.insert(2);
        let r3 = p.insert(3);
        assert_eq!(p.len(), 3);
        assert!(p.resolve(&json!(2), Ok(json!("two"))));
        assert!(p.resolve(&json!("3"), Err(RpcError::new(-1, "three"))));
        assert!(p.resolve(&json!(1), Ok(json!("one"))));
        assert_eq!(r2.await.unwrap(), Ok(json!("two")));
        assert_eq!(r1.await.unwrap(), Ok(json!("one")));
        assert_eq!(r3.await.unwrap().unwrap_err().message, "three");
        assert!(p.is_empty());
        // Unknown, duplicate and non-numeric ids are ignored.
        assert!(!p.resolve(&json!(2), Ok(Value::Null)));
        assert!(!p.resolve(&json!(42), Ok(Value::Null)));
        assert!(!p.resolve(&json!({ "x": 1 }), Ok(Value::Null)));
    }

    #[tokio::test]
    async fn fail_all_releases_every_waiter() {
        let p = PendingRequests::new();
        let rs: Vec<_> = (10..15).map(|i| p.insert(i)).collect();
        assert_eq!(p.fail_all(RpcError::new(codes::DAEMON_UNAVAILABLE, "daemon exited")), 5);
        for r in rs {
            assert_eq!(r.await.unwrap().unwrap_err().code, codes::DAEMON_UNAVAILABLE);
        }
        assert!(p.is_empty());
    }

    #[test]
    fn resolve_after_waiter_dropped_is_harmless() {
        let p = PendingRequests::new();
        drop(p.insert(1));
        assert!(p.resolve(&json!(1), Ok(Value::Null)));
    }

    #[test]
    fn line_buffer_handles_partial_crlf_and_bad_utf8() {
        let mut b = LineBuffer::default();
        assert!(b.push(b"{\"a\":").is_empty());
        assert_eq!(b.pending(), 5);
        assert_eq!(b.push(b"1}\r\n{\"b\":2}\n\n  \n{\"c\""), vec!["{\"a\":1}", "{\"b\":2}"]);
        assert_eq!(b.push(b":3}\n"), vec!["{\"c\":3}"]);
        let lines = b.push(b"\xff\xfeok\n");
        assert_eq!(lines.len(), 1);
        assert!(lines[0].ends_with("ok"));
        assert_eq!(b.pending(), 0);
    }

    #[test]
    fn id_parsing() {
        assert_eq!(id_as_u64(&json!(12)), Some(12));
        assert_eq!(id_as_u64(&json!("12")), Some(12));
        assert_eq!(id_as_u64(&json!(-1)), None);
        assert_eq!(id_as_u64(&json!(1.5)), None);
        assert_eq!(id_as_u64(&Value::Null), None);
    }
}
