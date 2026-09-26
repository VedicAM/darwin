//! The Pi-to-harness bridge.
//!
//! Pi is a child process. It reasons, it has `read`/`ls`/`grep`/`find`, and it
//! deliberately does **not** have network access — a webview that can issue
//! prompts must not be able to issue arbitrary HTTP requests. But it still has
//! to be able to *ask the harness to do science*, so there has to be a
//! channel.
//!
//! The channel is a Unix domain socket, and the choice is the security
//! property rather than an implementation detail:
//!
//!   * **No TCP port.** A localhost listener is reachable by anything on the
//!     machine and needs a port to collide with. A socket is a filesystem
//!     entry in the app's own data directory, created with mode `0600`.
//!   * **No new dependency.** `std::os::unix::net` is in the standard library
//!     and Node's `net` module is built in, so the bridge adds nothing to
//!     either dependency tree.
//!   * **The trust boundary does not move.** The peer is still the same
//!     capability request a webview `invoke` would make, and it still goes
//!     through `Harness::execute`, so the registry invariant — installed,
//!     smoke-passed, routed — is enforced identically. The socket is a
//!     transport, not a back door around the registry.
//!
//! ## Wire format
//!
//! One JSON object per connection, one line each way. The request is a
//! `CapabilityRequest`; the response is a `BridgeReply`.
//!
//! ```text
//! -> {"capability":"research.arxiv","query":"RNA consensus structure"}
//! <- {"ok":true,"capability":"research.arxiv","result":{...}}
//! <- {"ok":false,"error":"no installed tool provides `research.arxiv`"}
//! ```
//!
//! `ok: false` is always a real error string. There is deliberately no "succeeded
//! but found nothing" encoding, because the failure this guards against is an
//! agent reporting "no papers found" after a dropped connection.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::capability::{CapabilityRequest, CapabilityResult};
use crate::service::Harness;

/// Longest request line accepted. A capability request is a few hundred bytes;
/// a megabyte is a mistake or an attack, and either way it is not a request.
const MAX_REQUEST_BYTES: usize = 64 * 1024;

/// Environment variable carrying the socket path to the Pi child.
///
/// The path is per-app-instance and lives in the app data directory, so it is
/// not a guessable location and does not need to be a fixed path that two
/// windows would fight over.
pub const SOCKET_ENV: &str = "DARWIN_HARNESS_SOCKET";

/// A running bridge. Dropping it closes the listener and removes the socket
/// file, so a stale socket cannot outlive the app that owned it.
pub struct Bridge {
    path: PathBuf,
    /// Held for its `Drop`, which unlinks the socket file. The listener itself
    /// has already been moved into the accept thread; this is a path, not a
    /// second socket, so there is no double-bind here.
    _guard: SocketPathGuard,
}

struct SocketPathGuard(PathBuf);

impl Drop for SocketPathGuard {
    fn drop(&mut self) {
        // Best effort: a leftover socket is inert once the listener is gone,
        // and `serve` unlinks a stale one before binding, so failing to clean
        // up here cannot wedge the next launch.
        let _ = std::fs::remove_file(&self.0);
    }
}

