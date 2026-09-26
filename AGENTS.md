# AGENTS.md

## Project state

Tauri v2 desktop app: React 19 + TypeScript + Tailwind v4 + shadcn/ui on a Rust
backend. Frontend at `src/`, Rust at `src-tauri/`. Identifier `com.vedicam.darwin`.

**There is no test runner, linter, or formatter configured.** Don't invent
`npm test` / `npm run lint`. No CI either. Keep this file to the things scripts
can't express; the command list lives in `package.json` and `README.md`.

## Commands

- `npm run tauri dev` — the real dev loop (Vite on :1420 + Rust, HMR both sides).
- `npm run build` — `tsc && vite build`. **`tsc` runs here**, so type errors fail
  the frontend build. There is no separate typecheck script.
- `npm run tauri build` — full bundle into `src-tauri/target/release/bundle/`.
- `cd src-tauri && cargo check` — Rust only. Cold `cargo check` of the Tauri dep
  tree writes ~600MB to `src-tauri/target/`.
- `npm run dev` — frontend only, in a browser. `invoke()` calls will fail; that is
  expected, not a bug.

## Things that will bite you

**Do not add `baseUrl` to `tsconfig.json`.** TypeScript here is `~6.0.3`, where
`baseUrl` is deprecated and errors out (TS5101). `@/*` resolves through `paths`
alone. Most Vite/shadcn guides tell you to set both, and following them breaks
the build.

**shadcn components are generated, not hand-written.** Add them with
`npx shadcn@latest add <name>`; edits to `src/components/ui/*` get clobbered on
the next add. The `components.json` style is `base-nova`, which is built on
`@base-ui/react` — **not Radix**, despite what most shadcn docs assume. `cn` is
the `cn` npm package, not `clsx` + `tailwind-merge`.

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
