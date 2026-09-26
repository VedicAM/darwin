//! Tool registry: the operational store.
//!
//! Holds the *declarative* half of a tool (name, version, artifact hash,
//! capability) and the *operational* half (where the venv lives on this
//! machine, which adapter is bound, whether it passed its smoke test).
//!
//! The declarative half is what a result's fingerprint is reconstructible
//! from. The operational half is machine-local and never leaves this machine —
//! a venv path is meaningless elsewhere and leaks the user's directory layout.
//!
//! `ToolRegistry` is a trait so the Atlas-backed implementation can replace
//! this one without any caller changing. IDs are content hashes rather than
//! database-generated keys, so they mean the same thing in either backend.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, MutexGuard};

use crate::capability::{Routing, LINEAR_THRESHOLD};
use crate::fingerprint::{sha256_hex, Algorithm};

pub const SOURCE_PYPI: &str = "pypi";
/// A remote API consulted over the network rather than an index that is
/// downloaded from. Distinct from `pypi` so the source alone says whether a
/// tool's "install" reaches the network.
pub const SOURCE_ARXIV: &str = "arxiv-api";

/// How much trust an artifact needs before it is installed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallTier {
    /// Prebuilt wheel, hash verified. Safe to install unattended.
    Wheel,
    /// Source distribution compiled locally.
    SourceBuild,
    /// Prebuilt native binary, unsigned, checksum verified only.
    NativeBinary,
    /// Built into the binary (no venv install needed).
    Builtin,
}

impl InstallTier {
    pub fn as_str(self) -> &'static str {
        match self {
            InstallTier::Wheel => "wheel",
            InstallTier::SourceBuild => "source_build",
            InstallTier::NativeBinary => "native_binary",
            InstallTier::Builtin => "builtin",
        }
    }

    /// Whether the user must approve before install. Compiling arbitrary
    /// source or running an unsigned binary always needs a human.
    ///
    /// `Builtin` is not that case, and treating it as though it were makes the
    /// tier unusable: a builtin is code already in this binary, reviewed here
    /// and hash-pinned in the catalog, so there is nothing to download and
    /// nothing to execute on the user's behalf. The human decision that
    /// actually matters for a builtin is the one `smoke` gates.
    pub fn requires_approval(self) -> bool {
        matches!(self, InstallTier::SourceBuild | InstallTier::NativeBinary)
    }
}

/// The declarative half. Safe to sync to a shared store.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolRecord {
    pub id: String,
    pub name: String,
    pub version: String,
    pub source: String,
    pub artifact_sha256: String,
    pub requires_python: String,
    pub license: String,
    pub tier: InstallTier,
    /// Capability names this tool can satisfy.
    pub capabilities: Vec<String>,
    pub algorithm: Algorithm,
    pub energy_model: String,
    pub homepage: String,
}

impl ToolRecord {
    /// Content-addressed identity. Stable across databases and machines, which
    /// is what lets the same tool be referenced from Atlas and from SQLite
    /// without a mapping table.
    pub fn make_id(name: &str, version: &str, source: &str) -> String {
        let payload = serde_json::json!({
            "name": name, "version": version, "source": source
        });
        let canonical = serde_json::to_string(&payload).unwrap_or_default();
        sha256_hex(canonical.as_bytes())
    }

    pub fn new(
        name: &str,
        version: &str,
        source: &str,
        artifact_sha256: &str,
        tier: InstallTier,
        algorithm: Algorithm,
    ) -> Self {
        Self {
            id: Self::make_id(name, version, source),
            name: name.to_string(),
            version: version.to_string(),
            source: source.to_string(),
            artifact_sha256: artifact_sha256.to_string(),
            requires_python: String::new(),
            license: String::new(),
            tier,
            capabilities: Vec::new(),
            algorithm,
            energy_model: "Turner2004".to_string(),
            homepage: String::new(),
        }
    }

    pub fn with_capabilities(mut self, caps: &[&str]) -> Self {
        self.capabilities = caps.iter().map(|s| s.to_string()).collect();
        self
    }

    pub fn with_python(mut self, req: &str) -> Self {
        self.requires_python = req.to_string();
        self
    }

