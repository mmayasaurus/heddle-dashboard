Run this repo's quality gate locally (mirrors `.github/workflows/gate.yml` — see docs/CI.md).

Execute from the repo root (or the active worktree):

1. `pnpm install --frozen-lockfile` if node_modules is missing or the lockfile changed; otherwise skip.
2. `pnpm build` — tsc + vite (also produces `dist/`, which cargo needs via tauri-build).
3. `pnpm test` — vitest (behavioral tests; a toggle-flips test is not a pass, see docs/CI.md standing rules).
4. `cargo check --manifest-path src-tauri/Cargo.toml --locked` and the same with `--no-default-features`.
5. `cargo test --manifest-path src-tauri/Cargo.toml --locked`.
6. `pnpm lint` — expected RED until HED-14 (upstream ConnectionBanner.tsx debt); report it, don't chase it here.

Report results as a table (Check | Result | Details). If anything fails, list the
specific errors and STOP — report, don't fix, unless asked. A green local gate is
necessary but not sufficient: the PR still needs the full review sweep
(docs/REVIEW-SWEEP.md) before it is called clean.
