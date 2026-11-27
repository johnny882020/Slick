//! The daemon sidecar: spawn, speak JSON-RPC over stdio, restart with backoff.
//!
//! One supervisor thread per daemon. It spawns the process, reads stdout line by line
//! (responses are routed to waiting callers by id, notifications go to `DaemonEvents`),
//! forwards stderr to the log after redaction, and when the process exits it fails every
//! pending call and starts a new process after a backoff delay.

use crate::redact::redact;
use crate::rpc::{self, codes, Incoming, LineBuffer, PendingRequests, RpcError, RpcResult};
use serde::Serialize;
use serde_json::Value;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// How to start the daemon.
#[derive(Debug, Clone, PartialEq)]
pub struct DaemonSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(String, OsString)>,
    pub cwd: Option<PathBuf>,
    /// Human description for logs and the status screen ("node .../main.js", "sidecar").
    pub description: String,
}

impl DaemonSpec {
    fn command(&self) -> Command {
        let mut cmd = Command::new(&self.program);
        cmd.args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Inherited Node flags could load arbitrary code into the daemon.
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH");
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        if let Some(dir) = &self.cwd {
            cmd.current_dir(dir);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd
    }
}

pub const SIDECAR_NAME: &str = "oneseat-daemon";

/// Where the daemon is. Pure, so it is tested without touching the environment.
///
/// - Debug builds: `ONESEAT_DAEMON` (a .js/.mjs/.cjs file runs with `ONESEAT_NODE` or `node`;
///   anything else runs directly), else `apps/daemon/dist/main.js`, else the fake daemon in
///   `apps/desktop/dev/fake-daemon.mjs`.
/// - Release builds: the bundled sidecar `oneseat-daemon[.exe]` next to the app executable
///   (Tauri strips the target-triple suffix from `bundle.externalBin` when bundling).
pub fn resolve_spec(
    debug: bool,
    env_daemon: Option<&str>,
    env_node: Option<&str>,
    manifest_dir: &Path,
    exe_dir: Option<&Path>,
    data_dir: &Path,
) -> Result<DaemonSpec, String> {
    let env = vec![
        ("ONESEAT_HOME".to_string(), data_dir.as_os_str().to_owned()),
        ("ONESEAT_SHELL".to_string(), OsString::from("desktop")),
    ];
    let node = env_node.filter(|s| !s.is_empty()).unwrap_or("node");
    let script = |path: PathBuf, description: String| DaemonSpec {
        program: PathBuf::from(node),
        args: vec![path.as_os_str().to_owned()],
        env: env.clone(),
        cwd: path.parent().map(Path::to_path_buf),
        description,
    };
    if debug {
        if let Some(p) = env_daemon.filter(|s| !s.is_empty()) {
            let path = PathBuf::from(p);
            let is_js = matches!(path.extension().and_then(|e| e.to_str()), Some("js" | "mjs" | "cjs"));
            return Ok(if is_js {
                script(path.clone(), format!("{node} {} (ONESEAT_DAEMON)", path.display()))
            } else {
                DaemonSpec {
                    program: path.clone(),
                    args: vec![],
                    env,
                    cwd: None,
                    description: format!("{} (ONESEAT_DAEMON)", path.display()),
                }
            });
        }
        let real = manifest_dir.join("../../daemon/dist/main.js");
        if real.exists() {
            return Ok(script(real.clone(), format!("{node} {}", real.display())));
        }
        let fake = manifest_dir.join("../dev/fake-daemon.mjs");
        return Ok(script(
            fake.clone(),
            format!(
                "{node} {} (fake daemon: apps/daemon/dist/main.js not built)",
                fake.display()
            ),
        ));
    }
    let dir = exe_dir.ok_or("cannot find the app's install folder")?;
    let exe = dir.join(format!("{SIDECAR_NAME}{}", std::env::consts::EXE_SUFFIX));
    if !exe.exists() {
        return Err(format!(
            "the OneSeat daemon is missing from {}; reinstall OneSeat",
            dir.display()
        ));
    }
    Ok(DaemonSpec {
        program: exe,
        args: vec![],
        env,
        cwd: Some(dir.to_path_buf()),
        description: "bundled sidecar".into(),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DaemonState {
    /// Process spawned; handshake (hello + keys) in progress.
    Starting,
    Running,
    /// Exited; waiting for the backoff delay before the next start.
    Restarting,
    /// Could not be spawned; will retry after the backoff delay.
    Failed,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    pub state: DaemonState,
    pub restarts: u32,
    pub pid: Option<u32>,
    pub version: Option<String>,
    pub last_error: Option<String>,
    pub description: String,
}

/// Callbacks from the supervisor. Called on supervisor/reader threads.
pub trait DaemonEvents: Send + Sync + 'static {
    fn notification(&self, method: &str, params: &Value);
    fn status(&self, status: &DaemonStatus);
    /// A redacted log line from the daemon (stderr, or stdout that was not JSON-RPC).
    fn log(&self, level: log::Level, line: &str);
    /// After each (re)spawn, on its own thread: say hello, send keys. Return the daemon
    /// version, or an error that makes the supervisor restart the process.
    fn handshake(&self, daemon: &Daemon) -> Result<Option<String>, RpcError>;
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Backoff {
    pub initial: Duration,
    pub max: Duration,
    /// A process that ran at least this long resets the delay to `initial`.
    pub reset_after: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Backoff {
            initial: Duration::from_millis(500),
            max: Duration::from_secs(30),
            reset_after: Duration::from_secs(60),
        }
    }
}

impl Backoff {
    pub fn next(&self, previous: Option<Duration>, uptime: Duration) -> Duration {
        match previous {
            _ if uptime >= self.reset_after => self.initial,
            None => self.initial,
            Some(p) => (p * 2).min(self.max).max(self.initial),
        }
    }
}

const READY_WAIT: Duration = Duration::from_secs(15);
const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;

struct Inner {
    spec: DaemonSpec,
    events: Arc<dyn DaemonEvents>,
    backoff: Backoff,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: PendingRequests,
    next_id: AtomicU64,
    status: Mutex<DaemonStatus>,
    shutdown: AtomicBool,
    /// Wakes backoff sleeps and ready waits.
    signal: (Mutex<u64>, Condvar),
}

#[derive(Clone)]
pub struct Daemon {
    inner: Arc<Inner>,
}

impl Daemon {
    /// Start the supervisor. Returns at once; the first spawn happens on its thread.
    pub fn start(spec: DaemonSpec, events: Arc<dyn DaemonEvents>, backoff: Backoff) -> Daemon {
        let status = DaemonStatus {
            state: DaemonState::Starting,
            restarts: 0,
            pid: None,
            version: None,
            last_error: None,
            description: spec.description.clone(),
        };
        let d = Daemon {
            inner: Arc::new(Inner {
                spec,
                events,
                backoff,
                stdin: Mutex::new(None),
                child: Mutex::new(None),
                pending: PendingRequests::new(),
                next_id: AtomicU64::new(1),
                status: Mutex::new(status),
                shutdown: AtomicBool::new(false),
                signal: (Mutex::new(0), Condvar::new()),
            }),
        };
        let sup = d.clone();
        std::thread::Builder::new()
            .name("oneseat-daemon-supervisor".into())
            .spawn(move || sup.supervise())
            .expect("spawn supervisor thread");
        d
    }

    pub fn status(&self) -> DaemonStatus {
        lock(&self.inner.status).clone()
    }

    /// Call a method once the daemon is running (waits up to 15 s through a restart).
    pub async fn call(&self, method: &str, params: Value, timeout: Duration) -> RpcResult {
        let deadline = Instant::now() + READY_WAIT;
        loop {
            let state = self.status().state;
            if state == DaemonState::Running {
                break;
            }
            if state == DaemonState::Stopped || self.inner.shutdown.load(Ordering::SeqCst) {
                return Err(RpcError::new(
                    codes::DAEMON_UNAVAILABLE,
                    "the OneSeat daemon has stopped",
                ));
            }
            if Instant::now() >= deadline {
                let why = self
                    .status()
                    .last_error
                    .unwrap_or_else(|| "it is still starting".into());
                return Err(RpcError::new(
                    codes::DAEMON_UNAVAILABLE,
                    format!("the OneSeat daemon is not ready ({why})"),
                ));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.call_now(method, params, timeout).await
    }

    /// Call without waiting for the Running state (used by the handshake).
    pub async fn call_now(&self, method: &str, params: Value, timeout: Duration) -> RpcResult {
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let rx = self.inner.pending.insert(id);
        if let Err(e) = self.write_line(&rpc::encode_request(id, method, &params)) {
            self.inner.pending.remove(id);
            return Err(e);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RpcError::new(codes::DAEMON_UNAVAILABLE, "the OneSeat daemon exited")),
            Err(_) => {
                self.inner.pending.remove(id);
                Err(RpcError::new(
                    codes::TIMEOUT,
                    format!("the OneSeat daemon did not answer {method} in time"),
                ))
            }
        }
    }

    /// Blocking form of `call_now`, for threads outside any async runtime.
    pub fn call_blocking(&self, method: &str, params: Value, timeout: Duration) -> RpcResult {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .map_err(|e| RpcError::new(codes::INTERNAL, format!("runtime: {e}")))?;
        rt.block_on(self.call_now(method, params, timeout))
    }

    /// Stop the daemon for good (app exit).
    pub fn shutdown(&self) {
        self.inner.shutdown.store(true, Ordering::SeqCst);
        // Closing stdin lets a well-behaved daemon exit on its own; then make sure.
        lock(&self.inner.stdin).take();
        if let Some(child) = lock(&self.inner.child).as_mut() {
            let _ = child.kill();
        }
        self.wake();
    }

    /// Kill the current process (it will be restarted). For tests and a "restart" action.
    pub fn kill_current(&self) {
        if let Some(child) = lock(&self.inner.child).as_mut() {
            let _ = child.kill();
        }
    }

    pub fn pending_len(&self) -> usize {
        self.inner.pending.len()
    }

    fn write_line(&self, line: &str) -> Result<(), RpcError> {
        let mut guard = lock(&self.inner.stdin);
        let Some(stdin) = guard.as_mut() else {
            return Err(RpcError::new(
                codes::DAEMON_UNAVAILABLE,
                "the OneSeat daemon is not running",
            ));
        };
        let res = stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush());
        res.map_err(|e| {
            guard.take();
            RpcError::new(
                codes::DAEMON_UNAVAILABLE,
                format!("cannot write to the OneSeat daemon: {e}"),
            )
        })
    }

    fn set_status(&self, f: impl FnOnce(&mut DaemonStatus)) {
        let snapshot = {
            let mut s = lock(&self.inner.status);
            f(&mut s);
            s.clone()
        };
        self.inner.events.status(&snapshot);
        self.wake();
    }

    fn wake(&self) {
        let (m, cv) = &self.inner.signal;
        *lock(m) += 1;
        cv.notify_all();
    }

    /// Sleep up to `d`, waking early on shutdown.
    fn sleep_interruptible(&self, d: Duration) {
        let (m, cv) = &self.inner.signal;
        let deadline = Instant::now() + d;
        let mut g = lock(m);
        while !self.inner.shutdown.load(Ordering::SeqCst) {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            g = cv.wait_timeout(g, deadline - now).unwrap_or_else(|e| e.into_inner()).0;
        }
    }

    fn supervise(self) {
        let mut delay: Option<Duration> = None;
        loop {
            if self.inner.shutdown.load(Ordering::SeqCst) {
                break;
            }
            let started = Instant::now();
            match self.inner.spec.command().spawn() {
                Err(e) => {
                    let msg = redact(&format!(
                        "cannot start the daemon ({}): {e}",
                        self.inner.spec.description
                    ));
                    self.inner.events.log(log::Level::Error, &msg);
                    self.set_status(|s| {
                        s.state = DaemonState::Failed;
                        s.pid = None;
                        s.last_error = Some(msg.clone());
                    });
                }
                Ok(mut child) => {
                    let pid = child.id();
                    let stdout = child.stdout.take();
                    let stderr = child.stderr.take();
                    *lock(&self.inner.stdin) = child.stdin.take();
                    *lock(&self.inner.child) = Some(child);
                    if self.inner.shutdown.load(Ordering::SeqCst) {
                        // shutdown() raced with the spawn: make sure this child dies too.
                        self.shutdown();
                    }
                    self.set_status(|s| {
                        s.state = DaemonState::Starting;
                        s.pid = Some(pid);
                    });
                    if let Some(err) = stderr {
                        self.spawn_stderr_reader(err);
                    }
                    self.spawn_handshake(pid);
                    if let Some(out) = stdout {
                        self.read_stdout(out);
                    }
                    // stdout closed: the process is exiting.
                    lock(&self.inner.stdin).take();
                    let code = lock(&self.inner.child).take().and_then(|mut c| c.wait().ok());
                    let failed = self.inner.pending.fail_all(RpcError::new(
                        codes::DAEMON_UNAVAILABLE,
                        "the OneSeat daemon exited; it is restarting",
                    ));
                    if self.inner.shutdown.load(Ordering::SeqCst) {
                        break;
                    }
                    let msg = match code {
                        Some(c) => format!("daemon exited ({c})"),
                        None => "daemon exited".to_string(),
                    };
                    self.inner.events.log(
                        log::Level::Warn,
                        &format!("{msg}; {failed} pending call(s) failed; restarting"),
                    );
                    self.set_status(|s| {
                        s.state = DaemonState::Restarting;
                        s.pid = None;
                        s.restarts += 1;
                        s.last_error = Some(msg.clone());
                    });
                }
            }
            if self.inner.shutdown.load(Ordering::SeqCst) {
                break;
            }
            let d = self.inner.backoff.next(delay, started.elapsed());
            delay = Some(d);
            self.sleep_interruptible(d);
        }
        lock(&self.inner.stdin).take();
        self.inner.pending.fail_all(RpcError::new(
            codes::DAEMON_UNAVAILABLE,
            "the OneSeat daemon has stopped",
        ));
        self.set_status(|s| {
            s.state = DaemonState::Stopped;
            s.pid = None;
        });
    }

    fn spawn_stderr_reader(&self, mut err: std::process::ChildStderr) {
        let events = self.inner.events.clone();
        let _ = std::thread::Builder::new()
            .name("oneseat-daemon-stderr".into())
            .spawn(move || {
                let mut buf = LineBuffer::default();
                let mut chunk = vec![0u8; 16 * 1024];
                loop {
                    match err.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            for line in buf.push(&chunk[..n]) {
                                events.log(log::Level::Info, &truncate(&redact(&line), 2000));
                            }
                            if buf.pending() > 1024 * 1024 {
                                buf = LineBuffer::default();
                            }
                        }
                    }
                }
            });
    }

    fn spawn_handshake(&self, pid: u32) {
        let me = self.clone();
        let _ = std::thread::Builder::new()
            .name("oneseat-daemon-handshake".into())
            .spawn(move || {
                match me.inner.events.handshake(&me) {
                    Ok(version) => {
                        // Only mark running if this is still the same process.
                        if me.status().pid == Some(pid) {
                            me.set_status(|s| {
                                s.state = DaemonState::Running;
                                s.version = version;
                                s.last_error = None;
                            });
                        }
                    }
                    Err(e) => {
                        let msg = redact(&format!("daemon handshake failed: {}", e.message));
                        me.inner.events.log(log::Level::Error, &msg);
                        if me.status().pid == Some(pid) {
                            me.set_status(|s| s.last_error = Some(msg));
                            me.kill_current();
                        }
                    }
                }
            });
    }

    fn read_stdout(&self, mut out: std::process::ChildStdout) {
        let mut buf = LineBuffer::default();
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            match out.read(&mut chunk) {
                Ok(0) => break,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
                Ok(n) => {
                    for line in buf.push(&chunk[..n]) {
                        self.dispatch(&line);
                    }
                    if buf.pending() > MAX_LINE_BYTES {
                        self.inner
                            .events
                            .log(log::Level::Error, "daemon wrote a line over 64 MB; dropped it");
                        buf = LineBuffer::default();
                    }
                }
            }
        }
    }

