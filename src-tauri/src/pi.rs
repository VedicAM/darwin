//! Manages a long-lived `pi` child process speaking RPC mode (JSONL over stdio).
//!
//! Protocol notes that shaped this file, from Pi's `docs/rpc.md`:
//!   * Records are framed with strict JSONL: one complete JSON object per LF.
//!     We read with `read_until(b'\n')` and strip a trailing CR. We never split
//!     on Unicode line/paragraph separators, which are legal inside JSON strings.
//!   * stdout carries protocol records only; diagnostics go to stderr and must
//!     not be parsed as protocol.
//!   * stdout must be drained continuously or Pi stalls on backpressure, so a
//!     dedicated thread owns the read for the life of the child.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

/// Tool allowlist. Deliberately excludes `bash`, `edit`, and `write` so the
/// webview cannot drive shell execution or mutate the workspace.
///
/// `research.arxiv` comes from the Pi extension in `.pi/extensions/`. It holds
/// no network capability of its own: it sends a capability request over the
/// harness socket (`bridge.rs`) and Rust performs the request and the parse.
/// Allowlisting it grants a *harness call*, not an HTTP client, which is the
/// whole point.
///
/// `github_search` is a second extension in the same directory, the
/// `research.github` capability, and it is still a direct read-only GET against
/// `api.github.com` from inside the agent process. It is left in place here
/// because it is pre-existing and outside this change, but it is the weaker of
/// the two patterns: it widens the agent's own network reach, where
/// `research.arxiv` does not. Migrating it onto the same socket is the obvious
/// follow-up.
///
/// `run_experiment` is the extension in `.pi/extensions/experiment-run.ts`. It
/// follows the `research.arxiv` pattern, not the `github_search` one: it holds
/// no execution or network capability of its own and sends an `experiment.run`
/// capability request over the harness socket, where Rust runs the code in a
/// constructed environment under a deadline. Allowlisting it grants a *harness
/// call*, not a shell.
///
/// Override with `DARWIN_PI_TOOLS` for a different posture.
const DEFAULT_TOOLS: &str =
    "read,ls,grep,find,research.arxiv,github_search,run_experiment,fold_rna,list_tools,install_tool,pip_install";

struct Running {
    child: Child,
    stdin: ChildStdin,
    next_id: u32,
}

impl Running {
    fn next_id(&mut self) -> String {
        self.next_id += 1;
        format!("darwin-{}", self.next_id)
    }
}

#[derive(Default)]
pub struct PiSession {
    running: Mutex<Option<Running>>,
    /// Where the harness socket lives, once `setup` has opened it. Handed to
    /// the child as `DARWIN_HARNESS_SOCKET` so a Pi extension can reach the
    /// harness without having to know where the app keeps its data.
    harness_socket: Mutex<Option<PathBuf>>,
}

impl PiSession {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<Running>>, String> {
        self.running
            .lock()
            .map_err(|_| "pi session lock poisoned".to_string())
    }

    /// Spawns `pi` if it is not already running. A child that has exited is
    /// replaced, so a crashed agent can be recovered from without a restart.
    fn ensure_running(
        slot: &mut Option<Running>,
        app: &AppHandle,
        harness_socket: Option<&Path>,
    ) -> Result<(), String> {
        let alive = match slot.as_mut() {
            Some(r) => matches!(r.child.try_wait(), Ok(None)),
            None => false,
        };
        if alive {
            return Ok(());
        }
        *slot = None;
        *slot = Some(spawn(app, harness_socket)?);
        Ok(())
    }

    pub fn prompt(&self, app: &AppHandle, message: String) -> Result<(), String> {
        let mut slot = self.lock()?;
        let socket = self.socket_path();
        Self::ensure_running(&mut slot, app, socket.as_deref())?;
        let running = slot.as_mut().expect("ensure_running spawns when empty");
        let id = running.next_id();
        write_record(&mut running.stdin, &json!({ "id": id, "type": "prompt", "message": message }))
    }