impl Bridge {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// One reply. `Serialize` and `Deserialize` rather than a hand-rolled string,
/// so the shape the extension parses is checked by the compiler.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "ok", rename_all = "snake_case")]
pub enum BridgeReply {
    Ok {
        capability: String,
        result: CapabilityResult,
    },
    Error {
        error: String,
    },
}

impl BridgeReply {
    fn failure(err: String) -> Self {
        BridgeReply::Error { error: err }
    }
}

/// Bind the socket and start serving capability requests.
///
/// The socket path is `<data_dir>/harness.sock`. A file already at that path is
/// removed first, because a socket left behind by a crashed process would
/// otherwise make every subsequent launch fail to bind.
pub fn serve(harness: Arc<Harness>, data_dir: &Path) -> Result<Bridge, String> {
    let path = data_dir.join("harness.sock");
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("could not remove the stale harness socket at {}: {e}", path.display()))?;
    }

    let listener = UnixListener::bind(&path)
        .map_err(|e| format!("could not bind the harness socket at {}: {e}", path.display()))?;
    // 0600: the socket grants the ability to run science and reach the
    // network on this machine's behalf, so it belongs to the user alone.
    // Notably *not* the process umask default, which would leave it
    // group- or world-accessible depending on how the app was launched.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("could not restrict the harness socket permissions: {e}"))?;

    let accept_path = path.clone();
    std::thread::Builder::new()
        .name("darwin-harness-bridge".into())
        .spawn(move || {
            // One thread per connection, bounded by a handler that answers and
            // closes. Connections are short-lived by construction: a client
            // writes one line and reads one line, so a thread per connection
            // cannot be a resource leak unless a client holds a connection
            // open without writing, which `read_line` below bounds by timeout
            // on the next call rather than by this loop.
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let harness = Arc::clone(&harness);
                // A detached thread per request keeps a slow search from
                // blocking the next one. The harness is `Sync`, so this is
                // sound; the arXiv throttle serialises the rate limit itself.
                let _ = std::thread::Builder::new()
                    .name("darwin-harness-req".into())
                    .spawn(move || {
                        if let Err(e) = handle(&harness, stream) {
                            eprintln!("darwin harness bridge: {e}");
                        }
                    });
            }
            let _ = std::fs::remove_file(&accept_path);
        })
        .map_err(|e| format!("could not start the harness bridge thread: {e}"))?;

    Ok(Bridge {
        path: path.clone(),
        _guard: SocketPathGuard(path),
    })
}

/// Answer one request.
fn handle(harness: &Harness, stream: UnixStream) -> Result<(), String> {
    // A client that connects and never writes would otherwise pin a thread
    // forever. Bounded, because the alternative is an unbounded wait on an
    // untrusted local peer.
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(30)))
        .map_err(|e| format!("could not set the socket read timeout: {e}"))?;
    stream
        .set_write_timeout(Some(std::time::Duration::from_secs(30)))
        .map_err(|e| format!("could not set the socket write timeout: {e}"))?;

    let reply = match read_request(&stream) {
        Err(e) => BridgeReply::failure(e),
        Ok(request) => match harness.execute(&request) {
            Ok(result) => BridgeReply::Ok {
                capability: result.capability().to_string(),
                result,
            },
            Err(e) => BridgeReply::failure(e),
        },
    };

    let mut line = serde_json::to_string(&reply).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut out = stream;
    out.write_all(line.as_bytes())
        .map_err(|e| format!("could not write the harness reply: {e}"))?;
    out.flush()
        .map_err(|e| format!("could not flush the harness reply: {e}"))
}