    fn dispatch(&self, line: &str) {
        match rpc::parse_line(line) {
            Incoming::Response { id, result } => {
                if !self.inner.pending.resolve(&id, result) {
                    self.inner
                        .events
                        .log(log::Level::Debug, &format!("response for unknown id {id}"));
                }
            }
            Incoming::Notification { method, params } => self.inner.events.notification(&method, &params),
            Incoming::Invalid(why) => {
                self.inner.events.log(
                    log::Level::Warn,
                    &format!("daemon stdout ({why}): {}", truncate(&redact(line), 500)),
                );
            }
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}... ({} bytes)", &s[..end], s.len())
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn backoff_grows_caps_and_resets() {
        let b = Backoff {
            initial: Duration::from_millis(500),
            max: Duration::from_secs(4),
            reset_after: Duration::from_secs(60),
        };
        let short = Duration::from_secs(1);
        let d1 = b.next(None, short);
        let d2 = b.next(Some(d1), short);
        let d3 = b.next(Some(d2), short);
        let d4 = b.next(Some(d3), short);
        let d5 = b.next(Some(d4), short);
        assert_eq!(
            [d1, d2, d3, d4, d5].map(|d| d.as_millis()),
            [500, 1000, 2000, 4000, 4000]
        );
        assert_eq!(b.next(Some(d5), Duration::from_secs(61)), Duration::from_millis(500));
    }

    #[test]
    fn resolves_daemon_location() {
        let manifest = Path::new("/repo/apps/desktop/src-tauri");
        let data = Path::new("/data/app.oneseat");
        // ONESEAT_DAEMON with a script runs through node (or ONESEAT_NODE).
        let s = resolve_spec(
            true,
            Some("/x/daemon/main.js"),
            Some("/opt/node/bin/node"),
            manifest,
            None,
            data,
        )
        .unwrap();
        assert_eq!(s.program, PathBuf::from("/opt/node/bin/node"));
        assert_eq!(s.args, vec![OsString::from("/x/daemon/main.js")]);
        assert!(s
            .env
            .contains(&("ONESEAT_HOME".to_string(), OsString::from("/data/app.oneseat"))));
        // ONESEAT_DAEMON with a binary runs it directly.
        let s = resolve_spec(true, Some("/x/oneseat-daemon"), None, manifest, None, data).unwrap();
        assert_eq!(s.program, PathBuf::from("/x/oneseat-daemon"));
        assert!(s.args.is_empty());
        // No override and no built daemon: the fake daemon, with plain node.
        let s = resolve_spec(true, None, None, manifest, None, data).unwrap();
        assert_eq!(s.program, PathBuf::from("node"));
        assert!(s.args[0].to_string_lossy().ends_with("dev/fake-daemon.mjs"));
        assert!(s.description.contains("fake"));
        // Release ignores ONESEAT_DAEMON and needs the sidecar next to the executable.
        let err = resolve_spec(
            false,
            Some("/x/main.js"),
            None,
            manifest,
            Some(Path::new("/nonexistent/bin")),
            data,
        )
        .unwrap_err();
        assert!(err.contains("missing"), "{err}");
        let tmp = std::env::temp_dir().join(format!("oneseat-sidecar-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let exe = tmp.join(format!("{SIDECAR_NAME}{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&exe, b"x").unwrap();
        let s = resolve_spec(false, Some("/x/main.js"), None, manifest, Some(&tmp), data).unwrap();
        assert_eq!(s.program, exe);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn truncates_on_char_boundaries() {
        assert_eq!(truncate("abc", 10), "abc");
        let t = truncate("ééééé", 3);
        assert!(t.starts_with('é') && t.contains("(10 bytes)"), "{t}");
    }

    // ---- integration with the fake daemon (needs node on PATH) ----

    #[derive(Default)]
    struct Recorder {
        notifications: Mutex<Vec<(String, Value)>>,
        statuses: Mutex<Vec<DaemonStatus>>,
        logs: Mutex<Vec<String>>,
        handshakes: AtomicU64,
    }

    impl DaemonEvents for Recorder {
        fn notification(&self, method: &str, params: &Value) {
            lock(&self.notifications).push((method.to_string(), params.clone()));
        }
        fn status(&self, status: &DaemonStatus) {
            lock(&self.statuses).push(status.clone());
        }
        fn log(&self, _level: log::Level, line: &str) {
            lock(&self.logs).push(line.to_string());
        }
        fn handshake(&self, daemon: &Daemon) -> Result<Option<String>, RpcError> {
            self.handshakes.fetch_add(1, Ordering::SeqCst);
            let hello = daemon.call_blocking("daemon.hello", json!({ "client": "test" }), Duration::from_secs(10))?;
            daemon.call_blocking(
                "auth.set",
                json!({ "provider": "anthropic", "apiKey": "sk-ant-test-0123456789" }),
                Duration::from_secs(10),
            )?;
            Ok(hello["version"].as_str().map(str::to_string))
        }
    }

    fn node_available() -> bool {
        Command::new("node")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn fake_spec(home: &Path) -> DaemonSpec {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut s = resolve_spec(true, None, None, manifest, None, home).unwrap();
        // Force the fake daemon even if apps/daemon has been built.
        s.args = vec![manifest.join("../dev/fake-daemon.mjs").into_os_string()];
        s.env.push(("FAKE_DAEMON_STEP_MS".into(), "1".into()));
        s
    }

    async fn wait_for(mut f: impl FnMut() -> bool, what: &str) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !f() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn talks_to_the_fake_daemon_and_restarts_it() {
        if !node_available() {
            eprintln!("skipping: node not on PATH");
            return;
        }
        let home = std::env::temp_dir().join(format!("oneseat-daemon-test-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let rec = Arc::new(Recorder::default());
        let backoff = Backoff {
            initial: Duration::from_millis(50),
            max: Duration::from_millis(200),
            reset_after: Duration::from_secs(60),
        };
        let d = Daemon::start(fake_spec(&home), rec.clone(), backoff);
        let t = Duration::from_secs(10);

        // Handshake ran, keys were sent.
        let status = d.call("auth.status", json!({}), t).await.unwrap();
        assert_eq!(status["anthropic"], true);
        assert_eq!(d.status().state, DaemonState::Running);
        assert_eq!(d.status().version.as_deref(), Some("0.0.0-fake"));

        // Concurrent calls are routed by id.
        let calls = (0..20).map(|i| {
            let d = d.clone();
            async move {
                let provider = ["anthropic", "openai", "google", "local"][i % 4];
                let r = d.call("models.list", json!({ "provider": provider }), t).await.unwrap();
                (provider, r)
            }
        });
        for (provider, r) in futures_join_all(calls).await {
            let first = r["models"][0]["id"].as_str().unwrap().to_string();
            let expected = match provider {
                "anthropic" => "claude-opus-5-5",
                "openai" => "gpt-5",
                "google" => "gemini-3-pro",
                _ => "local-model",
            };
            assert_eq!(first, expected);
        }

        // Errors come back as RpcError.
        let err = d.call("no.such.method", json!({}), t).await.unwrap_err();
        assert_eq!(err.code, codes::METHOD_NOT_FOUND);

        // Notifications are forwarded.
        let run = d
            .call(
                "harness.run",
                json!({ "input": "weekly recap", "provider": "anthropic", "model": "claude-opus-5-5" }),
                t,
            )
            .await
            .unwrap();
        let run_id = run["runId"].as_str().unwrap().to_string();
        wait_for(
            || {
                lock(&rec.notifications)
                    .iter()
                    .any(|(m, p)| m == "harness.event" && p["runId"] == run_id.as_str() && p["event"]["type"] == "done")
            },
            "done event",
        )
        .await;
        assert!(lock(&rec.notifications)
            .iter()
            .any(|(_, p)| p["event"]["type"] == "skill_loaded" && p["event"]["name"] == "weekly-report"));

        // Kill it: pending calls fail fast, then it comes back and the handshake runs again.
        d.call("fake.crash", json!({}), t).await.unwrap();
        wait_for(
            || lock(&rec.statuses).iter().any(|s| s.state == DaemonState::Restarting),
            "restart",
        )
        .await;
        let again = d.call("auth.status", json!({}), t).await.unwrap();
        assert_eq!(again["anthropic"], true, "keys re-sent after restart");
        assert!(rec.handshakes.load(Ordering::SeqCst) >= 2);
        assert!(d.status().restarts >= 1);
        assert_eq!(d.pending_len(), 0);

        // The key never shows up in any log line.
        assert!(lock(&rec.logs).iter().all(|l| !l.contains("sk-ant-test")));
        assert!(
            lock(&rec.logs).iter().any(|l| l.contains("[fake-daemon]")),
            "stderr is logged"
        );

        d.shutdown();
        wait_for(|| d.status().state == DaemonState::Stopped, "stop").await;
        let err = d.call("auth.status", json!({}), t).await.unwrap_err();
        assert_eq!(err.code, codes::DAEMON_UNAVAILABLE);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reports_a_daemon_that_cannot_start() {
        let rec = Arc::new(Recorder::default());
        let spec = DaemonSpec {
            program: PathBuf::from("/nonexistent/oneseat-daemon-binary"),
            args: vec![],
            env: vec![],
            cwd: None,
            description: "missing".into(),
        };
        let backoff = Backoff {
            initial: Duration::from_millis(20),
            max: Duration::from_millis(40),
            reset_after: Duration::from_secs(60),
        };
        let d = Daemon::start(spec, rec.clone(), backoff);
        wait_for(
            || {
                lock(&rec.statuses)
                    .iter()
                    .filter(|s| s.state == DaemonState::Failed)
                    .count()
                    >= 2
            },
            "retries",
        )
        .await;
        assert!(d.status().last_error.unwrap().contains("cannot start"));
        d.shutdown();
        wait_for(|| d.status().state == DaemonState::Stopped, "stop").await;
    }

    /// Minimal join_all without pulling in the futures crate.
    async fn futures_join_all<F: std::future::Future + Send + 'static>(
        fs: impl IntoIterator<Item = F>,
    ) -> Vec<F::Output>
    where
        F::Output: Send + 'static,
    {
        let handles: Vec<_> = fs.into_iter().map(tokio::spawn).collect();
        let mut out = Vec::new();
        for h in handles {
            out.push(h.await.expect("task"));
        }
        out
    }
}
