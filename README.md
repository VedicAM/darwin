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
