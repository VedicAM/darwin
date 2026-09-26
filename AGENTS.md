# AGENTS.md

## Project state

Tauri v2 desktop app that drives the [Pi coding agent](https://pi.dev) as a child
process. React 19 + TypeScript + Tailwind v4 + shadcn/ui on a Rust backend.
Frontend at `src/`, Rust at `src-tauri/`. Identifier `com.vedicam.darwin`.

It also carries a self-extending RNA tool harness: it installs hash-pinned
scientific Python packages into managed venvs and dispatches capability requests
to them, currently folding RNA with LinearFold. See "How the tool harness is
wired" below. Pi is the *assistant* half and never gains tool access beyond
`read,ls,grep,find`; the harness is the *execution* half and owns all network
and filesystem writes.

**There is no test runner, linter, or formatter configured.** Don't invent
`npm test` / `npm run lint`. No CI either. Keep this file to the things scripts
can't express; the command list lives in `package.json` and `README.md`.

The Rust side *does* have real tests: `cargo test` in `src-tauri/` runs 31 unit
tests, and `cargo test --test vertical -- --ignored --test-threads=1` runs 7
end-to-end tests that build a real venv and download pinned wheels. The
integration tests are `#[ignore]`d because they need the network; a green
`cargo test` alone does not mean the install path works.

## Commands

- `npm run tauri dev` — the real dev loop (Vite on :1420 + Rust, HMR both sides).
- `npm run build` — `tsc && vite build`. **`tsc` runs here**, so type errors fail
  the frontend build. There is no separate typecheck script.
- `npm run tauri build` — full bundle into `src-tauri/target/release/bundle/`.
- `cd src-tauri && cargo check` — Rust only. Cold `cargo check` of the Tauri dep
  tree writes ~600MB to `src-tauri/target/`.
- `cd src-tauri && cargo test` — 31 unit tests, no network.
- `cd src-tauri && cargo test --test vertical -- --ignored --test-threads=1` —
  7 end-to-end tests. Builds a venv and downloads pinned wheels, so it needs
  network and roughly a minute. Run these after touching `install.rs`,
  `dispatch.rs`, `catalog.rs`, or any adapter.
- `npm run dev` — frontend only, in a browser. `invoke()` calls will fail; that is
  expected, not a bug.

Environment overrides: `DARWIN_PYTHON` picks the interpreter venvs are built
from, `DARWIN_HARNESS_REV` is baked in as the harness revision in every
fingerprint (falls back to `unknown` when unset).

## How Pi is wired

`src-tauri/src/pi.rs` owns a long-lived `pi` child; the webview never touches it
directly. **The Pi SDK cannot run in the webview** — a Tauri webview has no Node,
no `fs`, no `child_process`. Rust spawns Pi and relays JSONL both ways:

```
webview  --invoke("pi_prompt")-->  Rust  --stdin-->   pi --mode rpc --no-session
webview  <--listen("pi://event")--  Rust  <--stdout--  (one raw JSON record each)
```

Spawn args are `--mode rpc --no-session --tools read,ls,grep,find`. The read-only
allowlist is deliberate: it keeps `bash`/`edit`/`write` away from a webview that
can issue prompts. Overrides: `DARWIN_PI_BIN`, `DARWIN_PI_TOOLS`, `DARWIN_WORKSPACE`.

Spawn is lazy (first `pi_prompt`/`pi_get_state`) and respawns if the child died.
`workspace_dir()` defaults to the parent of `CARGO_MANIFEST_DIR`; do **not**
inherit the process cwd, because Tauri's dev cwd is not reliably the repo root.

**The installed Pi is 0.78.1, which is behind pi.dev's docs (~0.85).** Verified
divergences, all handled in `src/lib/pi.ts`:
- **`agent_settled` is never emitted on 0.78.1** — a run ends at `agent_end`.
  Waiting only for `agent_settled` hangs the UI forever. `TERMINAL_EVENTS`
  accepts both so an upgrade stays correct; `isActive` flips back to running so a
  retry or compaction turn does not leave a stale "settled".
- **`response.data` is `null`** for `prompt`, not `{disposition: "started"}` as
  documented. The `disposition === "handled"` check is forward-compat only.

Observed record types on 0.78.1: `agent_start`, `turn_start`/`turn_end`,
`message_start`/`message_end`, `message_update`, `tool_execution_start`/`_end`,
`agent_end`. Tool records carry `toolName` + `args`, then `result` + `isError`.

## How the tool harness is wired

Callers ask for a **capability** (`fold.mfe`), never for a tool. A registry
record binds a concrete `tool@version` to a capability, and routing picks the
implementation. The order in `service.rs::execute` is the security property, not
an implementation detail:

```
validate sequence in Rust  ->  candidates = installed AND smoke-passed
  ->  route by length      ->  re-read record by content-addressed id
  ->  dispatch in a built env, under a deadline
  ->  build fingerprint from registry state (never from adapter output)
```

Modules: `capability.rs` (contract + `Routing`), `fingerprint.rs` (provenance),
`registry.rs` (SQLite + `ToolRegistry` trait), `install.rs` (venv + pinned
installs), `dispatch.rs` (subprocess), `catalog.rs` (curated seed),
`service.rs` (orchestration).

Three properties worth preserving:

- **The adapter cannot report its own provenance.** `dispatch::run` passes tool,
  version, artifact hash and algorithm through the environment; the fingerprint
  is assembled from the registry. The adapter's echo is checked for *agreement*
  in `verify_context` and disagreement is fatal. An adapter that hardcoded its
  own name could otherwise misattribute a number.
- **Adapter source is `include_str!`'d** (`catalog.rs`), so the adapter bytes and
  the `adapter_sha256` in every fingerprint cannot drift apart. Editing an
  adapter changes the hash, which surfaces in results.
- **A tool is not a candidate until it reproduces its known answers.** Failures
  are recorded, not discarded, so a broken tool stays visible instead of
  vanishing. Known answers in `catalog.rs` are regression baselines captured
  from these exact wheels, not literature values.

`install` uses pip's own `--require-hashes` rather than hashing after the fact,
so a swapped artifact fails the install. Because a hash is ABI-specific, the
venv interpreter is chosen from the seed's `python_tag` (`cp314`); picking
whatever `python3` happens to be gives a venv whose wheels cannot match.
`DARWIN_PYTHON` overrides and is authoritative — if it disagrees with the tag
that is a hard error, not something to paper over.

**Network isolation is not enforced, and the code says so.** cwd is a scratch
dir and the environment is built rather than inherited, but macOS
`sandbox-exec` is deprecated and seccomp is unavailable from a Rust process. An
adapter that wants to phone home can. Treat adapter code as trusted-but-reviewed;
it is not a boundary against a hostile package. This is also why the
`--require-hashes` install, not the sandbox, is what makes a package safe to run.

## Things that will bite you

**`pylinearfold`'s `partition` output is not what the docs suggest.** Verified
against the real 1.0.0 wheel:
- `probabilities` is a **numpy structured array** with fields `(i, j, prob)`, not
  a dict of `"i-j"` string keys.
- The indices are **already 0-based**. Checked on a 14-mer: rows span i=0..13 and
  every row is complementary under 0-based indexing, none under 1-based.

An early adapter read it as a dict and subtracted 1 from each index, which would
have silently returned wrong base pairs. The integration test now asserts every
returned pair is complementary in the returned sequence, which is what catches
this class of bug.

**`partition`'s `free_energy` is the ensemble free energy, not the MFE.** The
adapter folds separately and reports both under `mfe` and
`ensemble_free_energy`. Reading the MFE out of `free_energy` made the two
identical, which erased the one distinction `fold.ensemble` exists to expose.

**Do not serialise `CapabilityRequest` to get the adapter payload.** Serde's
internal tagging flattens a newtype variant, so the sequence lands at the top
level and an adapter reading `request["fold"]` sees nothing. `service.rs` builds
the `{capability, fold}` envelope by hand. Relatedly: dispatch the *normalized*
sequence. Sending the raw one put a `T` in front of an adapter that correctly
rejects it, so T-input and lowercase both failed after `normalized()` had
already accepted them.

**`SqliteRegistry` locks a `Mutex`, and it is not reentrant.** Tauri state must be
`Send + Sync` and a `rusqlite::Connection` is only `Send`. Public methods take
the lock once and delegate to `*_locked` helpers; `candidates()` needs two
helpers under one lock. Calling a public method from another public method
deadlocks. Also, `&self.conn()?` does not compile — deref coercion does not
apply through `?`, so bind the guard first.

**Do not add `baseUrl` to `tsconfig.json`.** TypeScript here is `~6.0.3`, where
`baseUrl` is deprecated and errors out (TS5101). `@/*` resolves through `paths`
alone. Most Vite/shadcn guides tell you to set both, and following them breaks
the build.

**shadcn components are generated, not hand-written.** Add them with
`npx shadcn@latest add <name>`; edits to `src/components/ui/*` get clobbered on
the next add. The `components.json` style is `base-nova`, which is built on
`@base-ui/react` — **not Radix**, despite what most shadcn docs assume. `cn` is
the `cn` npm package, not `clsx` + `tailwind-merge`.

**`scroll-area.tsx` ships a dead `import * as React`** which trips
`noUnusedLocals`. It was removed once; re-remove it if a re-add brings it back.

**There is no `tailwind.config.js`.** Tailwind v4 is configured CSS-first in
`src/index.css` (`@import "tailwindcss"` + an `@theme inline` block that maps
shadcn's CSS variables). The Vite plugin is `@tailwindcss/vite`. Don't go looking
for a JS config.

**New Rust commands need two edits, not one.** Add the `#[tauri::command] fn` in
`src-tauri/src/lib.rs` *and* register it in the `tauri::generate_handler![...]`
list, or the frontend `invoke` fails at runtime with no compile error.

**`src-tauri/capabilities/default.json` gates what the webview may call.** New
Tauri plugins need their permission added there, or calls are denied. Note
`security.csp` is `null` in `tauri.conf.json` — tighten it before shipping.

**Vite must not watch `src-tauri`** or Rust edits trigger frontend reloads. The
`server.watch.ignored` entry in `vite.config.ts` handles this; port 1420 is
`strictPort` because Tauri hardcodes `devUrl`.

**Pi's JSONL framing is LF-only.** The reader uses `read_until(b'\n')` and strips
a trailing CR. Do not "simplify" it to a generic line reader: Pi's docs call out
that splitting on U+2028/U+2029 corrupts records, and Node's `readline` does
exactly that. Two more: stdout carries protocol records only (diagnostics go to
stderr, surfaced as `pi://stderr` — never parse it as protocol), and stdout must
be drained continuously or Pi stalls on backpressure.

**`message_start`/`message_end` carry whole transcripts.** `isLoggable` drops
them, along with token-level `message_update`s, or the activity log floods.

## Conventions

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): subject`, e.g. `feat(cli): add resolve command`. Imperative mood,
  no trailing period.
- Default branch is `main`. Remote is `https://github.com/VedicAM/darwin.git`.
- `src-tauri/Cargo.lock` is committed (this is an app, not a library). Don't add
  it to `.gitignore`.
- `tsconfig.json` has `noUnusedLocals`/`noUnusedParameters` on, so dead code
  breaks the build.
- Two tsconfigs: `tsconfig.json` (app) and `tsconfig.node.json` (`vite.config.ts`,
  composite). A change to the Vite config may need the node project checked too.
- `pi` on macOS is a symlink to a `#!/usr/bin/env node` script with no shell
  wrapper, so `Child::kill()` reaches the real node process — no orphans to reap.
