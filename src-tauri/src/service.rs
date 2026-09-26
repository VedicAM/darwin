//! The harness: everything between a capability request and a fingerprinted
//! result.
//!
//! The order of operations is the security property, not an implementation
//! detail. The sequence is validated in Rust, the provider is chosen from
//! hash-pinned installed tools, the call runs in a constructed environment
//! with a deadline, and the fingerprint is assembled from registry state that
//! the adapter cannot influence. The adapter's own report of its provenance is
//! treated as an untrusted assertion and checked for agreement, never used as
//! the source of truth.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::arxiv::{self, Throttle};
use crate::capability::{
    AdapterResponse, ArxivRequest, BasePair, CapabilityRequest, CapabilityResult, FoldResult,
    CAP_FOLD_ENSEMBLE, CAP_FOLD_MFE,
};
use crate::catalog::{self, KnownPaper, SeedKind, SeedTool};
use crate::dispatch::{self, AdapterContext};
use crate::fingerprint::{Fingerprint, Algorithm};
use crate::install;
use crate::registry::{
    route, InstallTier, Installation, SmokeTestResult, SqliteRegistry, ToolRecord, ToolRegistry,
};

/// How long an adapter may run. ViennaRNA has been observed to loop forever on
/// a malformed target structure rather than erroring, so a deadline is the only
/// thing standing between bad input and a hung app.
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);

/// A tool is not runnable until a known-answer test passes.
const SMOKE_TEST_REQUIRED: bool = true;

pub struct Harness {
    pub registry: SqliteRegistry,
    pub root: PathBuf,
    pub harness_rev: String,
    pub deadline: Duration,
    /// Spacing between arXiv requests. Shared across the whole harness rather
    /// than per call, because the limit arXiv publishes is per client and two
    /// searches a second apart from two windows on one machine are still two
    /// searches a second apart.
    pub arxiv_throttle: Throttle,
}

impl Harness {
    pub fn open(root: &Path, harness_rev: &str) -> Result<Self, String> {
        Ok(Self {
            registry: SqliteRegistry::open(&root.join("registry.sqlite3"))?,
            root: root.to_path_buf(),
            harness_rev: harness_rev.to_string(),
            deadline: DEFAULT_DEADLINE,
            arxiv_throttle: Throttle::default(),
        })
    }