/// Read one length-bounded JSON line and parse it as a capability request.
fn read_request(stream: &UnixStream) -> Result<CapabilityRequest, String> {
    let mut line = String::new();
    // `take` is the bound: without it a peer could stream forever and the
    // thread would never reach the parse. It is applied to the stream rather
    // than the reader so the cap is on bytes off the socket, not on lines.
    let read = BufReader::new(stream)
        .take(MAX_REQUEST_BYTES as u64)
        .read_line(&mut line)
        .map_err(|e| format!("could not read the harness request: {e}"))?;
    if read == 0 {
        return Err("harness request was empty".into());
    }
    if read >= MAX_REQUEST_BYTES {
        return Err(format!(
            "harness request exceeded {MAX_REQUEST_BYTES} bytes"
        ));
    }
    serde_json::from_str(&line).map_err(|e| {
        format!("harness request was not a valid capability request: {e}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "darwin-bridge-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn harness(dir: &Path) -> Arc<Harness> {
        let h = Arc::new(Harness::open(dir, "testrev").expect("open harness"));
        h.seed_catalog().expect("seed");
        h
    }

    #[test]
    fn a_socket_is_created_owner_only() {
        let dir = temp_dir("perms");
        let _bridge = serve(harness(&dir), &dir).expect("serve");
        let meta = std::fs::metadata(dir.join("harness.sock")).expect("socket exists");
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unknown_capability_is_an_explicit_error_not_an_empty_success() {
        let dir = temp_dir("unknown");
        let _bridge = serve(harness(&dir), &dir).expect("serve");
        let mut c = UnixStream::connect(dir.join("harness.sock")).expect("connect");
        c.write_all(br#"{"capability":"fold.nonsense"}"#)
            .and_then(|_| c.write_all(b"\n"))
            .expect("write");
        let mut reply = String::new();
        BufReader::new(&c).read_line(&mut reply).expect("read");
        let parsed: BridgeReply = serde_json::from_str(&reply).expect("reply json");
        assert!(
            matches!(&parsed, BridgeReply::Error { error } if !error.is_empty()),
            "expected an error reply, got {reply}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_malformed_request_is_refused_rather_than_crashing() {
        let dir = temp_dir("malformed");
        let _bridge = serve(harness(&dir), &dir).expect("serve");
        let mut c = UnixStream::connect(dir.join("harness.sock")).expect("connect");
        c.write_all(b"not json at all\n").expect("write");
        let mut reply = String::new();
        BufReader::new(&c).read_line(&mut reply).expect("read");
        let parsed: BridgeReply = serde_json::from_str(&reply).expect("reply json");
        assert!(matches!(parsed, BridgeReply::Error { .. }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_request_before_install_reports_the_install_guidance() {
        // Nothing is installed, so the registry has no candidate. The reply
        // must say so rather than returning an empty result the agent would
        // read as "no papers exist".
        let dir = temp_dir("uninstalled");
        let _bridge = serve(harness(&dir), &dir).expect("serve");
        let mut c = UnixStream::connect(dir.join("harness.sock")).expect("connect");
        c.write_all(br#"{"capability":"research.arxiv","query":"rna"}"#)
            .and_then(|_| c.write_all(b"\n"))
            .expect("write");
        let mut reply = String::new();
        BufReader::new(&c).read_line(&mut reply).expect("read");
        let parsed: BridgeReply = serde_json::from_str(&reply).expect("reply json");
        match parsed {
            BridgeReply::Error { error } => {
                assert!(error.contains("no installed tool"), "{error}")
            }
            other => panic!("expected an error, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_socket_path_is_removed_when_the_bridge_drops() {
        let dir = temp_dir("cleanup");
        let socket = dir.join("harness.sock");
        {
            let _bridge = serve(harness(&dir), &dir).expect("serve");
            assert!(socket.exists());
        }
        assert!(!socket.exists(), "socket outlived the bridge");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stale_socket_file_does_not_block_the_next_launch() {
        let dir = temp_dir("stale");
        // Simulate a crashed previous run: the path exists but nothing is
        // listening on it.
        std::fs::write(dir.join("harness.sock"), b"stale").expect("write stale file");
        let _bridge = serve(harness(&dir), &dir).expect("serve should unlink first");
        assert!(dir.join("harness.sock").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversized_requests_are_refused_before_parsing() {
        let dir = temp_dir("oversize");
        let _bridge = serve(harness(&dir), &dir).expect("serve");
        let mut c = UnixStream::connect(dir.join("harness.sock")).expect("connect");
        let blob = "x".repeat(MAX_REQUEST_BYTES + 16);
        c.write_all(blob.as_bytes())
            .and_then(|_| c.write_all(b"\n"))
            .expect("write");
        let mut reply = String::new();
        BufReader::new(&c).read_line(&mut reply).expect("read");
        let parsed: BridgeReply = serde_json::from_str(&reply).expect("reply json");
        match parsed {
            BridgeReply::Error { error } => assert!(error.contains("exceeded"), "{error}"),
            other => panic!("expected an oversize error, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
