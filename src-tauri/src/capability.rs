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
pub const CAP_RESEARCH_CORPUS: &str = "research.corpus";
pub const CAP_EXPERIMENT_RUN: &str = "experiment.run";
pub const CAP_TOOL_LIST: &str = "tool.list";
pub const CAP_TOOL_INSTALL: &str = "tool.install";
pub const CAP_PIP_INSTALL: &str = "pip.install";

/// Every capability the harness knows how to satisfy.
pub const KNOWN_CAPABILITIES: &[&str] = &[
    CAP_FOLD_MFE,
    CAP_FOLD_ENSEMBLE,
    CAP_RESEARCH_ARXIV,
    CAP_RESEARCH_CORPUS,
    CAP_EXPERIMENT_RUN,
    CAP_TOOL_LIST,
    CAP_TOOL_INSTALL,
    CAP_PIP_INSTALL,
];

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
    #[serde(rename = "research.corpus")]
    ResearchCorpus(CorpusRequest),
    #[serde(rename = "experiment.run")]
    ExperimentRun(ExperimentRequest),
    #[serde(rename = "tool.list")]
    ToolList(ToolListRequest),
    #[serde(rename = "tool.install")]
    ToolInstall(ToolInstallRequest),
    #[serde(rename = "pip.install")]
    PipInstall(PipInstallRequest),
}

/// Request payload for `tool.list`. Deliberately empty: the agent lists the
/// whole catalog and decides for itself, rather than the harness pre-filtering.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolListRequest {}

/// Request payload for `tool.install`. `name` must be a curated catalog tool;
/// installing arbitrary discovered code is intentionally not reachable here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolInstallRequest {
    pub name: String,
}

/// Result of a `tool.list` call: every registered tool and its install/health
/// state, so the agent can see what it can fold with and what it must install.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolListResult {
    pub tools: Vec<crate::service::ToolSummary>,
}

/// Most packages one `pip.install` call may request.
pub const PIP_MAX_PACKAGES: usize = 25;
/// Longest a single requirement spec may be.
pub const PIP_MAX_SPEC_CHARS: usize = 200;

/// Request payload for `pip.install`: pull packages from PyPI into the managed
/// experiment environment so the agent can acquire a tool it needs on demand.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipInstallRequest {
    /// pip requirement specs, e.g. `["pyfamsa", "scikit-bio==0.6.0"]`.
    pub packages: Vec<String>,
}

impl PipInstallRequest {
    /// Validate the specs, or say why they are unusable. Each is passed to pip
    /// as its own argv entry (never through a shell), so the concern is not
    /// shell injection but keeping specs well-formed and bounded: no
    /// whitespace, no control characters, no pip *options* (`-`-prefixed), and a
    /// finite count.
    pub fn normalized(&self) -> Result<Vec<String>, String> {
        if self.packages.is_empty() {
            return Err("no packages requested".into());
        }
        if self.packages.len() > PIP_MAX_PACKAGES {
            return Err(format!(
                "requested {} packages; the limit is {PIP_MAX_PACKAGES}",
                self.packages.len()
            ));
        }
        let mut out: Vec<String> = Vec::new();
        for raw in &self.packages {
            let spec = raw.trim();
            if spec.is_empty() {
                return Err("a package spec is empty".into());
            }
            if spec.chars().count() > PIP_MAX_SPEC_CHARS {
                return Err(format!("package spec {spec:?} is too long"));
            }
            if spec.starts_with('-') {
                return Err(format!("package spec {spec:?} looks like a pip option, not a package"));
            }
            if spec.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return Err(format!("package spec {spec:?} contains whitespace or control characters"));
            }
            if !out.contains(&spec.to_string()) {
                out.push(spec.to_string());
            }
        }
        Ok(out)
    }
}

/// Result of a `pip.install`: which specs were requested, and the environment's
/// updated provenance so a later experiment's `deps_hash` is explained.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PipInstallResult {
    pub packages: Vec<String>,
    pub python_version: String,
    /// Hash of the env's full resolved package set after the install.
    pub deps_hash: String,
    /// Count of packages in the environment after the install.
    pub resolved_count: usize,
}

