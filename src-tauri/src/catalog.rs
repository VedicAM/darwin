//! The curated seed catalog.
//!
//! Tier 1 of the discovery waterfall: a small set of tool versions that have
//! been resolved, hash-pinned, and known-answer tested by hand. Everything
//! downstream can widen this, but nothing downstream can silently change what
//! is in it.
//!
//! Adapter source is embedded in the binary rather than shipped as a loose
//! file, so the adapter bytes and the adapter hash in every result's
//! fingerprint cannot drift apart. Re-`include_str!`ing a modified adapter
//! changes the hash, which makes an unreviewed adapter edit visible in
//! results.

use serde::Serialize;

use crate::arxiv::{ARXIV_ENDPOINT, ARXIV_HOST, ARXIV_REV, MAX_RESULTS};
use crate::capability::{CAP_FOLD_ENSEMBLE, CAP_FOLD_MFE, CAP_RESEARCH_ARXIV};
use crate::fingerprint::Algorithm;
use crate::install::Pin;
use crate::registry::{InstallTier, ToolRecord, SOURCE_ARXIV, SOURCE_PYPI};

/// A known-answer test: input, and the answer this exact artifact produced.
///
/// These are regression baselines captured from these exact wheels, not values
/// quoted from a paper. They exist to catch an adapter or binding regression,
/// not to certify the physics. ViennaRNA agrees on the cases in this file,
/// which is a cross-implementation check, not a proof of correctness.
#[derive(Clone, Debug, Serialize)]
pub struct KnownAnswer {
    pub name: &'static str,
    pub sequence: &'static str,
    pub structure: &'static str,
    pub mfe: f64,
}

/// A known-answer test for a metadata tool.
///
/// The fold baselines are `(sequence, structure, mfe)` because those are what a
/// folder is checked on. A literature client has no sequence and no energy, so
/// the checkable property is different in kind: given a fixed recorded
/// response, does the parser still extract the same identifiers and titles?
/// That is the regression that matters here — a parser change that silently
/// shifts a field mapping is invisible in a fold result and obvious here.
#[derive(Clone, Debug)]
pub struct KnownPaper {
    pub name: &'static str,
    /// Versionless arXiv id, as it must come out of the parser.
    pub arxiv_id: &'static str,
    /// First 40 characters of the title. Truncated so the baseline stays
    /// readable in this file; a full-title baseline would make a whitespace
    /// change look like a parser failure.
    pub title_prefix: &'static str,
    /// Number of authors the parser must recover.
    pub authors: usize,
    /// Primary category the parser must put first.
    pub primary_category: &'static str,
}

/// Which concrete implementation a seed installs.
///
/// A wheel seed is downloaded, hash-verified, and dispatched to a Python
/// adapter. A builtin seed is Rust compiled into this binary, so there is
/// nothing to download, no environment to build, and no adapter to
/// misattribute its own provenance. Modelling the difference here rather than
/// as "a wheel with empty fields" is what keeps `install` honest: a builtin
/// cannot accidentally be handed a venv path.
pub enum SeedKind {
    /// A hash-pinned wheel installed into a managed venv.
    Wheel {
        pins: Vec<Pin>,
        adapter_source: &'static str,
        known_answers: Vec<KnownAnswer>,
        /// Wheel ABI the pins were resolved for. A hash-enforced install cannot
        /// cross ABIs, so this selects the interpreter the venv is built from.
        python_tag: &'static str,
    },
    /// Implemented in this binary. Selected by name at dispatch time.
    Builtin { known_papers: Vec<KnownPaper> },
}

pub struct SeedTool {
    pub record: ToolRecord,
    pub kind: SeedKind,
}

pub const PYLINEARFOLD_ADAPTER: &str = include_str!("../adapters/pylinearfold_adapter.py");

/// A real arXiv Atom response, captured once and committed.
///
/// Embedded rather than fetched so the smoke test is offline and
/// deterministic. An install that needed the network to decide whether it
/// succeeded would be a much worse property than one that does not, and the
/// network path is covered by the `#[ignore]`d integration tests instead.
pub const ARXIV_FEED_FIXTURE: &str = include_str!("../fixtures/arxiv_atom.xml");

