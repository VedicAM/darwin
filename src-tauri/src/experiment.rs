//! The `experiment.run` execution sandbox.
//!
//! An experiment is agent-authored Python that the *harness* runs — never Pi,
//! which has no execution tools. This is the deliberate concession the rest of
//! the design avoids: the code here is not trusted-but-reviewed like an
//! adapter, it is generated. So the posture matters, and it is the same one
//! `dispatch.rs` uses, tightened:
//!
//!   * cwd is a fresh scratch directory, unique per run, removed afterwards.
//!   * the environment is constructed, not inherited, so the desktop app's
//!     credentials are not visible to the code.
//!   * a wall-clock deadline kills the process; there is no unbounded run.
//!   * stdout/stderr are drained on their own threads and byte-capped, so a
//!     program that prints forever cannot wedge the pipe or the reply.
//!   * only files the run *produced* are reported, and each is size-capped.
//!
//! What this is NOT: network isolation. Same honest limit as `dispatch.rs` —
//! macOS `sandbox-exec` is deprecated and seccomp is unavailable from a Rust
//! std process. An experiment that wants to reach the network can. The bound
//! that makes this safe to expose is the *deadline and the byte caps*, not a
//! network jail.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::capability::{ExperimentInput, ExperimentPlan, ProducedFile, ProducedFileKind};

/// Cap on captured stdout/stderr. A program that prints megabytes is not
/// reporting a result; the tail is dropped and a marker is appended.
const MAX_STDIO_BYTES: usize = 256 * 1024;

/// Largest text file inlined into a `ProducedFile`. Beyond this the file is
/// reported with `truncated: true` and no content.
const MAX_TEXT_PREVIEW_BYTES: u64 = 256 * 1024;

/// Largest image inlined as a data URI. Plots are tens of kilobytes; this is
/// slack, not a target.
const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;

/// What one run produced, before the service attaches provenance.
#[derive(Debug)]
pub struct ExperimentOutcome {
    pub stdout: String,
    pub stderr: String,
    /// `None` when the run was killed on its deadline.
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub produced_files: Vec<ProducedFile>,
    pub elapsed_ms: u64,
}

/// Run one experiment under `interpreter` and collect its output.
///
/// `interpreter` is the Python the harness chose (a managed venv, or the
/// configured fallback). The plan is already validated: code non-empty, inputs
/// are bare filenames, timeout clamped.
pub fn run(interpreter: &Path, plan: &ExperimentPlan) -> Result<ExperimentOutcome, String> {
    if !interpreter.exists() {
        return Err(format!("no experiment interpreter at {}", interpreter.display()));
    }

    let workdir = scratch_dir()?;
    // Best-effort cleanup on every return path.
    let _cleanup = ScratchGuard(workdir.clone());

    stage_inputs(&workdir, &plan.inputs)?;
    let script = workdir.join("experiment.py");
    std::fs::write(&script, &plan.code)
        .map_err(|e| format!("could not write the experiment script: {e}"))?;

    // Everything present before the run is staging, not a result.
    let staged = existing_names(&workdir);

    let mut child = Command::new(interpreter)
        .arg(&script)
        .current_dir(&workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Constructed, not inherited.
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &workdir)
        .env("TMPDIR", &workdir)
        // matplotlib needs a writable config dir and a non-interactive backend
        // or it tries to open a display and hangs the deadline out.
        .env("MPLCONFIGDIR", &workdir)
        .env("MPLBACKEND", "Agg")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONNOUSERSITE", "1")
        .spawn()
        .map_err(|e| format!("could not start the experiment interpreter: {e}"))?;

    let stdout_rx = drain(child.stdout.take());
    let stderr_rx = drain(child.stderr.take());
    // Close stdin immediately: an experiment reads its inputs from files, not
    // from a pipe, and a program blocked on stdin would only burn its deadline.
    drop(child.stdin.take());

    let started = Instant::now();
    let (exit_code, timed_out) = wait_with_deadline(&mut child, Duration::from_secs(plan.timeout_s));
    let elapsed_ms = started.elapsed().as_millis() as u64;

    let stdout = cap(recv(stdout_rx));
    let stderr = cap(recv(stderr_rx));
    let produced_files = collect_produced(&workdir, &staged);

    Ok(ExperimentOutcome {
        stdout,
        stderr,
        exit_code,
        timed_out,
        produced_files,
        elapsed_ms,
    })
}