impl CapabilityRequest {
    pub fn capability(&self) -> &'static str {
        match self {
            CapabilityRequest::FoldMfe(_) => CAP_FOLD_MFE,
            CapabilityRequest::FoldEnsemble(_) => CAP_FOLD_ENSEMBLE,
            CapabilityRequest::ResearchArxiv(_) => CAP_RESEARCH_ARXIV,
            CapabilityRequest::ResearchCorpus(_) => CAP_RESEARCH_CORPUS,
            CapabilityRequest::ExperimentRun(_) => CAP_EXPERIMENT_RUN,
            CapabilityRequest::ToolList(_) => CAP_TOOL_LIST,
            CapabilityRequest::ToolInstall(_) => CAP_TOOL_INSTALL,
            CapabilityRequest::PipInstall(_) => CAP_PIP_INSTALL,
        }
    }

    pub fn as_experiment(&self) -> Option<&ExperimentRequest> {
        match self {
            CapabilityRequest::ExperimentRun(r) => Some(r),
            _ => None,
        }
    }

    pub fn as_tool_list(&self) -> Option<&ToolListRequest> {
        match self {
            CapabilityRequest::ToolList(r) => Some(r),
            _ => None,
        }
    }

    pub fn as_tool_install(&self) -> Option<&ToolInstallRequest> {
        match self {
            CapabilityRequest::ToolInstall(r) => Some(r),
            _ => None,
        }
    }

    pub fn as_pip_install(&self) -> Option<&PipInstallRequest> {
        match self {
            CapabilityRequest::PipInstall(r) => Some(r),
            _ => None,
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
            _ => None,
        }
    }

    pub fn as_arxiv(&self) -> Option<&ArxivRequest> {
        match self {
            CapabilityRequest::ResearchArxiv(r) => Some(r),
            _ => None,
        }
    }

    pub fn as_corpus(&self) -> Option<&CorpusRequest> {
        match self {
            CapabilityRequest::ResearchCorpus(r) => Some(r),
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

/// Default and hard-ceiling result counts for `research.corpus`.
pub const CORPUS_DEFAULT_MAX_RESULTS: usize = 10;
pub const CORPUS_MAX_RESULTS: usize = 50;

/// Request payload for `research.corpus`: a full-text-ish query over the
/// project's MongoDB paper corpus. An empty query returns the whole (small)
/// corpus rather than erroring, since "show me what's in there" is a real ask.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CorpusRequest {
    #[serde(default)]
    pub query: String,
    #[serde(default = "corpus_default_max_results")]
    pub max_results: usize,
}

fn corpus_default_max_results() -> usize {
    CORPUS_DEFAULT_MAX_RESULTS
}

impl CorpusRequest {
    pub fn new(query: String) -> Self {
        Self { query, max_results: CORPUS_DEFAULT_MAX_RESULTS }
    }

    /// Whitespace-collapsed query and a clamped result count.
    pub fn normalized(&self) -> (String, usize) {
        let query = collapse_whitespace(&self.query);
        (query, self.max_results.clamp(1, CORPUS_MAX_RESULTS))
    }
}

/// One source from the corpus. Field names line up with what the papers
/// projector recognises (`title`, `authors`, `arxiv_id`, `summary`), so a
/// corpus result renders in the same research view as an arXiv search.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CorpusPaper {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    pub title: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arxiv_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default)]
    pub key_points: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Result of a `research.corpus` call.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CorpusResult {
    pub query: String,
    pub results: Vec<CorpusPaper>,
    pub provider: String,
    pub elapsed_ms: u64,
}

/// Longest analysis script accepted, in bytes. Agent-authored code is a few
/// kilobytes; a megabyte is a runaway generation, not an experiment.
pub const EXPERIMENT_MAX_CODE_BYTES: usize = 256 * 1024;

/// Largest single input file the caller may stage, in bytes. Inputs are held in
/// memory and written to the run's scratch dir, so this bounds both.
pub const EXPERIMENT_MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;

/// Most input files a single experiment may stage.
pub const EXPERIMENT_MAX_INPUTS: usize = 32;

/// Default wall-clock budget for one experiment, and the ceiling a caller may
/// ask for. Execution is agent-authored, so an unbounded run is not an option.
pub const EXPERIMENT_DEFAULT_TIMEOUT_S: u64 = 60;
pub const EXPERIMENT_MAX_TIMEOUT_S: u64 = 300;

/// A file staged into an experiment's working directory before it runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExperimentInput {
    /// A bare filename, no path separators. Written into the scratch cwd.
    pub name: String,
    /// UTF-8 contents. Binary inputs are out of scope for this capability.
    pub contents: String,
}

/// Request payload for `experiment.run`.
///
/// The code is agent-authored and run by the harness — never by Pi, which has
/// no execution tools. Validation lives here so the sandbox is never the thing
/// that discovers an empty script or an absurd timeout.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExperimentRequest {
    /// The Python program to run. Reads its inputs from the working directory
    /// and writes results (files, stdout) back into it.
    pub code: String,
    #[serde(default)]
    pub inputs: Vec<ExperimentInput>,
    /// Wall-clock budget in seconds. Clamped to `EXPERIMENT_MAX_TIMEOUT_S`.
    #[serde(default)]
    pub timeout_s: Option<u64>,
}

/// A validated experiment: code within bounds, inputs named safely, timeout
/// clamped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExperimentPlan {
    pub code: String,
    pub inputs: Vec<ExperimentInput>,
    pub timeout_s: u64,
}

impl ExperimentRequest {
    pub fn new(code: String) -> Self {
        Self { code, inputs: Vec::new(), timeout_s: None }
    }