/// pylinearfold 1.0.0, resolved from PyPI for cp314/macosx_11_0_arm64.
pub fn pylinearfold() -> SeedTool {
    SeedTool {
        record: ToolRecord::new(
            "pylinearfold",
            "1.0.0",
            SOURCE_PYPI,
            "1d3a59afe98b27cf5276d8300362afcce6d87f632cad1b34bb66a298052cbc72",
            InstallTier::Wheel,
            Algorithm::LinearTime,
        )
        .with_capabilities(&[CAP_FOLD_MFE, CAP_FOLD_ENSEMBLE])
        .with_python(">=3.10")
        .with_license("see PyPI metadata")
        .with_homepage("https://pypi.org/project/pylinearfold/"),
        kind: SeedKind::Wheel {
            pins: vec![
                Pin {
                    name: "pylinearfold".into(),
                    version: "1.0.0".into(),
                    sha256: "1d3a59afe98b27cf5276d8300362afcce6d87f632cad1b34bb66a298052cbc72".into(),
                },
                // pylinearfold declares an unbounded `numpy` dependency, so a bare
                // resolve would drift to whatever is newest. Pin it explicitly, or
                // results stop being reproducible.
                Pin {
                    name: "numpy".into(),
                    version: "2.5.3".into(),
                    sha256: "012e66aca395d795496446e52aeeb5866312a5d4d3f27da270e5a0b43f70dc5c".into(),
                },
            ],
            adapter_source: PYLINEARFOLD_ADAPTER,
            // The pins below are the cp314 macosx_11_0_arm64 wheels.
            python_tag: "cp314",
            known_answers: vec![
                KnownAnswer {
                    name: "hairpin_14",
                    sequence: "AUCGGUUCGCCGAU",
                    structure: "(((((....)))))",
                    mfe: -4.2,
                },
                KnownAnswer {
                    name: "with_ambiguous_bases",
                    sequence: "AUCGNNUCGCCGANN",
                    structure: ".(((......)))..",
                    mfe: -0.2,
                },
            ],
        },
    }
}

/// The arXiv API, as a capability provider.
///
/// The name is `arxiv_api` rather than `arxiv` on purpose: the capability is
/// `research.arxiv`, and the registry is what maps one to the other. Callers
/// ask for the capability, so a second arXiv client added later is a catalog
/// row and not a change to any call site.
pub fn arxiv_api() -> SeedTool {
    let mut record = ToolRecord::new(
        "arxiv_api",
        ARXIV_REV,
        SOURCE_ARXIV,
        // A builtin has no artifact to hash, so `artifact_sha256` carries the
        // identity of the implementation contract instead: the endpoint and
        // the feed revision this build was written against. It is a
        // deliberate placeholder rather than a hash of nothing, and it changes
        // if the pinned endpoint or feed revision does.
        &arxiv_impl_sha256(),
        InstallTier::Builtin,
        Algorithm::Metadata,
    )
    .with_capabilities(&[CAP_RESEARCH_ARXIV])
    .with_license("arXiv API terms of use")
    .with_homepage("https://info.arxiv.org/help/api/index.html");
    // No energy model: this capability produces records, not numbers. Left as
    // the `ToolRecord::new` default it would claim `Turner2004`, which is
    // false and would end up in a fingerprint.
    record.energy_model = "none".into();
    SeedTool {
        record,
        kind: SeedKind::Builtin {
            known_papers: known_papers(),
        },
    }
}

/// Baselines captured from `ARXIV_FEED_FIXTURE`.
///
/// Not literature values and not a claim about arXiv's contents — they record
/// what this parser produced from this recorded response, so a mapping change
/// shows up as a smoke-test failure instead of as quietly different metadata.
fn known_papers() -> Vec<KnownPaper> {
    vec![
        KnownPaper {
            name: "nucleic_acid_folding_2015",
            arxiv_id: "1502.05667",
            title_prefix: "A free-energy based model of",
            authors: 3,
            primary_category: "q-bio.BM",
        },
        KnownPaper {
            name: "five_prime_three_prime_2011",
            arxiv_id: "1103.3032",
            title_prefix: "In vivo hybridization kinetics",
            authors: 3,
            primary_category: "q-bio.BM",
        },
        KnownPaper {
            name: "later_revision_2026",
            // The third entry was submitted in 2025 and revised in 2026, so it
            // is the case where `published` and `updated` genuinely differ.
            arxiv_id: "2511.02622",
            title_prefix: "Foundation models for nucleic acid",
            authors: 3,
            primary_category: "q-bio.BM",
        },
    ]
}