fn stage_inputs(workdir: &Path, inputs: &[ExperimentInput]) -> Result<(), String> {
    for input in inputs {
        // The name is already validated as a bare filename by
        // `ExperimentRequest::normalized`; join is safe.
        std::fs::write(workdir.join(input.name.trim()), &input.contents)
            .map_err(|e| format!("could not stage input {:?}: {e}", input.name))?;
    }
    Ok(())
}

fn existing_names(workdir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(workdir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                names.push(name.to_string());
            }
        }
    }
    names
}

/// Read the scratch dir and turn every file the run left behind into a
/// `ProducedFile`. Directories and the staged inputs are skipped.
fn collect_produced(workdir: &Path, staged: &[String]) -> Vec<ProducedFile> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(workdir) else {
        return out;
    };
    for entry in entries.flatten() {
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };
        if staged.contains(&name) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) if m.is_file() => m,
            _ => continue,
        };
        let path = entry.path();
        let kind = classify(&name);
        let size = meta.len();
        let (content, truncated) = read_content(&path, kind, size);
        out.push(ProducedFile { name, kind, size, content, truncated });
    }
    // Stable order so the same run renders the same way twice.
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Read a produced file into an inline representation, honouring the per-kind
/// caps. Images become `data:` URIs; text is inlined as-is; anything oversized
/// or undecodable comes back as `(None, true)`.
fn read_content(path: &Path, kind: ProducedFileKind, size: u64) -> (Option<String>, bool) {
    match kind {
        ProducedFileKind::Image => {
            if size > MAX_IMAGE_BYTES {
                return (None, true);
            }
            match std::fs::read(path) {
                Ok(bytes) => {
                    let mime = if path.extension().and_then(|e| e.to_str()) == Some("svg") {
                        "image/svg+xml"
                    } else {
                        "image/png"
                    };
                    (Some(format!("data:{mime};base64,{}", base64_encode(&bytes))), false)
                }
                Err(_) => (None, true),
            }
        }
        _ => {
            if size > MAX_TEXT_PREVIEW_BYTES {
                return (None, true);
            }
            match std::fs::read(path) {
                // A binary file with a text-ish extension decodes lossily; treat
                // a decode failure as "not inlineable" rather than garbling it.
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => (Some(text), false),
                    Err(_) => (None, true),
                },
                Err(_) => (None, true),
            }
        }
    }
}

/// Coarse classification by extension. The frontend refines it (a `.json` may
/// be a plot spec or a table); this only picks the read strategy.
pub fn classify(name: &str) -> ProducedFileKind {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("json") => ProducedFileKind::Data,
        Some("csv") | Some("tsv") => ProducedFileKind::Table,
        Some("fasta") | Some("fa") | Some("fna") | Some("aln") | Some("clustal") => {
            ProducedFileKind::Sequence
        }
        Some("png") | Some("svg") => ProducedFileKind::Image,
        _ => ProducedFileKind::Text,
    }
}

fn cap(mut s: String) -> String {
    if s.len() > MAX_STDIO_BYTES {
        // Truncate on a char boundary at or below the cap.
        let mut end = MAX_STDIO_BYTES;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s.push_str("\n… [output truncated]");
    }
    s
}

/// A unique scratch directory. Process id plus a monotonic counter plus the
/// nanosecond clock, so two concurrent runs — the bridge answers each request
/// on its own thread — cannot collide.
fn scratch_dir() -> Result<PathBuf, String> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "darwin-experiment-{}-{n}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create experiment scratch dir: {e}"))?;
    Ok(dir)
}

struct ScratchGuard(PathBuf);

impl Drop for ScratchGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
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