    pub fn get_state(&self, app: &AppHandle) -> Result<(), String> {
        let mut slot = self.lock()?;
        let socket = self.socket_path();
        Self::ensure_running(&mut slot, app, socket.as_deref())?;
        let running = slot.as_mut().expect("ensure_running spawns when empty");
        let id = running.next_id();
        write_record(&mut running.stdin, &json!({ "id": id, "type": "get_state" }))
    }

    /// Record the harness socket path so spawned children inherit it.
    ///
    /// Called from `setup` once the bridge is listening. Storing it here rather
    /// than in the process environment means a `pi` launched by hand has no
    /// socket to find and no way to reach the harness.
    pub fn set_harness_socket(&self, path: PathBuf) {
        match self.harness_socket.lock() {
            Ok(mut slot) => *slot = Some(path),
            Err(_) => {}
        }
    }

    fn socket_path(&self) -> Option<PathBuf> {
        self.harness_socket.lock().ok().and_then(|p| p.clone())
    }

    /// Terminates the child and clears the slot. Closes stdin first so Pi can
    /// dispose its runtime and exit on its own terms.
    pub fn stop(&self) -> Result<(), String> {
        let mut slot = self.lock()?;
        if let Some(mut running) = slot.take() {
            drop(running.stdin);
            let _ = running.child.kill();
            let _ = running.child.wait();
        }
        Ok(())
    }
}

fn spawn(app: &AppHandle, harness_socket: Option<&Path>) -> Result<Running, String> {
    let binary = std::env::var("DARWIN_PI_BIN").unwrap_or_else(|_| "pi".to_string());
    let tools = std::env::var("DARWIN_PI_TOOLS").unwrap_or_else(|_| DEFAULT_TOOLS.to_string());
    let workspace = workspace_dir();

    let mut cmd = Command::new(&binary);
    cmd.current_dir(&workspace)
        .args(["--mode", "rpc", "--no-session"])
        .args(["--tools", &tools])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The only way Pi reaches the harness. Set on the child rather than in the
    // desktop app's own environment, so a `pi` started outside Darwin finds no
    // socket and cannot call the harness.
    if let Some(path) = harness_socket {
        cmd.env(crate::bridge::SOCKET_ENV, path);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start `{binary}` ({e}). Is Pi installed and on PATH? Set DARWIN_PI_BIN to override."))?;


    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "pi stdin was not piped".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "pi stdout was not piped".to_string())?;

    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.split(b'\n') {
                let Ok(line) = line else { break };
                let text = String::from_utf8_lossy(&line);
                let text = text.trim();
                if !text.is_empty() {
                    let _ = app.emit("pi://stderr", text.to_string());
                }
            }
        });
    }

    let app = app.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf);
                    let line = line.trim_end_matches(['\n', '\r']);
                    if line.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(line) {
                        Ok(record) => {
                            let _ = app.emit("pi://event", record);
                        }
                        Err(err) => {
                            let _ = app.emit(
                                "pi://stderr",
                                format!("could not parse pi record ({err}): {line}"),
                            );
                        }
                    }
                }
                Err(err) => {
                    let _ = app.emit("pi://stderr", format!("pi stdout read failed: {err}"));
                    break;
                }
            }
        }
        let _ = app.emit("pi://exit", "pi stdout closed".to_string());
    });

    Ok(Running {
        child,
        stdin,
        next_id: 0,
    })
}

fn write_record(stdin: &mut ChildStdin, record: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(record).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .map_err(|e| format!("pi stdin write failed: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("pi stdin flush failed: {e}"))
}

/// The directory Pi treats as the project root. Tauri's dev cwd is not
/// reliably the workspace root, so inherit-cwd would be a silent bug.
fn workspace_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("DARWIN_WORKSPACE") {
        return PathBuf::from(dir);
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}