/// Hash of the pinned arXiv contract. See `arxiv_api` for why this stands in
/// for an artifact hash.
fn arxiv_impl_sha256() -> String {
    crate::fingerprint::sha256_hex(
        format!("{ARXIV_ENDPOINT}|{ARXIV_HOST}|{ARXIV_REV}|{MAX_RESULTS}").as_bytes(),
    )
}

pub fn all() -> Vec<SeedTool> {
    vec![pylinearfold(), arxiv_api()]
}

/// Check a known-answer result. Compares structure exactly and energy to
/// `1e-6`; `partition` is a float32-backed computation, so a loose comparison
/// would hide a real change and a tight one would fail spuriously.
/// Check a known paper. Exact on the identifier, exact on the title prefix and
/// the primary category, exact on the author count.
///
/// The author count is compared rather than the author list because arXiv
/// renders given names inconsistently ("Alice Zhang" vs "A. Zhang") and a
/// baseline that pinned the exact strings would fail on a cosmetic upstream
/// change while missing the real regression, which is an author being dropped
/// by the parser.
pub fn check_known_paper(kat: &KnownPaper, paper: &crate::arxiv::Paper) -> Result<(), String> {
    if paper.arxiv_id != kat.arxiv_id {
        return Err(format!(
            "known paper `{}`: id was {}, expected {}",
            kat.name, paper.arxiv_id, kat.arxiv_id
        ));
    }
    if !paper.title.starts_with(kat.title_prefix) {
        return Err(format!(
            "known paper `{}`: title was {:?}, expected it to start with {:?}",
            kat.name, paper.title, kat.title_prefix
        ));
    }
    if paper.authors.len() != kat.authors {
        return Err(format!(
            "known paper `{}`: {} authors, expected {}",
            kat.name,
            paper.authors.len(),
            kat.authors
        ));
    }
    match paper.categories.first() {
        Some(first) if first == kat.primary_category => {}
        other => {
            return Err(format!(
                "known paper `{}`: primary category was {other:?}, expected {}",
                kat.name, kat.primary_category
            ))
        }
    }
    Ok(())
}