/// Poll for exit, killing on deadline. Returns `(exit_code, timed_out)`.
fn wait_with_deadline(child: &mut Child, timeout: Duration) -> (Option<i32>, bool) {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return (status.code(), false),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return (None, true);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            // A wait error is not recoverable; treat it as a killed run so the
            // caller reports a failure rather than hanging.
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return (None, true);
            }
        }
    }
}

/// Minimal standard base64 (no line wrapping). Used only to inline small plot
/// images as data URIs; not worth a dependency.
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = chunk.get(1).copied().unwrap_or(0) as usize;
        let b2 = chunk.get(2).copied().unwrap_or(0) as usize;
        out.push(TABLE[b0 >> 2] as char);
        out.push(TABLE[((b0 & 0x03) << 4) | (b1 >> 4)] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((b1 & 0x0f) << 2) | (b2 >> 6)] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[b2 & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::ExperimentRequest;

    fn interpreter() -> PathBuf {
        // These tests need a real Python. The harness venv is not built in a
        // unit test, so use whatever python3 is on PATH; skip if none.
        for cand in ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"] {
            if Path::new(cand).exists() {
                return PathBuf::from(cand);
            }
        }
        PathBuf::from("/usr/bin/python3")
    }

    fn plan(code: &str) -> ExperimentPlan {
        ExperimentRequest::new(code.into()).normalized().unwrap()
    }

    #[test]
    fn classify_maps_extensions_to_kinds() {
        assert_eq!(classify("out.json"), ProducedFileKind::Data);
        assert_eq!(classify("scores.CSV"), ProducedFileKind::Table);
        assert_eq!(classify("aln.fasta"), ProducedFileKind::Sequence);
        assert_eq!(classify("plot.png"), ProducedFileKind::Image);
        assert_eq!(classify("notes"), ProducedFileKind::Text);
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn captures_stdout_and_produced_files() {
        let py = interpreter();
        if !py.exists() {
            eprintln!("skipping: no python3 at {}", py.display());
            return;
        }
        let out = run(
            &py,
            &plan("print('hello')\nopen('result.json','w').write('{\"n\": 3}')\n"),
        )
        .expect("run");
        assert!(out.stdout.contains("hello"), "{}", out.stdout);
        assert_eq!(out.exit_code, Some(0));
        assert!(!out.timed_out);
        let file = out.produced_files.iter().find(|f| f.name == "result.json").expect("json produced");
        assert_eq!(file.kind, ProducedFileKind::Data);
        assert_eq!(file.content.as_deref(), Some("{\"n\": 3}"));
        // The script itself is staging, not a result.
        assert!(!out.produced_files.iter().any(|f| f.name == "experiment.py"));
    }

    #[test]
    fn a_nonzero_exit_is_reported_not_an_error() {
        let py = interpreter();
        if !py.exists() {
            return;
        }
        let out = run(&py, &plan("import sys; sys.stderr.write('boom'); sys.exit(2)")).expect("run");
        assert_eq!(out.exit_code, Some(2));
        assert!(out.stderr.contains("boom"));
    }

    #[test]
    fn an_infinite_loop_is_killed_on_the_deadline() {
        let py = interpreter();
        if !py.exists() {
            return;
        }
        let mut p = plan("while True: pass");
        p.timeout_s = 1;
        let out = run(&py, &p).expect("run");
        assert!(out.timed_out);
        assert_eq!(out.exit_code, None);
    }

    #[test]
    fn staged_inputs_are_readable_and_not_reported_as_produced() {
        let py = interpreter();
        if !py.exists() {
            return;
        }
        let mut req = ExperimentRequest::new(
            "print(open('in.txt').read().strip())".into(),
        );
        req.inputs.push(crate::capability::ExperimentInput {
            name: "in.txt".into(),
            contents: "payload".into(),
        });
        let out = run(&py, &req.normalized().unwrap()).expect("run");
        assert!(out.stdout.contains("payload"));
        assert!(!out.produced_files.iter().any(|f| f.name == "in.txt"));
    }
}
