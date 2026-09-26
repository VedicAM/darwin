//! Public surface for the integration tests in `tests/`.
//!
//! Integration tests link against the crate rather than being compiled into
//! it, so they cannot see private modules. This re-exports the narrow slice
//! they need. It is `#[doc(hidden)]` because it exists for tests, not for
//! callers — nothing in the app should import from here.

pub use crate::capability::{
    CapabilityRequest, FoldRequest, FoldResult, CAP_FOLD_ENSEMBLE, CAP_FOLD_MFE,
};
pub use crate::fingerprint::{Algorithm, Fingerprint};
pub use crate::service::{Harness, InstallReport, ToolSummary};

/// The curated pylinearfold seed, for tests that want its pins or known
/// answers without re-declaring them.
pub fn catalog_pylinearfold() -> crate::catalog::SeedTool {
    crate::catalog::pylinearfold()
}

pub fn fold_mfe(sequence: &str) -> CapabilityRequest {
    CapabilityRequest::FoldMfe(FoldRequest::new(sequence.to_string()))
}

pub fn fold_ensemble(sequence: &str) -> CapabilityRequest {
    CapabilityRequest::FoldEnsemble(FoldRequest::new(sequence.to_string()))
}

/// A `fold.mfe` request with a non-default beam width, for testing that
/// approximation parameters reach the fingerprint.
pub fn fold_mfe_with_beamsize(sequence: &str, beamsize: u32) -> CapabilityRequest {
    let mut req = FoldRequest::new(sequence.to_string());
    req.beamsize = beamsize;
    CapabilityRequest::FoldMfe(req)
}

/// A `fold.mfe` request that forces a routing choice.
pub fn fold_mfe_routed(sequence: &str, routing: crate::capability::Routing) -> CapabilityRequest {
    let mut req = FoldRequest::new(sequence.to_string());
    req.routing = routing;
    CapabilityRequest::FoldMfe(req)
}
