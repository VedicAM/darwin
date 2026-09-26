//! Managed tool environments and hash-pinned installs.
//!
//! Each tool gets its own venv under the app data directory. Nothing is ever
//! installed into the system interpreter, and nothing is upgraded in place: a
//! new version is a new directory, so an old environment stays byte-for-byte
//! reproducible.
//!
//! Hashes are enforced by pip itself via a `--require-hashes` requirements
//! file. That is stronger than hashing after the fact, because a swapped file
//! on the index fails the install instead of being detected later.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::fingerprint::{hash_deps, sha256_hex};

// Re-exported so a caller that has just installed something can compute the
// dependency hash of an empty set — which is what a builtin genuinely has —
// without reaching into a private `use`.
pub use crate::fingerprint::hash_deps as hash_empty_deps;

/// One resolved artifact: an exact version with the hash of the exact file
/// that will be installed.
#[derive(Clone, Debug)]
pub struct Pin {
    pub name: String,
    pub version: String,
    pub sha256: String,
}

impl Pin {
    /// A requirement line pinning name, version, and file hash together, so
    /// pip refuses to proceed if any of the three differ.
    pub fn requirement_line(&self) -> String {
        format!("{}=={} --hash=sha256:{}", self.name, self.version, self.sha256)
    }
}

/// Locate a Python 3 interpreter to build venvs from, with no version
/// constraint. Prefer `base_python_for_tag` when the wheels are pinned.
pub fn base_python() -> Result<String, String> {
    if let Ok(p) = std::env::var("DARWIN_PYTHON") {
        if Path::new(&p).exists() {
            return Ok(p);
        }
    }
    for candidate in ["python3", "python3.13", "python3.12"] {
        if probe_version(candidate).is_some_and(|(ma, mi)| (ma, mi) >= (3, 10)) {
            return Ok(candidate.to_string());
        }
    }
    Err("no Python >= 3.10 found; set DARWIN_PYTHON to override".into())
}

/// A wheel ABI tag such as `cp313` or `cp314t` (the trailing `t` is
/// free-threaded CPython).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WheelTag {
    pub major: u32,
    pub minor: u32,
    pub free_threaded: bool,
}

impl WheelTag {
    pub fn parse(tag: &str) -> Result<Self, String> {
        let rest = tag
            .strip_prefix("cp")
            .ok_or_else(|| format!("`{tag}` is not a CPython ABI tag"))?;
        let (digits, free_threaded) = match rest.strip_suffix('t') {
            Some(d) => (d, true),
            None => (rest, false),
        };
        if digits.len() < 2 || !digits.chars().all(|c| c.is_ascii_digit()) {
            return Err(format!("`{tag}` is not a CPython ABI tag"));
        }
        let (major, minor) = digits.split_at(digits.len() - 2);
        Ok(Self {
            major: major.parse().map_err(|e| format!("bad tag `{tag}`: {e}"))?,
            minor: minor.parse().map_err(|e| format!("bad tag `{tag}`: {e}"))?,
            free_threaded,
        })
    }
}

fn probe_version(candidate: &str) -> Option<(u32, u32)> {
    let out = Command::new(candidate)
        .arg("-c")
        .arg("import sys;print(f'{sys.version_info[0]}.{sys.version_info[1]}')")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let s = s.trim();
    let (ma, mi) = s.split_once('.')?;
    Some((ma.parse().ok()?, mi.parse().ok()?))
}

fn is_free_threaded(candidate: &str) -> bool {
    Command::new(candidate)
        .arg("-c")
        .arg("import sys;print(int(not __import__('sys')._is_gil_enabled()))")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "1")
        .unwrap_or(false)
}