    pub fn with_license(mut self, lic: &str) -> Self {
        self.license = lic.to_string();
        self
    }

    pub fn with_homepage(mut self, url: &str) -> Self {
        self.homepage = url.to_string();
        self
    }

    /// Content hash over everything except the id itself, so a changed field
    /// is detectable on sync.
    pub fn content_hash(&self) -> String {
        let mut payload = serde_json::to_value(self).unwrap_or_default();
        if let Some(obj) = payload.as_object_mut() {
            obj.remove("id");
        }
        sha256_hex(serde_json::to_string(&payload).unwrap_or_default().as_bytes())
    }

    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ToolRecord> {
        Ok(ToolRecord {
            id: row.get("id")?,
            name: row.get("name")?,
            version: row.get("version")?,
            source: row.get("source")?,
            artifact_sha256: row.get("artifact_sha256")?,
            requires_python: row.get("requires_python")?,
            license: row.get("license")?,
            tier: match row.get::<_, String>("tier")?.as_str() {
                "wheel" => InstallTier::Wheel,
                "source_build" => InstallTier::SourceBuild,
                "builtin" => InstallTier::Builtin,
                _ => InstallTier::NativeBinary,
            },
            capabilities: serde_json::from_str(&row.get::<_, String>("capabilities")?)
                .unwrap_or_default(),
            algorithm: match row.get::<_, String>("algorithm")?.as_str() {
                "linear_time" => Algorithm::LinearTime,
                "metadata" => Algorithm::Metadata,
                _ => Algorithm::DynamicProgramming,
            },
            energy_model: row.get("energy_model")?,
            homepage: row.get("homepage")?,
        })
    }
}

/// The operational half. Never leaves this machine.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Installation {
    pub tool_id: String,
    pub venv_path: String,
    pub adapter_path: String,
    pub adapter_sha256: String,
    pub python_version: String,
    pub deps_hash: String,
    pub installed_at: String,
    pub smoke_test: Option<SmokeTestResult>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SmokeTestResult {
    pub passed: bool,
    pub detail: String,
    pub ran_at: String,
}

pub trait ToolRegistry {
    fn upsert_tool(&self, rec: &ToolRecord) -> Result<(), String>;
    fn tool(&self, id: &str) -> Result<Option<ToolRecord>, String>;
    fn list_tools(&self) -> Result<Vec<ToolRecord>, String>;
    fn save_installation(&self, inst: &Installation) -> Result<(), String>;
    fn installation(&self, tool_id: &str) -> Result<Option<Installation>, String>;
    fn list_installations(&self) -> Result<Vec<Installation>, String>;
    /// Installed tools that can satisfy a capability.
    fn candidates(&self, capability: &str) -> Result<Vec<ToolRecord>, String>;
}

/// Picks which installed tool handles a call.
///
/// `Auto` prefers the exact implementation for short sequences and the linear
/// one for long ones. Below the threshold the exact answer is cheap enough
/// that approximation buys nothing; above it, the linear implementation is
/// the only interactive option.
pub fn route<'a>(
    candidates: &'a [ToolRecord],
    capability: &str,
    routing: Routing,
    seq_len: usize,
) -> Result<&'a ToolRecord, String> {
    if candidates.is_empty() {
        return Err(format!("no installed tool provides `{capability}`"));
    }
    let want_algorithm = match routing {
        Routing::Linear => Some(Algorithm::LinearTime),
        Routing::Exact => Some(Algorithm::DynamicProgramming),
        Routing::Auto => {
            if seq_len > LINEAR_THRESHOLD {
                Some(Algorithm::LinearTime)
            } else {
                Some(Algorithm::DynamicProgramming)
            }
        }
    };
    let want = want_algorithm.expect("Auto always resolves to an algorithm");
    // Metadata tools (research.arxiv) have no exact/linear split, so the
    // length-based preference does not apply to them.
    if candidates.iter().any(|t| t.algorithm == Algorithm::Metadata) {
        return Ok(&candidates[0]);
    }
    candidates
        .iter()
        .find(|t| t.algorithm == want)
        .or_else(|| candidates.first())
        .ok_or_else(|| format!("no installed tool provides `{capability}`"))
}