    /// Validate and bound the request, or say why it is unusable.
    pub fn normalized(&self) -> Result<ExperimentPlan, String> {
        if self.code.trim().is_empty() {
            return Err("experiment code is empty".into());
        }
        if self.code.len() > EXPERIMENT_MAX_CODE_BYTES {
            return Err(format!(
                "experiment code is {} bytes; the limit is {EXPERIMENT_MAX_CODE_BYTES}",
                self.code.len()
            ));
        }
        if self.inputs.len() > EXPERIMENT_MAX_INPUTS {
            return Err(format!(
                "experiment declares {} inputs; the limit is {EXPERIMENT_MAX_INPUTS}",
                self.inputs.len()
            ));
        }
        let mut seen = Vec::new();
        for input in &self.inputs {
            let name = input.name.trim();
            // A bare filename only: an input must land in the scratch cwd and
            // nowhere else, so a path separator or a parent reference is a
            // traversal attempt, not a filename.
            if name.is_empty()
                || name.contains('/')
                || name.contains('\\')
                || name == "."
                || name == ".."
                || name.starts_with('.') && name.len() == 1
            {
                return Err(format!("input name {name:?} is not a bare filename"));
            }
            if input.contents.len() > EXPERIMENT_MAX_INPUT_BYTES {
                return Err(format!(
                    "input {name:?} is {} bytes; the per-file limit is {EXPERIMENT_MAX_INPUT_BYTES}",
                    input.contents.len()
                ));
            }
            if seen.contains(&name) {
                return Err(format!("input {name:?} is declared more than once"));
            }
            seen.push(name);
        }
        let timeout_s = self
            .timeout_s
            .unwrap_or(EXPERIMENT_DEFAULT_TIMEOUT_S)
            .clamp(1, EXPERIMENT_MAX_TIMEOUT_S);
        Ok(ExperimentPlan {
            code: self.code.clone(),
            inputs: self.inputs.clone(),
            timeout_s,
        })
    }
}

/// How the harness classified a file the experiment wrote, so the UI can pick a
/// renderer without re-sniffing. Deliberately coarse: the frontend refines it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProducedFileKind {
    /// `.json` — a structured result the agent chose to emit.
    Data,
    /// `.csv`/`.tsv` — tabular.
    Table,
    /// `.fasta`/`.fa`/`.aln` — sequence or alignment.
    Sequence,
    /// `.png`/`.svg` — a plot the code rendered.
    Image,
    /// Anything else, surfaced as text when it decodes as UTF-8.
    Text,
}

/// One file an experiment left in its working directory.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProducedFile {
    pub name: String,
    pub kind: ProducedFileKind,
    pub size: u64,
    /// UTF-8 contents when the file is text and within the preview cap; a
    /// base64 data URI for images. `None` when the file is too large or binary.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Set when `content` was omitted because the file exceeded the cap.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

/// Result of an `experiment.run` call.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExperimentResult {
    /// The code that ran, echoed so the result is self-describing and the UI
    /// can show exactly what produced the numbers.
    pub code: String,
    pub stdout: String,
    pub stderr: String,
    /// Process exit code, or `None` if the run was killed on its deadline.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub produced_files: Vec<ProducedFile>,
    pub provider: String,
    /// SHA-256 of the exact code that ran. Always present: a run is always
    /// attributable to its source even on the bare interpreter.
    pub code_sha256: String,
    /// Interpreter version, when the run used the managed experiment env.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub python_version: Option<String>,
    /// Order-independent hash of the environment's `pip freeze`, when the run
    /// used the managed experiment env. This is what makes a result reproducible.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deps_hash: Option<String>,
    pub elapsed_ms: u64,
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
    #[serde(rename = "research.corpus")]
    ResearchCorpus(CorpusResult),
    #[serde(rename = "experiment.run")]
    ExperimentRun(ExperimentResult),
    #[serde(rename = "tool.list")]
    ToolList(ToolListResult),
    #[serde(rename = "tool.install")]
    ToolInstall(crate::service::InstallReport),
    #[serde(rename = "pip.install")]
    PipInstall(PipInstallResult),
}

impl CapabilityResult {
    pub fn capability(&self) -> &'static str {
        match self {
            CapabilityResult::FoldMfe(_) => CAP_FOLD_MFE,
            CapabilityResult::FoldEnsemble(_) => CAP_FOLD_ENSEMBLE,
            CapabilityResult::ResearchArxiv(_) => CAP_RESEARCH_ARXIV,
            CapabilityResult::ResearchCorpus(_) => CAP_RESEARCH_CORPUS,
            CapabilityResult::ExperimentRun(_) => CAP_EXPERIMENT_RUN,
            CapabilityResult::ToolList(_) => CAP_TOOL_LIST,
            CapabilityResult::ToolInstall(_) => CAP_TOOL_INSTALL,
            CapabilityResult::PipInstall(_) => CAP_PIP_INSTALL,
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
    fn pip_install_validates_and_dedups_specs() {
        let ok = PipInstallRequest {
            packages: vec!["pyfamsa".into(), "scikit-bio==0.6.0".into(), " pyfamsa ".into()],
        };
        assert_eq!(ok.normalized().unwrap(), vec!["pyfamsa", "scikit-bio==0.6.0"]);

        assert!(PipInstallRequest { packages: vec![] }.normalized().is_err());
        // A pip option, not a package.
        assert!(PipInstallRequest { packages: vec!["--index-url".into()] }.normalized().is_err());
        // Whitespace inside a spec (a smuggled second arg) is refused.
        assert!(PipInstallRequest { packages: vec!["numpy --upgrade".into()] }.normalized().is_err());
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
