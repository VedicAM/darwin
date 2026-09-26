# darwin

Desktop app: a GUI harness around the [Pi coding agent](https://pi.dev). Tauri v2
(Rust) + React 19 + TypeScript + Tailwind v4 + shadcn/ui.

Pi runs as a child process speaking RPC mode; Rust spawns it and relays JSONL to
and from the webview. The agent gets a read-only toolset (`read`, `ls`, `grep`,
`find`).

## Prerequisites

- Node.js 20+ (verified on v24.1.0) and npm — the only package manager in use.
- Rust stable (`rustup`), verified on 1.90.0 / aarch64-apple-darwin.
- macOS: Xcode Command Line Tools (`xcode-select --install`).
- **Pi on `PATH`**, verified against 0.78.1:
  ```sh
  npm install -g @earendil-works/pi-coding-agent
  ```
  Pi must be authenticated (`/login` inside `pi`, or a provider API key).

## Setup

```sh
npm install
```

## Run

```sh
npm run tauri dev
```

Starts Vite on port 1420 (strict) and opens the native window with HMR for both
the frontend and Rust code.

`npm run dev` alone serves the UI in a browser. The frontend renders, but every
`invoke` fails — the Rust side does not exist in plain Vite.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DARWIN_PI_BIN` | `pi` | Path to the Pi executable |
| `DARWIN_PI_TOOLS` | `read,ls,grep,find` | Comma-separated tool allowlist |
| `DARWIN_WORKSPACE` | repo root | Directory Pi treats as the project root |

## Build

```sh
npm run tauri build
```

Bundles a `.app`/`.dmg` into `src-tauri/target/release/bundle/`. This runs the
frontend build first, so it also typechecks.

Frontend-only build (typecheck + Vite bundle, no Rust): `npm run build`
Typecheck only: `npx tsc --noEmit`
Rust only: `cd src-tauri && cargo check`

## Self-evolving tool taxonomy

The standalone Python package in [`evolution/`](evolution/) maintains a
versioned scientific-tool Table of Contents in MongoDB Atlas. It benchmarks
tree-aware routing against flat and unconstrained baselines, proposes guarded
structural mutations, promotes changes using a held-out paired test, measures
causal contribution with mutation knockouts, and writes an offline replay.

It targets the `darwin_evaluation` database by default and requires explicit
`MONGODB_URI` and `OPENROUTER_API_KEY` environment variables. See
[`evolution/README.md`](evolution/README.md) for setup and commands.

### Three-minute judging path

Darwin addresses a common agent-infrastructure failure: tool catalogs are
hand-organized, yet teams rarely measure whether that organization routes work
correctly. Darwin treats the catalog as a living, versioned taxonomy. It diagnoses
misroutes, proposes structural changes, rejects unsafe changes, promotes only on a
held-out split, and preserves the lineage and causal evidence for every survivor.

Run these in separate terminals:

```bash
python -m evolution.smoke_test
python -m evolution.live_panel
python -m evolution.phylogeny
python -m evolution.rigor_report --verify-routing
python -m evolution.transfer_test
```

For a network-independent presentation, point the same dashboard at a saved
evolution log: `python -m evolution.live_panel --replay evolution/runs/toc_evolution_log.json`.
The UI labels missing measurements and cached state explicitly; it never fills a
demo with synthetic performance results.
The timed narration and operator handoff are in [`DEMO.md`](DEMO.md).

### Built for the Darwin evolution demo

- `evolution/taxonomy.py` — reproducible 35-node starting tree and 60-task benchmark.
- `evolution/router.py` — constrained tree router, baselines, and latency/token telemetry.
- `evolution/toc_mutations.py` — five structural operators plus deterministic safety guard.
- `evolution/evolve_loop.py` — three-way split selection loop and immutable lineage.
- `evolution/knockouts.py` — paired bootstrap causal knockouts and pruned champion.
- `evolution/live_panel.py` — four-pane Atlas dashboard with cached and 4× replay modes.
- `evolution/smoke_test.py` — one-minute green/red preflight.
- `evolution/rigor_report.py` — computed protocol, guard, statistics, hash, and reproducibility evidence.
- `evolution/phylogeny.py` — lineage tree, per-leaf fossil record, and provenance ratio.
- `evolution/transfer_test.py` — never-touched-leaf generalization and wrong-tool cost.
- `evolution/negative_results.py` — bounded, calibrated Negative Results Registry.
- `evolution/paper_tools.py` — evidence-gated paper-derived tool candidates.
- `skills/darwin-paper-to-tool/` — reusable paper-to-tested-tool workflow.

The implementation history is visible in the repository's
[commit log](https://github.com/VedicAM/darwin/commits/feat/self-evolving-tool-taxonomy).