/// SQLite-backed registry.
///
/// Tauri managed state must be `Send + Sync`, and a `rusqlite::Connection` is
/// `Send` but not `Sync`. The mutex is what makes it shareable. Public methods
/// take the lock exactly once and delegate to `*_locked` helpers that assume it
/// is already held — a non-reentrant lock plus a public method calling another
/// public method would deadlock.
pub struct SqliteRegistry {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS tools (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    version         TEXT NOT NULL,
    source          TEXT NOT NULL,
    artifact_sha256 TEXT NOT NULL,
    requires_python TEXT NOT NULL,
    license         TEXT NOT NULL,
    tier            TEXT NOT NULL,
    capabilities    TEXT NOT NULL,
    algorithm       TEXT NOT NULL,
    energy_model    TEXT NOT NULL,
    homepage        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS installations (
    tool_id        TEXT PRIMARY KEY,
    venv_path      TEXT NOT NULL,
    adapter_path   TEXT NOT NULL,
    adapter_sha256 TEXT NOT NULL,
    python_version TEXT NOT NULL,
    deps_hash      TEXT NOT NULL,
    installed_at   TEXT NOT NULL,
    smoke_test     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tools_name ON tools(name);
"#;

impl SqliteRegistry {
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("could not open registry: {e}"))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| format!("could not configure registry: {e}"))?;
        conn.execute_batch(SCHEMA)
            .map_err(|e| format!("could not migrate registry: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// A poisoned lock means a previous registry call panicked mid-transaction.
    /// Failing loudly beats reading a half-written registry.
    fn conn(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| "registry lock is poisoned by an earlier panic".to_string())
    }
}

// --- Lock-held helpers. Callers must already hold the connection lock. ---

fn upsert_tool_locked(conn: &Connection, rec: &ToolRecord) -> Result<(), String> {
    let caps = serde_json::to_string(&rec.capabilities).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO tools (id,name,version,source,artifact_sha256,requires_python,
                            license,tier,capabilities,algorithm,energy_model,homepage)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT(id) DO UPDATE SET
             artifact_sha256=excluded.artifact_sha256,
             requires_python=excluded.requires_python,
             license=excluded.license,
             tier=excluded.tier,
             capabilities=excluded.capabilities,
             algorithm=excluded.algorithm,
             energy_model=excluded.energy_model,
             homepage=excluded.homepage",
        params![
            rec.id, rec.name, rec.version, rec.source, rec.artifact_sha256,
            rec.requires_python, rec.license, rec.tier.as_str(), caps,
            rec.algorithm.as_str(), rec.energy_model, rec.homepage,
        ],
    )
    .map_err(|e| format!("could not upsert tool: {e}"))?;
    Ok(())
}

fn list_tools_locked(conn: &Connection) -> Result<Vec<ToolRecord>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM tools ORDER BY name, version")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], ToolRecord::from_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn list_installations_locked(conn: &Connection) -> Result<Vec<Installation>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM installations ORDER BY installed_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], installation_from_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn installation_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Installation> {
    let smoke_raw: String = row.get("smoke_test")?;
    Ok(Installation {
        tool_id: row.get("tool_id")?,
        venv_path: row.get("venv_path")?,
        adapter_path: row.get("adapter_path")?,
        adapter_sha256: row.get("adapter_sha256")?,
        python_version: row.get("python_version")?,
        deps_hash: row.get("deps_hash")?,
        installed_at: row.get("installed_at")?,
        smoke_test: if smoke_raw.is_empty() {
            None
        } else {
            serde_json::from_str(&smoke_raw).ok()
        },
    })
}

impl ToolRegistry for SqliteRegistry {
    fn upsert_tool(&self, rec: &ToolRecord) -> Result<(), String> {
        let conn = self.conn()?;
        upsert_tool_locked(&conn, rec)
    }

    fn tool(&self, id: &str) -> Result<Option<ToolRecord>, String> {
        self.conn()?
            .query_row("SELECT * FROM tools WHERE id=?1", params![id], ToolRecord::from_row)
            .optional()
            .map_err(|e| format!("could not read tool: {e}"))
    }

