//! The capability contract.
//!
//! Callers ask for a *capability* (`fold.mfe`), never for a tool. A registry
//! entry binds a concrete `tool@version` to a capability, and a provider
//! preference lets the registry route long sequences to the linear-time
//! implementation and short ones to the exact one.
//!
//! Keeping this vocabulary closed is the point: adding a tool must not be able
//! to change what existing callers mean.

use serde::{Deserialize, Serialize};

pub const CAP_FOLD_MFE: &str = "fold.mfe";
pub const CAP_FOLD_ENSEMBLE: &str = "fold.ensemble";
pub const CAP_RESEARCH_ARXIV: &str = "research.arxiv";

/// Every capability the harness knows how to satisfy.
pub const KNOWN_CAPABILITIES: &[&str] =
    &[CAP_FOLD_MFE, CAP_FOLD_ENSEMBLE, CAP_RESEARCH_ARXIV];

/// Which implementation to use for a call.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Routing {
    /// Let the registry choose. Prefers the linear-time provider above
    /// `linear_threshold`, and the exact provider at or below it.
    #[default]
    Auto,
    /// Force the linear-time, beam-search implementation.
    Linear,
    /// Force the exact, dynamic-programming implementation.
    Exact,
}

/// Sequences longer than this route to the linear provider under `Auto`.
/// Measured on this machine: the crossover sits between 2 kb and 8 kb, where
/// the linear implementation reaches ~20x. See `fold.mfe` docs in AGENTS.md.
pub const LINEAR_THRESHOLD: usize = 2000;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FoldRequest {
    pub sequence: String,
    #[serde(default)]
    pub routing: Routing,
    /// Beam width for the linear provider. 100 is the upstream default; it is
    /// an approximation parameter, so it is part of the fingerprint.
    #[serde(default = "default_beamsize")]
    pub beamsize: u32,
    /// Base-pair probability cutoff for `fold.ensemble`.
    #[serde(default = "default_cutoff")]
    pub cutoff: f64,
    /// Cap on returned base pairs, highest probability first.
    #[serde(default = "default_max_pairs")]
    pub max_pairs: usize,
}

fn default_beamsize() -> u32 {
    100
}
fn default_cutoff() -> f64 {
    1e-5
}
fn default_max_pairs() -> usize {
    50
}

impl FoldRequest {
    pub fn new(sequence: String) -> Self {
        Self {
            sequence,
            routing: Routing::default(),
            beamsize: default_beamsize(),
            cutoff: default_cutoff(),
            max_pairs: default_max_pairs(),
        }
    }

    /// Normalised sequence, or why it is unusable.
    ///
    /// RNA is validated here rather than in the adapter, because a malformed
    /// sequence has produced a hard hang in ViennaRNA (`make_ptable` loops on
    /// unbalanced brackets) and the sandbox must never be the thing that
    /// discovers it.
    pub fn normalized(&self) -> Result<String, String> {
        let trimmed = self.sequence.trim();
        if trimmed.is_empty() {
            return Err("sequence is empty".into());
        }
        let upper: String = trimmed.chars().map(|c| c.to_ascii_uppercase()).collect();
        if let Some(bad) = upper.chars().find(|c| !matches!(c, 'A' | 'C' | 'G' | 'U' | 'T' | 'N')) {
            return Err(format!(
                "sequence contains {bad:?}; expected only A, C, G, U, T, or N"
            ));
        }
        // U and T are interchangeable; fold on U.
        Ok(upper.replace('T', "U"))
    }
}

/// A tagged request. The tag is the capability name the caller asked for.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "capability")]
pub enum CapabilityRequest {
    #[serde(rename = "fold.mfe")]
    FoldMfe(FoldRequest),
    #[serde(rename = "fold.ensemble")]
    FoldEnsemble(FoldRequest),
    #[serde(rename = "research.arxiv")]
    ResearchArxiv(ArxivRequest),
}

