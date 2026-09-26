//! End-to-end vertical slice, gated because it needs the network.
//!
//! This is the only test that proves the whole path works: a real venv, a
//! hash-verified pip install of the pinned wheels, the embedded adapter
//! written to disk, known-answer tests, and a capability call returning a
//! fingerprinted result.
//!
//! Run with `cargo test --test vertical -- --ignored --nocapture`.

use darwin_lib::testing::*;

fn temp_root(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "darwin-e2e-{tag}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
#[ignore = "creates a real venv and downloads pinned wheels"]
fn install_then_fold_mfe_end_to_end() {
    let root = temp_root("mfe");
    let h = Harness::open(&root, "testrev").expect("open harness");

    assert_eq!(h.seed_catalog().unwrap(), 1, "one seed tool");

    // Nothing is installed yet, so a call must fail with guidance rather than
    // silently reaching for something.
    let err = h
        .execute(&fold_mfe("AUCGGUUCGCCGAU"))
        .expect_err("uninstalled tool must not be used");
    assert!(err.contains("no installed tool"), "{err}");

    let report = h.install_named("pylinearfold").expect("install");
    assert_eq!(report.tool, "pylinearfold");
    assert_eq!(report.version, "1.0.0");
    assert!(report.approximate, "LinearFold is approximate");
    assert!(
        report.smoke_test.contains("known answer"),
        "smoke test did not report: {}",
        report.smoke_test
    );
    assert!(report.deps_hash.len() == 64, "deps hash must be a sha256");

    // Records are registered, so the tool is now discoverable and healthy.
    let summary = h.summarize().unwrap();
    assert_eq!(summary.len(), 1);
    assert!(summary[0].installed);
    assert_eq!(summary[0].healthy, Some(true));
    assert!(summary[0].capabilities.contains(&"fold.mfe".to_string()));

    let result = h.execute(&fold_mfe("AUCGGUUCGCCGAU")).expect("fold");

    assert_eq!(result.structure, "(((((....)))))");
    assert!((result.mfe - -4.2).abs() < 1e-9, "mfe was {}", result.mfe);
    assert_eq!(result.sequence, "AUCGGUUCGCCGAU");
    assert_eq!(result.provider, "pylinearfold@1.0.0");

    // The fingerprint is the point of the whole exercise.
    let fp = &result.fingerprint;
    assert_eq!(fp.tool, "pylinearfold");
    assert_eq!(fp.tool_version, "1.0.0");
    assert_eq!(fp.algorithm.as_str(), "linear_time");
    assert_eq!(fp.beamsize, Some(100));
    assert_eq!(fp.cutoff, None, "cutoff is only part of fold.ensemble");
    assert_eq!(
        fp.artifact_sha256,
        "1d3a59afe98b27cf5276d8300362afcce6d87f632cad1b34bb66a298052cbc72"
    );
    assert_eq!(fp.adapter_sha256.len(), 64);
    assert_eq!(fp.deps_hash.len(), 64);
    assert_eq!(fp.harness_rev, "testrev");
    assert!(fp.python_version.starts_with("3."));

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
#[ignore = "creates a real venv and downloads pinned wheels"]
fn ensemble_reports_base_pairs_and_approximation() {
    let root = temp_root("ens");
    let h = Harness::open(&root, "testrev").unwrap();
    h.install_named("pylinearfold").expect("install");

    let result = h
        .execute(&fold_ensemble("AUCGGUUCGCCGAU"))
        .expect("partition");

    assert_eq!(result.structure, "(((((....)))))");
    // The ensemble free energy is below the MFE, as it must be.
    assert!(
        result.ensemble_free_energy.unwrap() < result.mfe,
        "ensemble {} should be below mfe {}",
        result.ensemble_free_energy.unwrap(),
        result.mfe
    );

    let pairs = result.base_pairs.expect("base pairs");
    assert!(!pairs.is_empty());
    assert!(pairs.len() <= 50, "max_pairs cap not applied");
    // Highest probability first.
    for w in pairs.windows(2) {
        assert!(w[0].probability >= w[1].probability, "pairs not sorted");
    }
    // Indices are 0-based into the returned sequence, and every pair is
    // complementary. This is the check that would have caught the 1-based
    // misreading of LinearFold's output.
    let seq = result.sequence.as_bytes();
    for p in &pairs {
        assert!(p.i < seq.len() && p.j < seq.len(), "pair {p:?} out of range");
        assert!(p.i < p.j, "pair not ordered: {p:?}");
        let ok = matches!(
            (seq[p.i], seq[p.j]),
            (b'A', b'U') | (b'U', b'A') | (b'C', b'G') | (b'G', b'C')
        );
        assert!(ok, "pair {p:?} is not complementary in {seq:?}");
    }

    assert_eq!(result.fingerprint.cutoff, Some(1e-5));

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
#[ignore = "creates a real venv and downloads pinned wheels"]
fn t_input_is_normalised_before_dispatch() {
    let root = temp_root("tnorm");
    let h = Harness::open(&root, "testrev").unwrap();
    h.install_named("pylinearfold").unwrap();

    let with_t = h.execute(&fold_mfe("AUCTGGUUCGCCGAU")).unwrap();
    assert_eq!(with_t.sequence, "AUCUGGUUCGCCGAU", "T must become U");
    assert_eq!(with_t.structure, "...(((....)))..");
    assert!((with_t.mfe - -0.7).abs() < 1e-9);

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
#[ignore = "creates a real venv and downloads pinned wheels"]
fn invalid_sequences_are_rejected_before_any_process_starts() {
    let root = temp_root("reject");
    let h = Harness::open(&root, "testrev").unwrap();
    h.install_named("pylinearfold").unwrap();

    for bad in ["", "   ", "AUCGXU", "AUCG U", "1234"] {
        let err = h
            .execute(&fold_mfe(bad))
            .expect_err("invalid sequence must be rejected");
        assert!(!err.is_empty());
    }
    // A lowercase sequence is fine; only the alphabet is constrained.
    assert!(h.execute(&fold_mfe("aucgguucgccgau")).is_ok());

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
#[ignore = "creates a real venv and downloads pinned wheels"]
fn results_are_reproducible_across_calls() {
    let root = temp_root("repro");
    let h = Harness::open(&root, "testrev").unwrap();
    h.install_named("pylinearfold").unwrap();

    let a = h.execute(&fold_mfe("AUCGGUUCGCCGAU")).unwrap();
    let b = h.execute(&fold_mfe("AUCGGUUCGCCGAU")).unwrap();

    assert_eq!(a.fingerprint.content_hash(), b.fingerprint.content_hash());
    assert_eq!(a.structure, b.structure);
    assert_eq!(a.mfe, b.mfe);

    // Changing an approximation parameter must change the fingerprint, or two
    // different numbers would look like one result.
    let mut c = h.execute(&fold_mfe("AUCGGUUCGCCGAU")).unwrap();
    c.fingerprint.beamsize = Some(250);
    assert_ne!(a.fingerprint.content_hash(), c.fingerprint.content_hash());

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
#[ignore = "creates a real venv and downloads pinned wheels"]
fn unknown_tool_name_lists_the_real_catalog() {
    let root = temp_root("unknown");
    let h = Harness::open(&root, "testrev").unwrap();
    let err = h.install_named("definitely-not-a-tool").unwrap_err();
    assert!(err.contains("pylinearfold"), "error should list catalog: {err}");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
#[ignore = "creates a real venv and downloads pinned wheels"]
fn reinstall_refuses_to_touch_an_existing_environment() {
    let root = temp_root("reinstall");
    let h = Harness::open(&root, "testrev").unwrap();
    h.install_named("pylinearfold").expect("first install");
    // "Never upgrade in place" is enforced by refusing, not by overwriting.
    let err = h.install_named("pylinearfold").expect_err("second install must refuse");
    assert!(err.contains("already exists"), "{err}");
    let _ = std::fs::remove_dir_all(&root);
}
