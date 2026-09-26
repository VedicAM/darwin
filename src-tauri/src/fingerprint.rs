//! Result provenance.
//!
//! Every numeric result carries the exact tuple that produced it. Two results
//! with different fingerprints are not comparable, and the fingerprint has to
//! be reconstructible from the tool record alone — that is what keeps local
//! machine state out of the science.
//!
//! The energy model and the algorithm's approximation parameters are included
//! because they change the number, not just the speed. ViennaRNA's compiled-in
//! Turner 2004 parameters and LinearFold's beam width are both invisible
//! unless they are written down here.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Which algorithm produced a number.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Algorithm {
    /// Beam-search linear-time folding (LinearFold). Approximate.
    LinearTime,
    /// Exact dynamic programming (ViennaRNA). O(n^3) time, O(n^2) memory.
    DynamicProgramming,
    /// Metadata search (e.g. arXiv). No structural prediction.
    Metadata,
}

impl Algorithm {
    pub fn as_str(self) -> &'static str {
        match self {
            Algorithm::LinearTime => "linear_time",
            Algorithm::DynamicProgramming => "dynamic_programming",
            Algorithm::Metadata => "metadata",
        }
    }

    /// True when the result is an approximation rather than the true optimum.
    pub fn is_approximate(self) -> bool {
        matches!(self, Algorithm::LinearTime)
    }
}

/// Everything needed to reproduce a result, minus the machine it ran on.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Fingerprint {
    pub tool: String,
    pub tool_version: String,
    pub artifact_sha256: String,
    pub adapter_sha256: String,
    pub algorithm: Algorithm,
    /// Named energy parameter set, e.g. `Turner2004`. The binding compiles
    /// these in, so nothing else records them.
    pub energy_model: String,
    /// Beam width for approximate algorithms. `None` for exact ones.
    pub beamsize: Option<u32>,
    /// Base-pair probability cutoff, when the call requested one.
    pub cutoff: Option<f64>,
    /// Python major.minor that executed the adapter.
    pub python_version: String,
    /// Hash of the resolved dependency set for the tool's environment.
    pub deps_hash: String,
    /// Git commit of the harness.
    pub harness_rev: String,
}

impl Fingerprint {
    /// Stable content hash. Equal fingerprints hash equal, so results can be
    /// grouped and cached without inspecting fields.
    pub fn content_hash(&self) -> String {
        let canonical = serde_json::to_string(self).unwrap_or_default();
        hex::encode(Sha256::digest(canonical.as_bytes()))
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Hash a dependency listing, normalised so ordering does not matter.
pub fn hash_deps(lines: &[&str]) -> String {
    let mut v: Vec<&str> = lines.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    v.sort_unstable();
    sha256_hex(v.join("\n").as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Fingerprint {
        Fingerprint {
            tool: "pylinearfold".into(),
            tool_version: "1.0.0".into(),
            artifact_sha256: "a".repeat(64),
            adapter_sha256: "b".repeat(64),
            algorithm: Algorithm::LinearTime,
            energy_model: "Turner2004".into(),
            beamsize: Some(100),
            cutoff: None,
            python_version: "3.14.7".into(),
            deps_hash: "c".repeat(64),
            harness_rev: "d".repeat(40),
        }
    }

    #[test]
    fn content_hash_is_stable_and_sensitive() {
        let a = sample();
        let b = sample();
        assert_eq!(a.content_hash(), b.content_hash());
        let mut c = sample();
        c.beamsize = Some(50);
        assert_ne!(a.content_hash(), c.content_hash());
    }

    #[test]
    fn dep_hash_ignores_order_but_not_content() {
        assert_eq!(hash_deps(&["b==1", "a==2"]), hash_deps(&["a==2", "b==1"]));
        assert_ne!(hash_deps(&["a==2"]), hash_deps(&["a==3"]));
    }

    #[test]
    fn linear_time_is_flagged_approximate() {
        assert!(Algorithm::LinearTime.is_approximate());
        assert!(!Algorithm::DynamicProgramming.is_approximate());
    }
}
