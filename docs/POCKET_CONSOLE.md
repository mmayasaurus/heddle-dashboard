# Pocket console

## S1 architecture

The pocket console is a sibling Axum host, not an extension of `web/`. It serves a separate phone PWA, uses a small auditable device-token check rather than the desktop password plus E2EE pairing flow (redundant over WireGuard), and remains loopback-only. The existing `/ws` multiplexes full command dispatch; the sibling keeps that capability outside the phone token boundary and provides a clean S6 security-review boundary. It shares the heddle process, so a later slice can reach `PtyManager` for keystroke injection.

S1 is read-nothing: health plus token confirmation only. S2 adds Sessions and Chat with a status strip; S3/S4 add the prompt feed and reverse-channel approvals; S5 adds web push (the source writes `~/.heddle/push/pending.json`, and the host drains/merges producer files); S6 is the security pass that gates the interactive path.

## Security posture

The listener binds only `127.0.0.1`, never a public or LAN address. Tailscale Serve supplies the real ts.net certificate and tailnet reachability; never use `tailscale funnel`. Each device uses a high-entropy token, whose SHA-256 hash alone is stored in `~/.heddle/pocket/config.json`. To verify “never a public listener,” inspect/assert the listener address is `127.0.0.1`; the only external exposure must be `tailscale serve`.

## Activation

1. In the Tailscale admin console, open DNS and enable HTTPS Certificates and MagicDNS.
2. Run `heddle --pocket-console mint-token`.
3. On the Mac, run `tailscale serve --https=443 127.0.0.1:8800` (one-time; it persists).
4. On iPhone, open `https://<mac>.<tailnet>.ts.net/#token=<token>`, verify it loads, then use Add to Home Screen.

## CLI

- `heddle --pocket-console mint-token` — generate the device token (printed once), write its SHA-256 to `~/.heddle/pocket/config.json`, and print the onboarding URL plus the Tailscale steps.
- `heddle --pocket-console status` — show whether the console is enabled, the port, and the loopback / Tailscale Serve commands.
- `heddle --pocket-console serve` — run the loopback service in the foreground without the desktop GUI (Ctrl-C to stop). Useful for the bind test below and as a headless read-nothing host.

When the desktop app launches it auto-starts the service on the configured port **only if a token has been minted** (opt-in); otherwise it stays off.

## Verifying "never a public listener"

With the service running (`heddle --pocket-console serve`), confirm the socket is loopback-only:

- `lsof -nP -iTCP -sTCP:LISTEN | grep <port>` shows `127.0.0.1:<port>` — never `*:<port>`, `0.0.0.0:<port>`, or a LAN address.
- `curl -s http://127.0.0.1:<port>/api/health` returns `{"ok":true}`.
- `curl http://<lan-ip>:<port>/api/health` is refused (the listener is not on the LAN interface).
- `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/api/me` returns `401`; adding `-H "Authorization: Bearer <token>"` returns `200`.
