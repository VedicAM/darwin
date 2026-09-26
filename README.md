# darwin

Desktop app scaffold: Tauri v2 (Rust) + React 19 + TypeScript + Tailwind v4 + shadcn/ui.

## Prerequisites

- Node.js 20+ (verified on v24.1.0) and npm — the only package manager in use. No pnpm/yarn/bun lockfile.
- Rust stable (`rustup`), verified on 1.90.0 / aarch64-apple-darwin. Required — Tauri compiles a Rust binary and npm cannot install it for you.
- macOS: Xcode Command Line Tools (`xcode-select --install`).

## Setup

```sh
npm install
```

## Run

```sh
npm run tauri dev
```

Starts Vite on port 1420 (strict) and opens the native window with HMR for both the frontend and Rust code.

`npm run dev` alone serves the UI in a browser. The frontend will render, but anything using `invoke` will fail — the Rust side does not exist in plain Vite.

## Build

```sh
npm run tauri build
```

Bundles a `.app`/`.dmg` into `src-tauri/target/release/bundle/`. This runs the frontend build first, so it also typechecks.

Frontend-only build (typecheck + Vite bundle, no Rust): `npm run build`
Typecheck only: `npx tsc --noEmit`
Rust only: `cd src-tauri && cargo check`