pub fn check_known_answer(
    kat: &KnownAnswer,
    sequence: &str,
    structure: &str,
    mfe: f64,
) -> Result<(), String> {
    if sequence != kat.sequence {
        return Err(format!(
            "known answer `{}` was run on {sequence}, expected {}",
            kat.name, kat.sequence
        ));
    }
    if structure != kat.structure {
        return Err(format!(
            "known answer `{}`: structure was {structure}, expected {}",
            kat.name, kat.structure
        ));
    }
    if (mfe - kat.mfe).abs() > 1e-6 {
        return Err(format!(
            "known answer `{}`: mfe was {mfe}, expected {}",
            kat.name, kat.mfe
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every seed declares at least one capability, and a capability belongs to
    /// exactly one seed per tier. Two tools claiming the same capability is not
    /// an error — routing exists for that — but a seed declaring none is a
    /// tool nothing can ever reach.
    #[test]
    fn seed_records_declare_their_capabilities() {
        for tool in all() {
            assert!(
                !tool.record.capabilities.is_empty(),
                "{} declares no capabilities",
                tool.record.name
            );
        }
    }

    #[test]
    fn wheel_seeds_are_fully_hashed() {
        let mut checked = 0;
        for tool in all() {
            // Only wheel seeds download artifacts, so only they have pins to
            // check. A builtin with an empty pin list is correct, not a gap.
            let SeedKind::Wheel { pins, .. } = &tool.kind else {
                continue;
            };
            assert!(!pins.is_empty(), "{} has no pins", tool.record.name);
            for p in pins {
                let id = format!("{}=={}", p.name, p.version);
                assert_eq!(p.sha256.len(), 64, "{id} is not a sha256");
                assert!(
                    p.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                    "{id} hash is not hex"
                );
                // The record's artifact hash is the primary wheel's hash, so a
                // mismatch means the fingerprint would attribute a result to
                // an artifact that is not the one installed.
                if p.name == tool.record.name {
                    assert_eq!(p.sha256, tool.record.artifact_sha256, "{id}");
                }
            }
            checked += 1;
        }
        assert!(checked > 0, "no wheel seeds to check");
    }

    #[test]
    fn a_builtin_declares_no_python_requirement() {
        for tool in all() {
            if matches!(tool.kind, SeedKind::Builtin { .. }) {
                assert!(
                    tool.record.requires_python.is_empty(),
                    "{} is builtin but asks for a Python",
                    tool.record.name
                );
                // A builtin has no energy model either. Leaving the
                // `ToolRecord::new` default would put `Turner2004` into every
                // fingerprint, which is a false provenance claim.
                assert_eq!(tool.record.energy_model, "none");
            }
        }
    }

    #[test]
    fn the_arxiv_builtin_is_routable_and_claims_the_research_capability() {
        let tool = arxiv_api();
        assert!(matches!(tool.kind, SeedKind::Builtin { .. }));
        assert!(tool
            .record
            .capabilities
            .contains(&CAP_RESEARCH_ARXIV.to_string()));
        // It must not be reachable as a folder, or routing would hand a
        // literature search to a sequence folder.
        assert!(!tool.record.capabilities.contains(&CAP_FOLD_MFE.to_string()));
        assert_eq!(tool.record.algorithm, Algorithm::Metadata);
    }

    #[test]
    fn arxiv_known_papers_reproduce_from_the_committed_fixture() {
        // This is the offline half of the builtin smoke test, and it is the
        // same check `install` runs. Asserting it here means a parser
        // regression fails `cargo test` rather than waiting for an install.
        let feed = crate::arxiv::parse_feed(ARXIV_FEED_FIXTURE).expect("fixture should parse");
        let kat = known_papers();
        assert_eq!(
            feed.entries.len(),
            kat.len(),
            "the fixture and the baselines disagree on entry count"
        );
        for (paper, expected) in feed.entries.iter().zip(&kat) {
            check_known_paper(expected, paper).unwrap_or_else(|e| panic!("{e}"));
        }
    }

    #[test]
    fn known_paper_matching_rejects_drift() {
        let kat = &known_papers()[0];
        let feed = crate::arxiv::parse_feed(ARXIV_FEED_FIXTURE).unwrap();
        let good = &feed.entries[0];
        assert!(check_known_paper(kat, good).is_ok());

        let mut bad = good.clone();
        bad.arxiv_id = "0000.00000".into();
        assert!(check_known_paper(kat, &bad).is_err(), "wrong id must fail");

        let mut bad = good.clone();
        bad.authors.pop();
        assert!(check_known_paper(kat, &bad).is_err(), "dropped author must fail");

        let mut bad = good.clone();
        bad.categories[0] = "cs.LG".into();
        assert!(
            check_known_paper(kat, &bad).is_err(),
            "misordered primary category must fail"
        );

        let mut bad = good.clone();
        bad.title = "Something else entirely".into();
        assert!(check_known_paper(kat, &bad).is_err(), "wrong title must fail");
    }

    #[test]
    fn known_answer_matching_rejects_drift() {
        let SeedKind::Wheel { known_answers, .. } = pylinearfold().kind else {
            panic!("pylinearfold is a wheel seed");
        };
        let kat = &known_answers[0];
        assert!(check_known_answer(kat, kat.sequence, kat.structure, kat.mfe).is_ok());
        assert!(check_known_answer(kat, kat.sequence, "((((()))))", kat.mfe).is_err());
        assert!(check_known_answer(kat, kat.sequence, kat.structure, kat.mfe - 1.0).is_err());
        assert!(check_known_answer(kat, "AUCG", kat.structure, kat.mfe).is_err());
    }

    #[test]
    fn adapter_is_embedded_and_non_trivial() {
        assert!(PYLINEARFOLD_ADAPTER.contains("pylinearfold"));
        assert!(PYLINEARFOLD_ADAPTER.len() > 500);
    }
}