impl CapabilityRequest {
    pub fn capability(&self) -> &'static str {
        match self {
            CapabilityRequest::FoldMfe(_) => CAP_FOLD_MFE,
            CapabilityRequest::FoldEnsemble(_) => CAP_FOLD_ENSEMBLE,
            CapabilityRequest::ResearchArxiv(_) => CAP_RESEARCH_ARXIV,
        }
    }

    /// The fold payload, or `None` for a non-folding capability.
    ///
    /// This used to be an infallible `fold()`. Widening the request enum made
    /// that a lie, and a `fold()` that panicked on a valid research request
    /// would have been a worse outcome than an `Option`.
    pub fn as_fold(&self) -> Option<&FoldRequest> {
        match self {
            CapabilityRequest::FoldMfe(r) | CapabilityRequest::FoldEnsemble(r) => Some(r),
            CapabilityRequest::ResearchArxiv(_) => None,
        }
    }

    pub fn as_arxiv(&self) -> Option<&ArxivRequest> {
        match self {
            CapabilityRequest::ResearchArxiv(r) => Some(r),
            _ => None,
        }
    }
}

/// One base pair and its probability.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BasePair {
    pub i: usize,
    pub j: usize,
    pub probability: f64,
}

/// Results per `research.arxiv` call when the caller does not say.
pub const ARXIV_DEFAULT_MAX_RESULTS: usize = 10;

/// Hard ceiling on results per call. A caller asking for ten thousand is
/// either confused or hostile, and either way the bound is enforced here
/// rather than at the call site.
pub const ARXIV_MAX_RESULTS: usize = 25;

/// Longest query accepted, in characters. arXiv's own limit is far higher;
/// this exists so a runaway prompt cannot turn into an unbounded URL.
pub const ARXIV_MAX_QUERY_CHARS: usize = 512;

/// Longest category accepted. `q-bio.QM` is 9; the bound is loose but finite.
pub const ARXIV_MAX_CATEGORY_CHARS: usize = 32;

/// Request payload for `research.arxiv`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ArxivRequest {
    pub query: String,
    #[serde(default = "arxiv_default_max_results")]
    pub max_results: usize,
    /// Optional arXiv category filter, e.g. `q-bio.BM`.
    #[serde(default)]
    pub category: Option<String>,
}

fn arxiv_default_max_results() -> usize {
    ARXIV_DEFAULT_MAX_RESULTS
}

pub use crate::arxiv::Paper as ArxivPaper;

/// A validated `research.arxiv` request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArxivQuery {
    /// The query as written, whitespace-collapsed.
    pub query: String,
    pub max_results: usize,
    pub category: Option<String>,
}

impl ArxivRequest {
    pub fn new(query: String) -> Self {
        Self {
            query,
            max_results: arxiv_default_max_results(),
            category: None,
        }
    }

    /// Validate and bound the request, or say why it is unusable.
    ///
    /// Validation lives in Rust for the same reason the sequence does: the
    /// adapter is not the thing that should discover a malformed request, and
    /// `max_results` must be bounded before it reaches a URL.
    pub fn normalized(&self) -> Result<ArxivQuery, String> {
        let query = collapse_whitespace(&self.query);
        if query.is_empty() {
            return Err("query is empty".into());
        }
        if query.chars().count() > ARXIV_MAX_QUERY_CHARS {
            return Err(format!(
                "query is {} characters; the limit is {ARXIV_MAX_QUERY_CHARS}",
                query.chars().count()
            ));
        }
        // Control characters have no meaning in a search and would end up
        // percent-encoded into the URL, so they are rejected rather than
        // escaped.
        if let Some(bad) = query.chars().find(|c| c.is_control()) {
            return Err(format!("query contains a control character {bad:?}"));
        }
        if self.max_results == 0 {
            return Err("max_results must be at least 1".into());
        }

        let category = match &self.category {
            None => None,
            Some(raw) => {
                let cat = raw.trim();
                if cat.is_empty() {
                    None
                } else {
                    Some(validate_category(cat)?)
                }
            }
        };

        Ok(ArxivQuery {
            query,
            max_results: self.max_results.min(ARXIV_MAX_RESULTS),
            category,
        })
    }
}

/// A category is interpolated into arXiv's query language, so it is held to a
/// fixed grammar rather than escaped. Real categories look like `q-bio.BM`,
/// `cs.LG`, `astro-ph.CO`, or the bare `hep-th`; old-style ids such as
/// `math/0309136` are *not* categories and are rejected.
fn validate_category(cat: &str) -> Result<String, String> {
    if cat.chars().count() > ARXIV_MAX_CATEGORY_CHARS {
        return Err(format!(
            "category is longer than {ARXIV_MAX_CATEGORY_CHARS} characters: {cat:?}"
        ));
    }
    let valid = !cat.is_empty()
        && cat.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && cat.starts_with(|c: char| c.is_ascii_lowercase())
        && !cat.contains("..")
        && !cat.ends_with(['.', '-']);
    if !valid {
        return Err(format!(
            "{cat:?} is not an arXiv category; expected something like `q-bio.BM` or `cs.LG`"
        ));
    }
    Ok(cat.to_string())
}

