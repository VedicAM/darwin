//! The `research.corpus` capability: search the project's MongoDB Atlas paper
//! corpus.
//!
//! The connection string is a *credential*, and the whole design keeps
//! credentials in Rust and out of agent-authored code. So this does not hand
//! the URI to a `run_experiment` script the model wrote; it runs a bundled,
//! reviewed query script (`adapters/corpus_query.py`) as a subprocess with
//! `MONGODB_URI` injected into its environment. Pi only ever sends a query
//! string over the bridge and gets structured papers back — the same shape as
//! an arXiv search, so it renders in the same research view.
//!
//! Why a Python subprocess rather than a Rust driver: the harness is
//! deliberately synchronous (see the reqwest note in Cargo.toml), and the only
//! Rust MongoDB client pulls in an async runtime. The bundled-script pattern is
//! the one the tool adapters already use, needs no new dependency, and reuses
//! the experiment environment's interpreter (which carries `pymongo`).

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::capability::{CorpusPaper, CorpusResult};

/// The reviewed query script, embedded so its bytes cannot drift from this
/// build — the same guarantee `catalog.rs` gives adapter source.
const QUERY_SCRIPT: &str = include_str!("../adapters/corpus_query.py");

/// Environment variable carrying the Atlas connection string. Read at call
/// time, never logged, never committed.
pub const MONGODB_URI_ENV: &str = "MONGODB_URI";

/// A corpus query is a single round trip to Atlas; 30s is generous.
const CORPUS_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(serde::Deserialize)]
struct ScriptOutput {
    #[serde(default)]
    results: Vec<CorpusPaper>,
    #[serde(default)]
    error: Option<String>,
}

/// Run a corpus query.
///
/// `interpreter` must be a Python with `pymongo` available — in practice the
/// experiment environment's venv. The URI comes from [`MONGODB_URI_ENV`]; a
/// missing or unusable one is a clear error, never an empty result the agent
/// would read as "the corpus is empty".
pub fn search(
    interpreter: &Path,
    query: &str,
    max_results: usize,
) -> Result<CorpusResult, String> {
    let uri = std::env::var(MONGODB_URI_ENV)
        .ok()
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| {
            format!("{MONGODB_URI_ENV} is not set; the paper corpus is not configured")
        })?;
    if !interpreter.exists() {
        return Err(format!(
            "no interpreter with pymongo at {}; install the experiment environment first",
            interpreter.display()
        ));
    }

    let dir = std::env::temp_dir().join(format!("darwin-corpus-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create corpus scratch dir: {e}"))?;
    let script = dir.join("corpus_query.py");
    std::fs::write(&script, QUERY_SCRIPT).map_err(|e| format!("could not write corpus script: {e}"))?;

    let started = Instant::now();
    let mut child = Command::new(interpreter)
        .arg(&script)
        .current_dir(&dir)
        // Constructed environment: the credential is injected here and nothing
        // from the parent leaks through.
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &dir)
        .env("TMPDIR", &dir)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env(MONGODB_URI_ENV, uri)
        .env("DARWIN_CORPUS_QUERY", query)
        .env("DARWIN_CORPUS_LIMIT", max_results.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start the corpus query: {e}"))?;

    let stdout_rx = drain(child.stdout.take());
    let stderr_rx = drain(child.stderr.take());

    let deadline = started + CORPUS_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = std::fs::remove_dir_all(&dir);
                    return Err(format!(
                        "corpus query exceeded its {}s deadline",
                        CORPUS_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(format!("could not wait for the corpus query: {e}"));
            }
        }
    };
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let stdout = recv(stdout_rx);
    let stderr = recv(stderr_rx);
    let _ = std::fs::remove_dir_all(&dir);

    if !status.success() {
        return Err(format!("corpus query failed: {}", stderr.trim()));
    }
    let last = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let parsed: ScriptOutput = serde_json::from_str(last)
        .map_err(|e| format!("corpus query returned unreadable output ({e}); stderr: {}", stderr.trim()))?;
    if let Some(err) = parsed.error {
        return Err(format!("corpus query error: {err}"));
    }

    Ok(CorpusResult {
        query: query.to_string(),
        results: parsed.results,
        provider: "mongodb-atlas (darwin_evaluation.sources)".to_string(),
        elapsed_ms,
    })
}

fn drain<R: Read + Send + 'static>(reader: Option<R>) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    match reader {
        Some(mut r) => {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = r.read_to_end(&mut buf);
                let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
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