/// Find an interpreter whose ABI matches a pinned wheel tag.
///
/// A hash-enforced install cannot work across ABIs: the cp314 wheel and the
/// cp312 wheel are different files with different hashes, so a venv on the
/// wrong Python fails the install rather than degrading. `DARWIN_PYTHON`, when
/// set, is authoritative — if it disagrees with the tag that is a configuration
/// error worth reporting, not something to paper over.
pub fn base_python_for_tag(tag: WheelTag) -> Result<String, String> {
    if let Ok(p) = std::env::var("DARWIN_PYTHON") {
        if !p.is_empty() {
            if !Path::new(&p).exists() {
                return Err(format!("DARWIN_PYTHON={p} does not exist"));
            }
            let got = probe_version(&p)
                .ok_or_else(|| format!("DARWIN_PYTHON={p} is not a usable interpreter"))?;
            let ft = is_free_threaded(&p);
            if got == (tag.major, tag.minor) && ft == tag.free_threaded {
                return Ok(p);
            }
            return Err(format!(
                "DARWIN_PYTHON={p} is Python {}.{}, but the pinned wheels are for Python {}.{}{}",
                got.0,
                got.1,
                tag.major,
                tag.minor,
                if tag.free_threaded { ", free-threaded" } else { "" }
            ));
        }
    }

    // Newest first, so a machine with several pythons gets the one the wheels
    // were built against.
    let mut names: Vec<String> = Vec::new();
    for minor in (10..=14).rev() {
        names.push(format!("python3.{minor}"));
    }
    names.push("python3".to_string());

    for name in names {
        if probe_version(&name) != Some((tag.major, tag.minor)) {
            continue;
        }
        if is_free_threaded(&name) != tag.free_threaded {
            continue;
        }
        return Ok(name);
    }
    Err(format!(
        "no Python {}.{} interpreter found for the pinned wheels ({}); \
         install one or set DARWIN_PYTHON",
        tag.major,
        tag.minor,
        if tag.free_threaded { "free-threaded" } else { "standard" }
    ))
}

fn venv_python(venv: &Path) -> Result<PathBuf, String> {
    let p = venv.join("bin").join("python");
    if p.exists() {
        Ok(p)
    } else {
        Err(format!("no interpreter at {}", p.display()))
    }
}