fn collapse_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FoldResult {
    pub sequence: String,
    pub structure: String,
    /// Minimum free energy in kcal/mol.
    pub mfe: f64,
    /// Ensemble free energy, `fold.ensemble` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ensemble_free_energy: Option<f64>,
    /// Base-pair probabilities above the cutoff, `fold.ensemble` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_pairs: Option<Vec<BasePair>>,
    pub provider: String,
    pub fingerprint: crate::fingerprint::Fingerprint,
    pub elapsed_ms: u64,
}

/// Result of a `research.arxiv` call.
///
/// Note what is *not* here: the query that produced it, and the total arXiv
/// reports. A caller that gets zero results needs to be able to tell "nothing
/// matched" from "the search was too narrow", and without the echoed query
/// and the total it cannot.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ArxivResult {
    /// The query as written, after whitespace collapsing.
    pub query: String,
    /// The arXiv query actually sent, after field-prefixing.
    pub search_query: String,
    /// Page size actually requested, after clamping.
    pub max_results: usize,
    /// Size of the full result set arXiv reports, not just this page.
    pub total_available: Option<u64>,
    pub results: Vec<ArxivPaper>,
    pub provider: String,
    /// Absent only if a caller constructs a result by hand. Every result the
    /// harness produces carries one, so a search can be attributed to the
    /// endpoint and feed revision that produced it.
    pub fingerprint: Option<crate::fingerprint::Fingerprint>,
    pub elapsed_ms: u64,
}

/// What a capability request produced.
///
/// Tagged, and tagged on the same vocabulary as the request, so a caller
/// holding a result knows which capability produced it without having to
/// infer it from which fields are populated. An untagged enum would make
/// "which capability was this?" a guess.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "capability")]
pub enum CapabilityResult {
    #[serde(rename = "fold.mfe")]
    FoldMfe(FoldResult),
    #[serde(rename = "fold.ensemble")]
    FoldEnsemble(FoldResult),
    #[serde(rename = "research.arxiv")]
    ResearchArxiv(ArxivResult),
}

impl CapabilityResult {
    pub fn capability(&self) -> &'static str {
        match self {
            CapabilityResult::FoldMfe(_) => CAP_FOLD_MFE,
            CapabilityResult::FoldEnsemble(_) => CAP_FOLD_ENSEMBLE,
            CapabilityResult::ResearchArxiv(_) => CAP_RESEARCH_ARXIV,
        }
    }

    /// The fold result, or an error naming the capability that was actually
    /// asked for. A fold command that silently returned research results
    /// would be worse than a loud failure.
    pub fn into_fold(self) -> Result<FoldResult, String> {
        match self {
            CapabilityResult::FoldMfe(r) | CapabilityResult::FoldEnsemble(r) => Ok(r),
            other => Err(format!(
                "`{}` does not return a fold result",
                other.capability()
            )),
        }
    }
}

/// The envelope an adapter writes to stdout.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AdapterResponse {
    Ok { result: serde_json::Value },
    Error { error: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_t_to_u_and_case() {
        let r = FoldRequest::new("gcuAt".into());
        assert_eq!(r.normalized().unwrap(), "GCUAU");
    }

    #[test]
    fn rejects_non_rna_alphabet() {
        let r = FoldRequest::new("GCUX".into());
        assert!(r.normalized().is_err());
    }

    #[test]
    fn rejects_empty() {
        assert!(FoldRequest::new("   ".into()).normalized().is_err());
    }

    #[test]
    fn capability_tag_round_trips() {
        let req = CapabilityRequest::FoldMfe(FoldRequest::new("GCGC".into()));
        let s = serde_json::to_string(&req).unwrap();
        assert!(s.contains("fold.mfe"), "{s}");
        let back: CapabilityRequest = serde_json::from_str(&s).unwrap();
        assert_eq!(back.capability(), CAP_FOLD_MFE);
    }
}