    fn list_tools(&self) -> Result<Vec<ToolRecord>, String> {
        let conn = self.conn()?;
        list_tools_locked(&conn)
    }

    fn save_installation(&self, inst: &Installation) -> Result<(), String> {
        let smoke = match &inst.smoke_test {
            Some(s) => serde_json::to_string(s).map_err(|e| e.to_string())?,
            None => String::new(),
        };
        self.conn()?
            .execute(
                "INSERT INTO installations (tool_id,venv_path,adapter_path,adapter_sha256,
                                            python_version,deps_hash,installed_at,smoke_test)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(tool_id) DO UPDATE SET
                     venv_path=excluded.venv_path,
                     adapter_path=excluded.adapter_path,
                     adapter_sha256=excluded.adapter_sha256,
                     python_version=excluded.python_version,
                     deps_hash=excluded.deps_hash,
                     installed_at=excluded.installed_at,
                     smoke_test=excluded.smoke_test",
                params![
                    inst.tool_id, inst.venv_path, inst.adapter_path, inst.adapter_sha256,
                    inst.python_version, inst.deps_hash, inst.installed_at, smoke,
                ],
            )
            .map_err(|e| format!("could not save installation: {e}"))?;
        Ok(())
    }

    fn installation(&self, tool_id: &str) -> Result<Option<Installation>, String> {
        self.conn()?
            .query_row(
                "SELECT * FROM installations WHERE tool_id=?1",
                params![tool_id],
                installation_from_row,
            )
            .optional()
            .map_err(|e| format!("could not read installation: {e}"))
    }

    fn list_installations(&self) -> Result<Vec<Installation>, String> {
        let conn = self.conn()?;
        list_installations_locked(&conn)
    }

    fn candidates(&self, capability: &str) -> Result<Vec<ToolRecord>, String> {
        // One lock, two locked helpers. Calling the public methods here would
        // deadlock on the non-reentrant mutex.
        let conn = self.conn()?;
        let all = list_tools_locked(&conn)?;
        let installed = list_installations_locked(&conn)?;
        let passed: Vec<&str> = installed
            .iter()
            .filter(|i| i.smoke_test.as_ref().map(|s| s.passed).unwrap_or(false))
            .map(|i| i.tool_id.as_str())
            .collect();
        let mut out: Vec<ToolRecord> = all
            .into_iter()
            .filter(|t| passed.contains(&t.id.as_str()))
            .filter(|t| t.capabilities.iter().any(|c| c == capability))
            .collect();
        out.sort_by(|a, b| {
            a.algorithm
                .as_str()
                .cmp(b.algorithm.as_str())
                .then(a.name.cmp(&b.name))
        });
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::{CAP_FOLD_ENSEMBLE, CAP_FOLD_MFE};

    const SOURCE_CONDA: &str = "conda";

    fn lf() -> ToolRecord {
        ToolRecord::new("pylinearfold", "1.0.0", SOURCE_PYPI, &"a".repeat(64), InstallTier::Wheel, Algorithm::LinearTime)
            .with_capabilities(&[CAP_FOLD_MFE, CAP_FOLD_ENSEMBLE])
            .with_python(">=3.10")
    }

    fn vrna() -> ToolRecord {
        ToolRecord::new("ViennaRNA", "2.7.2", SOURCE_PYPI, &"b".repeat(64), InstallTier::Wheel, Algorithm::DynamicProgramming)
            .with_capabilities(&[CAP_FOLD_MFE, CAP_FOLD_ENSEMBLE])
            .with_python(">=3.8")
    }

    fn reg_with(f: impl FnOnce(&SqliteRegistry)) -> SqliteRegistry {
        let r = SqliteRegistry::open_in_memory().unwrap();
        f(&r);
        r
    }

    #[test]
    fn id_is_content_addressed_and_stable() {
        let a = ToolRecord::make_id("x", "1.0", SOURCE_PYPI);
        let b = ToolRecord::make_id("x", "1.0", SOURCE_PYPI);
        let c = ToolRecord::make_id("x", "1.0", SOURCE_CONDA);
        assert_eq!(a, b);
        assert_ne!(a, c, "source must participate in identity");
    }

    #[test]
    fn round_trips_a_tool() {
        let r = reg_with(|r| r.upsert_tool(&lf()).unwrap());
        let got = r.tool(&lf().id).unwrap().unwrap();
        assert_eq!(got.name, "pylinearfold");
        assert_eq!(got.capabilities.len(), 2);
        assert_eq!(got.algorithm, Algorithm::LinearTime);
        assert_eq!(got.tier, InstallTier::Wheel);
    }

    #[test]
    fn candidates_exclude_uninstalled_and_failing_tools() {
        let r = reg_with(|r| {
            r.upsert_tool(&lf()).unwrap();
            r.upsert_tool(&vrna()).unwrap();
        });
        // Nothing installed yet.
        assert!(r.candidates(CAP_FOLD_MFE).unwrap().is_empty());

        // Installed but no smoke test -> not trusted.
        r.save_installation(&Installation {
            tool_id: lf().id,
            venv_path: "/tmp/v".into(),
            adapter_path: "/tmp/a.py".into(),
            adapter_sha256: "d".repeat(64),
            python_version: "3.14.7".into(),
            deps_hash: "e".repeat(64),
            installed_at: "2026-01-01T00:00:00Z".into(),
            smoke_test: None,
        })
        .unwrap();
        assert!(r.candidates(CAP_FOLD_MFE).unwrap().is_empty());

        // Smoke test passed -> trusted.
        r.save_installation(&Installation {
            tool_id: lf().id,
            venv_path: "/tmp/v".into(),
            adapter_path: "/tmp/a.py".into(),
            adapter_sha256: "d".repeat(64),
            python_version: "3.14.7".into(),
            deps_hash: "e".repeat(64),
            installed_at: "2026-01-01T00:00:00Z".into(),
            smoke_test: Some(SmokeTestResult {
                passed: true,
                detail: "ok".into(),
                ran_at: "2026-01-01T00:00:00Z".into(),
            }),
        })
        .unwrap();
        assert_eq!(r.candidates(CAP_FOLD_MFE).unwrap().len(), 1);
    }

    #[test]
    fn auto_routing_switches_algorithm_with_length() {
        let cands = vec![vrna(), lf()];
        let short = route(&cands, CAP_FOLD_MFE, Routing::Auto, 100).unwrap();
        assert_eq!(short.algorithm, Algorithm::DynamicProgramming);
        let long = route(&cands, CAP_FOLD_MFE, Routing::Auto, 50_000).unwrap();
        assert_eq!(long.algorithm, Algorithm::LinearTime);
    }

    #[test]
    fn explicit_routing_overrides_length() {
        let cands = vec![vrna(), lf()];
        let a = route(&cands, CAP_FOLD_MFE, Routing::Linear, 10).unwrap();
        assert_eq!(a.algorithm, Algorithm::LinearTime);
        let b = route(&cands, CAP_FOLD_MFE, Routing::Exact, 999_999).unwrap();
        assert_eq!(b.algorithm, Algorithm::DynamicProgramming);
    }

    #[test]
    fn routing_falls_back_when_preferred_algorithm_absent() {
        let only_linear = vec![lf()];
        let got = route(&only_linear, CAP_FOLD_MFE, Routing::Exact, 10).unwrap();
        assert_eq!(got.algorithm, Algorithm::LinearTime);
    }

    #[test]
    fn routing_errors_on_empty_candidates() {
        assert!(route(&[], CAP_FOLD_MFE, Routing::Auto, 10).is_err());
    }

    #[test]
    fn only_downloaded_tiers_need_approval() {
        // A builtin is code already in this binary, so there is nothing to
        // fetch and nothing new to trust.
        assert!(!InstallTier::Builtin.requires_approval());
        assert!(!InstallTier::Wheel.requires_approval());
        assert!(InstallTier::SourceBuild.requires_approval());
        assert!(InstallTier::NativeBinary.requires_approval());
    }
}
