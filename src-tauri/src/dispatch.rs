//! Sandboxed capability dispatch.
//!
//! An adapter is a Python script run by a tool's own venv interpreter. It
//! reads one JSON request on stdin and writes one JSON response on stdout.
//! Everything it needs to know about its provenance arrives in the environment,
//! supplied by the registry, so an adapter cannot misreport which tool or
//! version produced a result.
//!
//! Sandbox posture, and its honest limits:
//!   * cwd is a fresh temp directory, so a stray relative write lands nowhere
//!     useful.
//!   * the environment is constructed, not inherited, so credentials in the
//!     parent's environment (cloud keys, tokens, a database URI) are not
//!     visible to adapter code.
//!   * a wall-clock deadline kills the process. This is not optional: ViennaRNA
//!     loops forever on a malformed structure rather than erroring.
//!   * Network isolation is NOT enforced. macOS `sandbox-exec` is deprecated
//!     and seccomp-style enforcement is not available from a Rust std
//!     process. An adapter that wants to phone home can. Treat adapter code as
//!     trusted-but-reviewed, not as a security boundary against a hostile
//!     package.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::capability::AdapterResponse;

/// Provenance handed to the adapter. Deliberately not adapter-settable.
#[derive(Clone, Debug, Serialize)]
pub struct AdapterContext {
    pub tool: String,
    pub tool_version: String,
    pub artifact_sha256: String,
    pub adapter_sha256: String,
    pub algorithm: String,
    pub energy_model: String,
    pub harness_rev: String,
}

#[derive(Debug)]
pub struct DispatchOutcome {
    pub response: AdapterResponse,
    /// Diagnostics the adapter wrote. Not part of the response, but it is the
    /// only useful evidence when a known-answer test or a context check fails.
    pub stderr: String,
    pub elapsed_ms: u64,
}

/// Run an adapter with one request and enforce a deadline.
pub fn run(
    venv: &Path,
    adapter: &Path,
    request: &serde_json::Value,
    ctx: &AdapterContext,
    timeout: Duration,
) -> Result<DispatchOutcome, String> {
    let py = venv.join("bin").join("python");
    if !py.exists() {
        return Err(format!("no interpreter at {}", py.display()));
    }
    if !adapter.exists() {
        return Err(format!("no adapter at {}", adapter.display()));
    }

    let workdir = std::env::temp_dir().join(format!("darwin-{}", std::process::id()));
    std::fs::create_dir_all(&workdir)
        .map_err(|e| format!("could not create scratch dir: {e}"))?;

    let mut child = Command::new(&py)
        .arg(adapter)
        .current_dir(&workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Constructed, not inherited: the adapter must not see the desktop
        // app's environment.
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &workdir)
        .env("TMPDIR", &workdir)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONNOUSERSITE", "1")
        .env("DARWIN_TOOL", &ctx.tool)
        .env("DARWIN_TOOL_VERSION", &ctx.tool_version)
        .env("DARWIN_ARTIFACT_SHA256", &ctx.artifact_sha256)
        .env("DARWIN_ADAPTER_SHA256", &ctx.adapter_sha256)
        .env("DARWIN_ALGORITHM", &ctx.algorithm)
        .env("DARWIN_ENERGY_MODEL", &ctx.energy_model)
        .env("DARWIN_HARNESS_REV", &ctx.harness_rev)
        .spawn()
        .map_err(|e| format!("could not start adapter: {e}"))?;

    let stdout_rx = drain(child.stdout.take(), "stdout");
    let stderr_rx = drain(child.stderr.take(), "stderr");

    if let Some(mut stdin) = child.stdin.take() {
        let payload = serde_json::to_vec(request).map_err(|e| e.to_string())?;
        let _ = stdin.write_all(&payload);
        // Closing stdin is the signal for the adapter to stop reading.
    }

    let started = Instant::now();
    let status = wait_with_deadline(&mut child, timeout)?;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    let stdout = recv(stdout_rx);
    let stderr = recv(stderr_rx);
    let _ = std::fs::remove_dir_all(&workdir);

    if !status.success() {
        return Err(format!(
            "adapter exited with {status}; stderr: {}",
            stderr.trim()
        ));
    }

    // The adapter may print diagnostics before its response, so take the last
    // non-empty line rather than assuming stdout is pure JSON.
    let last = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    if last.is_empty() {
        return Err(format!("adapter produced no output; stderr: {}", stderr.trim()));
    }
    let response: AdapterResponse = serde_json::from_str(last).map_err(|e| {
        format!(
            "adapter output was not a valid response ({e}); got: {}",
            truncate(last, 400)
        )
    })?;

    Ok(DispatchOutcome { response, stderr, elapsed_ms })
}

/// Owns one pipe for the life of the child.
///
/// Draining is not optional: if the adapter writes more than the pipe buffer
/// and nothing reads it, the child blocks forever and the deadline kill
/// becomes the only way out. Same failure mode as an undrained Pi stdout.
fn drain<R: Read + Send + 'static>(reader: Option<R>, label: &'static str) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    match reader {
        Some(mut r) => {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                if let Ok(n) = r.read_to_end(&mut buf) {
                    let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
                } else {
                    let _ = tx.send(format!("<{label} unreadable>"));
                }
            });
        }
        None => {
            let _ = tx.send(String::new());
        }
    }
    rx
}

fn recv(rx: mpsc::Receiver<String>) -> String {
    rx.recv().unwrap_or_default()
}

/// Poll for exit, killing on deadline. `wait()` alone would block forever.
fn wait_with_deadline(child: &mut Child, timeout: Duration) -> Result<std::process::ExitStatus, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "adapter exceeded its {}s deadline and was killed; \
                         check the input is a valid sequence",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("could not wait for adapter: {e}")),
        }
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let head: String = s.chars().take(n).collect();
        format!("{head}...")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_on_char_boundary() {
        assert_eq!(truncate("abc", 10), "abc");
        let t = truncate("ααααα", 3);
        assert_eq!(t, "ααα...");
    }

    #[test]
    fn missing_interpreter_is_reported_not_panicked() {
        let r = run(
            Path::new("/nonexistent-venv"),
            Path::new("/nonexistent.py"),
            &serde_json::json!({}),
            &AdapterContext {
                tool: "t".into(),
                tool_version: "1".into(),
                artifact_sha256: String::new(),
                adapter_sha256: String::new(),
                algorithm: "linear_time".into(),
                energy_model: "Turner2004".into(),
                harness_rev: String::new(),
            },
            Duration::from_secs(1),
        );
        assert!(r.unwrap_err().contains("no interpreter"));
    }
}
