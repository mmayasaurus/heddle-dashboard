# Rotation advisor policy

`~/.heddle/rotation-policy.json` is optional. Its versioned shape is:

```json
{"schemaVersion": 1, "rotateThresholdPct": 85, "criticalPct": 95}
```

When absent or invalid, the keeper logs the condition and uses the normal 85% rotation threshold
and 95% critical threshold. The advisor uses a fresh interactive-session census and exact integer
ceiling; it reports whether the observed pre-rotation split is even, but does not suppress advice
merely because it is skewed. It never rotates accounts itself.

When present, HED-451's `~/.heddle/live-identities.json` may provide `{ "accounts": { "acct1":
"identity-id" } }` for identity grouping. Without it, matching `accounts.json` email values are
treated as one live identity and logged loudly. A partial artifact for an email-sharing group falls
back to email grouping rather than splitting the identity.

A `live-identities.json` producer must not be wired until duplicate identities are handled this way:
a grouping artifact that maps two config-dir ids to one identity triggers the duplicate-identity mute.
The advisor is loudly muted through the delivery channel (`rotation-advice.json` and fleet post), rather
than silently advising from an invalid, double-counted census.

Set `HEDDLE_COMMS_POST` when installing the launchd job for a portable rotation poster, for example
`HEDDLE_COMMS_POST=/path/to/comms-post.mjs ./scripts/install-window-keeper-launchd.sh`. The installer
bakes that path into the plist's `EnvironmentVariables`; without it, it defaults to the operator's
workspace `comms-post.mjs`. If the poster receives no `HEDDLE_COMMS_POST`, it warns on stderr and
no-ops rather than crashing when the configured path is absent.
