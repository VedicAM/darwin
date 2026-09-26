mod arxiv;
mod bridge;
mod capability;
mod catalog;
mod corpus;
mod dispatch;
mod experiment;
mod fingerprint;
mod install;
mod pi;
mod registry;
mod service;
#[doc(hidden)]
pub mod testing;

use std::sync::Arc;

use capability::{ArxivRequest, CapabilityRequest, CapabilityResult, ExperimentRequest, FoldRequest};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::init;

use service::{Harness, ToolSummary};

/// Sends a prompt to the running `pi` session, spawning it on first use.
/// Returns as soon as Pi accepts the prompt. Progress arrives as `pi://event`.
#[tauri::command]
fn pi_prompt(app: AppHandle, state: State<'_, pi::PiSession>, message: String) -> Result<(), String> {
    state.prompt(&app, message)
}

/// Asks Pi to report its current state (model, provider, ...). The reply comes
/// back through `pi://event` as a `get_state` response, not through this call.
#[tauri::command]
fn pi_get_state(app: AppHandle, state: State<'_, pi::PiSession>) -> Result<(), String> {
    state.get_state(&app)
}

/// Terminates the `pi` child. The next prompt will spawn a fresh one.
#[tauri::command]
fn pi_stop(state: State<'_, pi::PiSession>) -> Result<(), String> {
    state.stop()
}

/// Minimum free-energy structure for a sequence.
#[tauri::command]
fn fold_mfe(
    h: State<'_, Arc<Harness>>,
    sequence: String,
) -> Result<capability::FoldResult, String> {
    h.execute(&CapabilityRequest::FoldMfe(FoldRequest::new(sequence)))?
        .into_fold()
}

/// Ensemble free energy plus base-pair probabilities.
#[tauri::command]
fn fold_ensemble(
    h: State<'_, Arc<Harness>>,
    sequence: String,
) -> Result<capability::FoldResult, String> {
    h.execute(&CapabilityRequest::FoldEnsemble(FoldRequest::new(sequence)))?
        .into_fold()
}

/// Dispatch a capability request with routing under the caller's control.
#[tauri::command]
fn capability_execute(
    h: State<'_, Arc<Harness>>,
    request: CapabilityRequest,
) -> Result<CapabilityResult, String> {
    h.execute(&request)
}

/// Search arXiv for papers matching a query.
///
/// Metadata and abstracts only. This does not read paper bodies: fetching a
/// specific paper is a separate capability (`research.arxiv.fetch`) so that
/// discovery stays cheap and the two can be allowlisted independently.
#[tauri::command]
fn search_arxiv(
    h: State<'_, Arc<Harness>>,
    query: String,
    max_results: Option<usize>,
    category: Option<String>,
) -> Result<capability::ArxivResult, String> {
    let mut request = ArxivRequest::new(query);
    if let Some(n) = max_results {
        request.max_results = n;
    }
    request.category = category;
    match h.execute(&CapabilityRequest::ResearchArxiv(request))? {
        CapabilityResult::ResearchArxiv(r) => Ok(r),
        other => Err(format!(
            "`{}` did not return a research result",
            other.capability()
        )),
    }
}

/// Run an agent-authored Python experiment in the harness sandbox.
///
/// Execution is the harness's, never Pi's: the code runs in a constructed
/// environment under a wall-clock deadline, and only files it produced are
/// returned. See `experiment.rs` for the posture and its honest limits.
#[tauri::command]
fn run_experiment(
    h: State<'_, Arc<Harness>>,
    code: String,
    inputs: Option<Vec<capability::ExperimentInput>>,
    timeout_s: Option<u64>,
) -> Result<capability::ExperimentResult, String> {
    let mut request = ExperimentRequest::new(code);
    if let Some(inputs) = inputs {
        request.inputs = inputs;
    }
    request.timeout_s = timeout_s;
    match h.execute(&CapabilityRequest::ExperimentRun(request))? {
        CapabilityResult::ExperimentRun(r) => Ok(r),
        other => Err(format!("`{}` did not return an experiment result", other.capability())),
    }
}

/// Every registered tool, with install and health status.
#[tauri::command]
fn list_tools(h: State<'_, Arc<Harness>>) -> Result<Vec<ToolSummary>, String> {
    h.summarize()
}

/// Install a catalog tool from its pinned artifacts and known-answer test it.
#[tauri::command]
fn install_tool(h: State<'_, Arc<Harness>>, name: String) -> Result<service::InstallReport, String> {
    h.install_named(&name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(init())
        .setup(|app| {
            // A failed registry open must not take the whole app down; the
            // Pi side of the app still works, and the failure surfaces on the
            // first science call instead.
            let data_dir = app.path().app_data_dir()?;
            // A build without DARWIN_HARNESS_REV still runs; it just cannot
            // attribute results to a commit, which is visible in the output
            // rather than silently wrong.
            let rev = option_env!("DARWIN_HARNESS_REV").unwrap_or("unknown");
            let harness = Arc::new(Harness::open(&data_dir, rev)?);
            harness.seed_catalog()?;
            // Builtins are activated here so the capability is usable without an
            // install step the UI does not offer. Failures are printed rather
            // than swallowed: a broken fixture must stay visible, and the app
            // still launches with the capability simply unresolved.
            for outcome in harness.activate_builtins() {
                match outcome {
                    Ok(report) => eprintln!("harness: activated {} {}", report.tool, report.version),
                    Err(err) => eprintln!("harness: builtin activation failed: {err}"),
                }
            }

            // The socket is what lets Pi reach the harness. It is opened before
            // the first prompt can arrive, and the path is handed to the Pi
            // child in `pi::spawn` — so a Pi extension can ask for a capability
            // without Pi itself ever making a network request.
            let socket = bridge::serve(Arc::clone(&harness), &data_dir)?;

            // Tell the Pi session where the socket is before any prompt can
            // arrive. `PiSession` is managed on the builder, so it is already
            // registered by the time `setup` runs.
            app.state::<pi::PiSession>()
                .set_harness_socket(socket.path().to_path_buf());

            app.manage(harness);
            app.manage(socket);
            Ok(())
        })
        .manage(pi::PiSession::default())
        .invoke_handler(tauri::generate_handler![
            pi_prompt,
            pi_get_state,
            pi_stop,
            fold_mfe,
            fold_ensemble,
            capability_execute,
            search_arxiv,
            run_experiment,
            list_tools,
            install_tool,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
