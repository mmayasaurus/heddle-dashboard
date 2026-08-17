# Building & verifying locally

These are the canonical local commands for a fleet worktree whose `node_modules` is symlinked to
the main checkout's copy (`<repo>/.worktrees/<agent>`). That layout is fast, but it has three sharp
edges worth treating as repository rules.

## The three landmines

### 1. Symlinked `node_modules`: never invoke pnpm — any of it

**Rule:** do not run `pnpm`, including `pnpm tauri ...` or `pnpm exec`, from a worktree with symlinked
dependencies. Use the installed binaries directly instead:

```sh
node_modules/.bin/tsc --noEmit -p tsconfig.json
node_modules/.bin/vitest run --configLoader runner
node_modules/.bin/eslint <files>
```

For a release bundle, run:

```sh
node_modules/.bin/vite build
node_modules/.bin/tauri build -c '{"build":{"beforeBuildCommand":""}}'
```

The `-c` override skips the configured `beforeBuildCommand`, which would otherwise re-enter pnpm.

**Failure:** pnpm's preflight `deps-check` resolves through the symlink and purges the main checkout's
`node_modules` mid-check — including when entered through `pnpm tauri ...` or `pnpm exec`.

**Incident receipt:** 2026-08-16, worktree R — a deps-check purge left the main checkout broken during
review.

### 2. `cargo fmt` formats the whole workspace even when given file paths

**Rule:** format Rust files directly with `rustfmt --edition 2021 <file>`, never `cargo fmt`; inspect
the diff before committing.

**Failure:** `cargo fmt -- <file>` ignores file scoping in this workspace and reflows every crate.

**Incident receipt:** 2026-08-16 — it twice polluted 28 out-of-lane files.

### 3. `.gitignore` `node_modules/` does not match a symlink

**Rule:** keep the symlink-layout exclusion local. Add `node_modules` (without a trailing slash) and
`__pycache__/` to `.git/info/exclude`; do not change the tracked `.gitignore` for this.

**Failure:** Git treats the symlink as a file, while the trailing-slash `node_modules/` pattern matches
directories only. The worktree then shows `?? node_modules`, and dispatch preflights requiring a clean
tree refuse to run.

**Incident receipt:** 2026-08-17 — the local `.git/info/exclude` fix was applied for the symlink layout.

## Quick reference

Copy this sequence for full local verification and a bundle build. Replace `<files>` with the changed
TypeScript files, and run `rustfmt` once for each changed Rust file.

```sh
node_modules/.bin/tsc --noEmit -p tsconfig.json
node_modules/.bin/vitest run --configLoader runner
node_modules/.bin/eslint <files>
rustfmt --edition 2021 <file>
node_modules/.bin/vite build
node_modules/.bin/tauri build -c '{"build":{"beforeBuildCommand":""}}'
git diff --check
```
