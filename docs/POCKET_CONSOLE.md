# Pocket console

## S1 architecture

The pocket console is a sibling Axum host, not an extension of `web/`. It serves a separate phone PWA, uses a small auditable device-token check rather than the desktop password plus E2EE pairing flow (redundant over WireGuard), and remains loopback-only. The existing `/ws` multiplexes full command dispatch; the sibling keeps that capability outside the phone token boundary and provides a clean S6 security-review boundary. It shares the heddle process, so a later slice can reach `PtyManager` for keystroke injection.

S1 is read-nothing: health plus token confirmation only. S2 adds Sessions and Chat with a status strip; S3/S4 add the prompt feed and reverse-channel approvals; S5 adds web push (the source writes `~/.heddle/push/pending.json`, and the host drains/merges producer files); S6 is the security pass that gates the interactive path.

## Ops panel

The first HED-319 Ops-panel increment is a read-only per-account usage view. The protected `GET /api/meters` route reads the keeper-mirrored `~/.heddle/usage/limits.json` contract and exposes each provider account’s five-hour and seven-day windows, plan, and stale state. The phone UI polls this route and never refreshes provider state or writes usage data.

Fleet-liveness, screenshot/artifact viewing, and the relaunch action are subsequent HED-319 increments. Relaunch remains S6-gated and is not part of this read-only meter view.

## S3b permission-prompt collector

`scripts/pocket-prompt-recorder.mjs` is an observational Claude Code `PermissionRequest` hook. It writes the latest pending permission prompt for each session to `~/.heddle/push/prompts/<session_id>.json` as a one-element pocket-envelope array; subsequent prompts for that session overwrite the prior file. The pocket host merges those files into `/api/approvals` alongside `pending.json`, so permission prompts render in the existing Approvals tab.

Prompt spools are TTL-filtered with `POCKET_PROMPT_TTL_SECS` (default: 21,600 seconds / 6 hours). There is no answered-prompt hook event yet, so an already answered prompt can linger until the TTL expires, until S4 adds approve/deny removal, or until a future PostToolUse-clearing follow-up. Overwrite-latest caps this at one stale card per session.

The recorder is default-off. It fires fleet-wide only when the launcher passes a `--settings <fleet-hooks overlay>` for each tab, with an environment toggle; R owns that activation. `scripts/fleet-hooks.sample.json` is the launcher-template sample and is not wired into the checked-in `.claude/settings.json`.

## Security posture

The listener binds only `127.0.0.1`, never a public or LAN address. Tailscale Serve supplies the real ts.net certificate and tailnet reachability; never use `tailscale funnel`. Each device uses a high-entropy token, whose SHA-256 hash alone is stored in `~/.heddle/pocket/config.json`. To verify “never a public listener,” inspect/assert the listener address is `127.0.0.1`; the only external exposure must be `tailscale serve`.

## Activation

1. In the Tailscale admin console, open DNS and enable HTTPS Certificates and MagicDNS.
2. Run `heddle --pocket-console mint-token`.
3. On the Mac, run `tailscale serve --bg --https=443 127.0.0.1:8800` (one-time; it persists).
4. On iPhone, open `https://<mac>.<tailnet>.ts.net/#token=<token>`, verify it loads, then use Add to Home Screen.

## CLI

- `heddle --pocket-console mint-token` — generate the device token (printed once), write its SHA-256 to `~/.heddle/pocket/config.json`, and print the onboarding URL plus the Tailscale steps.
- `heddle --pocket-console status` — show whether the console is enabled, the port, and the loopback / Tailscale Serve commands.
- `heddle --pocket-console serve` — run the loopback service in the foreground without the desktop GUI (Ctrl-C to stop). Useful for the bind test below and as a headless read-nothing host.

When the desktop app launches it auto-starts the service on the configured port **only if a token has been minted** (opt-in); otherwise it stays off.

## Verifying "never a public listener"

With the service running (`heddle --pocket-console serve`) and Tailscale Serve configured with `tailscale serve --bg --https=443 127.0.0.1:<port>`, confirm the socket is loopback-only:

- `lsof -nP -iTCP -sTCP:LISTEN | grep <port>` shows `127.0.0.1:<port>` — never `*:<port>`, `0.0.0.0:<port>`, or a LAN address.
- `curl -s http://127.0.0.1:<port>/api/health` returns `{"ok":true}`.
- `curl http://<lan-ip>:<port>/api/health` is refused (the listener is not on the LAN interface).
- `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/api/me` returns `401`; adding `-H "Authorization: Bearer <token>"` returns `200`.
