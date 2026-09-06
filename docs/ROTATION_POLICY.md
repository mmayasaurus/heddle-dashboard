# Rotation advisor policy

`~/.heddle/rotation-policy.json` is optional. Its versioned shape is:

```json
{"schemaVersion": 1, "rotateThresholdPct": 85, "criticalPct": 95}
```

When absent or invalid, the keeper logs the condition and uses the normal 85% rotation threshold
and 95% critical threshold. The advisor only recommends a target after a fresh interactive-session
census confirms that the exact integer split remains legal; it never rotates accounts itself.

When present, HED-451's `~/.heddle/live-identities.json` may provide `{ "accounts": { "acct1":
"identity-id" } }` for identity grouping. Without it, matching `accounts.json` email values are
treated as one live identity and logged loudly.