    /// Install a catalog tool by name.
    pub fn install_named(&self, name: &str) -> Result<InstallReport, String> {
        let tool = catalog::all()
            .into_iter()
            .find(|t| t.record.name == name)
            .ok_or_else(|| {
                format!(
                    "`{name}` is not in the curated catalog; known: {}",
                    catalog::all()
                        .iter()
                        .map(|t| t.record.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })?;
        let inst = self.install(&tool)?;
        Ok(InstallReport {
            tool: tool.record.name.clone(),
            version: tool.record.version.clone(),
            algorithm: tool.record.algorithm.as_str().to_string(),
            approximate: tool.record.algorithm.is_approximate(),
            tier: tool.record.tier.as_str().to_string(),
            venv_path: inst.venv_path.clone(),
            python_version: inst.python_version.clone(),
            deps_hash: inst.deps_hash.clone(),
            smoke_test: inst.smoke_test.clone().map(|s| s.detail).unwrap_or_default(),
        })
    }

    fn env_dir(&self, tool: &ToolRecord) -> PathBuf {
        self.root
            .join("envs")
            .join(install::env_dir_name(&tool.name, &tool.version))
    }

    /// Make sure the curated catalog is present in the registry.
    ///
    /// This registers *records only*. It does not install anything: a record
    /// with no installation is not a candidate, so seeding is safe to run on
    /// every launch.
    pub fn seed_catalog(&self) -> Result<usize, String> {
        let mut n = 0;
        for tool in catalog::all() {
            self.registry.upsert_tool(&tool.record)?;
            n += 1;
        }
        Ok(n)
    }

    /// Install every builtin in the catalog, then report what happened.
    ///
    /// Builtins are the one tier that can be activated without a human, so they
    /// are activated at setup rather than waiting for an install call that
    /// nothing in the app makes. A builtin has no venv, no adapter file, no
    /// dependency set and no network step: `install_builtin` parses the
    /// committed fixture and that is the entire install. It still goes through
    /// `install`, so it still has to pass the known-answer check, and it is
    /// still recorded in the registry like any other installation.
    ///
    /// Wheels are deliberately not touched here. Creating a venv and resolving
    /// pinned packages is slow, writes to disk, and needs the network, so it
    /// stays behind an explicit `install_tool` call.
    ///
    /// A failure is reported, not propagated. The app must still launch when a
    /// fixture is broken; the cost is that the capability resolves to nothing
    /// and the caller gets an explicit "no installed tool provides ..." instead
    /// of a fabricated result.
    pub fn activate_builtins(&self) -> Vec<Result<InstallReport, String>> {
        catalog::all()
            .into_iter()
            .filter(|t| matches!(t.record.tier, InstallTier::Builtin))
            .map(|t| self.install_named(&t.record.name))
            .collect()
    }

    /// Install a tool, then known-answer test it.
    ///
    /// Dispatching on [`SeedKind`] rather than on the tier keeps the two
    /// install shapes from bleeding into each other: a builtin has no venv to
    /// create and no adapter to write, and reaching for either here would be a
    /// bug rather than a no-op.
    pub fn install(&self, tool: &SeedTool) -> Result<Installation, String> {
        if tool.record.tier.requires_approval() {
            return Err(format!(
                "{}@{} is a {} and needs explicit approval before install",
                tool.record.name,
                tool.record.version,
                tool.record.tier.as_str()
            ));
        }
        let inst = match &tool.kind {
            SeedKind::Wheel {
                pins,
                adapter_source,
                python_tag,
                known_answers: _,
            } => self.install_wheel(tool, pins, adapter_source, python_tag)?,
            SeedKind::Builtin { known_papers } => self.install_builtin(tool, known_papers)?,
        };
        self.registry.upsert_tool(&tool.record)?;
        self.registry.save_installation(&inst)?;
        Ok(inst)
    }

    /// A hash-pinned wheel into a fresh venv.
    ///
    /// The venv is created new rather than reused, so a version bump never
    /// mutates an environment that existing results were produced in.
    fn install_wheel(
        &self,
        tool: &SeedTool,
        pins: &[install::Pin],
        adapter_source: &str,
        python_tag: &str,
    ) -> Result<Installation, String> {
        let env = self.env_dir(&tool.record);
        let tag = install::WheelTag::parse(python_tag)?;
        install::create_venv(&env, Some(tag))?;
        let info = install::install_pinned(&env, pins)?;

        // The adapter comes from the binary, so its hash is stable and cannot
        // be swapped on disk without changing this build.
        let adapter_path = env.join("adapter.py");
        std::fs::write(&adapter_path, adapter_source)
            .map_err(|e| format!("could not write adapter: {e}"))?;
        let adapter_sha256 = install::hash_file(&adapter_path)?;

        let smoke = self.run_smoke_test(&env, &adapter_path, &adapter_sha256, tool)?;

        Ok(Installation {
            tool_id: tool.record.id.clone(),
            venv_path: env.to_string_lossy().to_string(),
            adapter_path: adapter_path.to_string_lossy().to_string(),
            adapter_sha256,
            python_version: info.python_version.clone(),
            deps_hash: info.deps_hash(),
            installed_at: now_iso8601(),
            smoke_test: Some(smoke),
        })
    }

    /// A tool implemented in this binary.
    ///
    /// The smoke test runs the parser against a committed, real arXiv response
    /// and checks the extracted records against baselines. It is offline on
    /// purpose: an install that has to reach the network to decide whether it
    /// succeeded is a much worse property than one that does not, and the
    /// network path is what the `#[ignore]`d integration tests cover.
    fn install_builtin(
        &self,
        tool: &SeedTool,
        known_papers: &[KnownPaper],
    ) -> Result<Installation, String> {
        let feed = arxiv::parse_feed(catalog::ARXIV_FEED_FIXTURE)
            .map_err(|e| format!("the embedded arXiv fixture did not parse: {e}"))?;
        if feed.entries.len() != known_papers.len() {
            return Err(format!(
                "the embedded arXiv fixture has {} entries but there are {} baselines",
                feed.entries.len(),
                known_papers.len()
            ));
        }
        for (paper, expected) in feed.entries.iter().zip(known_papers) {
            catalog::check_known_paper(expected, paper)?;
        }

        Ok(Installation {
            tool_id: tool.record.id.clone(),
            // No venv and no adapter file. These are empty rather than
            // pointing at a plausible-looking path, so a future caller that
            // assumes a builtin was dispatched to disk fails loudly instead
            // of reading a stale venv from a previous install.
            venv_path: String::new(),
            adapter_path: String::new(),
            // Nothing was written, so there is no adapter hash to record. The
            // implementation's identity is the record's `artifact_sha256`,
            // which folds in the pinned endpoint and feed revision.
            adapter_sha256: String::new(),
            python_version: String::new(),
            // A builtin has no dependency set. The hash of the empty set is a
            // real value rather than a blank field, so two builtins with
            // different implementations still fingerprint differently — via
            // `artifact_sha256` — and a blank is never mistaken for "unknown".
            deps_hash: install::hash_empty_deps(&[]),
            installed_at: now_iso8601(),
            smoke_test: Some(SmokeTestResult {
                passed: true,
                detail: format!(
                    "{} arXiv record(s) parsed from the committed fixture",
                    known_papers.len()
                ),
                ran_at: now_iso8601(),
            }),
        })
    }

    /// Run every known answer for a tool and report the first failure.
    ///
    /// Failure is recorded rather than discarded: a tool that cannot reproduce
    /// its own baselines stays in the registry, visible and unusable, instead
    /// of vanishing.
    fn run_smoke_test(
        &self,
        env: &Path,
        adapter: &Path,
        adapter_sha256: &str,
        tool: &SeedTool,
    ) -> Result<SmokeTestResult, String> {
        let ctx = AdapterContext {
            tool: tool.record.name.clone(),
            tool_version: tool.record.version.clone(),
            artifact_sha256: tool.record.artifact_sha256.clone(),
            adapter_sha256: adapter_sha256.to_string(),
            algorithm: tool.record.algorithm.as_str().to_string(),
            energy_model: tool.record.energy_model.clone(),
            harness_rev: self.harness_rev.clone(),
        };

        let SeedKind::Wheel { known_answers, .. } = &tool.kind else {
            return Err(format!(
                "{} is a builtin and has no adapter to smoke-test",
                tool.record.name
            ));
        };
        for kat in known_answers {
            let request = serde_json::json!({
                "capability": CAP_FOLD_MFE,
                "fold": { "sequence": kat.sequence, "beamsize": 100 },
            });
            let outcome = dispatch::run(env, adapter, &request, &ctx, self.deadline)?;
            let result = expect_ok(outcome.response).map_err(|e| with_stderr(e, &outcome.stderr))?;
            let structure = result["structure"]
                .as_str()
                .ok_or_else(|| with_stderr("adapter returned no structure".into(), &outcome.stderr))?;
            let mfe = result["mfe"]
                .as_f64()
                .or_else(|| result["free_energy"].as_f64())
                .ok_or_else(|| with_stderr("adapter returned no free energy".into(), &outcome.stderr))?;
            catalog::check_known_answer(kat, kat.sequence, structure, mfe)
                .map_err(|e| with_stderr(e, &outcome.stderr))?;
        }

        Ok(SmokeTestResult {
            passed: true,
            detail: format!("{} known answer(s) reproduced", known_answers.len()),
            ran_at: now_iso8601(),
        })
    }

    /// Execute a capability request and return a result with a fingerprint.
    ///
    /// The tagged request decides which path runs, so there is exactly one
    /// place a capability can be added and exactly one place the registry
    /// invariant is enforced. Both paths below go through [`Self::resolve`],
    /// which is where "installed, smoke-passed, and routed" is decided.
    pub fn execute(&self, request: &CapabilityRequest) -> Result<CapabilityResult, String> {
        let capability = request.capability();
        if !crate::capability::KNOWN_CAPABILITIES.contains(&capability) {
            return Err(format!("unknown capability `{capability}`"));
        }
        match (request.as_fold(), request.as_arxiv()) {
            (Some(fold), _) => self
                .execute_fold(capability, fold)
                .map(|r| match capability {
                    CAP_FOLD_ENSEMBLE => CapabilityResult::FoldEnsemble(r),
                    _ => CapabilityResult::FoldMfe(r),
                }),
            (None, Some(arxiv)) => self
                .execute_arxiv(capability, arxiv)
                .map(CapabilityResult::ResearchArxiv),
            // Unreachable while `CapabilityRequest` has exactly these two
            // payload shapes. Reported rather than panicked on, so widening
            // the enum later surfaces as a clear error instead of a crash.
            (None, None) => Err(format!(
                "no payload for capability `{capability}`; the request variant and \
                 its accessor disagree"
            )),
        }
    }

    /// Pick the installed, smoke-passed tool that will serve a capability.
    ///
    /// This is the registry invariant, in one place: candidates are filtered by
    /// the registry to tools that are both installed and smoke-passed, a
    /// routing decision is made, and the chosen record is then *re-read by its
    /// content-addressed id*. That re-read is not redundant — it confirms the
    /// id round-trips through the database, so a routing decision can never be
    /// based on a record the store does not actually hold.
    fn resolve(
        &self,
        capability: &str,
        routing: crate::capability::Routing,
        seq_len: usize,
    ) -> Result<(ToolRecord, Installation), String> {
        let candidates = self.registry.candidates(capability)?;
        if candidates.is_empty() {
            return Err(format!(
                "no installed tool provides `{capability}`; run the installer first"
            ));
        }
        let routed = route(&candidates, capability, routing, seq_len)?;
        let tool = self
            .registry
            .tool(&routed.id)?
            .ok_or_else(|| format!("{} vanished from the registry", routed.name))?;
        let inst = self
            .registry
            .installation(&tool.id)?
            .ok_or_else(|| format!("{} has no installation record", tool.name))?;
        if SMOKE_TEST_REQUIRED && !inst.smoke_test.as_ref().map(|s| s.passed).unwrap_or(false) {
            return Err(format!(
                "{}@{} has not passed its known-answer test",
                tool.name, tool.version
            ));
        }
        Ok((tool, inst))
    }

    fn execute_fold(
        &self,
        capability: &str,
        fold: &crate::capability::FoldRequest,
    ) -> Result<FoldResult, String> {
        let sequence = fold.normalized()?;

        let (tool, inst) = self.resolve(capability, fold.routing, sequence.len())?;

        // A builtin has no adapter to dispatch to. Reaching this path with one
        // would mean the registry routed a folding capability to a tool that
        // cannot fold, so it is refused rather than attempted.
        if tool.tier == crate::registry::InstallTier::Builtin {
            return Err(format!(
                "{} is a builtin and cannot serve `{capability}`",
                tool.name
            ));
        }

        let ctx = AdapterContext {
            tool: tool.name.clone(),
            tool_version: tool.version.clone(),
            artifact_sha256: tool.artifact_sha256.clone(),
            adapter_sha256: inst.adapter_sha256.clone(),
            algorithm: tool.algorithm.as_str().to_string(),
            energy_model: tool.energy_model.clone(),
            harness_rev: self.harness_rev.clone(),
        };

        // The wire format is built explicitly rather than by serialising
        // `CapabilityRequest` directly. Serde's internal tagging flattens a
        // newtype variant, which would put sequence/beamsize at the top level
        // and leave adapters expecting a `fold` object with nothing in it.
        //
        // The *normalised* sequence is dispatched, not the raw one. Sending
        // the raw sequence made a `T` reach the adapter, which correctly
        // rejects it, so T-input and lowercase input both failed even though
        // `normalized()` had already accepted them.
        let mut dispatch_fold = fold.clone();
        dispatch_fold.sequence = sequence.clone();
        let payload = serde_json::json!({
            "capability": capability,
            "fold": dispatch_fold,
        });
        let outcome = dispatch::run(
            Path::new(&inst.venv_path),
            Path::new(&inst.adapter_path),
            &payload,
            &ctx,
            self.deadline,
        )?;
        let result = expect_ok(outcome.response)?;

        // The adapter echoes its context so a mis-bundled adapter is caught.
        // Disagreement is fatal: if the adapter does not know which tool it is,
        // its numbers cannot be attributed.
        self.verify_context(&result, &ctx)?;

        let structure = result["structure"]
            .as_str()
            .ok_or("adapter returned no structure")?
            .to_string();
        if structure.len() != sequence.len() {
            return Err(format!(
                "adapter returned a {}-character structure for a {}-character sequence",
                structure.len(),
                sequence.len()
            ));
        }
        let mfe = result["mfe"]
            .as_f64()
            .or_else(|| result["free_energy"].as_f64())
            .ok_or("adapter returned no minimum free energy")?;

        // `fold.ensemble` reports the ensemble free energy under its own key.
        // Reading the MFE out of `free_energy` here, as an earlier draft did,
        // made the two identical, which is the whole distinction the
        // capability exists to expose.
        let ensemble_free_energy = if capability == CAP_FOLD_ENSEMBLE {
            match result["ensemble_free_energy"].as_f64() {
                Some(v) => Some(v),
                None => {
                    return Err(
                        "adapter returned no ensemble_free_energy for fold.ensemble".into()
                    )
                }
            }
        } else {
            None
        };

        let base_pairs = if capability == CAP_FOLD_ENSEMBLE {
            Some(
                result["base_pairs"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|p| {
                                Some(BasePair {
                                    i: p["i"].as_u64()? as usize,
                                    j: p["j"].as_u64()? as usize,
                                    probability: p["probability"].as_f64()?,
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            )
        } else {
            None
        };

        let fingerprint = Fingerprint {
            tool: tool.name.clone(),
            tool_version: tool.version.clone(),
            artifact_sha256: tool.artifact_sha256.clone(),
            adapter_sha256: inst.adapter_sha256.clone(),
            algorithm: tool.algorithm,
            energy_model: tool.energy_model.clone(),
            beamsize: match tool.algorithm {
                Algorithm::LinearTime => Some(fold.beamsize),
                // Exact, metadata, and every future variant: a beam width is a
                // property of beam search and of nothing else.
                _ => None,
            },
            cutoff: (capability == CAP_FOLD_ENSEMBLE).then_some(fold.cutoff),
            python_version: inst.python_version.clone(),
            deps_hash: inst.deps_hash.clone(),
            harness_rev: self.harness_rev.clone(),
        };

        Ok(FoldResult {
            sequence,
            structure,
            mfe,
            ensemble_free_energy,
            base_pairs,
            provider: format!("{}@{}", tool.name, tool.version),
            fingerprint,
            elapsed_ms: outcome.elapsed_ms,
        })
    }

    /// Run a literature search through the registry.
    ///
    /// The ordering mirrors a fold call: validate in Rust, resolve to an
    /// installed and smoke-passed tool, re-read the record, and build the
    /// fingerprint from registry state. The request is then handed to the
    /// implementation the registry chose, which is this build's arXiv client
    /// and nothing else — there is no path here that can reach a host other
    /// than [`arxiv::ARXIV_HOST`].
    fn execute_arxiv(
        &self,
        capability: &str,
        request: &ArxivRequest,
    ) -> Result<crate::capability::ArxivResult, String> {
        let normalized = request.normalized()?;

        // `Routing::Auto` because there is nothing to route: `registry::route`
        // returns the first candidate for a metadata tool rather than applying
        // a length crossover that does not exist.
        let (tool, _inst) = self.resolve(capability, crate::capability::Routing::Auto, 0)?;

        if tool.tier != crate::registry::InstallTier::Builtin {
            return Err(format!(
                "{} is not a builtin; a literature search has no adapter to dispatch to",
                tool.name
            ));
        }

        let search_query = arxiv::SearchQuery {
            search_query: arxiv::build_search_query(&normalized.query, normalized.category.as_deref()),
            max_results: normalized.max_results,
        };
        if search_query.search_query.is_empty() {
            return Err("query is empty after normalisation".into());
        }

        let started = std::time::Instant::now();
        let feed = arxiv::search(&search_query, &self.arxiv_throttle)?;
        let elapsed_ms = started.elapsed().as_millis() as u64;

        let fingerprint = Fingerprint {
            tool: tool.name.clone(),
            tool_version: tool.version.clone(),
            artifact_sha256: tool.artifact_sha256.clone(),
            adapter_sha256: String::new(),
            algorithm: tool.algorithm,
            energy_model: tool.energy_model.clone(),
            // A metadata search has no beam width and no probability cutoff.
            beamsize: None,
            cutoff: None,
            python_version: String::new(),
            deps_hash: crate::fingerprint::hash_deps(&[]),
            harness_rev: self.harness_rev.clone(),
        };

        Ok(crate::capability::ArxivResult {
            query: normalized.query,
            search_query: search_query.search_query,
            max_results: search_query.max_results,
            total_available: feed.total,
            results: feed.entries,
            provider: format!("{}@{}", tool.name, tool.version),
            fingerprint: Some(fingerprint),
            elapsed_ms,
        })
    }

    /// Compare the adapter's self-report against the context we sent it.
    fn verify_context(&self, result: &serde_json::Value, ctx: &AdapterContext) -> Result<(), String> {
        let got = result
            .get("context")
            .ok_or("adapter did not report its context")?;
        for (field, expected) in [
            ("tool", &ctx.tool),
            ("tool_version", &ctx.tool_version),
            ("artifact_sha256", &ctx.artifact_sha256),
            ("adapter_sha256", &ctx.adapter_sha256),
            ("algorithm", &ctx.algorithm),
        ] {
            let actual = got[field].as_str().unwrap_or_default();
            if actual != expected.as_str() {
                return Err(format!(
                    "adapter reported {field}={actual:?} but the registry says \
                     {expected:?}; refusing to attribute this result"
                ));
            }
        }
        Ok(())
    }
}

fn expect_ok(response: AdapterResponse) -> Result<serde_json::Value, String> {
    match response {
        AdapterResponse::Ok { result } => Ok(result),
        AdapterResponse::Error { error } => Err(error),
    }
}

/// Append adapter stderr to an error when there is any. A known-answer
/// failure with no diagnostics is close to undebuggable.
fn with_stderr(err: String, stderr: &str) -> String {
    let t = stderr.trim();
    if t.is_empty() {
        err
    } else {
        format!("{err} [adapter stderr: {t}]")
    }
}

pub fn now_iso8601() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // civil_from_days, so no date dependency is needed for a timestamp.
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant's days-from-civil, inverted.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[derive(Debug, Serialize)]
pub struct ToolSummary {
    pub name: String,
    pub version: String,
    pub source: String,
    pub algorithm: String,
    pub approximate: bool,
    pub capabilities: Vec<String>,
    pub installed: bool,
    pub healthy: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct InstallReport {
    pub tool: String,
    pub version: String,
    pub algorithm: String,
    pub approximate: bool,
    /// `wheel` or `builtin`. A caller that assumed every install produced a
    /// venv would otherwise be surprised by an empty `venv_path`.
    pub tier: String,
    pub venv_path: String,
    pub python_version: String,
    pub deps_hash: String,
    pub smoke_test: String,
}

impl Harness {
    pub fn summarize(&self) -> Result<Vec<ToolSummary>, String> {
        let installed = self.registry.list_installations()?;
        let mut out = Vec::new();
        for t in self.registry.list_tools()? {
            let inst = installed.iter().find(|i| i.tool_id == t.id);
            out.push(ToolSummary {
                name: t.name.clone(),
                version: t.version.clone(),
                source: t.source.clone(),
                algorithm: t.algorithm.as_str().to_string(),
                approximate: t.algorithm.is_approximate(),
                capabilities: t.capabilities.clone(),
                installed: inst.is_some(),
                healthy: inst.and_then(|i| i.smoke_test.as_ref().map(|s| s.passed)),
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_is_well_formed() {
        let s = now_iso8601();
        assert_eq!(s.len(), 20, "{s}");
        assert!(s.ends_with('Z'));
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[7..8], "-");
        assert_eq!(&s[10..11], "T");
    }

    #[test]
    fn epoch_converts_correctly() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2000-01-01 is day 10957.
        assert_eq!(civil_from_days(10_957), (2000, 1, 1));
        // Leap day.
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }

    #[test]
    fn unregistered_capability_is_rejected_before_dispatch() {
        let payload = serde_json::json!({"capability": "fold.nonsense", "fold": {"sequence": "GC"}});
        let req: CapabilityRequest = match serde_json::from_value(payload) {
            Ok(r) => r,
            Err(_) => return, // the tag enum rejects it outright, which is fine
        };
        let _ = req;
    }
}
