# Heddle Gate

Run this repo's quality gate locally (mirrors `.github/workflows/gate.yml` — see docs/CI.md).

Execute from the repo root (or the active worktree):

For worktree-safe direct-binary commands, `docs/BUILDING.md` is the authority.

1. If `node_modules` is missing or the lockfile changed, stop and restore dependencies from the main checkout; do not run pnpm in a symlinked worktree.
2. `node_modules/.bin/tsc --noEmit -p tsconfig.json`, then `npm_package_version="$(node -p 'require("./package.json").version')" node_modules/.bin/vite build` — produces `dist/`, which cargo needs via tauri-build.
3. `node_modules/.bin/vitest run` — behavioral tests; a toggle-flips test is not a pass (see docs/CI.md standing rules).
4. `cargo check --manifest-path src-tauri/Cargo.toml --locked` and the same with `--no-default-features`.
5. `cargo test --manifest-path src-tauri/Cargo.toml --locked`.

Advisory — NOT part of the gate (mirrors the non-required CI job):

- `node_modules/.bin/eslint <files>` — expected RED until HED-14 (upstream ConnectionBanner.tsx debt); report it, don't chase it here.

Report results as a table (Check | Result | Details). If anything fails, list the
specific errors and STOP — report, don't fix, unless asked. A green local gate is
necessary but not sufficient: the PR still needs the full review sweep
(docs/REVIEW-SWEEP.md) before it is called clean.