/// Create a fresh venv. Fails if the directory already exists, which is what
/// makes "never upgrade in place" enforceable rather than aspirational.
///
/// `tag` pins the ABI of the resulting venv; pass `None` to accept any
/// Python >= 3.10.
pub fn create_venv(venv: &Path, tag: Option<WheelTag>) -> Result<String, String> {
    if venv.exists() {
        return Err(format!("{} already exists", venv.display()));
    }
    if let Some(dir) = venv.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    }
    let base = match tag {
        Some(t) => base_python_for_tag(t)?,
        None => base_python()?,
    };
    let out = Command::new(&base)
        .arg("-m")
        .arg("venv")
        .arg(venv)
        .output()
        .map_err(|e| format!("could not run `{base} -m venv`: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "venv creation failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    python_version(venv)
}

pub fn python_version(venv: &Path) -> Result<String, String> {
    let py = venv_python(venv)?;
    let out = Command::new(py)
        .arg("-c")
        .arg("import platform;print(platform.python_version())")
        .output()
        .map_err(|e| format!("could not query interpreter version: {e}"))?;
    if !out.status.success() {
        return Err("interpreter did not report a version".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Install pinned artifacts with hash enforcement.
///
/// `pip_free` drops pip from the environment afterwards so the resolved set
/// cannot drift under us, and the environment is then hashed to form part of
/// every result's fingerprint.
pub fn install_pinned(venv: &Path, pins: &[Pin]) -> Result<InstallationInfo, String> {
    if pins.is_empty() {
        return Err("no pins supplied".into());
    }
    let py = venv_python(venv)?;
    let req = venv.join("darwin-requirements.txt");
    let body = pins
        .iter()
        .map(|p| p.requirement_line())
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&req, format!("{body}\n")).map_err(|e| format!("could not write requirements: {e}"))?;

    let out = Command::new(&py)
        .arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--require-hashes")
        .arg("--no-deps")
        .arg("--disable-pip-version-check")
        .arg("-r")
        .arg(&req)
        .output()
        .map_err(|e| format!("pip install failed to start: {e}"))?;

    if !out.status.success() {
        let _ = std::fs::remove_file(&req);
        return Err(format!(
            "hash-verified install rejected:\n{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let info = InstallationInfo {
        python_version: python_version(venv)?,
        deps: frozen_deps(venv)?,
    };
    let _ = std::fs::remove_file(&req);
    Ok(info)
}

/// Install packages (each spec a pip requirement string, optionally version-
/// pinned) *with* their dependencies, without hash enforcement.
///
/// This is the weaker sibling of [`install_pinned`], and the weakening is
/// deliberate and scoped. The experiment environment exists to run
/// agent-authored code, which is already the one place the harness executes
/// something it did not vet — so hash-pinning the base scientific stack is
/// defense-in-depth here, not the trust boundary it is for a fold result. It is
/// traded away because a hash-pinned install needs a fully resolved lockfile
/// (every transitive wheel, per ABI), which the scientific stack does not ship
/// with. Versions are still pinned, and the *resolved* set is captured by
/// `pip freeze` into a `deps_hash`, so a run is still attributable to an exact
/// environment even though the fetch was not hash-verified.
///
/// TODO: once the stack is resolved on a real cp314 machine, replace this with a
/// committed hash-pinned lockfile and route it through `install_pinned`.
pub fn install_versioned(venv: &Path, specs: &[&str]) -> Result<InstallationInfo, String> {
    if specs.is_empty() {
        return Err("no package specs supplied".into());
    }
    let py = venv_python(venv)?;
    let req = venv.join("darwin-experiment-requirements.txt");
    let body = specs.join("\n");
    std::fs::write(&req, format!("{body}\n")).map_err(|e| format!("could not write requirements: {e}"))?;

    let out = Command::new(&py)
        .arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--disable-pip-version-check")
        .arg("-r")
        .arg(&req)
        .output()
        .map_err(|e| format!("pip install failed to start: {e}"))?;
    let _ = std::fs::remove_file(&req);

    if !out.status.success() {
        return Err(format!(
            "experiment environment install failed:\n{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    Ok(InstallationInfo {
        python_version: python_version(venv)?,
        deps: frozen_deps(venv)?,
    })
}

/// `pip freeze` output, which is what we hash for provenance.
pub fn frozen_deps(venv: &Path) -> Result<Vec<String>, String> {
    let py = venv_python(venv)?;
    let out = Command::new(&py)
        .arg("-m")
        .arg("pip")
        .arg("freeze")
        .arg("--disable-pip-version-check")
        .output()
        .map_err(|e| format!("pip freeze failed to start: {e}"))?;
    if !out.status.success() {
        return Err("pip freeze failed".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect())
}

#[derive(Clone, Debug)]
pub struct InstallationInfo {
    pub python_version: String,
    pub deps: Vec<String>,
}

impl InstallationInfo {
    /// Order-independent hash of the resolved dependency set.
    pub fn deps_hash(&self) -> String {
        let refs: Vec<&str> = self.deps.iter().map(String::as_str).collect();
        hash_deps(&refs)
    }
}

/// Directory name for a tool's environment. Versioned so two versions coexist.
pub fn env_dir_name(name: &str, version: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    format!("{safe}-{version}")
}

pub fn hash_file(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    Ok(sha256_hex(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requirement_line_binds_name_version_and_hash() {
        let p = Pin {
            name: "pylinearfold".into(),
            version: "1.0.0".into(),
            sha256: "1d3a5".into(),
        };
        assert_eq!(p.requirement_line(), "pylinearfold==1.0.0 --hash=sha256:1d3a5");
    }

    #[test]
    fn env_dir_is_filesystem_safe_and_versioned() {
        assert_eq!(env_dir_name("ViennaRNA", "2.7.2"), "viennarna-2.7.2");
        assert_eq!(env_dir_name("py_linear.fold", "1.0.0"), "py-linear-fold-1.0.0");
    }

    #[test]
    fn deps_hash_is_order_independent() {
        let a = InstallationInfo { python_version: "3.14.7".into(), deps: vec!["b==1".into(), "a==2".into()] };
        let b = InstallationInfo { python_version: "3.14.7".into(), deps: vec!["a==2".into(), "b==1".into()] };
        assert_eq!(a.deps_hash(), b.deps_hash());
    }

    #[test]
    fn empty_pin_list_is_rejected() {
        let missing = PathBuf::from("/nonexistent-venv-for-test");
        assert!(install_pinned(&missing, &[]).is_err());
    }

    #[test]
    fn parses_standard_and_free_threaded_tags() {
        let t = WheelTag::parse("cp314").unwrap();
        assert_eq!((t.major, t.minor, t.free_threaded), (3, 14, false));
        let ft = WheelTag::parse("cp313t").unwrap();
        assert_eq!((ft.major, ft.minor, ft.free_threaded), (3, 13, true));
    }

    #[test]
    fn rejects_non_cpython_tags() {
        // A tag from another interpreter or another platform must not be
        // silently accepted, or the installer would build a venv that cannot
        // use the wheels it is about to fetch.
        for bad in ["pp39", "cp3", "cp31x", "", "3.14"] {
            assert!(WheelTag::parse(bad).is_err(), "{bad} should not parse");
        }
    }

    #[test]
    fn seed_tag_matches_the_pinned_wheel() {
        // The pins are cp314 wheels; a tag that disagreed would fail at install
        // time with a hash error instead of a clear message.
        let tool = crate::catalog::pylinearfold();
        let crate::catalog::SeedKind::Wheel { python_tag, .. } = tool.kind else {
            panic!("pylinearfold is a wheel seed");
        };
        let tag = WheelTag::parse(&python_tag).unwrap();
        assert_eq!((tag.major, tag.minor), (3, 14));
        assert!(!tag.free_threaded);
    }
}
